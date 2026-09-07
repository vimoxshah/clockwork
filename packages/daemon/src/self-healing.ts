/**
 * F8 — self-healing (plan/AGENT-WORKFORCE-SPEC.md §4, "F8 — self-healing").
 *
 * After N consecutive failures of the same task, Clockwork books ONE diagnostic
 * run of that same task. The diagnostic reads the failed transcripts and writes
 * a proposal: change this prompt, or move to that profile, and here is why. The
 * proposal lands in the human's existing approvals inbox.
 *
 * THE AGENT NEVER EDITS ITS OWN PROMPT. `apply()` is the only writer of
 * `tasks.prompt` / `tasks.profile_id` in this feature, it runs only from an
 * explicit human action, and it is CAS-guarded so it can run at most once per
 * proposal. The diagnostic run itself is booked in permission mode 'plan' by
 * the injected `bookRun` (see the api.ts wiring snippet), so "propose, don't
 * apply" is enforced by the runner, not only by prompt wording.
 *
 * The failure counter is the EXISTING `task_failure_streaks` row (PK `task_id`
 * alone). `policies.ts` already writes that row with `kind='auth'`; this module
 * writes the same row with `kind='failure'` through its own
 * `ON CONFLICT(task_id) DO UPDATE`, so `kind` names the most recent failure
 * class. There is no second failure table and `policies.ts` is not touched.
 * `clearFailureStreak` deletes the row — which clears `diagnostic_at` too, and
 * that is the intended re-arm: a task that recovers gets a clean slate.
 */
import { z } from 'zod';
import { newId, RemediationProposal, RemediationStatus, RemediationTarget } from '@clockwork/shared';
import type { DB } from './db.js';

export interface SelfHealingDeps {
  db: DB;
  /** books the diagnostic run with an already-materialized prompt */
  bookRun(taskId: string, promptOverride: string): string | null;
}

/**
 * Stamped into every diagnostic prompt so a diagnostic run stays identifiable
 * from its jobspec alone. `diagnostic_run_id` is not enough on its own: a
 * diagnostic run that COMPLETES makes run-manager call `clearFailureStreak`,
 * which deletes the streak row and with it the id — while the run's jobspec
 * lives forever. The marker is what stops the recursion after that point.
 */
export const DIAGNOSTIC_MARKER = '[clockwork:self-heal-diagnostic]';

/** The fenced block `diagnosticPromptFor` asks the agent to end its summary with. */
const PROPOSAL_FENCE = /```clockwork-remediation[^\n]*\r?\n([\s\S]*?)```/i;

/** Default when `workforce_prefs` is somehow missing its singleton row. */
const DEFAULT_THRESHOLD = 3;

/** How many proposals `list()` returns when the caller names no limit. */
const DEFAULT_LIST_LIMIT = 100;

/**
 * Terminal states that count as "the task did not do what was asked".
 *
 * 'completed' clears the streak (run-manager.ts) and 'cancelled' is a human
 * decision, not an agent failure — neither may push a task toward a diagnostic.
 * 'budget_exceeded' does count: three runs in a row that burn the budget
 * without finishing is exactly the shape a prompt diagnosis is for.
 */
const FAILURE_STATES = new Set(['failed', 'timed_out', 'budget_exceeded']);

interface ProposalRow {
  id: string;
  task_id: string;
  run_id: string | null;
  approval_id: string | null;
  target: string;
  current_value: string | null;
  proposed_value: string;
  rationale: string | null;
  status: string;
  created_at: number;
  decided_at: number | null;
}

interface StreakRow {
  count: number;
  diagnostic_run_id: string | null;
  diagnostic_at: number | null;
}

interface RunRow {
  id: string;
  task_id: string;
  state: string;
  outcome_reason: string | null;
}

/** What the diagnostic agent is asked to emit; anything else is refused. */
const ProposalBlock = z.object({
  target: RemediationTarget,
  proposedValue: z.string().min(1),
  rationale: z.string().nullish(),
});

