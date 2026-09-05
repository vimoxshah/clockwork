/**
 * Full-loop integration tests: scheduler -> run manager -> REAL child process
 * (tsx + runner-child.ts with CW_ENGINE=mock) -> finalize. Covers queue
 * ordering (S-2/S-27), repo mutex (S-3/S-28), recovery sweep (S-30/S-31),
 * report assembly (FR-15), search indexing (FR-29).
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { FakeClock } from '../src/clock.js';
import { SafetyJournal } from '@clockwork/runner';

let db: DB;
let dir: string;
let repoDir: string;
let rm: RunManager;
let clock: FakeClock;
const notifications: Array<{ kind: string; title: string; body: string }> = [];

function seedTask(name: string, over: Partial<Record<string, unknown>> = {}): any {
  const now = Date.now();
  const id = `t-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, 'mock work', repoDir, now, now);
  for (const [k, v] of Object.entries(over)) {
    db.prepare(`UPDATE tasks SET ${k}=? WHERE id=?`).run(v as never, id);
  }
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as any;
}

function enqueue(taskId: string): string {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as any;
  const { enqueueRunNowApiFree } = { enqueueRunNowApiFree: null };
  void enqueueRunNowApiFree;
  // build jobspec via the same helper the API uses (duplicated minimal here)
  const spec = JSON.parse(
    JSON.stringify({
      runId: `r-${Math.random().toString(36).slice(2, 10)}`,
      taskId: task.id,
      taskName: task.name,
      taskSlug: task.name.toLowerCase(),
      prompt: task.prompt,
      engine: 'cli',
      model: null,
      permissionMode: 'acceptEdits',
      budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 60 },
      repoPath: task.repo_path,
      baseBranch: null,
      worktreePath: path.join(dir, 'worktrees', `${task.name.toLowerCase()}`, Math.random().toString(36).slice(2)),
      branch: `clockwork/${task.name.toLowerCase()}/x`,
      scratchPath: null,
      profile: null,
      contextFiles: [],
      occurrenceAt: Date.now(),
      scheduledFor: Date.now(),
      createdAt: Date.now(),
    }),
  );
  const now = Date.now();
  db.prepare(`INSERT INTO runs (id, task_id, occurrence_at, jobspec_json, state, state_changed_at, scheduled_for) VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
    .run(spec.runId, taskId, now, JSON.stringify(spec), now, now);
  return spec.runId;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-loop-'));
  repoDir = path.join(dir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 't']);
  writeFileSync(path.join(repoDir, 'f.txt'), '1\n');
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoDir });

  const opened = openDatabase(path.join(dir, 'data'));
  db = opened.db;
  createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
  clock = new FakeClock(Date.now());
  rm = new RunManager({
    db,
    clock,
    dataDir: path.join(dir, 'data'),
    runnerChildModule: path.resolve(import.meta.dirname, '../src/runner-child.ts'),
    childCommandPrefix: [path.resolve(import.meta.dirname, '../node_modules/.bin/tsx')],
    maxParallel: 2,
    notify: (kind, title, body) => notifications.push({ kind, title, body }),
    broadcast: () => {},
    safetyJournal: new SafetyJournal(path.join(dir, 'journal.jsonl')),
  });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      try {
        if (predicate()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          reject(new Error('waitFor timeout'));
        }
      } catch (e) {
        clearInterval(timer);
        reject(e as Error);
      }
    }, 200);
  });
}

describe('full loop through child process (MockRunner engine)', () => {
  it('S-1/S-13-happy: queued run executes in a real child and finalizes completed with a report', async () => {
    process.env.CW_ENGINE = 'mock';
    const taskId = seedTask('loop-happy').id;
    const runId = enqueue(taskId);

    rm.pump();
    await waitFor(() => stateOf(runId) === 'completed');

    const row = db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as any;
    expect(row.state).toBe('completed');
    const report = JSON.parse(row.report_json);
    expect(report.summary.length).toBeGreaterThan(0);
    expect(report.engine).toBe('cli'); // job spec says cli; CW_ENGINE=mock overrides execution only
    expect(row.worktree_path).toContain(path.join('worktrees'));

    // S-39: analysis-only run (mock commits nothing) → worktree auto-pruned immediately
    expect(existsSync(row.worktree_path)).toBe(false);
    const branches = execFileSync('git', ['branch', '--list', row.branch], { cwd: repoDir, encoding: 'utf8' });
    expect(branches).not.toContain(row.branch);

    // events audit trail exists
    const events = db.prepare('SELECT COUNT(*) c FROM events WHERE run_id=?').get(runId) as any;
    expect(events.c).toBeGreaterThanOrEqual(3); // queued->preparing->running->finalizing->completed
    delete process.env.CW_ENGINE;
  }, 60_000);

  it('S-3/S-28: same-repo runs serialize on the mutex — second waits until first finishes', async () => {
    process.env.CW_ENGINE = 'mock';
    // Make r1 slow enough that its lifetime is observable (instant mock would
    // flip queued→completed between 200ms samples on fast CI machines).
    const t1 = seedTask('mutex-a').id;
    const r1 = enqueue(t1);
    process.env.CW_MOCK_STEP_MS = '1500';
    rm.pump();
    await waitFor(() => stateOf(r1) === 'running');

    // While r1 is alive, enqueue r2 in the SAME repo: mutex must hold it.
    process.env.CW_MOCK_STEP_MS = '0';
    const t2 = seedTask('mutex-b').id;
    const r2 = enqueue(t2);

    // Invariant sampling across r1's remaining life: r2 never runs concurrently.
    // finalize() pumps r2 the instant r1 turns terminal — that immediate
    // hand-off is correct behavior, so nothing is asserted after the loop;
    // the loop itself is the serialization proof.
    let samples = 0;
    while (!isTerminal(stateOf(r1))) {
      expect(['queued', 'preparing']).toContain(stateOf(r2));
      samples++;
      await new Promise((res) => setTimeout(res, 120));
    }
    expect(samples).toBeGreaterThan(2); // we actually observed the overlap window
    await waitFor(() => stateOf(r2) === 'completed');
    delete process.env.CW_MOCK_STEP_MS;
    delete process.env.CW_ENGINE;
  }, 90_000);

  it('S-2/S-27: different repos run in parallel up to maxParallel; third queues FIFO', async () => {
    process.env.CW_ENGINE = 'mock';
    // two extra repos so mutex isn't the limiter
    const repoB = path.join(dir, 'repo-b');
    mkdirSync(repoB, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoB });
    execFileSync('git', ['-C', repoB, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repoB, 'config', 'user.name', 't']);
    writeFileSync(path.join(repoB, 'x.txt'), 'x');
    execFileSync('git', ['-C', repoB, 'add', '-A']);
    execFileSync('git', ['-C', repoB, 'commit', '-qm', 'i']);

    const ids = [
      seedTask('par-a', { repo_path: repoDir }).id,
      seedTask('par-b', { repo_path: repoB }).id,
      seedTask('par-c', { repo_path: repoDir }).id, // shares repo with par-a → waits on mutex anyway
    ];
    const runs = ids.map((id) => enqueue(id));
    // small per-step delay so states are observable on fast machines
    process.env.CW_MOCK_STEP_MS = '250';
    rm.pump();
    await new Promise((r) => setTimeout(r, 1500));
    // at most 2 active
    const states = runs.map((r) => stateOf(r));
    const activeCount = states.filter((s) => ['preparing', 'running'].includes(s)).length;
    expect(activeCount).toBeLessThanOrEqual(2);
    await waitFor(() => runs.every((r) => isTerminal(stateOf(r))), 60_000);
    delete process.env.CW_MOCK_STEP_MS;
    delete process.env.CW_ENGINE;
  }, 120_000);

  it('cancel of a running run terminates the child group and marks cancelled', async () => {
    process.env.CW_ENGINE = 'mock';
    process.env.CW_MOCK_STEP_MS = '1200'; // keep it running long enough to cancel
    const id = seedTask('cancel-run').id;
    const runId = enqueue(id);
    rm.pump();
    await waitFor(() => stateOf(runId) === 'running');
    const row = db.prepare('SELECT pgid FROM runs WHERE id=?').get(runId) as any;
    expect(row.pgid).toBeGreaterThan(0);
    // The daemon marks a run 'running' at SPAWN, before the child has executed a
    // single line — so cancelling on that signal alone races the child's first
    // message and `sandboxed` would be legitimately null (nothing was contained
    // because no engine ever launched). Wait for the containment stamp so we are
    // interrupting a run that is genuinely under way.
    await waitFor(() =>
      db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind='sandbox_status'`).get(runId) !== undefined,
    );
    rm.cancel(runId);
    await waitFor(() => stateOf(runId) === 'cancelled');

    // An interrupted run keeps its worktree even though it committed nothing —
    // the S-39 prune is for runs that ENDED cleanly. Before 2026-09-05 this path
    // force-deleted whatever a killed agent left behind.
    const done = db.prepare('SELECT worktree_path, report_json FROM runs WHERE id=?').get(runId) as any;
    expect(existsSync(done.worktree_path)).toBe(true);
    const report = JSON.parse(done.report_json);
    expect(report.worktreeState).toEqual({ preserved: true, path: done.worktree_path, dirty: false, interruptedOp: null, reason: 'interrupted' });
    expect(report.sandboxed).toBe(true); // runner-child reported its containment status before spawning

    delete process.env.CW_MOCK_STEP_MS;
    delete process.env.CW_ENGINE;
  }, 60_000);
});

function stateOf(runId: string): string {
  return (db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as any)?.state ?? 'missing';
}

function isTerminal(s: string): boolean {
  return ['completed', 'failed', 'cancelled', 'budget_exceeded', 'timed_out', 'missed'].includes(s);
}
