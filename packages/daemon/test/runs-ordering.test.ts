/**
 * T1-18. `/runs` is most-recently-HAPPENED, and it did not used to be.
 *
 * `RunRepo.list` ordered by `COALESCE(scheduled_for, state_changed_at) DESC`.
 * A queued run carries `scheduled_for` in the future, so a booking for next
 * week sorted above every run that had already finished. Printed under three
 * lines of history in the menu-bar tray it read "your last run was next
 * Tuesday" — which is where it was found.
 *
 * The COALESCE also defeated every index, because it is not sargable, so each
 * call sorted the whole table.
 *
 * AND THE DEFECT WAS WIDER THAN THE TRAY SYMPTOM. All four INSERT INTO runs
 * paths — `api.ts` enqueueRunNow, `run-manager.ts` chain-fire, `scheduler.ts`
 * insertRunRow, `main.ts`'s hazard placeholder — write a non-null
 * `scheduled_for`. So the COALESCE resolved to `scheduled_for` for every row
 * ever written, and `state_changed_at` was dead weight in the expression.
 * That means two FINISHED runs were ordered by when they were BOOKED, not by
 * when they finished — so a run-late or long-queued run appeared out of order
 * in plain history, with no future booking involved at all. The last test
 * below is the one that catches that half; the fixture in the first test
 * cannot, because there the two timestamps agree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { RunRepo } from '../src/repo.js';

const MIGRATIONS = path.resolve(import.meta.dirname, '../migrations');
const DAY = 86_400_000;
const NOW = 1_760_000_000_000;

let db: Database.Database;
let runs: RunRepo;

function migrate(d: Database.Database): void {
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    d.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
}

/** A row in whatever state, with the two timestamps set independently. */
function seed(id: string, state: string, changedAt: number, scheduledFor: number | null, endedAt: number | null = null): void {
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, ended_at)
     VALUES (?, 'task-1', '{}', ?, ?, ?, ?)`,
  ).run(id, state, changedAt, scheduledFor, endedAt);
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO tasks (id, name, prompt, engine, permission_mode, budget_usd, max_turns, timeout_sec, created_at, updated_at, version)
              VALUES ('task-1', 'Weekly dep triage', 'p', 'cli', 'plan', 1, 10, 600, ?, ?, 1)`).run(NOW, NOW);
  runs = new RunRepo(db as never);
});
afterEach(() => db.close());

describe('a future booking never outranks a run that already happened', () => {
  it('puts the finished run first, though the booking is scheduled later', () => {
    seed('r-finished', 'completed', NOW - DAY, NOW - DAY, NOW - DAY);
    seed('r-booked', 'queued', NOW, NOW + 7 * DAY); // next week
    const list = runs.list({ limit: 50 });
    expect(list.map((r) => r.id)).toEqual(['r-booked', 'r-finished']);
    // The booking is present and near the top because BEING QUEUED is the most
    // recent thing that happened to it — not because it is scheduled furthest
    // ahead. That distinction is the fix: with the old COALESCE, a booking a
    // year out would have outranked one queued a second ago.
    seed('r-far', 'queued', NOW - 2 * DAY, NOW + 365 * DAY);
    expect(runs.list({ limit: 50 }).map((r) => r.id)).toEqual(['r-booked', 'r-finished', 'r-far']);
  });

  it('orders three finished runs by when they finished', () => {
    seed('r-old', 'completed', NOW - 3 * DAY, NOW - 3 * DAY, NOW - 3 * DAY);
    seed('r-mid', 'completed', NOW - 2 * DAY, NOW - 2 * DAY, NOW - 2 * DAY);
    seed('r-new', 'completed', NOW - DAY, NOW - DAY, NOW - DAY);
    expect(runs.list({ limit: 50 }).map((r) => r.id)).toEqual(['r-new', 'r-mid', 'r-old']);
  });

  it('orders two finished runs by when they FINISHED, not by when they were booked', () => {
    // The half the tray symptom hid. Booked in one order, finished in the
    // other: r-late was booked first but ran late, so it finished last.
    // Under the old COALESCE this returned ['r-early', 'r-late'] — plain
    // history in the wrong order, no future booking anywhere in the fixture.
    seed('r-late', 'completed', NOW - 1 * DAY, NOW - 9 * DAY, NOW - 1 * DAY);
    seed('r-early', 'completed', NOW - 5 * DAY, NOW - 8 * DAY, NOW - 5 * DAY);
    expect(runs.list({ limit: 50 }).map((r) => r.id)).toEqual(['r-late', 'r-early']);
  });

  it('holds the same order when the list is filtered to one task', () => {
    seed('r-finished', 'completed', NOW - DAY, NOW - DAY, NOW - DAY);
    seed('r-booked', 'queued', NOW, NOW + 7 * DAY);
    expect(runs.list({ taskId: 'task-1', limit: 50 }).map((r) => r.id)).toEqual(['r-booked', 'r-finished']);
  });

  it('never sorts on a column that can point into the future', () => {
    // A source assertion, because the behavioural tests above would also pass
    // on an ordering that happened to agree on this fixture.
    const src = readFileSync(path.resolve(import.meta.dirname, '../src/repo.ts'), 'utf8');
    const stmt = src.slice(src.indexOf('SELECT * FROM runs'), src.indexOf('SELECT * FROM runs') + 120);
    expect(stmt, 'the ORDER BY is back on scheduled_for, which a queued run sets in the future').not.toMatch(
      /ORDER BY[^`]*scheduled_for/,
    );
    expect(stmt).toMatch(/ORDER BY state_changed_at DESC/);
  });
});

describe('the ordering can use an index', () => {
  it('does not scan and sort the whole table for the unfiltered list', () => {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM runs ORDER BY state_changed_at DESC LIMIT ?').all(50) as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail, `no index used: ${detail}`).toMatch(/idx_runs_time/);
    expect(detail, `still sorting in memory: ${detail}`).not.toMatch(/USE TEMP B-TREE/);
  });

  it('uses the composite index when filtered to one task', () => {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM runs WHERE task_id=? ORDER BY state_changed_at DESC LIMIT ?').all('task-1', 50) as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail, `no composite index used: ${detail}`).toMatch(/idx_runs_task_changed/);
    expect(detail, `still sorting in memory: ${detail}`).not.toMatch(/USE TEMP B-TREE/);
  });
});
