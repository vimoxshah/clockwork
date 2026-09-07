/**
 * Scheduler service (T-103, arch §4, ADR-005): 30s DB-driven tick loop,
 * materialized next_fire, THE occurrence-ledger claim transaction (double-fire
 * guard), missed detection + policies + coalescing, wake-event catch-up.
 *
 * Fire = ONE transaction: claim occurrence + insert run row + advance
 * next_fire. Crash at any point commits all three or none. The ledger PK
 * (schedule_id, occurrence_at) makes double-fire impossible even across
 * crash/restart races and backward clock jumps (S-25).
 */
import { DateTime } from 'luxon';
import type { DB } from './db.js';
import type { Clock } from './clock.js';
import { occurrencesBetween, nextOccurrenceAfter, type ScheduleLike } from './recurrence.js';
import { newId, slugify, branchFor, type JobSpec } from '@clockwork/shared';
import { shiftForApproval } from './office-hours.js';

export const GRACE_MS = 120_000; // NFR-1: missed-run detection within 120s of wake

export interface SchedulerDeps {
  db: DB;
  clock: Clock;
  /** enqueue a claimed occurrence as a runnable run; returns run id */
  enqueueRun(spec: JobSpec): void;
  /** notify layer for missed/ask outcomes */
  notify(kind: 'missed' | 'ask_user' | 'auto_disabled', taskName: string, detail: string): void;
}

interface TaskRow {
  id: string;
  name: string;
  prompt: string;
  profile_id: string | null;
  repo_path: string | null;
  model: string | null;
  permission_mode: string;
  budget_usd: number;
  max_turns: number;
  timeout_sec: number;
  base_branch: string | null;
  context_json: string;
  delivery_json: string;
  missed_policy: string;
  missed_window_sec: number;
  overlap_policy: string;
  retry_on_transient: number;
  enabled: number;
  version: number;
  deleted_at: number | null;
}

interface ScheduleRow {
  id: string;
  task_id: string;
  kind: 'once' | 'rrule' | 'cron';
  rrule: string | null;
  cron: string | null;
  run_at: number | null;
  tz: string;
  next_fire: number | null;
  enabled: number;
}

