/**
 * F1 plan-then-execute (plan/AGENT-WORKFORCE-SPEC.md §F1).
 *
 * The feature is a GATE, so most of what matters here is what it refuses to
 * do: never execute without a human verdict, never re-enable the execute half,
 * never open an approval for a plan that was never written, never act twice on
 * one decision.
 *
 * The one thing it does NOT refuse is retrying a booking that was refused
 * AFTER the verdict committed — one verdict, one run, but more than one
 * attempt at it. That recovery has its own suite: plan-execute-retry.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { DateTime } from 'luxon';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { TaskRepo, type TaskRow } from '../src/repo.js';
import { PlanExecute, planPromptFor, executePromptFor } from '../src/plan-execute.js';
import { TaskCreate, newId } from '@clockwork/shared';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

/** 2026-03-02T18:20:00Z — a Monday afternoon in New York, well clear of a DST edge. */
const NOW = Date.UTC(2026, 2, 2, 18, 20, 0);

let db: DB;
let tasks: TaskRepo;
let planExecute: PlanExecute;
let booked: Array<{ taskId: string; prompt: string }>;
/** what the injected bookRun returns; null models a refused booking (policy, paused). */
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

function makeTask(over: Partial<{ name: string; prompt: string; permissionMode: string }> = {}): TaskRow {
  const input = TaskCreate.parse({
    name: over.name ?? 'Nightly dependency sweep',
    prompt: over.prompt ?? 'Upgrade the outdated dependencies and open a PR.',
    permissionMode: over.permissionMode ?? 'acceptEdits',
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

const taskRow = (id: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown>;

const approvalRows = (): Array<Record<string, unknown>> =>
  db.prepare('SELECT * FROM approvals').all() as Array<Record<string, unknown>>;

/** A plan report the human would approve. */
const PLAN_REPORT = { summary: 'Step 1: bump lodash. Step 2: run the suite.', artifacts: ['plan.md'] };

// ---------------------------------------------------------------------------
describe('createPair — one booking becomes two tasks, one of them disabled', () => {
  it('leaves the execute half DISABLED: enabled=0 is the gate, not chain_after', () => {
    const source = makeTask();
    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    expect('error' in pair).toBe(false);
    if ('error' in pair) return;

    const plan = taskRow(pair.planTaskId);
    const execute = taskRow(pair.executeTaskId);
    expect(plan.enabled).toBe(1);
    expect(plan.plan_stage).toBe('plan');
    expect(plan.permission_mode).toBe('plan');
    expect(execute.enabled).toBe(0);
    expect(execute.plan_stage).toBe('execute');
    expect(pair.status).toBe('awaiting_plan');
  });

  it('keeps the execute half invisible to the scheduler: its schedule is a disabled queue row', () => {
    const source = makeTask();
    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    if ('error' in pair) throw new Error(pair.error);

    const sched = tasks.scheduleFor(pair.executeTaskId)!;
    expect(sched.kind).toBe('queue');
    expect(sched.enabled).toBe(0);
    expect(sched.next_fire).toBeNull();
  });

  it('schedules the plan half once, at the requested human hour in the requested zone', () => {
    const source = makeTask();
    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'America/New_York' }, NOW);
    if ('error' in pair) throw new Error(pair.error);

    const sched = tasks.scheduleFor(pair.planTaskId)!;
    expect(sched.kind).toBe('once');
    expect(sched.enabled).toBe(1);
    expect(sched.run_at).toBeGreaterThan(NOW);
    expect(sched.next_fire).toBe(sched.run_at);
    expect(DateTime.fromMillis(sched.run_at!, { zone: 'America/New_York' }).hour).toBe(9);
  });

  it('does not clone chain_after from the source: the plan half must not fire as some third task’s successor', () => {
    const upstream = makeTask({ name: 'Upstream' });
    const source = makeTask();
    db.prepare('UPDATE tasks SET chain_after=? WHERE id=?').run(upstream.id, source.id);

    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    if ('error' in pair) throw new Error(pair.error);
    expect(taskRow(pair.planTaskId).chain_after).toBeNull();
    // the execute half points at the plan half for provenance only
    expect(taskRow(pair.executeTaskId).chain_after).toBe(pair.planTaskId);
  });

  it('refuses an unknown task instead of creating half a pair', () => {
    const res = planExecute.createPair({ taskId: 'nope', planHour: 9, tz: 'UTC' }, NOW);
    expect(res).toEqual({ error: "unknown task 'nope'" });
    expect(db.prepare('SELECT COUNT(*) c FROM plan_execute_pairs').get()).toEqual({ c: 0 });
  });

  it('refuses an unknown time zone rather than silently planning in UTC', () => {
    const source = makeTask();
    const res = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'Mars/Olympus' }, NOW);
    expect(res).toEqual({ error: "unknown time zone 'Mars/Olympus'" });
    expect(db.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 1 });
  });

  it('refuses a prompt too long to survive wrapping, and writes no task at all', () => {
    const source = makeTask({ prompt: 'x'.repeat(31_990) });
    const res = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    expect('error' in res).toBe(true);
    if (!('error' in res)) return;
    expect(res.error).toContain('prompt');
    expect(db.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 1 }); // only the source
    expect(db.prepare('SELECT COUNT(*) c FROM plan_execute_pairs').get()).toEqual({ c: 0 });
  });
});

