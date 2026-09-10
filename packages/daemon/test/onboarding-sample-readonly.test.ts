/**
 * T4-2 — the sample run cannot change anything, and this is where that is
 * proved rather than asserted in prose.
 *
 * The Code Reviewer profile is read-only BY MISSION, and a mission is a
 * paragraph in a system prompt. Three things make the first run actually
 * incapable of a write, and each one is checked here against the exact body
 * `OnboardingGate` posts:
 *
 *   1. `permissionMode: 'plan'` on the TASK, which survives into the frozen
 *      JobSpec and reaches the CLI as `--permission-mode plan`. Note that the
 *      seeded profile's own permission mode is `acceptEdits` — the profile is
 *      not what is holding this line, and one of the cases below says so out
 *      loud.
 *   2. The run's cwd is a throwaway worktree under the data dir, never the
 *      user's checkout.
 *   3. The Seatbelt profile: `buildSandboxSpec` puts the repo in READ paths
 *      and only the worktree/scratch in the write allowlist, under a blanket
 *      `(deny file-write*)`. That one is the OS boundary, and the last case
 *      here is a vacuity control proving the check can fail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { ProfileRepo } from '../src/repo.js';
import { seedBuiltinProfiles } from '../src/profiles.js';
import { ONBOARDING_SAMPLE_PROFILE_SLUG, onboardingRepoReviewJob } from '../src/profile-library.js';
import { SafetyJournal, buildSandboxSpec, cliWorkDirFor, generateSeatbeltProfile } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

let db: DB;
let dir: string;
let repoPath: string;
let app: FastifyInstance;
let token: string;
/** `buildSandboxSpec` pre-creates the CLI's per-cwd work dir under /tmp, exactly as a real run does. */
const cliWorkDirs: string[] = [];

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

/**
 * The body `OnboardingGate.book` posts, field for field. Restated here rather
 * than imported because it is composed in a React component in another
 * package; `packages/ui/test/onboarding-sample.test.tsx` is what pins the
 * component to these values, and this file is what proves the values are safe.
 */
function sampleBody(): Record<string, unknown> {
  return {
    name: onboardingRepoReviewJob(path.basename(repoPath)).name,
    prompt: onboardingRepoReviewJob(path.basename(repoPath)).prompt,
    repoPath,
    profileSlugMention: ONBOARDING_SAMPLE_PROFILE_SLUG,
    permissionMode: 'plan',
    budget: { maxUsd: 0.5, maxTurns: 30, timeoutSec: 900 },
    schedule: { kind: 'once', runAt: Date.now() + 15_000, tz: 'UTC' },
    overlapPolicy: 'skip',
    missedPolicy: 'run-late',
    context: { files: [] },
    delivery: { osNotify: true },
  };
}

