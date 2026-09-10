/**
 * F1 recovery: a plan→execute pair stranded by a refused booking (T1-11).
 *
 * THE BUG THESE TESTS EXIST FOR. Approving a plan commits the verdict FIRST
 * and books the execute run SECOND (plan-execute.ts `resolve`). When the
 * booking is refused — the policy engine rejects the execute half, the execute
 * task was deleted between the plan run and the decision, or the booker throws
 * — the pair stops at status 'approved' with no execute run. Every later
 * resolve answered 'already_resolved', so nothing on any surface re-booked it.
 * The refusal is audited as `plan_execute.book_rejected`, but `GET /audit` is a
 * 402 route with no screen, so in practice the pair simply disappeared: a
 * decision the human made, and work that never happened.
 *
 * WHAT THE RECOVERY IS. A second 'approved' on exactly that shape — status
 * 'approved', `execute_run_id` NULL, `decided_at` set — re-runs the booker
 * through the same `bookExecute` the first attempt used, so the approved plan
 * is bound into the prompt the same way. It is a retry of the BOOKING, never a
 * second verdict: `decided_at` does not move and the inbox item stays closed.
 *
 * WHAT IT MUST NOT BECOME. A way to book an execute run for a pair no human
 * approved. Half of this file is that refusal, shape by shape — F1 is one of
 * three `enforced` workforce features and this path must not widen it.
 *
 * Why a sibling file rather than more cases in plan-execute.test.ts:
 * claims-honesty.test.ts counts `it(` across the twelve F1–F12 feature suites
 * and pins the total against a hand-written row in plan/STATUS.md. Growing
 * plan-execute.test.ts turns that tripwire red, and plan/STATUS.md says its own
 * counts must be re-measured from a real run rather than carried forward by
 * hand. This file keeps both true.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { TaskRepo, type TaskRow } from '../src/repo.js';
import { PlanExecute } from '../src/plan-execute.js';
import { TaskCreate, newId } from '@clockwork/shared';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

/** Same instant plan-execute.test.ts uses: a Monday afternoon, clear of DST. */
const NOW = Date.UTC(2026, 2, 2, 18, 20, 0);
const DECIDED_AT = NOW + 2000;
const RETRIED_AT = NOW + 3000;

let db: DB;
let tasks: TaskRepo;
let planExecute: PlanExecute;
let booked: Array<{ taskId: string; prompt: string }>;
/** what the injected bookRun returns; null models a refused booking (policy). */
let bookResult: string | null;

beforeEach(() => {
  db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
  createMigrator(db, MIGRATIONS).migrate();
  tasks = new TaskRepo(db);
  booked = [];
  bookResult = 'RUN_EXECUTE';
  planExecute = new PlanExecute({
    db,
    bookRun: (taskId, prompt) => {
      booked.push({ taskId, prompt });
      return bookResult;
    },
  });
});

afterEach(() => db.close());

function makeTask(over: Partial<{ name: string; prompt: string }> = {}): TaskRow {
  const input = TaskCreate.parse({
    name: over.name ?? 'Nightly dependency sweep',
    prompt: over.prompt ?? 'Upgrade the outdated dependencies and open a PR.',
    permissionMode: 'acceptEdits',
    schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', tz: 'UTC' },
  });
  return tasks.create(input, null, NOW + 3_600_000);
}

function insertRun(taskId: string, state: string, report: unknown | null, runId = newId()): string {
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, ended_at, report_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, taskId, JSON.stringify({ taskId }), state, NOW, NOW, NOW, report === null ? null : JSON.stringify(report));
  return runId;
}

