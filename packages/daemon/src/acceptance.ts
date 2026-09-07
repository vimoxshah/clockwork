/**
 * F6 accept-with-note (plan/AGENT-WORKFORCE-SPEC.md).
 *
 * The inbox gains accept / reject / accept-with-note. The note is written
 * into that task's shift-handoff memory (F2's `HandoffMemory`, `agent_memories`
 * table) so the next occurrence of the same task can read a human's
 * correction. This module owns `run_outcomes` — THE ACCEPTANCE SIGNAL — read
 * by F7 (earned-autonomy), F10 (timesheets) and F11 (performance-reviews).
 *
 * `record()` is idempotent per run: `run_id` is the primary key, and a second
 * decision on the same run UPDATEs the row (`ON CONFLICT(run_id) DO UPDATE`)
 * rather than duplicating it. `agent_memories` itself stays append-only (F2's
 * invariant) — a decision that is no longer `accepted_with_note` simply stops
 * pointing `memory_id` at a note; the earlier memory row it once pointed to is
 * never deleted or edited.
 *
 * `profile_id` is a snapshot resolved from the run's frozen `jobspec_json` via
 * `json_extract(jobspec_json, '$.profile.id')` (verified against
 * `jobSpecForTask`, api.ts:1484-1513, which always writes `profile.id` or
 * `profile: null`) — never joined against `profiles` at read time, so a
 * profile rename or deletion after the fact cannot rewrite history.
 *
 * ASSUMPTION recorded for the integrator (not fixed elsewhere in the spec):
 * `record()`'s exported signature takes an already zod-validated
 * `RunOutcomeWrite`, whose `.refine()` already guarantees a non-empty `note`
 * for `accepted_with_note` at the route boundary. This module still guards
 * that invariant defensively (throws rather than silently writing a noteless
 * "note") for any caller that constructs the input by hand, bypassing zod —
 * the same fail-closed posture `HandoffMemory.append` takes on an unknown
 * `taskId` (handoff.ts:70).
 */
import type { DB } from './db.js';
import type { RunOutcomeRecord, RunOutcomeWrite, OutcomeDecision } from '@clockwork/shared';
import type { HandoffMemory } from './handoff.js';

/** `listForTask()`'s default row count, matching sentinel.ts's `trips()` precedent (sentinel.ts:45). */
const DEFAULT_LIST_LIMIT = 50;

interface OutcomeRow {
  run_id: string;
  task_id: string;
  profile_id: string | null;
  decision: string;
  note: string | null;
  memory_id: string | null;
  actor: string;
  decided_at: number;
}

function rowToRecord(row: OutcomeRow): RunOutcomeRecord {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    profileId: row.profile_id,
    decision: row.decision as OutcomeDecision,
    note: row.note,
    memoryId: row.memory_id,
    actor: row.actor,
    decidedAt: row.decided_at,
  };
}

export class Acceptance {
  constructor(
    private readonly db: DB,
    private readonly handoff: HandoffMemory,
  ) {}

  /**
   * Idempotent per run: a second decision UPDATEs, never duplicates.
   * Returns 'not_found' when `runId` names no run — there is nothing to
   * attach an acceptance signal to.
   */
  record(runId: string, input: RunOutcomeWrite, actor = 'local', now: number = Date.now()): RunOutcomeRecord | 'not_found' {
    const run = this.db
      .prepare(`SELECT id, task_id, json_extract(jobspec_json, '$.profile.id') AS profile_id FROM runs WHERE id=?`)
      .get(runId) as { id: string; task_id: string; profile_id: string | null } | undefined;
    if (!run) return 'not_found';

    const note = input.note && input.note.trim().length > 0 ? input.note : null;

    let memoryId: string | null = null;
    if (input.decision === 'accepted_with_note') {
      // Defensive: RunOutcomeWrite.refine() already enforces this at the route.
      if (!note) {
        throw new Error('accepted_with_note requires a non-empty note');
      }
      const mem = this.handoff.append({ taskId: run.task_id, runId, author: 'human', kind: 'note', body: note }, now);
      memoryId = mem.id;
    }

    this.db
      .prepare(
        `INSERT INTO run_outcomes (run_id, task_id, profile_id, decision, note, memory_id, actor, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           decision=excluded.decision,
           note=excluded.note,
           memory_id=excluded.memory_id,
           actor=excluded.actor,
           decided_at=excluded.decided_at`,
      )
      .run(runId, run.task_id, run.profile_id, input.decision, note, memoryId, actor, now);

    return {
      runId,
      taskId: run.task_id,
      profileId: run.profile_id,
      decision: input.decision,
      note,
      memoryId,
      actor,
      decidedAt: now,
    };
  }

  get(runId: string): RunOutcomeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM run_outcomes WHERE run_id=?').get(runId) as OutcomeRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Newest first. `rowid DESC` breaks ties on identical `decided_at`, matching `HandoffMemory.latest` (handoff.ts:103). */
  listForTask(taskId: string, limit: number = DEFAULT_LIST_LIMIT): RunOutcomeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM run_outcomes WHERE task_id=? ORDER BY decided_at DESC, rowid DESC LIMIT ?')
      .all(taskId, limit) as OutcomeRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Consecutive accepted decisions for a profile, newest-first, stopping at
   * the first rejection. Counts both 'accepted' and 'accepted_with_note' — a
   * note is still an acceptance (F7 reads this for the earned-autonomy
   * streak).
   */
  acceptedStreak(profileId: string): number {
    const rows = this.db
      .prepare('SELECT decision FROM run_outcomes WHERE profile_id=? ORDER BY decided_at DESC, rowid DESC')
      .all(profileId) as { decision: string }[];
    let streak = 0;
    for (const row of rows) {
      if (row.decision === 'rejected') break;
      streak++;
    }
    return streak;
  }
}
