/**
 * F1 plan-then-execute (plan/AGENT-WORKFORCE-SPEC.md §F1).
 *
 * One booking becomes two runs: a PLAN-mode run at a human hour whose report
 * becomes an approval item, then an EXECUTE run gated on that approval and fed
 * the plan through the existing `{{previous.report}}` binding. No new engine
 * code — this composes TaskRepo, renderChainPrompt and the `approvals` inbox.
 *
 * Why a table and not just `chain_after`: chain firing is one-shot at the
 * upstream run's terminal state and filters `enabled = 1`
 * (run-manager.ts:603). The human's verdict lands AFTER the plan run has
 * already ended, so the chain can never carry it. The `plan_execute_pairs` row
 * is the durable gate across that gap.
 *
 * THE INVARIANT: nothing in this module ever sets the execute task's
 * `enabled` to 1. `enabled = 0` is the gate. The execute run is booked
 * directly through `deps.bookRun`; re-enabling the task would re-arm the
 * one-shot chain and let a later plan run fire execute with no approval.
 *
 * RECOVERY (T1-11): the verdict commits BEFORE the booking, so a refused
 * booking used to strand the pair at 'approved' with no execute run and no way
 * back — a second resolve answered 'already_resolved' and nothing re-booked it.
 * `resolve` now reads a second 'approved' on exactly that shape as a RETRY of
 * the booking rather than as a second verdict: same route, same
 * `bookExecute`, same rendered plan, and `decided_at` untouched. It opens no
 * new way in. Only a pair a human already approved can reach it, so the gate
 * this module exists to hold is unchanged.
 */
import { DateTime } from 'luxon';
import {
  TaskCreate,
  newId,
  type PlanExecuteCreate,
  type PlanExecutePair,
  type PlanExecuteStatus,
} from '@clockwork/shared';
import type { DB } from './db.js';
import { TaskRepo, type TaskRow } from './repo.js';
import { renderChainPrompt } from './templates.js';
import { wallTimeToUtcMs } from './recurrence.js';

export interface PlanExecuteDeps {
  db: DB;
  /** books a run for taskId with an already-materialized prompt; returns the run id */
  bookRun(taskId: string, promptOverride: string): string | null;
}

/**
 * TaskRow with the two columns repo.ts does not declare but 0002/0003 added.
 * Cloning a task has to carry them or the halves silently change provider.
 */
interface SourceTaskRow extends TaskRow {
  engine: string | null;
  byok_id: string | null;
}

interface PairRow {
  id: string;
  plan_task_id: string;
  execute_task_id: string;
  plan_run_id: string | null;
  approval_id: string | null;
  execute_run_id: string | null;
  status: string;
  decided_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Longest plan summary carried into the approval payload. */
const PLAN_PAYLOAD_CHARS = 8_000;
/** tasks.name is max 120 chars (TaskCreate); a long source name must still pair. */
const NAME_CHARS = 120;

// ---------------------------------------------------------------------------
// prompt wrappers
// ---------------------------------------------------------------------------

/** The plan half: produce a plan a human can approve, and change nothing. */
export function planPromptFor(basePrompt: string): string {
  return [
    'You are the PLAN half of a plan-then-execute pair. Produce a plan; do NOT do the work.',
    'Change no file, run no mutating command, commit nothing. Read whatever you need.',
    '',
    'Write the plan so a human can approve it in one reading:',
    '  1. what you will change, file by file',
    '  2. the order you will do it in',
    '  3. what could go wrong, and how you would notice',
    '',
    'Your report summary IS the approval item a human sees, so put the plan there.',
    '',
    'The work to plan:',
    basePrompt,
  ].join('\n');
}

/**
 * The execute half: carry out the approved plan. The `{{previous.report}}`
 * placeholder is required — renderChainPrompt (templates.ts:85) binds the plan
 * run's report into it at resolve time.
 */
export function executePromptFor(basePrompt: string): string {
  return [
    'You are the EXECUTE half of a plan-then-execute pair. A human has read and APPROVED the plan below.',
    'Carry out that plan. Do not redesign it. If it cannot be followed as written, stop and say why',
    'instead of improvising — a different plan was never approved.',
    '',
    'The approved plan:',
    '{{previous.report}}',
    '',
    'The original request the plan was written for:',
    basePrompt,
  ].join('\n');
}

// ---------------------------------------------------------------------------

export class PlanExecute {
  private readonly db: DB;
  private readonly tasks: TaskRepo;