const pairRow = (id: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM plan_execute_pairs WHERE id=?').get(id) as Record<string, unknown>;

const taskRow = (id: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown>;

/** The plan the human read and approved. */
const PLAN_REPORT = { summary: 'Step 1: bump lodash. Step 2: run the suite.', artifacts: ['plan.md'] };

interface Pair {
  pairId: string;
  planTaskId: string;
  executeTaskId: string;
  planRunId: string;
  approvalId: string;
}

/** source task -> pair -> completed plan run -> approval open, awaiting a verdict. */
function pairAtTheGate(name = 'Nightly dependency sweep'): Pair {
  const source = makeTask({ name });
  const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
  if ('error' in pair) throw new Error(pair.error);
  const planRunId = insertRun(pair.planTaskId, 'completed', PLAN_REPORT);
  const opened = planExecute.onPlanRunFinalized(planRunId, pair.planTaskId, 'completed', NOW + 1000)!;
  return {
    pairId: pair.id,
    planTaskId: pair.planTaskId,
    executeTaskId: pair.executeTaskId,
    planRunId,
    approvalId: opened.approvalId,
  };
}

/**
 * A pair the human approved and the policy engine then refused to book: the
 * exact state api.ts:452 leaves behind after `plan_execute.book_rejected`.
 */
function strandedPair(name?: string): Pair {
  const p = pairAtTheGate(name);
  bookResult = null;
  const res = planExecute.resolve(p.pairId, 'approved', DECIDED_AT);
  if (typeof res === 'string') throw new Error(`setup: resolve answered ${res}`);
  if (res.status !== 'approved' || res.executeRunId !== null) throw new Error('setup: the pair is not stranded');
  return p;
}

// ---------------------------------------------------------------------------
describe('the stranded pair is recoverable', () => {
  it('a policy-refused booking leaves the pair at approved with no run — the shape the retry looks for', () => {
    const { pairId } = strandedPair();

    const row = pairRow(pairId);
    expect(row.status).toBe('approved');
    expect(row.execute_run_id).toBeNull();
    expect(row.decided_at).toBe(DECIDED_AT);
    expect(booked).toHaveLength(1); // one attempt, and it was refused
  });

  it('retrying that pair books the execute run and moves it to executed', () => {
    const { pairId, executeTaskId } = strandedPair();
    bookResult = 'RUN_RETRIED'; // the policy rule was fixed

    const res = planExecute.resolve(pairId, 'approved', RETRIED_AT);
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') return;
    expect(res.status).toBe('executed');
    expect(res.executeRunId).toBe('RUN_RETRIED');
    expect(booked).toHaveLength(2);
    expect(booked[1]!.taskId).toBe(executeTaskId);
  });

  it('carries the approved plan into the retried prompt, byte for byte what the first attempt sent', () => {
    const { pairId } = strandedPair();
    bookResult = 'RUN_RETRIED';

    planExecute.resolve(pairId, 'approved', RETRIED_AT);
    expect(booked).toHaveLength(2);
    const retried = booked[1]!.prompt;

    // The plan itself, not a placeholder and not an empty binding. This is the
    // whole point of the retry: `POST /tasks/:id/run-now` on the execute half
    // is allowed at this status and would send the STORED prompt, which still
    // holds the unrendered placeholder.
    expect(retried).toContain('Step 1: bump lodash');
    expect(retried).toContain('Artifacts: plan.md');
    expect(retried).not.toContain('{{previous.report}}');
    expect(retried).not.toContain('(no previous run output available)');
    // …and the surrounding contract the execute half was created with.
    expect(retried).toContain('A human has read and APPROVED the plan below');
    expect(retried).toContain('Upgrade the outdated dependencies and open a PR.');
    // Same renderer, same template, same plan run: the retry cannot drift.
    expect(retried).toBe(booked[0]!.prompt);
  });

  it('leaves the task row unrendered, so a later retry re-binds the plan rather than a stale copy', () => {
    const { pairId, executeTaskId } = strandedPair();
    bookResult = 'RUN_RETRIED';
    planExecute.resolve(pairId, 'approved', RETRIED_AT);

    // §3: the rendered prompt is passed to the booker, never written back.
    expect(String(taskRow(executeTaskId).prompt)).toContain('{{previous.report}}');
  });

  it('a retry that is refused again books nothing and leaves the pair retryable', () => {
    const { pairId } = strandedPair();
    // bookResult is still null: the policy rule has not been fixed.

    const res = planExecute.resolve(pairId, 'approved', RETRIED_AT);
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') return;
    expect(res.status).toBe('approved');
    expect(res.executeRunId).toBeNull();
    expect(booked).toHaveLength(2); // it really did try again
    expect(db.prepare('SELECT COUNT(*) c FROM runs WHERE task_id=?').get(res.executeTaskId)).toEqual({ c: 0 });

    // still recoverable — a refused retry is not a third state
    bookResult = 'RUN_THIRD_TIME';
    const later = planExecute.resolve(pairId, 'approved', RETRIED_AT + 1000);
    expect(typeof later).not.toBe('string');
    if (typeof later === 'string') return;
    expect(later.status).toBe('executed');
    expect(later.executeRunId).toBe('RUN_THIRD_TIME');
  });

  it('survives a booker that throws on the retry, landing where a refused retry lands', () => {
    const { pairId } = strandedPair();
    const throwing = new PlanExecute({
      db,
      bookRun: () => {
        throw new Error('enqueueRunNow exploded');
      },
    });

    const res = throwing.resolve(pairId, 'approved', RETRIED_AT);
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') return;
    expect(res.status).toBe('approved');
    expect(res.executeRunId).toBeNull();
    expect(pairRow(pairId).decided_at).toBe(DECIDED_AT);
  });

  it('books nothing while the execute half is deleted, and does not invent a run for it', () => {
    const { pairId, executeTaskId } = strandedPair();
    tasks.softDelete(executeTaskId);
    bookResult = 'RUN_SHOULD_NOT_HAPPEN';

    const res = planExecute.resolve(pairId, 'approved', RETRIED_AT);
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') return;
    expect(res.status).toBe('approved');
    expect(res.executeRunId).toBeNull();
    expect(booked).toHaveLength(1); // the booker was never reached
  });

  it('does not re-take the verdict: decided_at, the approval row and the inbox response all stand', () => {
    const { pairId, approvalId } = strandedPair();
    const before = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as Record<string, unknown>;
    bookResult = 'RUN_RETRIED';

    planExecute.resolve(pairId, 'approved', RETRIED_AT);

    const after = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as Record<string, unknown>;
    expect(after.responded_at).toBe(before.responded_at);
    expect(after.responded_at).toBe(DECIDED_AT);
    expect(after.response_json).toBe(before.response_json);
    expect(pairRow(pairId).decided_at).toBe(DECIDED_AT);
    expect(db.prepare('SELECT COUNT(*) c FROM approvals').get()).toEqual({ c: 1 });
  });

  it('never re-enables the execute half — the retry books it directly, exactly as the verdict did', () => {
    const { pairId, executeTaskId, planTaskId } = strandedPair();
    bookResult = 'RUN_RETRIED';
    planExecute.resolve(pairId, 'approved', RETRIED_AT);

    expect(taskRow(executeTaskId).enabled).toBe(0);
    // the exact query run-manager.ts uses to fire chained successors
    expect(
      db.prepare('SELECT id FROM tasks WHERE chain_after = ? AND deleted_at IS NULL AND enabled = 1').all(planTaskId),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The retry is not a way in. F1 is `enforced`: the execute half never runs
// without a human's explicit approval of THAT plan, and re-using the resolve
// route for the retry must not weaken that by one shape.
// ---------------------------------------------------------------------------
describe('the retry path refuses every pair a human never approved', () => {
  it('a pair whose plan run has not finished is still not bookable', () => {
    const source = makeTask();
    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    if ('error' in pair) throw new Error(pair.error);
    bookResult = 'RUN_SNEAK';

    expect(planExecute.resolve(pair.id, 'approved', RETRIED_AT)).toBe('already_resolved');
    expect(planExecute.resolve(pair.id, 'approved', RETRIED_AT + 1)).toBe('already_resolved');
    expect(booked).toHaveLength(0);
    expect(pairRow(pair.id).status).toBe('awaiting_plan');
    expect(pairRow(pair.id).decided_at).toBeNull();
  });

  it('a plan the human rejected is still not bookable', () => {
    const { pairId } = pairAtTheGate();
    planExecute.resolve(pairId, 'rejected', DECIDED_AT);
    bookResult = 'RUN_SNEAK';

    expect(planExecute.resolve(pairId, 'approved', RETRIED_AT)).toBe('already_resolved');
    expect(booked).toHaveLength(0);
    expect(pairRow(pairId).status).toBe('rejected');
    expect(pairRow(pairId).execute_run_id).toBeNull();
  });

  it('a pair rejected because its plan run failed is still not bookable — there is no plan to carry', () => {
    const source = makeTask();
    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    if ('error' in pair) throw new Error(pair.error);
    const runId = insertRun(pair.planTaskId, 'failed', null);
    planExecute.onPlanRunFinalized(runId, pair.planTaskId, 'failed', DECIDED_AT);
    bookResult = 'RUN_SNEAK';

    expect(pairRow(pair.id).status).toBe('rejected');
    expect(planExecute.resolve(pair.id, 'approved', RETRIED_AT)).toBe('already_resolved');
    expect(booked).toHaveLength(0);
  });

  it('an executed pair is not retryable: one approval books at most one run', () => {
    const { pairId } = pairAtTheGate();
    expect(typeof planExecute.resolve(pairId, 'approved', DECIDED_AT)).not.toBe('string');
    expect(booked).toHaveLength(1);
    bookResult = 'RUN_SECOND';

    expect(planExecute.resolve(pairId, 'approved', RETRIED_AT)).toBe('already_resolved');
    expect(booked).toHaveLength(1);
    expect(pairRow(pairId).execute_run_id).toBe('RUN_EXECUTE');
  });

  it('a rejection aimed at a stranded pair changes nothing: a recorded verdict never flips', () => {
    const { pairId } = strandedPair();
    bookResult = 'RUN_SNEAK';

    expect(planExecute.resolve(pairId, 'rejected', RETRIED_AT)).toBe('already_resolved');
    expect(booked).toHaveLength(1);
    expect(pairRow(pairId).status).toBe('approved');
    expect(pairRow(pairId).decided_at).toBe(DECIDED_AT);
  });

  it('an unknown pair is still not_found, not a booking', () => {
    bookResult = 'RUN_SNEAK';
    expect(planExecute.resolve('nope', 'approved', RETRIED_AT)).toBe('not_found');
    expect(booked).toHaveLength(0);
  });

  it('retries only the pair it was asked for, leaving another stranded pair stranded', () => {
    const first = strandedPair('Weekly changelog');
    const second = strandedPair('Nightly dependency sweep');
    bookResult = 'RUN_RETRIED';

    planExecute.resolve(second.pairId, 'approved', RETRIED_AT);

    expect(pairRow(second.pairId).status).toBe('executed');
    expect(pairRow(first.pairId).status).toBe('approved');
    expect(pairRow(first.pairId).execute_run_id).toBeNull();
    expect(booked.filter((b) => b.taskId === first.executeTaskId)).toHaveLength(1);
  });
});
