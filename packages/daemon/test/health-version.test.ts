/**
 * `/health` has to say which build is actually answering.
 *
 * The stale-daemon trap (S-80, single-instance.test.ts): a long-lived daemon
 * keeps serving the version it started with, while the build on disk — and the
 * UI bundle served out of it — moves on. `startBuildDriftWatch` says so on
 * stderr, which nobody reads. The handshake the UI already polls has to carry
 * it too, so the app can put a "restart needed" chip in front of a human.
 *
 * Two honesty rules are pinned here:
 *  - unwired or unreadable → `installedVersion: null`, `versionSkew: false`.
 *    Never claim skew that cannot be proven.
 *  - re-read per request. The whole point is that this process does not change
 *    while the file under it does, so a cached answer is the bug.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { readInstalledVersion } from '../src/main.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const BUILD_VERSION = (
  JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version: string }
).version;

interface HealthBody {
  ok: boolean;
  apiVersion: number | string;
  daemonVersion: string;
  installedVersion: string | null;
  versionSkew: boolean;
  paused: boolean;
  activeRuns: number;
  queuedRuns: number;
  nextFire: number | null;
}

let dir: string;
let db: DB;
let servers: FastifyInstance[];

async function serverWith(extra: { version: string; installedVersion?: () => string | null }): Promise<FastifyInstance> {
  const clock = new FakeClock(Date.now());
  const rm = new RunManager({
    db,
    clock,
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js',
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock, enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, ...extra });
  await built.app.ready();
  servers.push(built.app);
  return built.app;
}

const health = async (app: FastifyInstance): Promise<HealthBody> => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  return res.json() as HealthBody;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-health-version-'));
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  servers = [];
});

afterEach(async () => {
  for (const app of servers) await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /health — the running build vs the installed build', () => {
  it('reports no skew when the daemon and the build on disk are in lockstep', async () => {
    const app = await serverWith({ version: '0.6.0', installedVersion: () => '0.6.0' });

    const body = await health(app);

    expect(body.daemonVersion).toBe('0.6.0');
    expect(body.installedVersion).toBe('0.6.0');
    expect(body.versionSkew).toBe(false);
    // the rest of the S-61 handshake is unchanged
    expect(body.ok).toBe(true);
    expect(body.paused).toBe(false);
    expect(body.activeRuns).toBe(0);
    expect(body.queuedRuns).toBe(0);
    expect(body).toHaveProperty('apiVersion');
    expect(body).toHaveProperty('nextFire');
  });

  it('reports skew — with BOTH versions — once the build on disk moves ahead', async () => {
    const app = await serverWith({ version: '0.4.0', installedVersion: () => '0.6.0' });

    const body = await health(app);

    expect(body.versionSkew).toBe(true);
    expect(body.daemonVersion).toBe('0.4.0'); // what is answering
    expect(body.installedVersion).toBe('0.6.0'); // what a restart would get you
  });

  it('re-reads per request: the flag flips without restarting the process', async () => {
    let onDisk = '0.6.0';
    const app = await serverWith({ version: '0.6.0', installedVersion: () => onDisk });

    expect((await health(app)).versionSkew).toBe(false);
    onDisk = '0.7.0'; // a new build lands under a daemon that keeps running

    const after = await health(app);
    expect(after.versionSkew).toBe(true);
    expect(after.installedVersion).toBe('0.7.0');
  });

  it('never claims a skew it cannot prove: unreadable package.json, and unwired', async () => {
    const unreadable = await health(await serverWith({ version: '0.6.0', installedVersion: () => null }));
    expect(unreadable.installedVersion).toBeNull();
    expect(unreadable.versionSkew).toBe(false);

    const unwired = await health(await serverWith({ version: '0.6.0' }));
    expect(unwired.installedVersion).toBeNull();
    expect(unwired.versionSkew).toBe(false);
  });

  it('reads the real build version through main.ts, which is what the daemon wires in', () => {
    expect(readInstalledVersion()).toBe(BUILD_VERSION);
  });

  it('main.ts still hands the reader to buildServer', () => {
    // Cheap drift guard beside the injected-reader tests above: the fields are
    // dead weight if the daemon never passes a reader, and no unit test of
    // buildServer can see that.
    const src = readFileSync(path.resolve(import.meta.dirname, '../src/main.ts'), 'utf8');
    expect(src).toMatch(/buildServer\(\{[^}]*installedVersion/s);
  });
});