  constructor(private readonly deps: PlanExecuteDeps) {
    this.db = deps.db;
    this.tasks = new TaskRepo(deps.db);
  }

  /**
   * Clone the source task into a plan half (once, at planHour in tz, enabled)
   * and an execute half (queue-kind schedule, DISABLED — the gate).
   * Returns `{ error }` for anything a human can fix: unknown task, unknown
   * zone, a prompt too long to survive wrapping.
   */
  createPair(input: PlanExecuteCreate, now: number = Date.now()): PlanExecutePair | { error: string } {
    const source = this.tasks.get(input.taskId) as SourceTaskRow | undefined;
    if (!source) return { error: `unknown task '${input.taskId}'` };

    const planAt = nextLocalHour(now, input.planHour, input.tz);
    if (planAt === null) return { error: `unknown time zone '${input.tz}'` };

    const common = {
      profileId: source.profile_id ?? undefined,
      repoPath: source.repo_path ?? undefined,
      baseBranch: source.base_branch ?? undefined,
      model: source.model ?? undefined,
      engine: source.engine ?? undefined,
      byokId: source.byok_id ?? undefined,
      budget: { maxUsd: source.budget_usd, maxTurns: source.max_turns, timeoutSec: source.timeout_sec },
      overlapPolicy: source.overlap_policy,
      missedPolicy: source.missed_policy,
      missedWindowSec: source.missed_window_sec,
      retryOnTransient: Boolean(source.retry_on_transient),
      context: contextOf(source.context_json),
      delivery: deliveryOf(source.delivery_json),
      // chain_after / chain_on / template_id are deliberately NOT cloned: a
      // plan half chained after some third task would fire as that task's
      // successor, outside this gate entirely.
    };

    const plan = TaskCreate.safeParse({
      ...common,
      name: clipName(`${source.name} — plan`),
      prompt: planPromptFor(source.prompt),
      // the plan half never edits: 'plan' is the whole point of the half
      permissionMode: 'plan',
      schedule: { kind: 'once', runAt: planAt, tz: input.tz },
    });
    if (!plan.success) return { error: `plan half is not a valid task: ${issuesOf(plan.error)}` };

    const execute = TaskCreate.safeParse({
      ...common,
      name: clipName(`${source.name} — execute`),
      prompt: executePromptFor(source.prompt),
      // the source's own mode, never an escalation of it
      permissionMode: source.permission_mode,
      // queue-kind schedules are stored enabled=0 with next_fire NULL, so the
      // scheduler cannot pick this half up even if the task were re-enabled.
      schedule: { kind: 'queue', tz: input.tz },
    });
    if (!execute.success) return { error: `execute half is not a valid task: ${issuesOf(execute.error)}` };

    const pairId = newId();
    const tx = this.db.transaction(() => {
      const planRow = this.tasks.create(plan.data, source.profile_id, planAt);
      this.db.prepare(`UPDATE tasks SET plan_stage='plan' WHERE id=?`).run(planRow.id);

      // chain_after records provenance only. The gate is enabled=0 below —
      // see the header invariant.
      const executeRow = this.tasks.create({ ...execute.data, chainAfter: planRow.id }, source.profile_id, null);
      this.db.prepare(`UPDATE tasks SET plan_stage='execute', enabled=0 WHERE id=?`).run(executeRow.id);

      this.db
        .prepare(
          `INSERT INTO plan_execute_pairs (id, plan_task_id, execute_task_id, status, created_at, updated_at)
           VALUES (?, ?, ?, 'awaiting_plan', ?, ?)`,
        )
        .run(pairId, planRow.id, executeRow.id, now, now);
    });
    tx();

    return this.get(pairId)!;
  }

  get(id: string): PlanExecutePair | undefined {
    const row = this.db.prepare('SELECT * FROM plan_execute_pairs WHERE id=?').get(id) as PairRow | undefined;
    return row ? toPair(row) : undefined;
  }

