/**
 * Single-instance lock and the stale-daemon trap (S-80).
 *
 * The failure pinned down here was hit in the field: a 0.4.0 daemon kept port
 * 4747 while the repo moved to 0.6.0. `acquireInstanceLock` existed but no
 * file imported it, and `main()` went from `openDatabase` straight to
 * `app.listen`. So every launch of the newer build ran 0.6.0 migrations
 * against the *running* 0.4.0 daemon's database and then died on an unhandled
 * EADDRINUSE — silently, in a launchd restart loop, for days.
 *
 * Two properties are asserted: the second instance loses predictably (says
 * which process holds the port, which version it is, and the one command that
 * fixes it) and it never opens the database it does not own. A third group
 * covers the periodic work `main()` must actually schedule — the retention
 * sweep that the user configures and that nothing ever called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { acquireInstanceLock } from '../src/single-instance.js';
import { main, startRetentionSweep, startBuildDriftWatch, readInstalledVersion } from '../src/main.js';
import { openDatabase, createMigrator, loadMigrationsFrom } from '../src/db.js';
import { RetentionAudit } from '../src/retention-audit.js';

const PKG = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version: string };
const BUILD_VERSION = PKG.version;
const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

const tmpDirs: string[] = [];
const openServers: Server[] = [];

function tmpHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-instance-'));
  tmpDirs.push(dir);
  return dir;
}

/** Bind an ephemeral loopback port and keep it. Never touches a developer's 4747. */
function holdPort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer();
    openServers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port, server });
    });
  });
}

/** An ephemeral port number that is free again by the time this resolves. */
async function freePort(): Promise<number> {
  const held = await holdPort();
  await new Promise<void>((r) => held.server.close(() => r()));
  return held.port;
}

/** A pid that is certainly not running: a child we already reaped. */
function deadPid(): number {
  const done = spawnSync('/bin/echo', ['x']);
  return done.pid ?? 999_999;
}

function writeLockFile(dir: string, pid: number, meta: Record<string, unknown>, ageMs = 0): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'daemon.lock');
  writeFileSync(file, `${pid}\n${JSON.stringify(meta)}\n`);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(file, when, when);
  }
}