async function bookSample(): Promise<{ taskId: string; runId: string; spec: Record<string, any> }> {
  const created = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { authorization: `Bearer ${token}` },
    payload: sampleBody(),
  });
  expect(created.statusCode, created.body).toBe(201);
  const taskId = (created.json() as { id: string }).id;
  const started = await app.inject({
    method: 'POST',
    url: `/tasks/${taskId}/run-now`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(started.statusCode, started.body).toBe(202);
  const runId = (started.json() as { runId: string }).runId;
  const row = db.prepare('SELECT jobspec_json FROM runs WHERE id=?').get(runId) as { jobspec_json: string };
  return { taskId, runId, spec: JSON.parse(row.jobspec_json) };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-sample-ro-'));
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'cw-sample-repo-'));
  const ident = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=Test'];
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath, encoding: 'utf8' });
  writeFileSync(path.join(repoPath, 'README.md'), '# sample\n');
  execFileSync('git', [...ident, 'add', '.'], { cwd: repoPath, encoding: 'utf8' });
  execFileSync('git', [...ident, 'commit', '-qm', 'init'], { cwd: repoPath, encoding: 'utf8' });

  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  seedBuiltinProfiles(new ProfileRepo(db));
  const clock = new FakeClock(Date.now());
  const rm = new RunManager({
    db,
    clock,
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js', // the run is never executed here
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock, dataDir: dir, enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
  app = built.app;
  token = built.token;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  for (const p of cliWorkDirs) rmSync(p, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

describe('T4-2 the sample booking, as stored', () => {
  it('is accepted, and stores plan mode with the $0.50 cap and an ASAP one-shot', async () => {
    const body = sampleBody();
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = (created.json() as { id: string }).id;

    const row = db
      .prepare('SELECT permission_mode, budget_usd, max_turns, timeout_sec, repo_path, profile_id FROM tasks WHERE id=?')
      .get(taskId) as Record<string, unknown>;
    expect(row.permission_mode).toBe('plan');
    expect(row.budget_usd).toBe(0.5);
    expect(row.max_turns).toBe(30);
    expect(row.timeout_sec).toBe(900);
    expect(row.repo_path).toBe(repoPath);

    // The @mention resolved to the read-only reviewer, not to nothing.
    const profile = db.prepare('SELECT slug FROM profiles WHERE id=?').get(row.profile_id) as { slug: string };
    expect(profile.slug).toBe('code-reviewer');

    // ASAP: a one-shot, armed, in the near future.
    const sched = db.prepare('SELECT kind, next_fire FROM schedules WHERE task_id=?').get(taskId) as {
      kind: string;
      next_fire: number;
    };
    expect(sched.kind).toBe('once');
    expect(sched.next_fire).toBe((body.schedule as { runAt: number }).runAt);
    expect(sched.next_fire).toBeGreaterThan(Date.now());
    expect(sched.next_fire - Date.now()).toBeLessThanOrEqual(15_000);
  });

  it('passes the policy gate and the autonomy ceiling — `plan` can never exceed a rung', async () => {
    // `AutonomyPolicy.evaluate` refuses anything above 'plan' on the bottom
    // rung. Asking for 'plan' is the one request no ceiling can reject, which
    // is a second reason this is the right mode for a first run.
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: sampleBody(),
    });
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).toBe(201);
  });
});

