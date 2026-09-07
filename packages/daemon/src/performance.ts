/**
 * F11 — performance-reviews (plan/AGENT-WORKFORCE-SPEC.md §4, "F11 —
 * performance-reviews").
 *
 * Per-profile scorecard over a period: acceptance rate, cost trend, failure
 * rate. Owns NO table (spec §1.1) — every number here is plain SQL over the
 * existing `runs` table, F6's `run_outcomes` acceptance signal, and `profiles`
 * for the human-readable name. A cache would be a second source of truth for
 * numbers that must not disagree with what a human can already see in the
 * inbox and the run list.
 *
 * `reviewPromptFor()` returns TEXT ONLY. This module makes no model call and
 * writes no prose — the written verdict is produced by a separately scheduled
 * task running a reviewer profile against that prompt (wiring: an
 * integrator-owned `POST /workforce/performance/:profileId/review-prompt`
 * caller decides how/when to book that task; nothing in this module books a
 * run). That split is deliberate: the numbers must be reproducible without an
 * LLM, so a human (or a test) can always check the reviewer's prose against
 * the arithmetic.
 *
 * GROUPING KEY AND WINDOW MUST MATCH F10 (timesheets.ts) EXACTLY — the spec is
 * explicit that these two features must agree, because a product that reports
 * two different numbers for the same agent's activity in the same window is
 * broken. Both use:
 *   - group key: COALESCE(run_outcomes.profile_id,
 *     json_extract(runs.jobspec_json, '$.profile.id')) — the F6 snapshot
 *     first, falling back to the jobspec for runs decided before run_outcomes
 *     existed (or never decided at all), so historical runs count with zero
 *     wiring (jobSpecForTask has always written profile.id, api.ts:1505).
 *   - window: COALESCE(ended_at, scheduled_for) in [fromMs, toMs).
 * A run with neither is excluded from every window (SQLite: `NULL >= ?` is
 * NULL, not true, so the WHERE clause drops it — matching "a run that never
 * ran and was never scheduled contributes to nothing").
 *
 * `profile_id IS ?` is used throughout rather than `= ?` because SQLite's
 * `IS` is null-safe equality: it binds correctly whether the caller's
 * `profileId` is a string or `null`, so one query serves both a named
 * profile's scorecard and the "Unassigned" bucket (runs with no profile at
 * all — every run predates workforce_prefs review-period defaults and none of
 * that history is lost).
 */
import type { DB } from './db.js';
import type { PerformanceScorecard } from '@clockwork/shared';

interface GroupAggregate {
  runs: number;
  costUsd: number;
  failedCount: number;
  decided: number;
  accepted: number;
}

// COALESCE wraps every SUM (not just cost_usd): SQLite's SUM() over ZERO
// matching rows returns NULL, not 0 — only COUNT(*) is safe unwrapped. An
// unwrapped SUM here would surface as a null failedCount/decided/accepted on
// an empty window, which the PerformanceScorecard schema (all non-negative
// numbers, never null) would reject.
const AGGREGATE_SQL = `
  SELECT
    COUNT(*) AS runs,
    COALESCE(SUM(COALESCE(r.cost_usd, 0)), 0) AS cost_usd,
    COALESCE(SUM(CASE WHEN r.state IN ('failed','timed_out') THEN 1 ELSE 0 END), 0) AS failed_count,
    COALESCE(SUM(CASE WHEN ro.decision IS NOT NULL THEN 1 ELSE 0 END), 0) AS decided,
    COALESCE(SUM(CASE WHEN ro.decision IN ('accepted','accepted_with_note') THEN 1 ELSE 0 END), 0) AS accepted
  FROM runs r
  LEFT JOIN run_outcomes ro ON ro.run_id = r.id
  WHERE COALESCE(r.ended_at, r.scheduled_for) >= ?
    AND COALESCE(r.ended_at, r.scheduled_for) < ?
    AND COALESCE(ro.profile_id, json_extract(r.jobspec_json, '$.profile.id')) IS ?
`;

/** Aggregate one profile group (or the `null` "Unassigned" bucket) over one window. */
function aggregateForGroup(db: DB, profileId: string | null, fromMs: number, toMs: number): GroupAggregate {
  const row = db.prepare(AGGREGATE_SQL).get(fromMs, toMs, profileId) as {
    runs: number;
    cost_usd: number;
    failed_count: number;
    decided: number;
    accepted: number;
  };
  return {
    runs: row.runs,
    costUsd: row.cost_usd,
    failedCount: row.failed_count,
    decided: row.decided,
    accepted: row.accepted,
  };
}

interface ProfileMeta {
  profileSlug: string | null;
  profileName: string;
}

/**
 * `null` -> the Unassigned bucket. A non-null id with no matching `profiles`
 * row means the profile was deleted after the fact (run_outcomes.profile_id
 * carries no FK, by design — see migration 0008 header); the group stays
 * addressable by falling back to the raw id rather than collapsing into
 * "Unassigned", which would wrongly merge a deleted agent's history with
 * runs that never had one.
 */
