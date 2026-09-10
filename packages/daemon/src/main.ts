/**
 * Daemon entrypoint: win the single-instance race, open DB, migrate, repair
 * schedules saved before the recurrence guard existed (T1-12), seed profiles,
 * recovery sweep, start scheduler + run manager + API. Runs as a
 * login-session LaunchAgent (T-108).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, createMigrator, type DB } from './db.js';
import { readFileSync, readdirSync } from 'node:fs';
import { acquireInstanceLock, readInstanceLockHolder, type HolderRecord, type LostReason } from './single-instance.js';
import { RetentionAudit } from './retention-audit.js';
import { SystemClock } from './clock.js';
import { Scheduler, buildJobSpec } from './scheduler.js';
import { RunManager } from './run-manager.js';
import { KeepAwake } from './keep-awake.js';
import { SafetyJournal } from '@clockwork/runner';
import { buildServer } from './api.js';
import { TaskRepo, ProfileRepo, type TaskRow } from './repo.js';
import { seedBuiltinProfiles, makeSkillResolver } from './profiles.js';
import { Notifier } from './notifier.js';
import { readPrefs, MAX_RRULE_COUNT } from './api.js';
import { loadDeliveryCreds } from './delivery.js';
import { TelegramApprovalsPoller } from './telegram-approvals.js';
import { guardSchedule, type GuardReason } from './schedule-guard.js';
import { newId } from '@clockwork/shared';

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

// ---------------------------------------------------------------------------
// T1-12 — repair schedules saved before `guardSchedule` existed
// ---------------------------------------------------------------------------

/** One hazardous row, and what the sweep did about it. */
export interface HazardSweepEntry {
  taskId: string;
  taskName: string;
  scheduleId: string;
  rrule: string;
  reason: GuardReason;
  /** The guard's own message — it already composes the fix. */
  detail: string;
  /** The placeholder run that carries the inbox item. */
  runId: string;
}

export interface HazardSweepResult {
  /** Enabled recurring rows examined. */
  checked: number;
  /** Rows disabled by THIS boot. Empty on every boot after the one that repaired them. */
  disabled: HazardSweepEntry[];
  /** Rows the guard refused but the repair could not write. The boot continues. */
  failed: number;
}

/** Short, stable code for the run row; the prose lives in the report summary. */
const HAZARD_OUTCOME = 'schedule_hazard';

/**
 * What the inbox item says. It names the task, the rule verbatim, the guard's
 * verdict and the guard's own remedy sentence, then says what was and was not
 * done — because a schedule that stopped firing with no explanation is the
 * failure mode this whole sweep exists to avoid.
 */
export function hazardNoticeText(entry: Omit<HazardSweepEntry, 'runId'>): string {
  return [
    `Clockwork disabled this task's schedule at startup, before the first tick.`,
    '',
    'Its recurrence rule is one rrule 2.8.1 cannot expand: asking for the next occurrence '
      + 'never returns, so the tick that reached this task would have taken the whole daemon '
      + 'with it. The rule was saved before the check that now refuses this shape at save '
      + 'time, which is why it was still here.',
    '',
    `    task     ${entry.taskName}`,
    `    rule     ${entry.rrule}`,
    `    verdict  ${entry.reason}`,
    '',
    entry.detail,
    '',
    'Nothing ran, nothing was deleted, and no other task was touched. Edit this task\'s '
      + 'recurrence and save it: the same check runs on save, so a corrected rule switches the '
      + 'schedule back on, and a rule that is still hazardous is refused with this message '
      + 'instead of being accepted.',
  ].join('\n');
}