describe('T4-2 the booked job cannot write', () => {
  it('freezes plan mode into the JobSpec the runner receives', async () => {
    const { spec } = await bookSample();

    expect(spec.permissionMode).toBe('plan');
    expect(spec.profile.slug).toBe('code-reviewer');
  });

  it('is NOT relying on the profile: the seeded Code Reviewer is acceptEdits', async () => {
    // The point of the whole exercise. The profile's mission says "you change
    // nothing"; its permission_mode says acceptEdits. Prose is not the
    // enforcement, and if a future seed changed this row the task-level mode
    // would still hold.
    const row = db
      .prepare('SELECT permission_mode, system_prompt_extra FROM profiles WHERE slug=?')
      .get('code-reviewer') as { permission_mode: string; system_prompt_extra: string };
    expect(row.permission_mode).toBe('acceptEdits');
    expect(row.system_prompt_extra).toContain('you change nothing');

    const { spec } = await bookSample();
    expect(spec.permissionMode, 'the task mode must win over the profile row').toBe('plan');
  });

  it('runs in a throwaway worktree, never in the user’s checkout', async () => {
    const { spec } = await bookSample();

    expect(spec.repoPath).toBe(repoPath);
    expect(spec.worktreePath.startsWith(`${dir}/worktrees/`)).toBe(true);
    expect(spec.worktreePath.startsWith(repoPath)).toBe(false);
    expect(spec.scratchPath).toBeNull();
  });

  it('gives the sandbox the repo as READ-ONLY and the worktree as the only writable place', async () => {
    const { spec } = await bookSample();
    mkdirSync(spec.worktreePath, { recursive: true }); // createWorktree would have
    cliWorkDirs.push(cliWorkDirFor(spec.worktreePath));

    const sandbox = buildSandboxSpec({
      worktreePath: spec.worktreePath,
      scratchPath: spec.scratchPath,
      repoPath: spec.repoPath,
      contextRoots: [],
      cacheRoot: path.join(dir, 'cache'),
    });

    expect(sandbox.readPaths).toContain(repoPath);
    expect(sandbox.writePaths).not.toContain(repoPath);
    expect(sandbox.writePaths).toContain(spec.worktreePath);

    const { profile } = generateSeatbeltProfile(sandbox);
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain(`(allow file-write* (subpath "${realpathSync(spec.worktreePath)}"))`);

    // Nothing on the write allowlist contains the repo. This is the assertion
    // that makes "cannot write" a fact about the OS rather than about a prompt.
    const repoReal = realpathSync(repoPath);
    const allowed = [...profile.matchAll(/\(allow file-write\* \(subpath "([^"]+)"\)\)/g)].map((m) => m[1]!);
    expect(allowed.length).toBeGreaterThan(0);
    expect(
      allowed.filter((p) => repoReal === p || repoReal.startsWith(`${p}/`)),
      'a write allowlist entry covers the user’s repo',
    ).toEqual([]);
  });

  it('control: the same check DOES catch a profile that allowlists the repo', async () => {
    // Without this, the assertion above would pass just as happily against a
    // profile with no write rules at all.
    const { profile } = generateSeatbeltProfile({ writePaths: [repoPath], readPaths: [], writeRegexes: [] });

    const repoReal = realpathSync(repoPath);
    const allowed = [...profile.matchAll(/\(allow file-write\* \(subpath "([^"]+)"\)\)/g)].map((m) => m[1]!);
    expect(allowed.filter((p) => repoReal === p || repoReal.startsWith(`${p}/`))).toEqual([repoReal]);
  });

  it('books exactly one run: the disarming PATCH stops the sweep firing the one-shot too', async () => {
    // The claim App.tsx's `book()` makes in a comment, checked at the layer
    // the duplicate would actually appear. `run-now` starts the run by hand
    // and leaves the ASAP occurrence armed; `{ enabled: false }` is what
    // consumes it. `Scheduler.tick`'s due query filters on `t.enabled = 1`.
    // Its own name: every other case in this file books the same task name,
    // they are all still armed in this database, and `notify` is only given a
    // name to identify a task by. Without this the sweep's notices from those
    // leftovers would be read as this one's.
    const name = 'Code review: disarmed-case';
    const runAt = Date.now() + 15_000;
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...sampleBody(), name, schedule: { kind: 'once', runAt, tz: 'UTC' } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = (created.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/run-now`,
      headers: { authorization: `Bearer ${token}` },
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((db.prepare('SELECT enabled FROM tasks WHERE id=?').get(taskId) as { enabled: number }).enabled).toBe(0);

    const notices: string[] = [];
    const tickClock = new FakeClock(runAt + 1000);
    const sweeper = new Scheduler({
      db,
      clock: tickClock,
      dataDir: dir,
      enqueueRun: () => {},
      notify: (kind, name, detail) => notices.push(`${kind}: ${name}: ${detail}`),
    });
    await sweeper.tick();

    const runs = db.prepare('SELECT COUNT(*) c FROM runs WHERE task_id=?').get(taskId) as { c: number };
    expect(runs.c, 'the sweep must not add a second run').toBe(1);
    expect(
      notices.filter((n) => n.includes(name)),
      'nor tell the user something was skipped',
    ).toEqual([]);
  });

  it('control: without the PATCH the same sweep does react, so the disarm is load-bearing', async () => {
    // The negative half. Left armed, the tick finds the due one-shot, sees the
    // manual run still going and fires the overlap notification — a
    // "Skipped: previous run still executing" alert 30 seconds into a user's
    // first ever run.
    const name = 'Code review: still-armed-case';
    const runAt = Date.now() + 15_000;
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...sampleBody(), name, schedule: { kind: 'once', runAt, tz: 'UTC' } },
    });
    const taskId = (created.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/run-now`,
      headers: { authorization: `Bearer ${token}` },
    });

    const notices: string[] = [];
    const sweeper = new Scheduler({
      db,
      clock: new FakeClock(runAt + 1000),
      dataDir: dir,
      enqueueRun: () => {},
      notify: (kind, taskName, detail) => notices.push(`${kind}: ${taskName}: ${detail}`),
    });
    await sweeper.tick();

    expect(notices.filter((n) => n.includes(name)).join(' ')).toContain(
      'Skipped: previous run still executing',
    );
  });

  it('and the runner really does hand plan mode to the CLI', async () => {
    // The last link in the chain, asserted against the source because
    // exercising it would mean spawning `claude`. `mapPermissionMode` is
    // module-private, so the mapping is read where it is written.
    const runner = readFileSync(
      path.resolve(import.meta.dirname, '../../runner/src/claude-cli-runner.ts'),
      'utf8',
    );
    expect(runner).toContain("'--permission-mode',");
    expect(runner).toContain('mapPermissionMode(job.permissionMode)');
    expect(runner).toMatch(/case 'plan':\s*\n\s*return 'plan';/);
  });
});