  list(status?: PlanExecuteStatus): PlanExecutePair[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM plan_execute_pairs WHERE status=? ORDER BY created_at DESC')
          .all(status) as PairRow[])
      : (this.db.prepare('SELECT * FROM plan_execute_pairs ORDER BY created_at DESC').all() as PairRow[]);
    return rows.map(toPair);
  }

  /**
   * The gate as a QUESTION the ordinary task routes can ask: is `taskId` the
   * execute half of a pair, and where does that pair stand?
   *
   * `enabled = 0` keeps the scheduler and the chain away from an execute half,
   * but three routes reach a task row directly — run-now, the webhook fire
   * path and `PATCH {enabled:true}` — and none of them can read `enabled` as a
   * gate, because the first two ignore it and the third rewrites it. They ask
   * this instead. Returns null for every ordinary task: only `createPair`
   * writes this table, and it clones a FRESH execute task per pair, so there
   * is at most one row per `execute_task_id`.
   */
  pairForExecuteTask(taskId: string): { pairId: string; status: PlanExecuteStatus } | null {
    const row = this.db
      .prepare('SELECT id, status FROM plan_execute_pairs WHERE execute_task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(taskId) as { id: string; status: string } | undefined;
    return row ? { pairId: row.id, status: row.status as PlanExecuteStatus } : null;
  }

  /**
   * Call at finalize. When runId is the run of a pair's plan half:
   *  - completed  -> open an approvals row (§2.4) and move to awaiting_approval
   *  - anything else -> the pair is rejected and NO approval is opened; there
   *    is no plan to approve, and a half-finished plan must not be executed.
   * Returns null for every run that is not a waiting pair's plan run.
   */
  onPlanRunFinalized(
    runId: string,
    taskId: string,
    state: string,
    now: number = Date.now(),
  ): { pairId: string; approvalId: string } | null {
    const row = this.db
      .prepare(`SELECT * FROM plan_execute_pairs WHERE plan_task_id=? AND status='awaiting_plan' ORDER BY created_at ASC LIMIT 1`)
      .get(taskId) as PairRow | undefined;
    if (!row) return null;

    if (state !== 'completed') {
      // CAS: a second finalize for the same pair changes nothing.
      this.db
        .prepare(
          `UPDATE plan_execute_pairs SET status='rejected', plan_run_id=?, decided_at=?, updated_at=?
           WHERE id=? AND status='awaiting_plan'`,
        )
        .run(runId, now, now, row.id);
      return null;
    }

    const approvalId = newId();
    const plan = planSummaryOf(this.planReportJson(runId));
    const claimed = this.db.transaction(() => {
      const r = this.db
        .prepare(
          `UPDATE plan_execute_pairs SET status='awaiting_approval', plan_run_id=?, approval_id=?, updated_at=?
           WHERE id=? AND status='awaiting_plan'`,
        )
        .run(runId, approvalId, now, row.id);
      if (r.changes === 0) return false;
      // §2.4: the inbox item. timeout_at is inert here — nothing sweeps the
      // table on it; these items wait for a human indefinitely, by design.
      this.db
        .prepare(
          `INSERT INTO approvals (id, run_id, kind, payload_json, requested_at, timeout_at, fallback)
           VALUES (?, ?, 'question', ?, ?, ?, 'deny-and-continue')`,
        )
        .run(approvalId, runId, JSON.stringify({ pairId: row.id, plan }), now, now + 30 * 86_400_000);
      return true;
    })();
    if (!claimed) return null;

    return { pairId: row.id, approvalId };
  }

  /**
   * The human's verdict. 'approved' books the execute run with the plan bound
   * into `{{previous.report}}`; 'rejected' closes the pair. Both paths CAS-close
   * the linked approvals row, so the inbox's own respond route and this one
   * land in the same state and whichever arrives second is a no-op (§2.4).
   *
   * A pair that has not reached the gate yet (status 'awaiting_plan') is NOT
   * resolvable: approving a plan that was never written would book an execute
   * run against an empty report. The contract's failure vocabulary has no third
   * value, so that case reports 'already_resolved' — a 409, never a booking.
   *
   * ONE exception, and it is a retry rather than a verdict (T1-11): a pair
   * already sitting at 'approved' with NO execute run is a booking that was
   * refused after the verdict committed. A second 'approved' re-runs
   * `bookExecute` for it — the verdict is not re-taken, `decided_at` does not
   * move, and the approvals row is already closed. Every other shape still
   * answers 'already_resolved', including 'rejected' against a stranded pair:
   * a recorded verdict never flips.
   */
  resolve(
    pairId: string,
    decision: 'approved' | 'rejected',
    now: number = Date.now(),
  ): PlanExecutePair | 'not_found' | 'already_resolved' {
    const r = this.db
      .prepare(
        `UPDATE plan_execute_pairs SET status=?, decided_at=?, updated_at=?
         WHERE id=? AND decided_at IS NULL AND status='awaiting_approval'`,
      )
      .run(decision === 'approved' ? 'approved' : 'rejected', now, now, pairId);
    if (r.changes === 0) {
      // Not a verdict — but it may be the retry of a refused booking.
      const stranded = decision === 'approved' ? this.strandedPair(pairId) : undefined;
      if (stranded) return this.bookExecute(stranded, now);
      return this.db.prepare('SELECT id FROM plan_execute_pairs WHERE id=?').get(pairId)
        ? 'already_resolved'
        : 'not_found';
    }

    const row = this.db.prepare('SELECT * FROM plan_execute_pairs WHERE id=?').get(pairId) as PairRow;

    if (row.approval_id) {
      try {
        // CAS: the inbox may have closed it first; then this is a no-op and the
        // verdict above still stands. Non-fatal either way — the pair row, not
        // the approvals row, is the gate.
        this.db
          .prepare('UPDATE approvals SET responded_at=?, response_json=? WHERE id=? AND responded_at IS NULL')
          .run(now, JSON.stringify({ decision, resolvedBy: 'plan-execute' }), row.approval_id);
      } catch {
        /* closing the inbox item must never undo a recorded verdict */
      }
    }

    if (decision !== 'approved') return toPair(row);

    return this.bookExecute(row, now);
  }

  /**
   * A pair stranded by a refused booking, or undefined for every other shape.
   *
   * The three columns together are the whole gate on the retry path, and each
   * one refuses something different: `status='approved'` keeps out a pair no
   * human ever approved ('awaiting_plan', 'awaiting_approval') and one whose
   * plan was refused ('rejected'); `execute_run_id IS NULL` keeps out
   * 'executed', where re-booking would mean a second run off one approval; and
   * `decided_at IS NOT NULL` is the second lock on the first — no row reaches
   * 'approved' without a recorded verdict, and one that did is not a verdict.
   */
  private strandedPair(pairId: string): PairRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM plan_execute_pairs
          WHERE id=? AND status='approved' AND execute_run_id IS NULL AND decided_at IS NOT NULL`,
      )
      .get(pairId) as PairRow | undefined;
  }

  /**
   * Book the execute run for an APPROVED pair, with the plan bound in. The one
   * place F1 books, called by the verdict and by the retry alike — so the
   * retry cannot drift into booking a prompt the first attempt would not have
   * sent. Returns the pair as it now stands: 'executed' with a run id, or
   * unchanged at 'approved' when the booking was refused again.
   */
  private bookExecute(row: PairRow, now: number): PlanExecutePair {
    const executeTask = this.tasks.get(row.execute_task_id);
    if (!executeTask) return toPair(row); // deleted mid-decision: approved, nothing to book

    const planRun = row.plan_run_id
      ? (this.db.prepare('SELECT report_json FROM runs WHERE id=?').get(row.plan_run_id) as
          | { report_json: string | null }
          | undefined)
      : undefined;
    // F1 renders the binding itself; it does not rely on chain firing. The
    // rendered prompt is passed to the booker and never written back to
    // tasks.prompt, so a retry re-renders from the same template and the same
    // plan run — this is what makes the retry carry the plan the first attempt
    // would have carried.
    const prompt = renderChainPrompt(executeTask.prompt, planRun);

    // NOTE: the execute task stays enabled=0. It is booked directly.
    //
    // S-review: the verdict CAS has already committed before this runs, so a
    // throw out of the booker would escape as a 500 on a decision that is
    // recorded. F8 wraps its own booker for the same reason
    // (self-healing.ts:170-176). A thrown refusal is treated as a returned
    // one — same landing, no run, and the pair stays retryable.
    let executeRunId: string | null = null;
    try {
      executeRunId = this.deps.bookRun(row.execute_task_id, prompt);
    } catch {
      executeRunId = null;
    }
    // Refused (policy, deleted half, …): stays 'approved' with no run, which is
    // the shape strandedPair reads — the pair stays retryable rather than lost.
    if (!executeRunId) return toPair(row);

    this.db
      .prepare(
        `UPDATE plan_execute_pairs SET status='executed', execute_run_id=?, updated_at=?
         WHERE id=? AND execute_run_id IS NULL`,
      )
      .run(executeRunId, now, row.id);
    return this.get(row.id)!;
  }

  private planReportJson(runId: string): string | null {
    const run = this.db.prepare('SELECT report_json FROM runs WHERE id=?').get(runId) as
      | { report_json: string | null }
      | undefined;
    return run?.report_json ?? null;
  }
}

// ---------------------------------------------------------------------------
// helpers (private to F1)
// ---------------------------------------------------------------------------

function toPair(row: PairRow): PlanExecutePair {
  return {
    id: row.id,
    planTaskId: row.plan_task_id,
    executeTaskId: row.execute_task_id,
    planRunId: row.plan_run_id ?? null,
    approvalId: row.approval_id ?? null,
    executeRunId: row.execute_run_id ?? null,
    status: row.status as PlanExecuteStatus,
    decidedAt: row.decided_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The next instant at which the local wall clock in `tz` reads `hour:00`,
 * strictly after `now`. Returns null for a zone luxon does not know.
 * DST is handled by wallTimeToUtcMs (recurrence.ts) — same rules as every
 * other next-fire in the product (S-20/S-21).
 */
function nextLocalHour(now: number, hour: number, tz: string): number | null {
  const local = DateTime.fromMillis(now, { zone: tz });
  if (!local.isValid) return null;
  let wall = DateTime.fromObject({ year: local.year, month: local.month, day: local.day, hour }, { zone: 'utc' });
  let at = wallTimeToUtcMs(wall, tz);
  if (at <= now) {
    wall = wall.plus({ days: 1 });
    at = wallTimeToUtcMs(wall, tz);
  }
  return at;
}

/** The plan a human is about to approve: the report summary plus its artifacts. */
function planSummaryOf(reportJson: string | null): string {
  if (!reportJson) return '(the plan run produced no report)';
  try {
    const report = JSON.parse(reportJson) as { summary?: unknown; artifacts?: unknown };
    let text = typeof report.summary === 'string' ? report.summary : '';
    const artifacts = Array.isArray(report.artifacts) ? report.artifacts.map(String) : [];
    if (artifacts.length > 0) text += `\nArtifacts: ${artifacts.join(', ')}`;
    return text.length > 0 ? clip(text, PLAN_PAYLOAD_CHARS) : '(the plan run produced an empty summary)';
  } catch {
    return '(the plan run produced an unreadable report)';
  }
}

function clip(text: string, budget: number): string {
  return text.length > budget ? `${text.slice(0, budget)}… [truncated to fit context budget]` : text;
}

/** Names are cosmetic and hard-capped at 120 by TaskCreate — cut, never annotate. */
function clipName(name: string): string {
  return name.length > NAME_CHARS ? name.slice(0, NAME_CHARS) : name;
}

function contextOf(json: string | null): { files: unknown[] } {
  try {
    const parsed = JSON.parse(json ?? '');
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { files?: unknown }).files)) {
      return parsed as { files: unknown[] };
    }
  } catch {
    /* a task row written before the {files:[]} shape settled; start empty */
  }
  return { files: [] };
}

function deliveryOf(json: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through to the schema's own defaults */
  }
  return {};
}

/** zod issues flattened into one sentence a human can act on (§2.2). */
function issuesOf(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
