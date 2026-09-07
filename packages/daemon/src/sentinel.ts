/**
 * F4 sentinel-worker (plan/AGENT-WORKFORCE-SPEC.md).
 *
 * A cheap sentinel run checks one condition on a tight cadence; when it trips
 * it books a full worker run. Reuses the existing trigger row rather than
 * binding directly to a worker task: `triggers.task_id` names the worker, and
 * the trigger already carries the enable flag and the audit surface.
 * `sentinels.trigger_id` cascades on delete, so `DELETE /triggers/:id` keeps
 * returning 204.
 *
 * Owns `sentinels`, `sentinel_trips` (migration 0008). Reads `triggers`,
 * `runs`.
 *
 * `evaluate()` is called from run-manager.ts's finalize hook for EVERY
 * finished run, not just sentinel runs — it looks up sentinels bound to the
 * finished task and is a no-op (returns null, writes nothing) when there are
 * none. `sentinel_task_id` has a non-unique index (`idx_sentinels_task`), and
 * `create()` places no rule against two sentinels watching the same task, so
 * `evaluate()` iterates every matching sentinel, writes one `sentinel_trips`
 * row per sentinel, and returns the first (or null when there were none).
 *
 * ASSUMPTIONS recorded for the integrator (not fixed elsewhere in the spec):
 *  - `sentinel_trips.reason` vocabulary: 'disabled' (sentinel off),
 *    'no_match' (trip_expr didn't match the report summary), 'cooldown'
 *    (tripped but inside cooldown_sec), 'trigger_disabled' (the bound
 *    trigger's own enabled flag is off — the spec's reason for binding to a
 *    trigger rather than a task is "the trigger carries the enable flag...
 *    already", so a disabled trigger must book nothing), 'policy_violation'
 *    (bookWorker returned null), null (a real trip that booked).
 *  - `last_tripped_at` only advances on a SUCCESSFUL booking. A
 *    'policy_violation' does not start the cooldown clock — nothing actually
 *    ran, so the next evaluation should retry immediately rather than wait
 *    out a cooldown for a run that never happened.
 *  - `evaluate()` itself does not catch errors from `deps.bookWorker` or its
 *    own DB calls; the spec's finalize anchor sits inside run-manager.ts's
 *    finalize transaction, so the wiring's monkey-patched callback (in
 *    api.ts, not here) is responsible for the try/catch that keeps a
 *    sentinel fault from rolling back the run's terminal state.
 */
import type { DB } from './db.js';
import { newId } from '@clockwork/shared';
import type { Sentinel, SentinelCreate, SentinelTrip } from '@clockwork/shared';

/** `trips()`'s default row count when the caller (route) supplies none. */
const DEFAULT_TRIPS_LIMIT = 50;