/**
 * Run `guardSchedule` over every enabled recurring row once, at boot, and
 * disable the ones it refuses.
 *
 * WHY THIS EXISTS. `api.ts` refuses these shapes AT SAVE and deliberately
 * leaves the tick path unguarded (`api.ts:786`): a hazardous row saved before
 * the check existed "would go from slow to throwing, and that is a different
 * change from refusing new ones". That reasoning is right about the tick and
 * leaves exactly one hole — an install already carrying such a row still has a
 * daemon that hangs on it, and nothing says so. `FREQ=HOURLY;INTERVAL=2;
 * BYHOUR=3` never terminates inside rrule 2.8.1, and both readers of a STORED
 * rule reach it: the scheduler tick (`scheduler.ts:171`) and the calendar
 * aggregate (`api.ts:1901`). Both are gated on `schedules.enabled = 1`, so
 * clearing that flag is what closes the hole for both.
 *
 * DISABLE, NEVER THROW. A daemon that refuses to boot over one bad row is
 * worse than the hang it is avoiding, and the row is the user's data.
 *
 * IT CANNOT ITSELF HANG. `guardSchedule` answers from the rule TEXT with
 * modular arithmetic and never calls into rrule — that is the first line of
 * its header — so this loop costs O(rows x BY parts) whatever the rows say.
 * Nothing here expands a rule.
 *
 * IDEMPOTENT BY CONSTRUCTION, not by a marker. The query only sees
 * `schedules.enabled = 1` and the repair sets it to 0, so a second boot finds
 * nothing and raises nothing. A marker table was considered and rejected: it
 * would make a row that came back to `enabled = 1` be SKIPPED, which is the
 * one outcome that leaves the daemon able to hang again.
 *
 * A ROW THAT COMES BACK IS REPAIRED AGAIN, deliberately. `schedules.enabled`
 * has exactly one writer that can set it to 1 — `TaskRepo.patch`
 * (`repo.ts:186`), reached only when the request carries a `schedule`, which
 * `validateAndMaterialize` puts through this same guard first. So there is no
 * guard-free path back to `enabled = 1` with a hazardous rule: a user who
 * re-enables the TASK (`PATCH /tasks/:id {enabled:true}`) never touches the
 * schedule row at all. A hazardous `enabled = 1` row at boot is therefore
 * never a validated user choice — it is pre-guard data or a direct write to
 * SQLite — so it is disabled again and the user is told again. Told, not
 * silently overruled.
 *
 * @param db the migrated database.
 * @param now timestamp to stamp the repair and its inbox item with.
 * @param log where the one-line summary goes; stderr in production.
 * @returns what was examined, what was disabled, and what could not be written.
 */
