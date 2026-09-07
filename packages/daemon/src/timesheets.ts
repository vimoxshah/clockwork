/**
 * F10 timesheets (plan/AGENT-WORKFORCE-SPEC.md, §F10).
 *
 * A per-agent punch clock: hours worked, dollars spent, outcomes accepted,
 * and an effective hourly rate, over an arbitrary window. **Plain SQL over
 * the existing `runs` table plus F6's acceptance signal (`run_outcomes`) —
 * this module owns no table.**
 *
 * GROUPING KEY (must match F11 — see performance.ts and §4/F11's "shares
 * F10's definitions"): `COALESCE(run_outcomes.profile_id,
 * json_extract(runs.jobspec_json, '$.profile.id'))`. `run_outcomes.profile_id`
 * is the live snapshot F6 writes at decision time; the `jobspec_json` fallback
 * is what makes runs that predate F6 (or that were never decided) count with
 * ZERO wiring, because `jobSpecForTask` (api.ts:1484-1513) has always written
 * `profile.id` (or `profile: null`) into every run's frozen jobspec. A run
 * with no profile at all groups under `profileId: null`, `profileName:
 * 'Unassigned'`.
 *
 * IDENTITY (slug/name) resolution: prefer a live join against `profiles` —
 * this module does read `profiles`, per the spec's Reads list, so a rename
 * shows up immediately. When the profile has since been deleted (no FK, by
 * design — run_outcomes.profile_id is informational, see 0008's header),
 * fall back to the same jobspec_json snapshot (`$.profile.slug` /
 * `$.profile.name`) that seeded the grouping key, so a deleted agent still
 * gets a readable name instead of a bare id. `profiles` is never written by
 * this module.
 *
 * WINDOW: `COALESCE(ended_at, scheduled_for)` in `[fromMs, toMs)`, matching
 * the existing `/analytics` route's window (api.ts:1003-1010).
 *
 * hoursWorked sums `MAX(0, ended_at - started_at)` and counts ONLY rows where
 * both are non-null — a run that never started contributes 0 hours and still
 * contributes its cost, so a crashed-before-start run cannot manufacture a
 * cheap effective rate. effectiveHourlyRateUsd is null (never Infinity, never
 * 0) when hoursWorked is 0.
 *
 * outcomesAccepted counts both 'accepted' and 'accepted_with_note' (a note is
 * still an acceptance — matches F7's acceptedStreak, acceptance.ts:133).
 * outcomesRejected counts 'rejected'. Rows with no run_outcomes decision at
 * all (never reviewed) count toward neither.
 *
 * This module does not validate `fromMs`/`toMs` — that is the route's job
 * (422 on a bad range, per §2.2's semantic-failure convention). A caller that
 * passes `toMs <= fromMs` simply gets a Timesheet with no rows, because the
 * window predicate can never be true; it is not this module's place to throw.
 */
import type { DB } from './db.js';
import type { Timesheet, TimesheetRow } from '@clockwork/shared';

interface WindowRow {
  profileId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  costUsd: number | null;
  decision: string | null;
  jobspecSlug: string | null;
  jobspecName: string | null;
}

interface Agg {
  profileId: string | null;
  runs: number;
  hoursMs: number;
  dollarsSpent: number;
  outcomesAccepted: number;
  outcomesRejected: number;
  jobspecSlug: string | null;
  jobspecName: string | null;
}

/** Rounds away float noise from repeated SUMs without hiding real precision. */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * `db`-first plain function per §2.5 — this module owns no table and has no
 * durable state to wrap in a class.
 */