afterEach(() => {
  for (const s of openServers.splice(0)) s.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('acquireInstanceLock', () => {
  it('wins on a free port and records pid + version, keeping the bare pid on line 1 for `clockworkd doctor`', async () => {
    const home = tmpHome();
    const port = await freePort();

    const lock = await acquireInstanceLock(home, port, '0.6.0');

    expect(lock.won).toBe(true);
    const raw = readFileSync(path.join(home, 'daemon.lock'), 'utf8');
    // cli.ts:118 does parseInt(readFileSync(lock).trim()) — line 1 must stay a bare pid.
    expect(parseInt(raw.trim(), 10)).toBe(process.pid);
    const meta = JSON.parse(raw.split('\n')[1] ?? '{}') as Record<string, unknown>;
    expect(meta.version).toBe('0.6.0');
    expect(meta.port).toBe(port);
    expect(typeof meta.startedAt).toBe('number');
    lock.release();
    expect(existsSync(path.join(home, 'daemon.lock'))).toBe(false);
  });

  it('creates the data directory when it does not exist yet', async () => {
    const home = path.join(tmpHome(), 'nested', 'clockwork');
    const port = await freePort();

    const lock = await acquireInstanceLock(home, port, '0.6.0');

    expect(lock.won).toBe(true);
    expect(existsSync(path.join(home, 'daemon.lock'))).toBe(true);
  });

  it('loses when the port is held, and reports the holder recorded in the lockfile', async () => {
    const home = tmpHome();
    const held = await holdPort();
    const startedAt = Date.parse('2026-09-03T09:12:00.000Z');
    writeLockFile(home, 4242, { version: '0.4.0', port: held.port, startedAt });

    const lock = await acquireInstanceLock(home, held.port, '0.6.0');

    expect(lock.won).toBe(false);
    expect(lock.reason).toBe('port-in-use');
    expect(lock.existingPid).toBe(4242);
    expect(lock.holder?.version).toBe('0.4.0');
    expect(lock.holder?.startedAt).toBe(startedAt);
  });

  it('reclaims a lockfile whose recorded pid is dead', async () => {
    const home = tmpHome();
    const port = await freePort();
    const gone = deadPid();
    writeLockFile(home, gone, { version: '0.4.0', port, startedAt: Date.now() });

    const lock = await acquireInstanceLock(home, port, '0.6.0');

    expect(lock.won).toBe(true);
    expect(lock.tookOverFrom?.pid).toBe(gone);
  });

  it('defers to a lockfile written seconds ago by a live pid: that is a real startup race', async () => {
    const home = tmpHome();
    const port = await freePort();
    writeLockFile(home, process.pid, { version: '0.6.0', port, startedAt: Date.now() });

    const lock = await acquireInstanceLock(home, port, '0.6.0');

    expect(lock.won).toBe(false);
    expect(lock.reason).toBe('startup-race');
  });

  it('reclaims an old lockfile with a live pid when the port is free — a recycled pid must never block startup forever', async () => {
    const home = tmpHome();
    const port = await freePort();
    // process.pid is alive but is not this daemon: exactly what a pid recycled
    // across a reboot looks like. The port is the authority, not the pid.
    writeLockFile(home, process.pid, { version: '0.4.0', port, startedAt: Date.now() - 3 * 86_400_000 }, 3 * 86_400_000);

    const lock = await acquireInstanceLock(home, port, '0.6.0');

    expect(lock.won).toBe(true);
    expect(lock.tookOverFrom?.pid).toBe(process.pid);
  });

  it('refuses when a live holder records a different port that is genuinely bound', async () => {
    const home = tmpHome();
    const ours = await freePort();
    const theirs = await holdPort();
    writeLockFile(home, process.pid, { version: '0.6.0', port: theirs.port, startedAt: Date.now() - 86_400_000 }, 86_400_000);

    const lock = await acquireInstanceLock(home, ours, '0.6.0');

    expect(lock.won).toBe(false);
    expect(lock.reason).toBe('other-port');
    expect(lock.holder?.port).toBe(theirs.port);
  });

  it('takes over when a live holder records a different port that nothing is serving', async () => {
    const home = tmpHome();
    const ours = await freePort();
    const abandoned = await freePort();
    writeLockFile(home, process.pid, { version: '0.4.0', port: abandoned, startedAt: Date.now() - 86_400_000 }, 86_400_000);

    const lock = await acquireInstanceLock(home, ours, '0.6.0');

    expect(lock.won).toBe(true);
  });

  it('release() leaves a lockfile that another process has since claimed alone', async () => {
    const home = tmpHome();
    const port = await freePort();
    const lock = await acquireInstanceLock(home, port, '0.6.0');
    writeLockFile(home, 4242, { version: '0.6.0', port, startedAt: Date.now() }); // someone else took over

    lock.release();

    expect(readFileSync(path.join(home, 'daemon.lock'), 'utf8').trim().split('\n')[0]).toBe('4242');
  });
});

describe('main() when another daemon already holds the port', () => {
  let stderr: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    const prevHome = process.env.CLOCKWORK_HOME;
    const prevPort = process.env.CLOCKWORK_PORT;
    restoreEnv = () => {
      if (prevHome === undefined) delete process.env.CLOCKWORK_HOME;
      else process.env.CLOCKWORK_HOME = prevHome;
      if (prevPort === undefined) delete process.env.CLOCKWORK_PORT;
      else process.env.CLOCKWORK_PORT = prevPort;
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
  });

  it('exits 0 with a diagnostic naming the holder, the skew and the fix — and never opens the database', async () => {
    const home = tmpHome();
    const held = await holdPort();
    const startedAt = Date.parse('2026-09-03T09:12:00.000Z');
    writeLockFile(home, 4242, { version: '0.4.0', port: held.port, startedAt });
    process.env.CLOCKWORK_HOME = home;
    process.env.CLOCKWORK_PORT = String(held.port);

    const code = await main([]);

    expect(code).toBe(0);
    expect(stderr).toContain(String(held.port));
    expect(stderr).toContain('pid 4242');
    expect(stderr).toContain('0.4.0');
    expect(stderr).toContain(BUILD_VERSION);
    expect(stderr.toLowerCase()).toContain('skew');
    expect(stderr).toContain('launchctl kickstart -k gui/$(id -u)/com.clockwork.daemon');
    expect(stderr).toContain('2026-09-03');
    // The blocker: the losing build used to migrate the database the running
    // daemon is serving. It must not open it at all.
    expect(existsSync(path.join(home, 'clockwork.sqlite'))).toBe(false);
  });

  it('says it will not kill the holder, because the holder may be mid-run', async () => {
    const home = tmpHome();
    const held = await holdPort();
    writeLockFile(home, 4242, { version: '0.4.0', port: held.port, startedAt: Date.now() });
    process.env.CLOCKWORK_HOME = home;
    process.env.CLOCKWORK_PORT = String(held.port);

    await main([]);

    expect(stderr.toLowerCase()).toContain('will not stop the running daemon');
  });

  it('still reports a holder that left no lockfile', async () => {
    const home = tmpHome();
    const held = await holdPort();
    process.env.CLOCKWORK_HOME = home;
    process.env.CLOCKWORK_PORT = String(held.port);

    const code = await main([]);

    expect(code).toBe(0);
    expect(stderr).toContain(String(held.port));
    expect(stderr.toLowerCase()).toContain('unknown');
    expect(existsSync(path.join(home, 'clockwork.sqlite'))).toBe(false);
  });
});

describe('startRetentionSweep', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sweeps immediately and again on the configured cadence', () => {
    const calls: number[] = [];
    const handle = startRetentionSweep({ sweeper: { sweep: () => calls.push(1) }, intervalMs: 1000, log: () => {} });

    expect(calls.length).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(calls.length).toBe(4);
    handle.stop();
    vi.advanceTimersByTime(5000);
    expect(calls.length).toBe(4);
  });

  it('survives a sweep that throws — a broken sweep must not take the daemon down', () => {
    const logged: string[] = [];
    let attempts = 0;
    const handle = startRetentionSweep({
      sweeper: {
        sweep: () => {
          attempts++;
          throw new Error('FOREIGN KEY constraint failed');
        },
      },
      intervalMs: 1000,
      log: (m) => logged.push(m),
    });

    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(attempts).toBe(3);
    expect(logged.join('\n')).toContain('FOREIGN KEY constraint failed');
    handle.stop();
  });

  it('prunes with the real RetentionAudit against a migrated database', () => {
    const home = tmpHome();
    const { db, file } = openDatabase(home);
    createMigrator(db, MIGRATIONS, file).migrate();
    db.prepare("INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('t1','old','p', 0, 0)").run();
    const old = Date.now() - 400 * 86_400_000;
    db.prepare(
      "INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, ended_at) VALUES ('r1','t1','{}','completed', ?, ?, ?)",
    ).run(old, old, old);
    const audit = new RetentionAudit(db);
    audit.setPrefs(90, 1000);

    const handle = startRetentionSweep({ sweeper: audit, intervalMs: 3_600_000, log: () => {} });
    handle.stop();

    expect((db.prepare("SELECT COUNT(*) c FROM runs WHERE id='r1'").get() as { c: number }).c).toBe(0);
    db.close();
  });
});

describe('build drift (version skew) detection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads the version the build on disk declares right now', () => {
    expect(readInstalledVersion()).toBe(BUILD_VERSION);
    expect(readInstalledVersion(path.join(tmpHome(), 'missing.json'))).toBeNull();
  });

  it('warns once when the installed build moves ahead of the running process', () => {
    const logged: string[] = [];
    let onDisk = '0.4.0';
    const handle = startBuildDriftWatch({
      runningVersion: '0.4.0',
      intervalMs: 1000,
      readInstalled: () => onDisk,
      log: (m) => logged.push(m),
    });

    vi.advanceTimersByTime(2000);
    expect(logged).toEqual([]); // in lockstep: silence

    onDisk = '0.6.0';
    vi.advanceTimersByTime(3000);
    handle.stop();

    expect(logged.length).toBe(1); // loud once, not every tick
    expect(logged[0]).toContain('0.4.0');
    expect(logged[0]).toContain('0.6.0');
    expect(logged[0]).toContain('launchctl kickstart -k gui/$(id -u)/com.clockwork.daemon');
  });
});
