/**
 * Daemon entrypoint: win the single-instance race, open DB, migrate, seed
 * profiles, recovery sweep, start scheduler + run manager + API. Runs as a
 * login-session LaunchAgent (T-108).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, createMigrator } from './db.js';
import { readFileSync, readdirSync } from 'node:fs';
import { acquireInstanceLock, readInstanceLockHolder, type HolderRecord, type LostReason } from './single-instance.js';
import { RetentionAudit } from './retention-audit.js';
import { SystemClock } from './clock.js';
import { Scheduler, buildJobSpec } from './scheduler.js';
import { RunManager } from './run-manager.js';
import { SafetyJournal } from '@clockwork/runner';
import { buildServer } from './api.js';
import { TaskRepo, ProfileRepo } from './repo.js';
import { seedBuiltinProfiles, makeSkillResolver } from './profiles.js';
import { Notifier } from './notifier.js';
import { readPrefs } from './api.js';
import { loadDeliveryCreds } from './delivery.js';
import { TelegramApprovalsPoller } from './telegram-approvals.js';

// Single source of truth: the daemon package.json. Keeps --version, /health,
// and the UI footer in lockstep with releases (no more hardcoded literals).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const DAEMON_VERSION: string = require('../package.json').version;

/** Same file, re-read at runtime: the build on disk moves, this process does not. */
const DAEMON_PKG_JSON = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
/** launchd owns the daemon's lifetime; this is how a human hands the slot to a new build. */
const RESTART_COMMAND = 'launchctl kickstart -k gui/$(id -u)/com.clockwork.daemon';
const RETENTION_SWEEP_MS = 6 * 60 * 60_000;
const BUILD_DRIFT_CHECK_MS = 30 * 60_000;

export interface PeriodicTask {
  stop(): void;
}

export interface DuplicateInstanceReport {
  port: number;
  dataDir: string;
  buildVersion: string;
  reason?: LostReason;
  holder?: HolderRecord;
}

/**
 * The only thing a losing daemon leaves behind (S-80): who holds the slot,
 * whether it is older than this build, and the one command that fixes it.
 *
 * @param report port/data dir this build wanted, its own version, and the holder on record.
 * @returns the message to write to stderr before exiting 0.
 */
export function duplicateInstanceMessage(report: DuplicateInstanceReport): string {
  const { port, dataDir, buildVersion, reason, holder } = report;
  const who = holder?.pid !== undefined ? `pid ${holder.pid}` : 'an unknown process (no lockfile on record)';
  const holderVersion = holder?.version ?? 'unknown (no version in the lockfile)';
  const since = holder?.startedAt !== undefined ? new Date(holder.startedAt).toISOString() : 'unknown';

  if (reason === 'startup-race') {
    return (
      `clockworkd ${buildVersion} did not start: another clockworkd (${who}) claimed the instance lock moments ago ` +
      `and is still binding 127.0.0.1:${port}.\n` +
      `  No action needed — one daemon per data directory (${dataDir}) is the point of the lock.\n` +
      `Exiting 0 (S-80: the loser of the single-instance race exits quietly).\n`
    );
  }

  const where =
    reason === 'other-port'
      ? `a live daemon owns this data directory on port ${holder?.port ?? '?'}`
      : `something is already serving 127.0.0.1:${port}`;
  const lines = [
    `clockworkd ${buildVersion} did not start: ${where}.`,
    `  data dir    ${dataDir}`,
    `  holder      ${who}, clockworkd ${holderVersion}, running since ${since}`,
    `  this build  clockworkd ${buildVersion}`,
  ];
  if (holder?.version !== undefined && holder.version !== buildVersion) {
    lines.push(
      `  VERSION SKEW: the running daemon is ${holder.version} and the installed build is ${buildVersion}.`,
      `  The UI is served from disk, so the browser already loads the ${buildVersion} frontend while the API`,
      `  answering it is ${holder.version}: routes added since ${holder.version} return 404 and the app looks`,
      `  broken in unrelated ways. Restarting the daemon is the whole fix.`,
    );
  }
  lines.push(
    `  Fix — hand the slot to this build (stops the old process, starts this one):`,
    `    ${RESTART_COMMAND}`,
    `  Clockwork will not stop the running daemon by itself: it may be executing agent runs right now`,
    `  (child processes, git worktrees, the repo mutex). That is a decision for you, not for this build.`,
    `Exiting 0 (S-80: the loser of the single-instance race exits quietly).`,
  );
  return `${lines.join('\n')}\n`;
}

