/**
 * F11 performance-reviews (plan/AGENT-WORKFORCE-SPEC.md, §F11).
 *
 * Defends: acceptanceRate/failureRate report `null` rather than `0` when
 * their denominator is empty ("nobody looked yet" must never read as "0%
 * accepted"); the grouping key falls back to the frozen jobspec profile id
 * for runs that predate (or never got) a `run_outcomes` row, exactly like
 * F10; the Unassigned bucket and a deleted-profile id both stay addressable
 * without colliding into each other; the window is a correct
 * `[fromMs, toMs)` half-open interval on `COALESCE(ended_at, scheduled_for)`;
 * `costTrendUsd` is `null` only when the PREVIOUS window has no runs, and is
 * otherwise the signed difference in mean cost/run; `scorecards()` only
 * returns groups that actually ran in the window, sorted by cost descending;
 * and `reviewPromptFor` states every number in the card without inventing
 * new ones and phrases the null cases as "not enough data" rather than as a
 * failing grade.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { scorecard, scorecards, reviewPromptFor } from '../src/performance.js';
import { PerformanceScorecard } from '@clockwork/shared';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

function freshDb(): DB {
  const db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
  createMigrator(db, MIGRATIONS).migrate();
  return db;
}

function insertTask(db: DB, id: string, now: number): void {
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    `task-${id}`,
    'do the thing',
    now,
    now,
  );
}

function insertProfile(db: DB, id: string, slug: string, name: string, now: number): void {
  db.prepare(`INSERT INTO profiles (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    slug,
    name,
    now,
    now,
  );
}

interface RunFixture {
  id: string;
  taskId: string;
  state: string;
  costUsd: number;
  endedAt: number | null;
  scheduledFor: number | null;
  jobspecProfileId: string | null;
}

function insertRun(db: DB, f: RunFixture): void {
  const jobspec = JSON.stringify({
    taskId: f.taskId,
    profile: f.jobspecProfileId ? { id: f.jobspecProfileId, slug: 'p', name: 'P' } : null,
  });
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, cost_usd, ended_at, scheduled_for)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(f.id, f.taskId, jobspec, f.state, f.endedAt ?? f.scheduledFor ?? 0, f.costUsd, f.endedAt, f.scheduledFor);
}

function insertOutcome(db: DB, runId: string, taskId: string, profileId: string | null, decision: string, at: number): void {
  db.prepare(
    `INSERT INTO run_outcomes (run_id, task_id, profile_id, decision, actor, decided_at) VALUES (?, ?, ?, ?, 'local', ?)`,
  ).run(runId, taskId, profileId, decision, at);
}

const DAY = 86_400_000;

describe('scorecard — acceptanceRate and failureRate null handling', () => {
  let db: DB;

  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', 1_000);
    insertProfile(db, 'p1', 'reviewer', 'Reviewer Bot', 1_000);
  });

  it('reports acceptanceRate=null (not 0) when nothing in the window was decided', () => {
    insertRun(db, { id: 'r1', taskId: 't1', state: 'completed', costUsd: 1, endedAt: 5_000, scheduledFor: null, jobspecProfileId: 'p1' });
    const card = scorecard(db, 'p1', { fromMs: 0, toMs: 10_000 });
    expect(card.decided).toBe(0);
    expect(card.acceptanceRate).toBeNull();
    expect(card.runs).toBe(1);
  });

  it('reports failureRate=null (not 0) when there are no runs at all in the window', () => {
    const card = scorecard(db, 'p1', { fromMs: 0, toMs: 10_000 });
    expect(card.runs).toBe(0);
    expect(card.failureRate).toBeNull();
    expect(card.acceptanceRate).toBeNull();
    expect(card.costUsd).toBe(0);
    // SQLite SUM() over zero matching rows is NULL, not 0 — decided/accepted/
    // failedCount must be coalesced to 0 in SQL, or the schema (all fields
    // non-negative numbers, never null except the *Rate/*Trend fields) fails.
    expect(card.decided).toBe(0);
    expect(PerformanceScorecard.safeParse(card).success).toBe(true);
  });

  it('acceptanceRate counts accepted_with_note as an acceptance, matching F6/F10 convention', () => {
    insertRun(db, { id: 'r1', taskId: 't1', state: 'completed', costUsd: 1, endedAt: 5_000, scheduledFor: null, jobspecProfileId: 'p1' });
    insertRun(db, { id: 'r2', taskId: 't1', state: 'completed', costUsd: 1, endedAt: 6_000, scheduledFor: null, jobspecProfileId: 'p1' });
    insertOutcome(db, 'r1', 't1', 'p1', 'accepted', 5_500);
    insertOutcome(db, 'r2', 't1', 'p1', 'accepted_with_note', 6_500);
    const card = scorecard(db, 'p1', { fromMs: 0, toMs: 10_000 });
    expect(card.decided).toBe(2);
    expect(card.acceptanceRate).toBe(1);
    expect(PerformanceScorecard.safeParse(card).success).toBe(true);
  });

  it('failureRate counts failed and timed_out but not cancelled or budget_exceeded', () => {
    insertRun(db, { id: 'r1', taskId: 't1', state: 'failed', costUsd: 0, endedAt: 1_000, scheduledFor: null, jobspecProfileId: 'p1' });
    insertRun(db, { id: 'r2', taskId: 't1', state: 'timed_out', costUsd: 0, endedAt: 2_000, scheduledFor: null, jobspecProfileId: 'p1' });
    insertRun(db, { id: 'r3', taskId: 't1', state: 'cancelled', costUsd: 0, endedAt: 3_000, scheduledFor: null, jobspecProfileId: 'p1' });
    insertRun(db, { id: 'r4', taskId: 't1', state: 'budget_exceeded', costUsd: 0, endedAt: 4_000, scheduledFor: null, jobspecProfileId: 'p1' });
    insertRun(db, { id: 'r5', taskId: 't1', state: 'completed', costUsd: 0, endedAt: 5_000, scheduledFor: null, jobspecProfileId: 'p1' });
    const card = scorecard(db, 'p1', { fromMs: 0, toMs: 10_000 });
    expect(card.runs).toBe(5);
    expect(card.failureRate).toBe(2 / 5);
  });
});

describe('scorecard — grouping key matches F10 (profile_id snapshot, falling back to jobspec)', () => {
  let db: DB;

  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', 1_000);
    insertProfile(db, 'p1', 'builder', 'Builder Bot', 1_000);
  });

  it('groups a historical run with no run_outcomes row by the frozen jobspec profile id', () => {
    insertRun(db, { id: 'r1', taskId: 't1', state: 'completed', costUsd: 3, endedAt: 5_000, scheduledFor: null, jobspecProfileId: 'p1' });
    // no run_outcomes row at all — this run predates F6, or was never decided
    const card = scorecard(db, 'p1', { fromMs: 0, toMs: 10_000 });
    expect(card.runs).toBe(1);
    expect(card.costUsd).toBe(3);
  });

  it('prefers the run_outcomes.profile_id snapshot over the jobspec when they disagree', () => {
    // jobspec says p1, but the acceptance snapshot says p2 — profile_id wins.
    insertProfile(db, 'p2', 'other', 'Other Bot', 1_000);
    insertRun(db, { id: 'r1', taskId: 't1', state: 'completed', costUsd: 3, endedAt: 5_000, scheduledFor: null, jobspecProfileId: 'p1' });
    insertOutcome(db, 'r1', 't1', 'p2', 'accepted', 5_500);
    const cardP2 = scorecard(db, 'p2', { fromMs: 0, toMs: 10_000 });
    const cardP1 = scorecard(db, 'p1', { fromMs: 0, toMs: 10_000 });
    expect(cardP2.runs).toBe(1);
    expect(cardP1.runs).toBe(0);
  });

  it('groups a profile-less run under the Unassigned bucket, addressed by profileId=null', () => {
    insertRun(db, { id: 'r1', taskId: 't1', state: 'completed', costUsd: 2, endedAt: 5_000, scheduledFor: null, jobspecProfileId: null });
    const card = scorecard(db, null, { fromMs: 0, toMs: 10_000 });
    expect(card.runs).toBe(1);
    expect(card.profileName).toBe('Unassigned');
    expect(card.profileId).toBeNull();
  });

  it('falls back to the raw id (not "Unassigned") for a profile id that names no profiles row', () => {
    // profile_id snapshot references an id that was never created / has since
    // been deleted (run_outcomes.profile_id carries no FK, by design).
    insertRun(db, { id: 'r1', taskId: 't1', state: 'completed', costUsd: 1, endedAt: 5_000, scheduledFor: null, jobspecProfileId: 'ghost-profile' });
    const card = scorecard(db, 'ghost-profile', { fromMs: 0, toMs: 10_000 });
    expect(card.runs).toBe(1);
    expect(card.profileName).toBe('ghost-profile');
    expect(card.profileSlug).toBeNull();
  });
});

describe('scorecard — window is a half-open [fromMs, toMs) interval on COALESCE(ended_at, scheduled_for)', () => {
  let db: DB;

  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', 1_000);
  });

  it('includes a run exactly at fromMs and excludes one exactly at toMs', () => {
    insertRun(db, { id: 'r-at-from', taskId: 't1', state: 'completed', costUsd: 1, endedAt: 1_000, scheduledFor: null, jobspecProfileId: null });
    insertRun(db, { id: 'r-at-to', taskId: 't1', state: 'completed', costUsd: 1, endedAt: 2_000, scheduledFor: null, jobspecProfileId: null });
    const card = scorecard(db, null, { fromMs: 1_000, toMs: 2_000 });
    expect(card.runs).toBe(1);
  });

  it('falls back to scheduled_for when ended_at is null (a run that never started still contributes)', () => {
    insertRun(db, { id: 'r1', taskId: 't1', state: 'failed', costUsd: 0, endedAt: null, scheduledFor: 1_500, jobspecProfileId: null });
    const card = scorecard(db, null, { fromMs: 1_000, toMs: 2_000 });
    expect(card.runs).toBe(1);
  });

  it('excludes a run with neither ended_at nor scheduled_for — it has no window to belong to', () => {
    insertRun(db, { id: 'r1', taskId: 't1', state: 'queued', costUsd: 0, endedAt: null, scheduledFor: null, jobspecProfileId: null });
    const card = scorecard(db, null, { fromMs: 0, toMs: 10_000 });
    expect(card.runs).toBe(0);
  });
});

describe('scorecard — costTrendUsd', () => {
  let db: DB;

  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', 1_000);
    insertProfile(db, 'p1', 'p', 'P', 1_000);
  });

  it('is null when the previous window (of equal length) had no runs', () => {
    insertRun(db, { id: 'r1', taskId: 't1', state: 'completed', costUsd: 5, endedAt: DAY + 1_000, scheduledFor: null, jobspecProfileId: 'p1' });
    const card = scorecard(db, 'p1', { fromMs: DAY, toMs: DAY * 2 });
    expect(card.costTrendUsd).toBeNull();
  });

  it('is the signed difference between this window\'s and the previous window\'s mean cost/run', () => {
    // previous window [0, DAY): one run at $10 -> mean $10/run
    insertRun(db, { id: 'r-prev', taskId: 't1', state: 'completed', costUsd: 10, endedAt: 500, scheduledFor: null, jobspecProfileId: 'p1' });
    // this window [DAY, 2*DAY): two runs averaging $16/run
    insertRun(db, { id: 'r-cur-1', taskId: 't1', state: 'completed', costUsd: 12, endedAt: DAY + 500, scheduledFor: null, jobspecProfileId: 'p1' });
    insertRun(db, { id: 'r-cur-2', taskId: 't1', state: 'completed', costUsd: 20, endedAt: DAY + 1_500, scheduledFor: null, jobspecProfileId: 'p1' });
    const card = scorecard(db, 'p1', { fromMs: DAY, toMs: DAY * 2 });
    expect(card.costUsd).toBe(32);
    expect(card.costTrendUsd).toBeCloseTo(16 - 10, 6);
  });

  it('treats a window with runs but zero cost as mean 0, not NaN, when computing a real previous window', () => {
    insertRun(db, { id: 'r-prev', taskId: 't1', state: 'completed', costUsd: 4, endedAt: 500, scheduledFor: null, jobspecProfileId: 'p1' });
    insertRun(db, { id: 'r-cur', taskId: 't1', state: 'completed', costUsd: 0, endedAt: DAY + 500, scheduledFor: null, jobspecProfileId: 'p1' });
    const card = scorecard(db, 'p1', { fromMs: DAY, toMs: DAY * 2 });
    expect(Number.isNaN(card.costTrendUsd)).toBe(false);
    expect(card.costTrendUsd).toBeCloseTo(0 - 4, 6);
  });

  it('DESIGN READING (spec silent): a THIS window with zero runs still computes a real (non-null) trend against a non-empty previous window, treating this window\'s mean cost as 0', () => {
    // Spec only names "previous window had no runs" as the null case. This
    // pins the reading taken here for the current window's own emptiness.
    insertRun(db, { id: 'r-prev', taskId: 't1', state: 'completed', costUsd: 6, endedAt: 500, scheduledFor: null, jobspecProfileId: 'p1' });
    const card = scorecard(db, 'p1', { fromMs: DAY, toMs: DAY * 2 });
    expect(card.runs).toBe(0);
    expect(card.costTrendUsd).toBeCloseTo(0 - 6, 6);
  });
});

describe('scorecards — only present groups, sorted by costUsd descending', () => {
  let db: DB;

  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', 1_000);
    insertProfile(db, 'p1', 'cheap', 'Cheap Bot', 1_000);
    insertProfile(db, 'p2', 'costly', 'Costly Bot', 1_000);
    insertProfile(db, 'p3', 'idle', 'Idle Bot (no runs this window)', 1_000);
  });

  it('omits a profile that had no runs in the window at all', () => {
    insertRun(db, { id: 'r1', taskId: 't1', state: 'completed', costUsd: 1, endedAt: 5_000, scheduledFor: null, jobspecProfileId: 'p1' });
    const cards = scorecards(db, { fromMs: 0, toMs: 10_000 });
    expect(cards.map((c) => c.profileId)).toEqual(['p1']);
  });

  it('sorts multiple present groups by costUsd descending, including the Unassigned bucket', () => {
    insertRun(db, { id: 'r1', taskId: 't1', state: 'completed', costUsd: 5, endedAt: 1_000, scheduledFor: null, jobspecProfileId: 'p1' });
    insertRun(db, { id: 'r2', taskId: 't1', state: 'completed', costUsd: 50, endedAt: 2_000, scheduledFor: null, jobspecProfileId: 'p2' });
    insertRun(db, { id: 'r3', taskId: 't1', state: 'completed', costUsd: 20, endedAt: 3_000, scheduledFor: null, jobspecProfileId: null });
    const cards = scorecards(db, { fromMs: 0, toMs: 10_000 });
    expect(cards.map((c) => c.profileId)).toEqual(['p2', null, 'p1']);
    expect(cards.map((c) => c.costUsd)).toEqual([50, 20, 5]);
  });
});

describe('reviewPromptFor — text only, states the given numbers without inventing new ones', () => {
  function baseCard(overrides: Partial<PerformanceScorecard> = {}): PerformanceScorecard {
    return {
      profileId: 'p1',
      profileSlug: 'reviewer',
      profileName: 'Reviewer Bot',
      fromMs: 0,
      toMs: DAY,
      runs: 10,
      acceptanceRate: 0.8,
      failureRate: 0.1,
      costUsd: 12.5,
      costTrendUsd: 2.25,
      decided: 5,
      ...overrides,
    };
  }

  it('includes the profile name and every computed number verbatim', () => {
    const prompt = reviewPromptFor(baseCard());
    expect(prompt).toContain('Reviewer Bot');
    expect(prompt).toContain('Runs in period: 10');
    expect(prompt).toContain('80%');
    expect(prompt).toContain('5 decided');
    expect(prompt).toContain('10%');
    expect(prompt).toContain('$12.50');
  });

  it('phrases a null acceptanceRate as "not enough data", never as a failing 0%', () => {
    const prompt = reviewPromptFor(baseCard({ acceptanceRate: null, decided: 0 }));
    expect(prompt).not.toContain('Acceptance rate: 0%');
    expect(prompt.toLowerCase()).toContain('not yet reviewed');
  });

  it('phrases a null costTrendUsd as "no prior period", not as a fabricated $0 trend', () => {
    const prompt = reviewPromptFor(baseCard({ costTrendUsd: null }));
    expect(prompt.toLowerCase()).toContain('no prior period');
  });

  it('makes no model call and returns a plain string synchronously', () => {
    const result = reviewPromptFor(baseCard());
    expect(typeof result).toBe('string');
  });
});