function resolveProfileMeta(db: DB, profileId: string | null): ProfileMeta {
  if (profileId === null) return { profileSlug: null, profileName: 'Unassigned' };
  const row = db.prepare('SELECT slug, name FROM profiles WHERE id = ?').get(profileId) as
    | { slug: string; name: string }
    | undefined;
  if (!row) return { profileSlug: null, profileName: profileId };
  return { profileSlug: row.slug, profileName: row.name };
}

function buildCard(
  db: DB,
  profileId: string | null,
  fromMs: number,
  toMs: number,
  cur: GroupAggregate,
  prev: GroupAggregate,
): PerformanceScorecard {
  const meta = resolveProfileMeta(db, profileId);

  // Never report 0% for "nobody looked yet" — an unreviewed agent is not a
  // failing one, so both rates are null (not 0) at their respective "no data"
  // denominators.
  const acceptanceRate = cur.decided > 0 ? cur.accepted / cur.decided : null;
  const failureRate = cur.runs > 0 ? cur.failedCount / cur.runs : null;

  // Mean cost per run this window, treated as 0 when the window has no runs
  // (no runs -> no spend, a defined baseline). The comparison itself is only
  // meaningful when the PREVIOUS window has data, per spec.
  const meanThis = cur.runs > 0 ? cur.costUsd / cur.runs : 0;
  const costTrendUsd = prev.runs > 0 ? meanThis - prev.costUsd / prev.runs : null;

  return {
    profileId,
    profileSlug: meta.profileSlug,
    profileName: meta.profileName,
    fromMs,
    toMs,
    runs: cur.runs,
    acceptanceRate,
    failureRate,
    costUsd: cur.costUsd,
    costTrendUsd,
    decided: cur.decided,
  };
}

/** One profile's (or `null` -> Unassigned) scorecard over `[opts.fromMs, opts.toMs)`. */
export function scorecard(db: DB, profileId: string | null, opts: { fromMs: number; toMs: number }): PerformanceScorecard {
  const { fromMs, toMs } = opts;
  const windowLenMs = toMs - fromMs;
  const cur = aggregateForGroup(db, profileId, fromMs, toMs);
  const prev = aggregateForGroup(db, profileId, fromMs - windowLenMs, fromMs);
  return buildCard(db, profileId, fromMs, toMs, cur, prev);
}

/**
 * One scorecard per distinct group (named profile, or the Unassigned bucket)
 * that has at least one run in the window, sorted by `costUsd` descending —
 * matching F10's Timesheet row order, so the two views read the same way.
 */
export function scorecards(db: DB, opts: { fromMs: number; toMs: number }): PerformanceScorecard[] {
  const { fromMs, toMs } = opts;
  const rows = db
    .prepare(
      `SELECT DISTINCT COALESCE(ro.profile_id, json_extract(r.jobspec_json, '$.profile.id')) AS profile_id
       FROM runs r
       LEFT JOIN run_outcomes ro ON ro.run_id = r.id
       WHERE COALESCE(r.ended_at, r.scheduled_for) >= ? AND COALESCE(r.ended_at, r.scheduled_for) < ?`,
    )
    .all(fromMs, toMs) as { profile_id: string | null }[];

  const cards = rows.map((r) => scorecard(db, r.profile_id, opts));
  cards.sort((a, b) => b.costUsd - a.costUsd);
  return cards;
}

function pct(rate: number | null): string {
  return rate === null ? 'not yet reviewed (nobody has accepted or rejected a run this period)' : `${(rate * 100).toFixed(0)}%`;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * The prompt a reviewer-profile task runs to write the prose verdict. Text
 * only — this module never calls a model. The numbers are stated as ALREADY
 * COMPUTED and not to be recomputed or contradicted, so the reviewer's prose
 * cannot silently disagree with the arithmetic a human (or a test) can check
 * independently.
 */
export function reviewPromptFor(card: PerformanceScorecard): string {
  const trend =
    card.costTrendUsd === null
      ? 'no prior period to compare against'
      : card.costTrendUsd >= 0
        ? `up ${usd(card.costTrendUsd)} per run vs. the previous period of equal length`
        : `down ${usd(Math.abs(card.costTrendUsd))} per run vs. the previous period of equal length`;

  return [
    `You are writing a performance review for the agent profile "${card.profileName}".`,
    `Review period: ${new Date(card.fromMs).toISOString()} to ${new Date(card.toMs).toISOString()}.`,
    '',
    'The following metrics are already computed from the run history. Do NOT recompute them, do not invent different numbers, and do not contradict them — your job is to explain what they mean, not to re-derive them:',
    `- Runs in period: ${card.runs}`,
    `- Acceptance rate: ${pct(card.acceptanceRate)} (${card.decided} decided)`,
    `- Failure rate: ${pct(card.failureRate)}`,
    `- Total cost: ${usd(card.costUsd)}`,
    `- Cost trend: ${trend}`,
    '',
    'Write a short, honest performance verdict (a few sentences): what is going well, what is not, and one concrete suggestion. If a rate above says "not yet reviewed", say plainly that there is not enough human feedback yet to judge acceptance — do not treat it as a failure.',
  ].join('\n');
}