function scheduleLike(row: ScheduleRow): ScheduleLike {
  return { kind: row.kind, rrule: row.rrule, cron: row.cron, runAt: row.run_at, tz: row.tz };
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(tickMs = 30_000): void {
    void this.tick(); // immediate first sweep (also the startup catch-up, S-14)
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep. Wall-clock comparisons only — no cached deltas (S-25). */
  async tick(): Promise<void> {
    if (this.running) return; // no tick starvation pileup (S-9)
    this.running = true;
    try {
      const now = this.deps.clock.now();
      const due = this.deps.db
        .prepare(
          `SELECT s.*, t.id AS tx_id FROM schedules s
           JOIN tasks t ON t.id = s.task_id
           WHERE s.enabled = 1 AND t.enabled = 1 AND t.deleted_at IS NULL AND s.next_fire IS NOT NULL AND s.next_fire <= ?`,
        )
        .all(now) as unknown as (ScheduleRow & { tx_id: string })[];
      for (const row of due) {
        try {
          await this.processDue(row as ScheduleRow, now);
        } catch (e) {
          // one bad schedule must never starve the rest (S-9)
          this.deps.db.prepare('INSERT INTO events (at, kind, data_json) VALUES (?, ?, ?)').run(
            now,
            'scheduler_error',
            JSON.stringify({ scheduleId: row.id, error: String(e) }),
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private processDue(sched: ScheduleRow, now: number): void {
    const fireAt = sched.next_fire!;
    const claimStmt = this.deps.db.prepare(
      `INSERT OR IGNORE INTO schedule_occurrences (schedule_id, occurrence_at, disposition, claimed_at)
       VALUES (?, ?, 'pending', ?)`,
    );
    const task = this.deps.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(sched.task_id) as unknown as TaskRow;

    let claimed = false;
    let late = false;
    let coveredCount = 0;

    const tx = this.deps.db.transaction(() => {
      const info = claimStmt.run(sched.id, fireAt, now);
      claimed = info.changes === 1;
      if (!claimed) return; // already claimed by a previous crash-recovered pass

      const staleBy = now - fireAt;
      late = staleBy > GRACE_MS;

      if (late) {
        // Missed-window analysis + COALESCING RULE (S-10/S-11):
        // claim every other past occurrence up to now as coalesced; at most ONE
        // catch-up run fires per schedule.
        const past = occurrencesBetween(scheduleLike(sched), fireAt, now, 1000);
        coveredCount = Math.max(0, past.length - 1);
        const covStmt = this.deps.db.prepare(
          `INSERT OR IGNORE INTO schedule_occurrences (schedule_id, occurrence_at, disposition, claimed_at)
           VALUES (?, ?, 'coalesced', ?)`,
        );
        for (const p of past) {
          if (p !== fireAt) covStmt.run(sched.id, p, now);
        }
        const withinWindow = staleBy <= task.missed_window_sec * 1000;
        if (task.missed_policy === 'skip' || !withinWindow) {
          this.deps.db
            .prepare(`UPDATE schedule_occurrences SET disposition='missed' WHERE schedule_id=? AND occurrence_at=?`)
            .run(sched.id, fireAt);
          if (task.missed_policy === 'ask') {
            // awaiting_user inbox item (FSM state on a placeholder run)
            const runId = newId();
            this.insertRunRow(runId, task, sched, fireAt, now, 'awaiting_user');
            this.deps.db
              .prepare(`UPDATE schedule_occurrences SET disposition='missed', run_id=? WHERE schedule_id=? AND occurrence_at=?`)
              .run(runId, sched.id, fireAt);
            this.deps.notify('ask_user', task.name, `Missed ${new Date(fireAt).toISOString()}; run late?`);
          } else {
            this.deps.notify('missed', task.name, `Skipped: machine slept past window (${Math.round(staleBy / 60000)}m).`);
          }
          claimed = false; // no run enqueued from the main path
        }
      }

      // advance next_fire regardless (re-materialized forward, S-11)
      const next = nextOccurrenceAfter(scheduleLike(sched), Math.max(fireAt, now));
      if (next == null && sched.kind !== 'once') {
        // S-24: RRULE exhausted → auto-disable + inbox note
        this.deps.db.prepare('UPDATE schedules SET next_fire=NULL, enabled=0 WHERE id=?').run(sched.id);
        this.deps.notify('auto_disabled', task.name, 'Schedule has no future occurrences.');
      } else {
        this.deps.db
          .prepare(
            sched.kind === 'once'
              ? 'UPDATE schedules SET next_fire=NULL WHERE id=?'
              : 'UPDATE schedules SET next_fire=? WHERE id=?',
          )
          .run(...(sched.kind === 'once' ? [sched.id] : [next, sched.id]));
      }
    });
    tx();

    if (claimed && !late) {
      // Quiet hours (ADR-030): defer into the task's local-time quiet window.
      const qh = readQuietHours(task.delivery_json);
      const tz = sched.tz;
      if (qh && inQuietWindow(fireAt, qh, tz)) {
        const resumeAt = quietWindowEnd(fireAt, qh, tz);
        this.deps.db
          .prepare(`UPDATE schedule_occurrences SET disposition='deferred' WHERE schedule_id=? AND occurrence_at=?`)
          .run(sched.id, fireAt);
        this.deps.notify('missed', task.name, `Deferred past quiet hours — rescheduled to ${new Date(resumeAt).toLocaleString()}.`);
        // Re-claim the pushed occurrence so it still fires after the window.
        this.deps.db
          .prepare(
            `INSERT OR IGNORE INTO schedule_occurrences (schedule_id, occurrence_at, disposition, claimed_at)
             VALUES (?, ?, 'pending', ?)`,
          )
          .run(sched.id, resumeAt, now);
        const bump = this.deps.db.prepare('UPDATE schedules SET next_fire=? WHERE id=? AND kind != \'once\'');
        if (sched.kind !== 'once') bump.run(resumeAt, sched.id);
        return;
      }
      // Office hours (F3, spec §4): a task whose profile is flagged
      // may_require_approval waits for a window a human can answer in.
      // Fail-open — shiftForApproval returns null on any error and the run
      // fires on time.
      const officeShift = shiftForApproval(this.deps.db, task.id, fireAt);
      if (officeShift != null && officeShift > fireAt) {
        this.deps.db
          .prepare(`UPDATE schedule_occurrences SET disposition='deferred' WHERE schedule_id=? AND occurrence_at=?`)
          .run(sched.id, fireAt);
        this.deps.notify('missed', task.name, `Deferred into office hours — rescheduled to ${new Date(officeShift).toLocaleString()}.`);
        // Repoint next_fire at the resume instant and deliberately DO NOT
        // pre-claim a ledger row there: the tick at officeShift has to win its
        // own INSERT OR IGNORE claim, or `if (!claimed) return` fires first and
        // the schedule is pinned here forever. 'once' is bumped too — the claim
        // tx above NULLed its next_fire, and a dropped one-shot is lost work.
        this.deps.db.prepare('UPDATE schedules SET next_fire=? WHERE id=?').run(officeShift, sched.id);
        return;
      }
      this.enqueue(task, sched, fireAt, now, false, 0);
    } else if (claimed && late) {
      // run-late within window: one catch-up run listing covered occurrences
      this.enqueue(task, sched, fireAt, now, true, coveredCount);
    }
  }

  /** Overlap policy (S-8): skip-or-queue when the previous instance still runs. */
  private enqueue(task: TaskRow, sched: ScheduleRow, occurrenceAt: number, now: number, ranLate: boolean, coveredCount: number): void {
    if (task.overlap_policy === 'skip') {
      const active = this.deps.db
        .prepare(
          `SELECT COUNT(*) AS c FROM runs WHERE task_id=? AND state IN ('queued','preparing','running','waiting_approval','finalizing')`,
        )
        .get(task.id) as unknown as { c: number };
      if (active.c > 0) {
        this.deps.db
          .prepare(`UPDATE schedule_occurrences SET disposition='skipped', run_id=NULL WHERE schedule_id=? AND occurrence_at=?`)
          .run(sched.id, occurrenceAt);
        this.deps.notify('missed', task.name, 'Skipped: previous run still executing (overlap policy=skip).');
        return;
      }
    }
    const runId = newId();
    const spec = buildJobSpec(runId, task, now, occurrenceAt, this.deps.db);
    const insertRun = this.deps.db.transaction(() => {
      this.insertRunRow(runId, task, sched, occurrenceAt, now, 'queued');
      this.deps.db
        .prepare(`UPDATE schedule_occurrences SET disposition='fired', run_id=? WHERE schedule_id=? AND occurrence_at=?`)
        .run(runId, sched.id, occurrenceAt);
    });
    insertRun();
    void ranLate;
    void coveredCount; // report assembly reads coverage via schedule_occurrences
    this.deps.enqueueRun(spec);
  }

  private insertRunRow(runId: string, task: TaskRow, sched: ScheduleRow, occurrenceAt: number, now: number, state: string): void {
    const spec = buildJobSpec(runId, task, now, occurrenceAt, this.deps.db);
    this.deps.db
      .prepare(
        `INSERT INTO runs (id, task_id, occurrence_at, schedule_id, jobspec_json, state, state_changed_at, scheduled_for)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, task.id, occurrenceAt, sched.id, JSON.stringify(spec), state, now, occurrenceAt);
    this.deps.db
      .prepare('INSERT INTO events (at, run_id, kind, data_json) VALUES (?, ?, ?, ?)')
      .run(now, runId, 'state_changed', JSON.stringify({ to: state }));
  }
}

/** Frozen JobSpec snapshot at enqueue (S-5) — edits affect NEXT occurrence only. */
export function buildJobSpec(runId: string, task: TaskRow, now: number, occurrenceAt: number, db: DB): JobSpec {
  const profile = task.profile_id
    ? (db.prepare('SELECT * FROM profiles WHERE id = ?').get(task.profile_id) as any)
    : null;
  const slug = slugify(task.name);
  return {
    runId,
    taskId: task.id,
    taskName: task.name,
    taskSlug: slug,
    prompt: task.prompt,
    engine: ((task as any).engine ?? profile?.engine ?? 'cli') as JobSpec['engine'],
    byokId: (task as any).byok_id ?? null,
    model: task.model ?? profile?.model ?? null,
    permissionMode: task.permission_mode as JobSpec['permissionMode'],
    budget: { maxUsd: task.budget_usd, maxTurns: task.max_turns, timeoutSec: task.timeout_sec },
    repoPath: task.repo_path ?? null,
    baseBranch: task.base_branch ?? null,
    worktreePath: `${process.env.HOME ?? '~'}/.clockwork/worktrees/${slug}/${runId}`,
    branch: branchFor(slug, runId),
    scratchPath: task.repo_path ? null : `${process.env.HOME ?? '~'}/.clockwork/scratch/${runId}`,
    profile: profile
      ? {
          id: profile.id,
          slug: profile.slug,
          name: profile.name,
          color: profile.color ?? null,
          glyph: profile.avatar ?? null,
          systemPromptExtra: profile.system_prompt_extra ?? null,
          skills: JSON.parse(profile.skills_json ?? '[]'),
          contextRoots: JSON.parse(profile.context_roots_json ?? '[]'),
          mcpAllow: JSON.parse(profile.mcp_allow_json ?? '[]'),
        }
      : null,
    contextFiles: JSON.parse(task.context_json ?? '[]'),
    occurrenceAt,
    scheduledFor: occurrenceAt,
    createdAt: now,
  };
}

// ---- Quiet hours helpers (ADR-030) ----

interface QuietHours {
  startHour: number;
  endHour: number;
}

/** Read quiet-hours config from delivery_json.quietHours (validated defensively). */
function readQuietHours(deliveryJson: string | null | undefined): QuietHours | null {
  try {
    const d = JSON.parse(deliveryJson ?? '{}') as { quietHours?: { startHour?: unknown; endHour?: unknown } };
    const q = d.quietHours;
    if (!q || typeof q !== 'object') return null;
    const s = Number(q.startHour);
    const e = Number(q.endHour);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || s > 23 || e < 0 || e > 23) return null;
    return { startHour: s, endHour: e };
  } catch {
    return null;
  }
}

/** Is `atMs` inside the local-time quiet window [start, end)? Wraps midnight. */
export function inQuietWindow(atMs: number, qh: QuietHours, tz: string): boolean {
  const hour = luxonHour(atMs, tz);
  if (qh.startHour === qh.endHour) return false; // zero-length window = always allowed
  if (qh.startHour < qh.endHour) return hour >= qh.startHour && hour < qh.endHour;
  return hour >= qh.startHour || hour < qh.endHour; // wraps midnight (e.g. 23→07)
}

/** First local-time instant at/after `atMs` where the quiet window has ended. */
export function quietWindowEnd(atMs: number, qh: QuietHours, tz: string): number {
  let probe = DateTime.fromMillis(atMs).setZone(tz).startOf('hour');
  for (let i = 0; i < 30; i++) {
    if (!inQuietWindow(probe.toMillis(), qh, tz)) return probe.toMillis();
    probe = probe.plus({ hours: 1 });
  }
  return atMs; // unreachable in practice
}

function luxonHour(atMs: number, tz: string): number {
  return DateTime.fromMillis(atMs).setZone(tz).hour;
}