// ---------------------------------------------------------------------------
describe('prompt wrappers', () => {
  it('emits {{previous.report}} in the execute half so renderChainPrompt can bind the plan', () => {
    expect(executePromptFor('do the thing')).toContain('{{previous.report}}');
    expect(executePromptFor('do the thing')).toContain('do the thing');
  });

  it('tells the plan half to change nothing', () => {
    const p = planPromptFor('do the thing');
    expect(p).toMatch(/change no file/i);
    expect(p).not.toContain('{{previous.report}}');
  });
});

// ---------------------------------------------------------------------------
describe('onPlanRunFinalized — the plan becomes an inbox item, or nothing', () => {
  it('opens exactly one approval carrying the pair id and the plan a human will read', () => {
    const source = makeTask();
    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    if ('error' in pair) throw new Error(pair.error);
    const runId = insertRun(pair.planTaskId, 'completed', PLAN_REPORT);

    const opened = planExecute.onPlanRunFinalized(runId, pair.planTaskId, 'completed', NOW + 1000);
    expect(opened).not.toBeNull();

    const rows = approvalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(opened!.approvalId);
    expect(rows[0]!.run_id).toBe(runId);
    expect(rows[0]!.kind).toBe('question');
    expect(rows[0]!.fallback).toBe('deny-and-continue');
    expect(rows[0]!.responded_at).toBeNull();
    const payload = JSON.parse(String(rows[0]!.payload_json));
    expect(payload.pairId).toBe(pair.id);
    expect(payload.plan).toContain('Step 1: bump lodash');
    expect(payload.plan).toContain('plan.md');

    const after = planExecute.get(pair.id)!;
    expect(after.status).toBe('awaiting_approval');
    expect(after.planRunId).toBe(runId);
    expect(after.decidedAt).toBeNull();
  });

  it('rejects the pair and opens NO approval when the plan run did not complete', () => {
    const source = makeTask();
    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    if ('error' in pair) throw new Error(pair.error);
    const runId = insertRun(pair.planTaskId, 'failed', null);

    expect(planExecute.onPlanRunFinalized(runId, pair.planTaskId, 'failed', NOW + 1000)).toBeNull();

    const after = planExecute.get(pair.id)!;
    expect(after.status).toBe('rejected');
    expect(after.planRunId).toBe(runId);
    expect(after.decidedAt).toBe(NOW + 1000);
    expect(approvalRows()).toHaveLength(0);
    expect(booked).toHaveLength(0);
  });

  it('ignores a run that belongs to no waiting pair', () => {
    const stranger = makeTask({ name: 'Unrelated' });
    const runId = insertRun(stranger.id, 'completed', PLAN_REPORT);
    expect(planExecute.onPlanRunFinalized(runId, stranger.id, 'completed', NOW + 1000)).toBeNull();
    expect(approvalRows()).toHaveLength(0);
  });

  it('opens one approval even if finalize is delivered twice for the same plan run', () => {
    const source = makeTask();
    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    if ('error' in pair) throw new Error(pair.error);
    const runId = insertRun(pair.planTaskId, 'completed', PLAN_REPORT);

    expect(planExecute.onPlanRunFinalized(runId, pair.planTaskId, 'completed', NOW + 1000)).not.toBeNull();
    expect(planExecute.onPlanRunFinalized(runId, pair.planTaskId, 'completed', NOW + 2000)).toBeNull();
    expect(approvalRows()).toHaveLength(1);
  });

  it('still opens an approval when the plan run left no report, saying so plainly', () => {
    const source = makeTask();
    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    if ('error' in pair) throw new Error(pair.error);
    const runId = insertRun(pair.planTaskId, 'completed', null);

    const opened = planExecute.onPlanRunFinalized(runId, pair.planTaskId, 'completed', NOW + 1000);
    expect(opened).not.toBeNull();
    const payload = JSON.parse(String(approvalRows()[0]!.payload_json));
    expect(payload.plan).toBe('(the plan run produced no report)');
  });
});