/** Anything that can prune history — `RetentionAudit` in production, a stub in tests. */
export interface RetentionSweeper {
  sweep(now?: number): number;
}

export interface RetentionSweepOptions {
  sweeper: RetentionSweeper;
  intervalMs?: number;
  log?: (message: string) => void;
}

/**
 * Run the retention policy the user configured (ADR-031) on a cadence.
 * Without this, `runDays` / `maxRuns` are settings that never execute.
 *
 * @param options the sweeper to call, the cadence, and where to log.
 * @returns a handle whose `stop()` clears the timer.
 */
export function startRetentionSweep(options: RetentionSweepOptions): PeriodicTask {
  const { sweeper, intervalMs = RETENTION_SWEEP_MS, log = writeStderr } = options;
  const run = (): void => {
    try {
      const deleted = sweeper.sweep();
      if (deleted > 0) log(`[retention] pruned ${deleted} row(s)`);
    } catch (err) {
      // Housekeeping must never take the daemon down: an uncaught throw inside
      // a timer callback would end the process and every run it is supervising.
      log(`[retention] sweep failed: ${(err as Error).message}`);
    }
  };
  run(); // startup sweep — a machine that sleeps through the cadence still prunes on wake
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

/**
 * Version the daemon build on disk declares right now.
 *
 * @param pkgJsonPath daemon package.json (defaults to this build's own).
 * @returns the version string, or null when it cannot be read.
 */
export function readInstalledVersion(pkgJsonPath: string = DAEMON_PKG_JSON): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

export interface BuildDriftOptions {
  runningVersion: string;
  intervalMs?: number;
  readInstalled?: () => string | null;
  log?: (message: string) => void;
}

/**
 * Watch for the installed build moving ahead of this process (the stale-daemon
 * trap). The UI is served off disk and upgrades the moment a new build lands;
 * a long-lived daemon does not, and nothing else says so out loud.
 *
 * @param options the running version, the cadence, the reader, and where to log.
 * @returns a handle whose `stop()` clears the timer.
 */
export function startBuildDriftWatch(options: BuildDriftOptions): PeriodicTask {
  const {
    runningVersion,
    intervalMs = BUILD_DRIFT_CHECK_MS,
    readInstalled = (): string | null => readInstalledVersion(),
    log = writeStderr,
  } = options;
  let reported: string | null = null;
  const check = (): void => {
    const installed = readInstalled();
    if (installed === null || installed === runningVersion || installed === reported) return;
    reported = installed; // loud once per new build, not once per tick
    log(
      `[version] SKEW: this daemon is running clockworkd ${runningVersion} but the build on disk is now ${installed}. ` +
        `The UI is served from that build, so the browser runs ${installed} against a ${runningVersion} API — ` +
        `routes added since ${runningVersion} return 404. Restart the daemon to pick up the new build:\n    ${RESTART_COMMAND}`,
    );
  };
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const dataDir = process.env.CLOCKWORK_HOME ?? `${process.env.HOME}/.clockwork`;
  const port = parseInt(process.env.CLOCKWORK_PORT ?? '4747', 10);

  if (argv.includes('--version')) {
    process.stdout.write(`clockworkd ${DAEMON_VERSION}\n`);
    return 0;
  }

  // S-80, and the blocker it was written for: win the instance race BEFORE
  // opening the database. A daemon that loses must not run its migrations
  // against the database the winner is serving — that is how a 0.6.0 build
  // left a running 0.4.0 daemon on a 0.6.0 schema while crash-looping on
  // EADDRINUSE (test/single-instance.test.ts).
  const lock = await acquireInstanceLock(dataDir, port, DAEMON_VERSION);
  if (!lock.won) {
    process.stderr.write(
      duplicateInstanceMessage({ port, dataDir, buildVersion: DAEMON_VERSION, reason: lock.reason, holder: lock.holder }),
    );
    return 0;
  }
  if (lock.tookOverFrom) {
    process.stderr.write(
      `clockworkd: reclaimed the instance lock from pid ${lock.tookOverFrom.pid ?? '?'} ` +
        `(clockworkd ${lock.tookOverFrom.version ?? 'unknown'}) — nothing was serving 127.0.0.1:${port}. ` +
        `No process was stopped.\n`,
    );
  }

  const { db, file } = openDatabase(dataDir);
  // Load ALL forward-only migrations in filename order (0001_*, 0002_*, …).
  const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ id: f.replace(/\.sql$/, ''), sql: readFileSync(resolve(migrationsDir, f), 'utf8') }));
  createMigrator(db, migrations, file).migrate();

  const profileRepo = new ProfileRepo(db);
  seedBuiltinProfiles(profileRepo);
  const skillResolver = makeSkillResolver(resolve(dirname(fileURLToPath(import.meta.url)), '../../../resources/skill-pack'));

  const journal = new SafetyJournal(`${dataDir}/safety-journal.jsonl`);
  const notifier = new Notifier({
    dataDir,
    soundMode: readPrefs(dataDir).soundMode,
    volumePct: readPrefs(dataDir).volumePct,
  });

  const clock = new SystemClock();
  const taskRepo = new TaskRepo(db);
  void taskRepo;

  const runManager = new RunManager({
    db,
    clock,
    dataDir,
    runnerChildModule: resolve(dirname(fileURLToPath(import.meta.url)), './runner-child.js'),
    maxParallel: parseInt(process.env.CLOCKWORK_MAX_PARALLEL ?? '2', 10),
    notify: (kind, title, body) => {
      void notifier.send(title, body);
      journal.record(kind as any, `${title}: ${body}`);
    },
    broadcast: () => {}, // replaced by buildServer wiring
    safetyJournal: journal,
    resolveSkill: skillResolver,
  });

  const scheduler = new Scheduler({
    db,
    clock,
    enqueueRun: (_spec) => runManager.pump(),
    notify: (kind, taskName, detail) => {
      void notifier.send(`Clockwork: ${taskName}`, detail);
      journal.record(kind === 'missed' ? 'preflight_failure' : 'preflight_failure', `${kind}: ${detail}`);
    },
  });

  const { app, token } = await buildServer({ db, dataDir, runManager, scheduler, version: DAEMON_VERSION });

  // startup sweep (S-14/S-30/S-31/S-81): same path as wake catch-up
  const recovery = runManager.recoverySweep();
  if (recovery.orphanedTerminated > 0 || recovery.quarantinedWorktrees.length > 0) {
    journal.record('orphan_terminated', JSON.stringify(recovery));
  }

  try {
    await app.listen({ port, host: '127.0.0.1' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      lock.release();
      db.close();
      throw err;
    }
    // Lost the port between the lock probe and this bind. The probe has to let
    // the port go before fastify can take it, so the window is real and an
    // unhandled rejection here is what made the stale daemon invisible.
    lock.release();
    db.close();
    process.stderr.write(
      duplicateInstanceMessage({
        port,
        dataDir,
        buildVersion: DAEMON_VERSION,
        reason: 'port-in-use',
        holder: readInstanceLockHolder(dataDir),
      }),
    );
    return 0;
  }
  process.stdout.write(`clockworkd ${DAEMON_VERSION} listening on 127.0.0.1:${port} (token in ${dataDir}/api-token)\n`);
  if (recovery.requeued + recovery.orphanedTerminated > 0) {
    process.stdout.write(`recovery: requeued=${recovery.requeued} orphanedTerminated=${recovery.orphanedTerminated} quarantinedWorktrees=${recovery.quarantinedWorktrees.length}\n`);
  }
  void token;

  scheduler.start(30_000);

  // Retention (ADR-031): the window and cap the user sets in Settings only
  // mean something if something runs them. Nothing did.
  const retention = startRetentionSweep({ sweeper: new RetentionAudit(db) });
  // The other half of the stale-daemon trap: this process cannot upgrade
  // itself, so it says when the build under it has moved on.
  const driftWatch = startBuildDriftWatch({ runningVersion: DAEMON_VERSION });

  // Reachable approvals (inbound half, ADR-036): outbound-only long-poll of
  // the Telegram Bot API, started only when a bot token is actually
  // configured. The daemon still binds loopback only (see above) — this is a
  // client of api.telegram.org, never a server.
  const telegramBotToken = loadDeliveryCreds(dataDir).telegramBotToken;
  const telegramPoller = telegramBotToken
    ? new TelegramApprovalsPoller({
        db,
        runManager,
        botToken: telegramBotToken,
        log: (msg) => process.stderr.write(`[telegram-approvals] ${msg}\n`),
      })
    : null;
  telegramPoller?.start();

  const shutdown = (): void => {
    scheduler.stop();
    retention.stop();
    driftWatch.stop();
    void Promise.resolve(telegramPoller?.stop()).finally(() => {
      lock.release();
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

void buildJobSpec; // re-exported for tests

/** CLI entrypoint when executed directly (node dist/main.js / clockworkd). */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().then((code) => {
    if (code !== 0 && code !== undefined) process.exitCode = code;
  });
}