interface SentinelRow {
  id: string;
  name: string;
  sentinel_task_id: string;
  trigger_id: string;
  trip_expr: string;
  cooldown_sec: number;
  last_tripped_at: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface SentinelTripRow {
  id: string;
  sentinel_id: string;
  run_id: string | null;
  worker_run_id: string | null;
  tripped: number;
  reason: string | null;
  at: number;
}

function rowToSentinel(row: SentinelRow): Sentinel {
  return {
    id: row.id,
    name: row.name,
    sentinelTaskId: row.sentinel_task_id,
    triggerId: row.trigger_id,
    tripExpr: row.trip_expr,
    cooldownSec: row.cooldown_sec,
    lastTrippedAt: row.last_tripped_at,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTrip(row: SentinelTripRow): SentinelTrip {
  return {
    id: row.id,
    sentinelId: row.sentinel_id,
    runId: row.run_id,
    workerRunId: row.worker_run_id,
    tripped: Boolean(row.tripped),
    reason: row.reason,
    at: row.at,
  };
}

export interface SentinelDeps {
  db: DB;
  /** books the worker run; returns the run id, or null when it was refused */
  bookWorker(taskId: string): string | null;
}

export class Sentinels {
  constructor(private readonly deps: SentinelDeps) {}

  /**
   * Rejects (`{ error }`, surfaced as 422 by the route) when `sentinelTaskId`
   * or `triggerId` does not exist, or when the trigger's task is the sentinel
   * task itself — a sentinel that books itself is an infinite loop.
   */
  create(input: SentinelCreate, now: number = Date.now()): Sentinel | { error: string } {
    const task = this.deps.db
      .prepare('SELECT id FROM tasks WHERE id=? AND deleted_at IS NULL')
      .get(input.sentinelTaskId) as { id: string } | undefined;
    if (!task) return { error: 'sentinel task not found' };

    const trigger = this.deps.db.prepare('SELECT id, task_id FROM triggers WHERE id=?').get(input.triggerId) as
      | { id: string; task_id: string }
      | undefined;
    if (!trigger) return { error: 'trigger not found' };

    if (trigger.task_id === input.sentinelTaskId) {
      return { error: 'the trigger books the sentinel task itself — a sentinel cannot book its own run' };
    }

    const id = newId();
    this.deps.db
      .prepare(
        `INSERT INTO sentinels (id, name, sentinel_task_id, trigger_id, trip_expr, cooldown_sec, last_tripped_at, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(id, input.name, input.sentinelTaskId, input.triggerId, input.tripExpr, input.cooldownSec, input.enabled ? 1 : 0, now, now);

    return {
      id,
      name: input.name,
      sentinelTaskId: input.sentinelTaskId,
      triggerId: input.triggerId,
      tripExpr: input.tripExpr,
      cooldownSec: input.cooldownSec,
      lastTrippedAt: null,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    };
  }

  list(): Sentinel[] {
    const rows = this.deps.db.prepare('SELECT * FROM sentinels ORDER BY created_at DESC').all() as SentinelRow[];
    return rows.map(rowToSentinel);
  }

  /** true when a row existed and was deleted; sentinel_trips cascade with it. */
  remove(id: string): boolean {
    const result = this.deps.db.prepare('DELETE FROM sentinels WHERE id=?').run(id);
    return result.changes > 0;
  }

  /** newest first. */
  trips(sentinelId: string, limit: number = DEFAULT_TRIPS_LIMIT): SentinelTrip[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM sentinel_trips WHERE sentinel_id=? ORDER BY at DESC LIMIT ?')
      .all(sentinelId, limit) as SentinelTripRow[];
    return rows.map(rowToTrip);
  }

  /**
   * Evaluate a finished run against every sentinel bound to `taskId`.
   * ALWAYS writes a sentinel_trips row per matching sentinel — a non-trip is
   * as diagnostic as a trip — and books the worker only when it tripped, the
   * sentinel is enabled, the bound trigger is enabled, and the cooldown has
   * expired. Returns null (writes nothing) when `taskId` names no sentinel's
   * `sentinel_task_id` — most finalized runs are not sentinel runs.
   */
  evaluate(runId: string, taskId: string, reportJson: string | null, now: number = Date.now()): SentinelTrip | null {
    const rows = this.deps.db.prepare('SELECT * FROM sentinels WHERE sentinel_task_id = ?').all(taskId) as SentinelRow[];
    if (rows.length === 0) return null;

    let first: SentinelTrip | null = null;
    for (const row of rows) {
      const trip = this.evaluateOne(row, runId, reportJson, now);
      if (first === null) first = trip;
    }
    return first;
  }

  private evaluateOne(row: SentinelRow, runId: string, reportJson: string | null, now: number): SentinelTrip {
    let tripFlag = 0;
    let reason: string | null = null;
    let workerRunId: string | null = null;

    if (!row.enabled) {
      reason = 'disabled';
    } else if (!tripped(reportJson, row.trip_expr)) {
      reason = 'no_match';
    } else if (row.last_tripped_at !== null && now - row.last_tripped_at < row.cooldown_sec * 1000) {
      reason = 'cooldown';
    } else {
      const trigger = this.deps.db.prepare('SELECT task_id, enabled FROM triggers WHERE id = ?').get(row.trigger_id) as
        | { task_id: string; enabled: number }
        | undefined;
      if (!trigger) {
        // Defensive only: sentinels.trigger_id cascades on trigger delete, so
        // the sentinel row would already be gone. Should not happen in practice.
        reason = 'trigger_missing';
      } else if (!trigger.enabled) {
        reason = 'trigger_disabled';
      } else {
        const booked = this.deps.bookWorker(trigger.task_id);
        if (booked === null) {
          reason = 'policy_violation';
        } else {
          tripFlag = 1;
          workerRunId = booked;
          this.deps.db.prepare('UPDATE sentinels SET last_tripped_at=?, updated_at=? WHERE id=?').run(now, now, row.id);
        }
      }
    }

    const id = newId();
    this.deps.db
      .prepare(
        `INSERT INTO sentinel_trips (id, sentinel_id, run_id, worker_run_id, tripped, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, row.id, runId, workerRunId, tripFlag, reason, now);

    return { id, sentinelId: row.id, runId, workerRunId, tripped: Boolean(tripFlag), reason, at: now };
  }
}

/** pure: case-insensitive substring match against the report summary. */
export function tripped(reportJson: string | null, tripExpr: string): boolean {
  if (!reportJson) return false;
  let summary = '';
  try {
    const parsed = JSON.parse(reportJson) as { summary?: unknown };
    summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  } catch {
    return false;
  }
  if (!summary) return false;
  return summary.toLowerCase().includes(tripExpr.toLowerCase());
}