function toProposal(row: ProposalRow): RemediationProposal {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    approvalId: row.approval_id,
    target: row.target as RemediationTarget,
    currentValue: row.current_value,
    proposedValue: row.proposed_value,
    rationale: row.rationale,
    status: row.status as RemediationStatus,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export class SelfHealing {
  constructor(private readonly deps: SelfHealingDeps) {}

  // -------------------------------------------------------------------------
  // failure accounting
  // -------------------------------------------------------------------------

  /**
   * Call after a failed run finalizes; books a diagnostic when the streak
   * crosses the threshold. Returns null — and increments nothing — on every
   * run this feature must keep its hands off.
   */
  onRunFailed(taskId: string, runId: string, now: number = Date.now()): { diagnosticRunId: string } | null {
    const db = this.deps.db;

    const run = db
      .prepare('SELECT id, task_id, state, outcome_reason FROM runs WHERE id=?')
      .get(runId) as unknown as RunRow | undefined;
    if (!run) return null;

    // Not a failure of the work: 'completed' clears the streak elsewhere and
    // 'cancelled' is a human decision.
    if (!FAILURE_STATES.has(run.state)) return null;

    // policies.ts:12 already incremented this very row for the auth class, and
    // it auto-pauses the task at 2. Incrementing again would double-count a
    // paused task straight into a diagnostic it can never run.
    if (run.outcome_reason === 'auth') return null;

    // Recursion guard: a diagnostic that fails never books another diagnostic,
    // and never inflates the streak it was booked to explain.
    if (this.isDiagnosticRun(runId)) return null;

    const task = db
      .prepare('SELECT id FROM tasks WHERE id=? AND deleted_at IS NULL')
      .get(taskId) as unknown as { id: string } | undefined;
    if (!task) return null;

    // The shared streak row. `kind` names the most recent failure class.
    db.prepare(
      `INSERT INTO task_failure_streaks (task_id, kind, count, last_at) VALUES (?, 'failure', 1, ?)
       ON CONFLICT(task_id) DO UPDATE SET count = count + 1, last_at = ?, kind='failure'`,
    ).run(taskId, now, now);

    const streak = db
      .prepare('SELECT count, diagnostic_run_id, diagnostic_at FROM task_failure_streaks WHERE task_id=?')
      .get(taskId) as unknown as StreakRow | undefined;
    if (!streak) return null;

    if (streak.count < this.threshold()) return null;
    // One diagnostic per streak. The re-arm is `clearFailureStreak` deleting
    // the row on the next completed run, not a second booking on this one.
    if (streak.diagnostic_at !== null) return null;

    const transcripts = this.recentFailedTranscripts(taskId, this.threshold());
    const prompt = diagnosticPromptFor(this.taskNameOf(taskId), this.taskPromptOf(taskId), transcripts);

    let diagnosticRunId: string | null = null;
    try {
      diagnosticRunId = this.deps.bookRun(taskId, prompt);
    } catch {
      // Booking is best-effort: a refusing booker (paused daemon, policy gate,
      // missing repo) must never break the run that is finalizing.
      diagnosticRunId = null;
    }
    // No run booked means no diagnostic was spent — leave diagnostic_at NULL so
    // the next failure tries again instead of the streak silently going quiet.
    if (!diagnosticRunId) return null;

    db.prepare('UPDATE task_failure_streaks SET diagnostic_run_id=?, diagnostic_at=? WHERE task_id=?').run(
      diagnosticRunId,
      now,
      taskId,
    );
    return { diagnosticRunId };
  }

  // -------------------------------------------------------------------------
  // proposals
  // -------------------------------------------------------------------------

  /**
   * Turn a diagnostic run's report into a proposal plus an approvals row, so
   * the suggestion lands in the inbox the human already reads. Returns null for
   * anything that is not a well-formed proposal from a diagnostic run —
   * a missing report, a truncated block, an unknown profile. A refusal here is
   * a quiet no-op by design: a malformed diagnosis must never become a pending
   * edit to a task's prompt.
   */
  proposeFrom(
    runId: string,
    taskId: string,
    reportJson: string | null,
    now: number = Date.now(),
  ): RemediationProposal | null {
    const db = this.deps.db;
    if (!reportJson) return null;
    if (!this.isDiagnosticRun(runId)) return null;

    // Idempotency: the finalize hook is best-effort and may be reached twice
    // for one run (recovery sweep, retry). One diagnostic, one proposal.
    const existing = db
      .prepare('SELECT id FROM remediation_proposals WHERE run_id=?')
      .get(runId) as unknown as { id: string } | undefined;
    if (existing) return null;

    const task = db
      .prepare('SELECT id, prompt, profile_id FROM tasks WHERE id=? AND deleted_at IS NULL')
      .get(taskId) as unknown as { id: string; prompt: string; profile_id: string | null } | undefined;
    if (!task) return null;

    const block = parseProposalBlock(reportJson);
    if (!block) return null;

    let proposedValue = block.proposedValue.trim();
    let currentValue: string | null;
    if (block.target === 'profile') {
      // Store the profile ID, never the slug: tasks.profile_id carries an FK,
      // and resolving at apply time would fail the UPDATE with nothing left to
      // report. An unknown profile is refused here instead.
      const profile = db
        .prepare('SELECT id FROM profiles WHERE id=? OR slug=?')
        .get(proposedValue, proposedValue) as unknown as { id: string } | undefined;
      if (!profile) return null;
      proposedValue = profile.id;
      currentValue = task.profile_id;
    } else {
      currentValue = task.prompt;
    }

    const id = newId();
    const approvalId = newId();
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO remediation_proposals
           (id, task_id, run_id, approval_id, target, current_value, proposed_value, rationale, status, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, NULL)`,
      ).run(id, taskId, runId, approvalId, block.target, currentValue, proposedValue, block.rationale ?? null, now);
      // §2.4 — the inbox item. run_id is the diagnostic run; timeout_at is inert
      // here (nothing sweeps it), so the 30-day value is an honest placeholder
      // for "waits for a human indefinitely".
      db.prepare(
        `INSERT INTO approvals (id, run_id, kind, payload_json, requested_at, timeout_at, fallback)
         VALUES (?, ?, 'question', ?, ?, ?, 'deny-and-continue')`,
      ).run(
        approvalId,
        runId,
        JSON.stringify({ proposalId: id, target: block.target, proposedValue }),
        now,
        now + 30 * 86_400_000,
      );
    });
    tx();

    return this.get(id) ?? null;
  }

  list(status?: RemediationStatus, limit: number = DEFAULT_LIST_LIMIT): RemediationProposal[] {
    const capped = Math.max(1, Math.min(Math.floor(limit) || DEFAULT_LIST_LIMIT, 500));
    const rows = status
      ? (this.deps.db
          .prepare('SELECT * FROM remediation_proposals WHERE status=? ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(status, capped) as unknown as ProposalRow[])
      : (this.deps.db
          .prepare('SELECT * FROM remediation_proposals ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(capped) as unknown as ProposalRow[]);
    return rows.map(toProposal);
  }

  get(id: string): RemediationProposal | undefined {
    const row = this.deps.db
      .prepare('SELECT * FROM remediation_proposals WHERE id=?')
      .get(id) as unknown as ProposalRow | undefined;
    return row ? toProposal(row) : undefined;
  }

  /**
   * The ONLY writer of `tasks.prompt` / `tasks.profile_id` in this feature, and
   * it runs only from an explicit human action. CAS on `decided_at IS NULL`, so
   * a second click — or the inbox arriving first — gets 'already_resolved'
   * rather than writing the task twice. `tasks.version` is bumped so an open
   * editor gets a 409 instead of clobbering the applied change.
   */
  apply(id: string, now: number = Date.now()): RemediationProposal | 'not_found' | 'already_resolved' {
    const db = this.deps.db;
    const row = db
      .prepare('SELECT * FROM remediation_proposals WHERE id=?')
      .get(id) as unknown as ProposalRow | undefined;
    if (!row) return 'not_found';
    if (row.decided_at !== null) return 'already_resolved';

    const task = db
      .prepare('SELECT id FROM tasks WHERE id=? AND deleted_at IS NULL')
      .get(row.task_id) as unknown as { id: string } | undefined;
    if (!task) return 'not_found';

    if (row.target === 'profile') {
      // The profile was deleted between propose and apply. Refuse WITHOUT
      // deciding the proposal: an FK failure inside the write would surface as
      // a 500, and silently flipping it to 'applied' would report a change that
      // never happened. The proposal stays open for the human to reject.
      const profile = db
        .prepare('SELECT id FROM profiles WHERE id=?')
        .get(row.proposed_value) as unknown as { id: string } | undefined;
      if (!profile) return 'not_found';
    }

    const tx = db.transaction((): boolean => {
      const cas = db
        .prepare(`UPDATE remediation_proposals SET status='applied', decided_at=? WHERE id=? AND decided_at IS NULL`)
        .run(now, id);
      if (cas.changes === 0) return false;
      if (row.target === 'profile') {
        db.prepare('UPDATE tasks SET profile_id=?, version=version+1, updated_at=? WHERE id=?').run(
          row.proposed_value,
          now,
          row.task_id,
        );
      } else {
        db.prepare('UPDATE tasks SET prompt=?, version=version+1, updated_at=? WHERE id=?').run(
          row.proposed_value,
          now,
          row.task_id,
        );
      }
      this.closeApproval(row.approval_id, now, 'approved');
      return true;
    });

    if (!tx()) return 'already_resolved';
    return this.get(id) ?? 'not_found';
  }

  /** Refuse the proposal. Writes nothing to the task — that is the whole point. */
  reject(id: string, now: number = Date.now()): RemediationProposal | 'not_found' | 'already_resolved' {
    const db = this.deps.db;
    const row = db
      .prepare('SELECT id, approval_id, decided_at FROM remediation_proposals WHERE id=?')
      .get(id) as unknown as Pick<ProposalRow, 'id' | 'approval_id' | 'decided_at'> | undefined;
    if (!row) return 'not_found';

    const tx = db.transaction((): boolean => {
      const cas = db
        .prepare(`UPDATE remediation_proposals SET status='rejected', decided_at=? WHERE id=? AND decided_at IS NULL`)
        .run(now, id);
      if (cas.changes === 0) return false;
      this.closeApproval(row.approval_id, now, 'denied');
      return true;
    });

    if (!tx()) return 'already_resolved';
    return this.get(id) ?? 'not_found';
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * CAS-close the linked inbox item. `changes === 0` is not an error: it means
   * the human answered in the inbox first (or run finalize auto-denied it), and
   * §2.4 requires both paths to land in the same state.
   */
  private closeApproval(approvalId: string | null, now: number, decision: 'approved' | 'denied'): void {
    if (!approvalId) return;
    this.deps.db
      .prepare('UPDATE approvals SET responded_at=?, response_json=? WHERE id=? AND responded_at IS NULL')
      .run(now, JSON.stringify({ decision, resolvedBy: 'self-healing' }), approvalId);
  }

  /** Threshold from the shared prefs singleton (workforce_prefs, id = 1). */
  private threshold(): number {
    const row = this.deps.db
      .prepare('SELECT self_heal_failure_threshold t FROM workforce_prefs WHERE id=1')
      .get() as unknown as { t: number } | undefined;
    const t = row?.t;
    return typeof t === 'number' && t >= 2 ? t : DEFAULT_THRESHOLD;
  }

  /**
   * A run is a diagnostic when its jobspec prompt carries the marker, or when
   * the streak row still points at it. The marker outlives the streak row; the
   * id match covers a run whose jobspec could not be read.
   */
  private isDiagnosticRun(runId: string): boolean {
    const db = this.deps.db;
    const byMarker = db
      .prepare(
        `SELECT id FROM runs
          WHERE id=? AND instr(COALESCE(json_extract(jobspec_json, '$.prompt'), ''), ?) > 0`,
      )
      .get(runId, DIAGNOSTIC_MARKER) as unknown as { id: string } | undefined;
    if (byMarker) return true;
    const byId = db
      .prepare('SELECT task_id FROM task_failure_streaks WHERE diagnostic_run_id=?')
      .get(runId) as unknown as { task_id: string } | undefined;
    return Boolean(byId);
  }

  /** The last `limit` failed transcripts for the task, oldest first. */
  private recentFailedTranscripts(taskId: string, limit: number): string[] {
    const rows = this.deps.db
      .prepare(
        `SELECT transcript_path FROM runs
          WHERE task_id=? AND transcript_path IS NOT NULL AND state IN ('failed','timed_out','budget_exceeded')
          ORDER BY COALESCE(ended_at, scheduled_for, state_changed_at) DESC, id DESC
          LIMIT ?`,
      )
      .all(taskId, Math.max(1, limit)) as unknown as Array<{ transcript_path: string }>;
    return rows.map((r) => r.transcript_path).reverse();
  }

  private taskNameOf(taskId: string): string {
    const row = this.deps.db
      .prepare('SELECT name FROM tasks WHERE id=?')
      .get(taskId) as unknown as { name: string } | undefined;
    return row?.name ?? taskId;
  }

  private taskPromptOf(taskId: string): string {
    const row = this.deps.db
      .prepare('SELECT prompt FROM tasks WHERE id=?')
      .get(taskId) as unknown as { prompt: string } | undefined;
    return row?.prompt ?? '';
  }
}

/**
 * Pull the proposal out of a run report. Reports are stored as bare JSON and
 * never re-validated, so every step here is defensive: unparseable JSON, a
 * missing summary, a summary that an engine truncated mid-block (hermes and
 * opencode cap `summary` at 400 characters), or a block whose shape is wrong
 * all return null rather than a half-read proposal.
 */
function parseProposalBlock(reportJson: string): z.infer<typeof ProposalBlock> | null {
  let summary: string;
  try {
    const report = JSON.parse(reportJson) as { summary?: unknown };
    if (typeof report?.summary !== 'string') return null;
    summary = report.summary;
  } catch {
    return null;
  }
  const match = PROPOSAL_FENCE.exec(summary);
  if (!match?.[1]) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const parsed = ProposalBlock.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The diagnostic prompt: read these transcripts, propose ONE change, change
 * nothing. The marker on the first line is what makes the resulting run
 * identifiable as a diagnostic for the rest of its life (see DIAGNOSTIC_MARKER).
 */
export function diagnosticPromptFor(taskName: string, currentPrompt: string, transcriptPaths: string[]): string {
  const transcripts = transcriptPaths.length
    ? transcriptPaths.map((p, i) => `${i + 1}. ${p}`).join('\n')
    : '(no transcripts were retained for these runs — reason from the prompt alone)';
  return [
    DIAGNOSTIC_MARKER,
    `The scheduled task "${taskName}" has failed several times in a row. You are the`,
    'diagnostician. Find out why, and propose exactly one change.',
    '',
    '# Read only',
    'Do NOT edit, create, move or delete any file. Do NOT run the task. Do NOT commit,',
    'push, or change any configuration. You are here to read and to advise; a human',
    'applies your suggestion, or does not.',
    '',
    '# Transcripts of the failed runs',
    transcripts,
    '',
    '# The task prompt as it stands today',
    '---',
    currentPrompt,
    '---',
    '',
    '# What to produce',
    'Propose ONE change, and only one: either a replacement prompt, or a different',
    'agent profile to run this task under. Say plainly why the evidence points there.',
    '',
    'End your summary with exactly this fenced block and nothing after it:',
    '',
    '```clockwork-remediation',
    '{',
    '  "target": "prompt",',
    '  "proposedValue": "<the complete replacement prompt, or the profile slug>",',
    '  "rationale": "<one or two sentences of evidence from the transcripts>"',
    '}',
    '```',
    '',
    'Use "target": "profile" instead, with a profile slug as proposedValue, when the',
    'prompt is fine and the task is simply running under the wrong agent. If the',
    'transcripts do not support any single change, say so in your summary and emit no',
    'block — no proposal is better than a guess a human has to undo.',
  ].join('\n');
}
