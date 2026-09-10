import { z } from 'zod';
import { ProposedEvent } from './workforce.js';

/**
 * Run Report — FR-15. The DB stores report_json (summary + pointers); big
 * payloads (transcript, diffs) live on disk under ~/.clockwork/runs/<run-id>/.
 */
export const DiffFileStat = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean().default(false),
});
export type DiffFileStat = z.infer<typeof DiffFileStat>;

export const TimelineEntry = z.object({
  at: z.number(),
  kind: z.enum([
    'state',
    'usage',
    'policy_deny',
    'sandbox_violation',
    'approval_requested',
    'approval_resolved',
    'budget_stop',
    'delivery',
    'note',
  ]),
  text: z.string(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const ApprovalRecord = z.object({
  id: z.string(),
  kind: z.enum(['permission', 'question']),
  payload: z.unknown(),
  requestedAt: z.number(),
  resolvedAt: z.number().nullable(),
  resolution: z.enum(['approved', 'denied', 'timeout-deny-and-continue', 'timeout-abort']).nullable(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

export const DeliveryReceipt = z.object({
  channel: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  attempts: z.number().int().positive(),
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>;

/**
 * What happened to the run's worktree at finalize. `reason` names why it was
 * kept — 'committed' | 'interrupted' | 'in_progress_op' | 'dirty' — and is null
 * when it was pruned (clean, committed nothing, ended normally) or when the run
 * had no repo.
 */
export const WorktreeStateRecord = z.object({
  preserved: z.boolean(),
  path: z.string().nullable(),
  dirty: z.boolean(),
  interruptedOp: z.string().nullable(),
  reason: z.string().nullable(),
});
export type WorktreeStateRecord = z.infer<typeof WorktreeStateRecord>;

export const RunReport = z.object({
  runId: z.string(),
  taskId: z.string(),
  taskName: z.string(),
  profile: z
    .object({ slug: z.string(), name: z.string(), color: z.string().nullable(), glyph: z.string().nullable() })
    .nullable(),
  engine: z.string(),
  cliVersion: z.string().nullable(), // R-2: record `claude --version` per run
  state: z.string(),
  failureReason: z.string().nullable(),
  summary: z.string(), // agent-authored, structured-output-forced
  branch: z.string().nullable(),
  baseSha: z.string().nullable(),
  basedOnLocalState: z.boolean().default(false), // S-35 banner
  committedSomething: z.boolean().default(false), // S-39: analysis-only runs are valid
  sandboxed: z.boolean().nullable().default(null), // false = CW_SANDBOX=off; null = engine never reported
  worktreeState: WorktreeStateRecord.nullable().default(null), // null = no repo, or report predates the field
  diffStat: z.array(DiffFileStat).default([]),
  artifacts: z.array(z.string()).default([]),
  transcriptPath: z.string().nullable(),
  costUsd: z.number().nonnegative().default(0),
  turns: z.number().int().nonnegative().default(0),
  softCapOvershootUsd: z.number().nonnegative().default(0), // FR-10 measured overshoot
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  ranLateMs: z.number().nonnegative().default(0), // S-10 banner data
  coveredOccurrences: z.array(z.number()).default([]), // S-11 coalescing disclosure
  /**
   * S-16 / T1-9. How long this Mac was ASLEEP inside the run's window, in ms.
   * Produced by `KeepAwake.sleepDuring()`; see its docstring for the method.
   *
   * Three states, and the third is the point of the field:
   *   `undefined` — NOBODY CHECKED. Off macOS, or a run this daemon never
   *                 observed (recovered after a restart), or a report written
   *                 before T1-9. Not a claim that the Mac stayed awake.
   *   `0`         — watched end to end, no sleep found.
   *   `> 0`       — frozen for at least this long. It is a floor: the
   *                 sampler subtracts one scheduled interval from each gap.
   *
   * `.optional()` and not `.default(0)`, for the reason spelled out at length
   * on `proposedEvents` below — RunReport is the zod OUTPUT type, so a default
   * makes the key REQUIRED on every report literal and writes a value into
   * `report_json` for every run. Here that written value would be the very
   * lie the field exists to stop telling.
   */
  sleptDuringRunMs: z.number().nonnegative().optional(),
  /**
   * The boolean face of `sleptDuringRunMs`, kept because the README and the
   * S-16 note both name it. Same three states; `undefined` = not checked.
   *
   * DO NOT RENDER OFF THIS FIELD. Until T1-9 it was `.default(false)` and
   * `run-manager.finalize()` wrote a literal `false` on every run without
   * ever computing it, so every report stored before then carries a `false`
   * that means "nobody looked". `sleptDuringRunMs` is absent on all of those,
   * which is why readers key off that one instead.
   */
  sleptThroughKeepAwake: z.boolean().optional(),
  approvals: z.array(ApprovalRecord).default([]),
  timeline: z.array(TimelineEntry).default([]),
  deliveries: z.array(DeliveryReceipt).default([]),
  queueDelayMs: z.number().nonnegative().default(0), // S-3/S-28 visibility
  repoLockDelayMs: z.number().nonnegative().default(0),
  /**
   * F9 proposed-events: calendar events the agent SUGGESTS from this run. The
   * UI offers them as a downloadable .ics; Clockwork never writes to the
   * user's real calendar.
   *
   * PRODUCER: the agent's own summary. `run-manager.finalize()` runs
   * `extractProposedEvents()` (packages/runner/src/proposed-events-parse.ts)
   * over it and sets this field from the fenced ```clockwork-events block, if
   * there is one. The convention is documented in docs/agent-workforce.md §F9.
   *
   * Deliberately `.optional()` and not `.default([])`. RunReport is the zod
   * OUTPUT type, so a default would make the key REQUIRED on every report
   * literal — and, worse, would print `"proposedEvents": []` into the stored
   * report_json for the overwhelming majority of runs that propose nothing,
   * which reads as "the agent was asked and declined". undefined = the run
   * proposed nothing, OR the report predates the field; the two are
   * deliberately indistinguishable. Read it with `?.`.
   */
  proposedEvents: z.array(ProposedEvent).optional(),
});
export type RunReport = z.infer<typeof RunReport>;