export function sweepHazardousSchedules(
  db: DB,
  now: number = Date.now(),
  log: (message: string) => void = writeStderr,
): HazardSweepResult {
  // `tasks.enabled` is deliberately NOT in this predicate, though the tick
  // requires it. A paused task's hazardous row is one `PATCH /tasks/:id
  // {enabled:true}` away from being live again, and that route does not
  // re-validate the schedule — so leaving it armed would just move the hang
  // behind a toggle. `deleted_at` IS in it: a soft-deleted task has no screen
  // to show an inbox item on.
  const rows = db
    .prepare(
      `SELECT s.id AS schedule_id, s.rrule AS rrule, t.id AS task_id, t.name AS task_name
         FROM schedules s JOIN tasks t ON t.id = s.task_id
        WHERE s.enabled = 1 AND s.kind = 'rrule' AND t.deleted_at IS NULL`,
    )
    .all() as unknown as Array<{ schedule_id: string; rrule: string | null; task_id: string; task_name: string }>;

  const disabled: HazardSweepEntry[] = [];
  let failed = 0;

  for (const row of rows) {
    const verdict = guardSchedule('rrule', row.rrule, MAX_RRULE_COUNT);
    if (verdict.safe) continue;
    // Every refusal counts, not just `unreachable`. The guard's verdict IS the
    // definition of hazardous here; filtering by reason would be re-tuning an
    // analysis this sweep is meant to reuse unchanged.
    const base = {
      taskId: row.task_id,
      taskName: row.task_name,
      scheduleId: row.schedule_id,
      rrule: (row.rrule ?? '').trim(),
      reason: verdict.reason,
      detail: verdict.detail,
    };
    try {
      const runId = newId();
      const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(row.task_id) as unknown as TaskRow;
      // `buildJobSpec` rather than a hand-rolled stub: the inbox list reads
      // `json_extract(jobspec_json, '$.taskName')` (api.ts:1859) and the report
      // view parses the same blob, so a placeholder run has to carry a
      // well-formed one. Nothing executes it — `pump()` only ever dequeues
      // `queued`, and `recoverySweep` does not look at `awaiting_user`.
      const spec = buildJobSpec(runId, task, now, now, db);
      const summary = hazardNoticeText(base);
      const tx = db.transaction(() => {
        db.prepare('UPDATE schedules SET enabled=0, next_fire=NULL WHERE id=?').run(row.schedule_id);
        // `awaiting_user` is the state the scheduler already uses for a
        // placeholder run that exists only to put a question in front of a
        // human (`scheduler.ts:158`), and it is what the Inbox's "Needs you"
        // filter matches on. `occurrence_at` stays NULL: there is no
        // occurrence, which is the entire complaint.
        db.prepare(
          `INSERT INTO runs (id, task_id, schedule_id, jobspec_json, state, state_changed_at, scheduled_for, outcome_reason, report_json)
           VALUES (?, ?, ?, ?, 'awaiting_user', ?, ?, ?, ?)`,
        ).run(
          runId,
          row.task_id,
          row.schedule_id,
          JSON.stringify(spec),
          now,
          now,
          HAZARD_OUTCOME,
          JSON.stringify({ taskName: row.task_name, summary, artifacts: [] }),
        );
        db.prepare('INSERT INTO events (at, run_id, kind, data_json) VALUES (?, ?, ?, ?)').run(
          now,
          runId,
          'state_changed',
          JSON.stringify({ to: 'awaiting_user', reason: HAZARD_OUTCOME }),
        );
        // The "record the reason" half, in the append-only control-plane log
        // (migration 0004, goal #40). Not a fallback for the inbox item —
        // `RetentionAudit.sweep` only deletes runs in a TERMINAL state
        // (retention-audit.ts:79), and `awaiting_user` is not one, so the
        // notice is not pruned. This is the machine-readable record beside the
        // human-readable one, and the only one that survives the user
        // deleting the task.
        db.prepare(
          `INSERT INTO audit_log (at, actor, action, target_type, target_id, detail_json)
           VALUES (?, 'daemon', 'schedule.hazard_disabled', 'schedule', ?, ?)`,
        ).run(now, row.schedule_id, JSON.stringify({ ...base, runId }));
      });
      tx();
      disabled.push({ ...base, runId });
    } catch (err) {
      // One unwritable row must not cost the others their repair, and must not
      // cost the daemon its boot.
      failed++;
      log(
        `[schedule-sweep] could not repair schedule ${row.schedule_id} on task "${row.task_name}" `
          + `(${base.reason}): ${(err as Error).message}. It is still enabled and can still hang the tick.`,
      );
    }
  }

  if (disabled.length > 0) {
    log(
      `[schedule-sweep] checked ${rows.length} recurring schedule(s) and disabled ${disabled.length} that rrule 2.8.1 `
        + `cannot expand; each disabled task has an inbox item naming its rule and the fix. Fix the recurrence and save `
        + `the task to switch it back on.`,
    );
  }
  return { checked: rows.length, disabled, failed };
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

  // T1-12. The earliest correct point: the schema is current, and NOTHING has
  // read a stored rule yet — `buildServer` (below) is not listening,
  // `recoverySweep` does not touch schedules, and `scheduler.start` fires its
  // first tick further down. Both readers of a stored rule can hang on a
  // pre-guard row, so the repair has to land before either of them runs. It
  // never throws by design; the catch is for the impossible one, because a
  // daemon that will not boot is worse than the hazard it was avoiding.
  try {
    sweepHazardousSchedules(db);
  } catch (err) {
    process.stderr.write(`[schedule-sweep] sweep failed: ${(err as Error).message}. Boot continues.\n`);
  }

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

  // FR-25/S-15. This class shipped written, tested and CONSTRUCTED BY NOTHING:
  // `run-manager` took it as an optional dep and every scheduled run therefore
  // armed no power assertion at all, while the docs said one was armed. Same
  // defect shape as `single-instance.ts` being imported by no file. It is safe
  // to arm unconditionally here — `arm()` is a no-op off macOS, declines on
  // battery unless opted in, is idempotent per run, and swallows a spawn
  // failure.
  const keepAwake = new KeepAwake({ allowOnBattery: process.env.CLOCKWORK_KEEP_AWAKE_ON_BATTERY === '1' });

  const runManager = new RunManager({
    db,
    clock,
    dataDir,
    keepAwake,
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
    // T1-15: the SAME resolved dataDir buildServer gets, threaded rather than
    // re-derived. SchedulerDeps makes this required on purpose — the scheduled
    // path is the one that writes real worktrees, and an optional field nothing
    // populated in production is how it silently kept using $HOME.
    dataDir,
    enqueueRun: (_spec) => runManager.pump(),
    notify: (kind, taskName, detail) => {
      void notifier.send(`Clockwork: ${taskName}`, detail);
      journal.record(kind === 'missed' ? 'preflight_failure' : 'preflight_failure', `${kind}: ${detail}`);
    },
  });

  // `installedVersion` is the other half of the stale-daemon trap: the drift
  // watch below only shouts on stderr, which nobody reads. /health carries it
  // so the UI can put "restart needed" in front of a human.
  const { app, token } = await buildServer({
    db,
    dataDir,
    runManager,
    scheduler,
    version: DAEMON_VERSION,
    installedVersion: () => readInstalledVersion(),
  });

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
    keepAwake.releaseAll(); // never leave a caffeinate child holding the Mac awake
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

/** CLI entrypoint when executed directly (node dist/main.js / clockworkd). */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().then((code) => {
    if (code !== 0 && code !== undefined) process.exitCode = code;
  });
}
