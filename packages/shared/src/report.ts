import { z } from 'zod';

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
  sleptThroughKeepAwake: z.boolean().default(false), // S-16 note
  approvals: z.array(ApprovalRecord).default([]),
  timeline: z.array(TimelineEntry).default([]),
  deliveries: z.array(DeliveryReceipt).default([]),
  queueDelayMs: z.number().nonnegative().default(0), // S-3/S-28 visibility
  repoLockDelayMs: z.number().nonnegative().default(0),
});
export type RunReport = z.infer<typeof RunReport>;
