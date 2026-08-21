/**
 * Daemon entrypoint: open DB, migrate, seed profiles, recovery sweep, start
 * scheduler + run manager + API. Runs as a login-session LaunchAgent (T-108).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, createMigrator } from './db.js';
import { readFileSync } from 'node:fs';
import { SystemClock } from './clock.js';
import { Scheduler, buildJobSpec } from './scheduler.js';
import { RunManager } from './run-manager.js';
import { SafetyJournal } from '@clockwork/runner';
import { buildServer } from './api.js';
import { TaskRepo, ProfileRepo } from './repo.js';
import { seedBuiltinProfiles, makeSkillResolver } from './profiles.js';
import { Notifier } from './notifier.js';

const DAEMON_VERSION = '0.1.0';

export async function main(argv: string[] = process.argv): Promise<number> {
  const dataDir = process.env.CLOCKWORK_HOME ?? `${process.env.HOME}/.clockwork`;
  const port = parseInt(process.env.CLOCKWORK_PORT ?? '4747', 10);

  if (argv.includes('--version')) {
    process.stdout.write(`clockworkd ${DAEMON_VERSION}\n`);
    return 0;
  }

  const { db } = openDatabase(dataDir);
  const migrationSql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations/0001_init.sql'), 'utf8');
  createMigrator(db, [{ id: '0001_init', sql: migrationSql }]).migrate();

  const profileRepo = new ProfileRepo(db);
  seedBuiltinProfiles(profileRepo);
  const skillResolver = makeSkillResolver(resolve(dirname(fileURLToPath(import.meta.url)), '../../../resources/skill-pack'));

  const journal = new SafetyJournal(`${dataDir}/safety-journal.jsonl`);
  const notifier = new Notifier();

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
    enqueueRun: (spec) => runManager.pump(),
    notify: (kind, taskName, detail) => {
      void notifier.send(`Clockwork: ${taskName}`, detail);
      journal.record(kind === 'missed' ? 'preflight_failure' : 'preflight_failure', `${kind}: ${detail}`);
    },
  });

  const { app, token } = buildServer({ db, dataDir, runManager, scheduler, version: DAEMON_VERSION });

  // startup sweep (S-14/S-30/S-31/S-81): same path as wake catch-up
  const recovery = runManager.recoverySweep();
  if (recovery.orphanedTerminated > 0 || recovery.quarantinedWorktrees.length > 0) {
    journal.record('orphan_terminated', JSON.stringify(recovery));
  }

  await app.listen({ port, host: '127.0.0.1' });
  process.stdout.write(`clockworkd ${DAEMON_VERSION} listening on 127.0.0.1:${port} (token in ${dataDir}/api-token)\n`);
  if (recovery.requeued + recovery.orphanedTerminated > 0) {
    process.stdout.write(`recovery: requeued=${recovery.requeued} orphanedTerminated=${recovery.orphanedTerminated} quarantinedWorktrees=${recovery.quarantinedWorktrees.length}\n`);
  }
  void token;

  scheduler.start(30_000);

  const shutdown = (): void => {
    scheduler.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

void buildJobSpec; // re-exported for tests