// ---------------------------------------------------------------------------
describe('resolve — the human verdict, and everything it refuses', () => {
  /** source task -> pair -> completed plan run -> approval open. */
  function pairAtTheGate(): { pairId: string; planRunId: string; executeTaskId: string; planTaskId: string; approvalId: string } {
    const source = makeTask();
    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    if ('error' in pair) throw new Error(pair.error);
    const planRunId = insertRun(pair.planTaskId, 'completed', PLAN_REPORT);
    const opened = planExecute.onPlanRunFinalized(planRunId, pair.planTaskId, 'completed', NOW + 1000)!;
    return {
      pairId: pair.id,
      planRunId,
      executeTaskId: pair.executeTaskId,
      planTaskId: pair.planTaskId,
      approvalId: opened.approvalId,
    };
  }

  it('books the execute run with the plan bound in — no unrendered placeholder reaches the agent', () => {
    const { pairId, executeTaskId } = pairAtTheGate();

    const res = planExecute.resolve(pairId, 'approved', NOW + 2000);
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') return;
    expect(res.status).toBe('executed');
    expect(res.executeRunId).toBe('RUN_EXECUTE');
    expect(res.decidedAt).toBe(NOW + 2000);

    expect(booked).toHaveLength(1);
    expect(booked[0]!.taskId).toBe(executeTaskId);
    expect(booked[0]!.prompt).toContain('Step 1: bump lodash');
    expect(booked[0]!.prompt).not.toContain('{{previous.report}}');
  });

  it('NEVER re-enables the execute task: after approval it is still disabled and still not a live chain successor', () => {
    const { pairId, executeTaskId, planTaskId } = pairAtTheGate();
    planExecute.resolve(pairId, 'approved', NOW + 2000);

    expect(taskRow(executeTaskId).enabled).toBe(0);
    // the exact query run-manager.ts:603 uses to fire chained successors
    const wouldFire = db
      .prepare('SELECT id FROM tasks WHERE chain_after = ? AND deleted_at IS NULL AND enabled = 1')
      .all(planTaskId);
    expect(wouldFire).toHaveLength(0);
  });

  it('closes the inbox item so the same decision cannot be made twice from two surfaces', () => {
    const { pairId, approvalId } = pairAtTheGate();
    planExecute.resolve(pairId, 'approved', NOW + 2000);

    const approval = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as Record<string, unknown>;
    expect(approval.responded_at).toBe(NOW + 2000);
    expect(JSON.parse(String(approval.response_json)).decision).toBe('approved');
  });

  it('still records the verdict when the inbox closed the approval first — the pair row is the gate', () => {
    const { pairId, approvalId } = pairAtTheGate();
    // POST /approvals/:id/respond got there first (§2.4)
    db.prepare('UPDATE approvals SET responded_at=?, response_json=? WHERE id=?').run(
      NOW + 1500,
      JSON.stringify({ decision: 'approved' }),
      approvalId,
    );

    const res = planExecute.resolve(pairId, 'approved', NOW + 2000);
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') return;
    expect(res.status).toBe('executed');
    // the earlier CAS stands; this one was a no-op
    expect((db.prepare('SELECT responded_at r FROM approvals WHERE id=?').get(approvalId) as { r: number }).r).toBe(NOW + 1500);
  });

  it('rejecting books nothing and closes the pair', () => {
    const { pairId, approvalId } = pairAtTheGate();
    const res = planExecute.resolve(pairId, 'rejected', NOW + 2000);
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') return;
    expect(res.status).toBe('rejected');
    expect(res.executeRunId).toBeNull();
    expect(booked).toHaveLength(0);
    expect((db.prepare('SELECT responded_at r FROM approvals WHERE id=?').get(approvalId) as { r: number }).r).toBe(NOW + 2000);
  });

  it('refuses to resolve a pair whose plan run has not finished — no plan, no approval to give', () => {
    const source = makeTask();
    const pair = planExecute.createPair({ taskId: source.id, planHour: 9, tz: 'UTC' }, NOW);
    if ('error' in pair) throw new Error(pair.error);

    expect(planExecute.resolve(pair.id, 'approved', NOW + 2000)).toBe('already_resolved');
    expect(booked).toHaveLength(0);
    expect(planExecute.get(pair.id)!.status).toBe('awaiting_plan');
    expect(planExecute.get(pair.id)!.decidedAt).toBeNull();
  });

  it('is decide-once: the second verdict books nothing and reports already_resolved', () => {
    const { pairId } = pairAtTheGate();
    expect(typeof planExecute.resolve(pairId, 'approved', NOW + 2000)).not.toBe('string');
    expect(planExecute.resolve(pairId, 'approved', NOW + 3000)).toBe('already_resolved');
    expect(planExecute.resolve(pairId, 'rejected', NOW + 4000)).toBe('already_resolved');
    expect(booked).toHaveLength(1);
    expect(planExecute.get(pairId)!.status).toBe('executed');
  });

  it('cannot be re-run after a rejection to sneak the work through', () => {
    const { pairId } = pairAtTheGate();
    planExecute.resolve(pairId, 'rejected', NOW + 2000);
    expect(planExecute.resolve(pairId, 'approved', NOW + 3000)).toBe('already_resolved');
    expect(booked).toHaveLength(0);
  });

  it('reports not_found for an unknown pair', () => {
    expect(planExecute.resolve('nope', 'approved', NOW + 2000)).toBe('not_found');
    expect(planExecute.get('nope')).toBeUndefined();
  });

  // T1-11 CHANGED THE SECOND HALF OF THIS TEST, and the first half is why.
  // It used to assert that the strand was permanent — 'already_resolved', and
  // `booked` still at 1. That was the defect being recorded as the contract:
  // the verdict commits before the booking, so a refusal left the pair at
  // 'approved' with no run and nothing on any surface could re-book it. A
  // second 'approved' on THAT shape is now read as a retry of the BOOKING
  // rather than as a second verdict (plan-execute.ts strandedPair/bookExecute).
  // Decide-once is untouched and still asserted by the two tests above; every
  // shape the retry must refuse is asserted in plan-execute-retry.test.ts.
  it('a refused booking leaves the pair approved-but-unexecuted, and a second approve retries the booking', () => {
    const { pairId } = pairAtTheGate();
    bookResult = null; // policy violation / paused daemon

    const res = planExecute.resolve(pairId, 'approved', NOW + 2000);
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') return;
    expect(res.status).toBe('approved');
    expect(res.executeRunId).toBeNull();
    expect(booked).toHaveLength(1);

    bookResult = 'RUN_LATE';
    const retried = planExecute.resolve(pairId, 'approved', NOW + 3000);
    expect(typeof retried).not.toBe('string');
    if (typeof retried === 'string') return;
    expect(retried.status).toBe('executed');
    expect(retried.executeRunId).toBe('RUN_LATE');
    expect(retried.decidedAt).toBe(NOW + 2000); // the verdict is not re-taken
    expect(booked).toHaveLength(2);
  });

  // S-review: `bookRun` is called AFTER the verdict CAS has committed, and it
  // was the only one of the three workforce bookers with no try/catch (F8 has
  // one at self-healing.ts:170-176). A throw out of `enqueueRunNow` therefore
  // escaped the route as a 500 with the verdict already recorded. A thrown
  // refusal now lands exactly where a returned one does.
  it('survives a booker that throws, landing where a refused booking lands', () => {
    const { pairId } = pairAtTheGate();
    const throwing = new PlanExecute({
      db,
      bookRun: () => {
        throw new Error('enqueueRunNow exploded');
      },
    });

    const runsBefore = db.prepare('SELECT COUNT(*) c FROM runs').get();
    const res = throwing.resolve(pairId, 'approved', NOW + 2000);
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') return;
    expect(res.status).toBe('approved');
    expect(res.executeRunId).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM runs').get()).toEqual(runsBefore);
  });

  it('does not book when the execute task was deleted between plan and verdict', () => {
    const { pairId, executeTaskId } = pairAtTheGate();
    tasks.softDelete(executeTaskId);

    const res = planExecute.resolve(pairId, 'approved', NOW + 2000);
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') return;
    expect(res.status).toBe('approved');
    expect(booked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('list', () => {
  it('filters by status so the inbox can ask only for pairs at the gate', () => {
    const a = planExecute.createPair({ taskId: makeTask({ name: 'A' }).id, planHour: 9, tz: 'UTC' }, NOW);
    const b = planExecute.createPair({ taskId: makeTask({ name: 'B' }).id, planHour: 9, tz: 'UTC' }, NOW + 10);
    if ('error' in a || 'error' in b) throw new Error('setup failed');
    const runId = insertRun(b.planTaskId, 'completed', PLAN_REPORT);
    planExecute.onPlanRunFinalized(runId, b.planTaskId, 'completed', NOW + 1000);

    expect(planExecute.list()).toHaveLength(2);
    expect(planExecute.list('awaiting_approval').map((p) => p.id)).toEqual([b.id]);
    expect(planExecute.list('awaiting_plan').map((p) => p.id)).toEqual([a.id]);
    expect(planExecute.list('executed')).toHaveLength(0);
  });
});