export function timesheet(db: DB, opts: { fromMs: number; toMs: number; profileId?: string }): Timesheet {
  const { fromMs, toMs, profileId } = opts;

  const rows = db
    .prepare(
      `SELECT
         COALESCE(o.profile_id, json_extract(r.jobspec_json, '$.profile.id')) AS profileId,
         r.started_at AS startedAt,
         r.ended_at AS endedAt,
         r.cost_usd AS costUsd,
         o.decision AS decision,
         json_extract(r.jobspec_json, '$.profile.slug') AS jobspecSlug,
         json_extract(r.jobspec_json, '$.profile.name') AS jobspecName
       FROM runs r
       LEFT JOIN run_outcomes o ON o.run_id = r.id
       WHERE COALESCE(r.ended_at, r.scheduled_for) >= ? AND COALESCE(r.ended_at, r.scheduled_for) < ?`,
    )
    .all(fromMs, toMs) as WindowRow[];

  const filtered = profileId !== undefined ? rows.filter((r) => r.profileId === profileId) : rows;

  const byProfile = new Map<string | null, Agg>();
  for (const r of filtered) {
    let agg = byProfile.get(r.profileId);
    if (!agg) {
      agg = {
        profileId: r.profileId,
        runs: 0,
        hoursMs: 0,
        dollarsSpent: 0,
        outcomesAccepted: 0,
        outcomesRejected: 0,
        jobspecSlug: null,
        jobspecName: null,
      };
      byProfile.set(r.profileId, agg);
    }
    agg.runs += 1;
    if (r.startedAt != null && r.endedAt != null) {
      agg.hoursMs += Math.max(0, r.endedAt - r.startedAt);
    }
    agg.dollarsSpent += r.costUsd ?? 0;
    if (r.decision === 'accepted' || r.decision === 'accepted_with_note') {
      agg.outcomesAccepted += 1;
    } else if (r.decision === 'rejected') {
      agg.outcomesRejected += 1;
    }
    if (agg.jobspecName == null && r.jobspecName != null) agg.jobspecName = r.jobspecName;
    if (agg.jobspecSlug == null && r.jobspecSlug != null) agg.jobspecSlug = r.jobspecSlug;
  }

  const liveProfiles = new Map<string, { slug: string; name: string }>();
  if (byProfile.size > 0) {
    const idList = [...byProfile.keys()].filter((id): id is string => id !== null);
    if (idList.length > 0) {
      const placeholders = idList.map(() => '?').join(',');
      const profileRows = db
        .prepare(`SELECT id, slug, name FROM profiles WHERE id IN (${placeholders})`)
        .all(...idList) as Array<{ id: string; slug: string; name: string }>;
      for (const p of profileRows) liveProfiles.set(p.id, { slug: p.slug, name: p.name });
    }
  }

  const outRows: TimesheetRow[] = [...byProfile.values()].map((agg) => {
    const hoursWorked = agg.hoursMs / 3_600_000;
    const dollarsSpent = agg.dollarsSpent;
    const effectiveHourlyRateUsd = agg.hoursMs === 0 ? null : round6(dollarsSpent / hoursWorked);

    let profileSlug: string | null = null;
    let profileName: string;
    if (agg.profileId === null) {
      profileName = 'Unassigned';
    } else {
      const live = liveProfiles.get(agg.profileId);
      if (live) {
        profileSlug = live.slug;
        profileName = live.name;
      } else if (agg.jobspecName) {
        profileSlug = agg.jobspecSlug;
        profileName = agg.jobspecName;
      } else {
        // No live profile and no jobspec snapshot to fall back on — should not
        // happen in practice (jobSpecForTask always writes profile.name when
        // profile.id is set), but a readable fallback beats a crash.
        profileName = agg.profileId;
      }
    }

    return {
      profileId: agg.profileId,
      profileSlug,
      profileName,
      runs: agg.runs,
      hoursWorked: round6(hoursWorked),
      dollarsSpent: round6(dollarsSpent),
      outcomesAccepted: agg.outcomesAccepted,
      outcomesRejected: agg.outcomesRejected,
      effectiveHourlyRateUsd,
    };
  });

  outRows.sort((a, b) => b.dollarsSpent - a.dollarsSpent);

  return {
    fromMs,
    toMs,
    humanHourlyRateUsd: humanHourlyRate(db),
    rows: outRows,
  };
}

/** The singleton row (`id = 1`) always exists — seeded by 0008's `INSERT OR IGNORE`. */
export function humanHourlyRate(db: DB): number | null {
  const row = db.prepare('SELECT human_hourly_rate_usd AS rate FROM workforce_prefs WHERE id = 1').get() as
    | { rate: number | null }
    | undefined;
  return row?.rate ?? null;
}

export function setHumanHourlyRate(db: DB, rate: number | null): void {
  db.prepare('UPDATE workforce_prefs SET human_hourly_rate_usd = ? WHERE id = 1').run(rate);
}
