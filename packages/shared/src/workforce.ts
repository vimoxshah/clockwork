import { z } from 'zod';

/**
 * Agent Workforce — the shared contract for the twelve workforce features
 * (plan/AGENT-WORKFORCE-SPEC.md). Backed by migration
 * packages/daemon/migrations/0008_agent_workforce.sql.
 *
 * Everything crossing a package boundary is declared once here so the daemon
 * modules, the API routes and the UI agree on one shape. Feature modules own
 * their own daemon-internal row types; they do NOT redeclare these.
 *
 * Convention, matching schemas.ts: wire shapes are camelCase and the repo
 * layer maps them to the snake_case columns.
 */

// ---------------------------------------------------------------------------
// Cross-feature settings (workforce_prefs, singleton row id=1)
// ---------------------------------------------------------------------------
export const WorkforcePrefs = z.object({
  /** F3: master switch — off, no next_fire is ever shifted. */
  officeHoursEnabled: z.boolean().default(false),
  /** F7: accepted-in-a-row needed before the next rung is OFFERED. */
  autonomyStreakRequired: z.number().int().min(1).max(100).default(5),
  /** F8: consecutive failures that book a diagnostic run. */
  selfHealFailureThreshold: z.number().int().min(2).max(50).default(3),
  /** F10: the human rate an agent's effective hourly rate is compared against. */
  humanHourlyRateUsd: z.number().nonnegative().nullable().default(null),
  /** F11: default scorecard window. */
  reviewPeriodDays: z.number().int().min(1).max(365).default(30),
});
export type WorkforcePrefs = z.infer<typeof WorkforcePrefs>;

// ---------------------------------------------------------------------------
// F1 plan-then-execute
// ---------------------------------------------------------------------------
export const planExecuteStatuses = [
  'awaiting_plan',
  'awaiting_approval',
  'approved',
  'rejected',
  'executed',
] as const;
export const PlanExecuteStatus = z.enum(planExecuteStatuses);
export type PlanExecuteStatus = (typeof planExecuteStatuses)[number];

/**
 * One booking, two runs. The PLAN half runs at a human hour in permission mode
 * 'plan'; its report becomes an approval item. The EXECUTE half is created
 * disabled and is booked only when a human approves — chain firing is one-shot
 * at the plan run's terminal state and skips disabled tasks, so the pair row,
 * not chain_after, is the gate.
 */
export const PlanExecutePair = z.object({
  id: z.string(),
  planTaskId: z.string(),
  executeTaskId: z.string(),
  planRunId: z.string().nullable(),
  approvalId: z.string().nullable(),
  executeRunId: z.string().nullable(),
  status: PlanExecuteStatus,
  decidedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type PlanExecutePair = z.infer<typeof PlanExecutePair>;

/** POST body that turns one task description into a plan/execute pair. */
export const PlanExecuteCreate = z.object({
  /** the task the pair is built from; its prompt seeds both halves */
  taskId: z.string().min(1),
  /** local hour (0-23) the PLAN half should run at — the "human hour" */
  planHour: z.number().int().min(0).max(23).default(9),
  /** IANA zone planHour is interpreted in */
  tz: z.string().min(1).default('UTC'),
});
export type PlanExecuteCreate = z.infer<typeof PlanExecuteCreate>;

// ---------------------------------------------------------------------------
// F2 shift-handoff (+ F6's note sink)
// ---------------------------------------------------------------------------
export const memoryAuthors = ['agent', 'human'] as const;
export const MemoryAuthor = z.enum(memoryAuthors);
export type MemoryAuthor = (typeof memoryAuthors)[number];

export const memoryKinds = ['handoff', 'note'] as const;
export const MemoryKind = z.enum(memoryKinds);
export type MemoryKind = (typeof memoryKinds)[number];

/**
 * What one shift leaves for the next. Read at the start of the next
 * occurrence of the SAME task — the chain's previous-report binding pointed at
 * the prior occurrence instead of an upstream task.
 */
export const AgentMemory = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string().nullable(),
  author: MemoryAuthor,
  kind: MemoryKind,
  tried: z.string().nullable(),
  blocked: z.string().nullable(),
  nextCheck: z.string().nullable(),
  /** free-form body; used verbatim for human notes */
  body: z.string().nullable(),
  createdAt: z.number(),
});
export type AgentMemory = z.infer<typeof AgentMemory>;

export const AgentMemoryWrite = z.object({
  taskId: z.string().min(1),
  runId: z.string().nullable().optional(),
  author: MemoryAuthor.default('agent'),
  kind: MemoryKind.default('handoff'),
  tried: z.string().max(4_000).nullable().optional(),
  blocked: z.string().max(4_000).nullable().optional(),
  nextCheck: z.string().max(4_000).nullable().optional(),
  body: z.string().max(8_000).nullable().optional(),
});
export type AgentMemoryWrite = z.infer<typeof AgentMemoryWrite>;

// ---------------------------------------------------------------------------
// F3 office-hours
// ---------------------------------------------------------------------------
/**
 * One window in which the human can answer an approval. No midnight wrap: a
 * window crossing midnight is two rows, so containment is always
 * [startMin, endMin).
 */
export const OfficeHourWindow = z.object({
  id: z.string(),
  label: z.string().nullable(),
  /** 0 = Sunday .. 6 = Saturday */
  dow: z.number().int().min(0).max(6),
  startMin: z.number().int().min(0).max(1439),
  endMin: z.number().int().min(1).max(1440),
  tz: z.string(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type OfficeHourWindow = z.infer<typeof OfficeHourWindow>;

export const OfficeHourCreate = z
  .object({
    label: z.string().max(64).optional(),
    dow: z.number().int().min(0).max(6),
    startMin: z.number().int().min(0).max(1439),
    endMin: z.number().int().min(1).max(1440),
    tz: z.string().min(1),
    enabled: z.boolean().default(true),
  })
  .refine((w) => w.endMin > w.startMin, {
    message: 'endMin must be after startMin — split a window that crosses midnight into two',
  });
export type OfficeHourCreate = z.infer<typeof OfficeHourCreate>;

// ---------------------------------------------------------------------------
// F4 sentinel-worker
// ---------------------------------------------------------------------------
export const Sentinel = z.object({
  id: z.string(),
  name: z.string(),
  sentinelTaskId: z.string(),
  /** the existing trigger the trip fires; the worker task is triggers.task_id */
  triggerId: z.string(),
  tripExpr: z.string(),
  cooldownSec: z.number().int().nonnegative(),
  lastTrippedAt: z.number().nullable(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Sentinel = z.infer<typeof Sentinel>;

export const SentinelCreate = z.object({
  name: z.string().min(1).max(80),
  sentinelTaskId: z.string().min(1),
  triggerId: z.string().min(1),
  /** case-insensitive substring the sentinel run's report summary must contain */
  tripExpr: z.string().min(1).max(200),
  cooldownSec: z.number().int().min(0).max(86_400).default(3_600),
  enabled: z.boolean().default(true),
});
export type SentinelCreate = z.infer<typeof SentinelCreate>;

export const SentinelTrip = z.object({
  id: z.string(),
  sentinelId: z.string(),
  runId: z.string().nullable(),
  workerRunId: z.string().nullable(),
  tripped: z.boolean(),
  reason: z.string().nullable(),
  at: z.number(),
});
export type SentinelTrip = z.infer<typeof SentinelTrip>;

// ---------------------------------------------------------------------------
// F5 repo-shipped-jobs
// ---------------------------------------------------------------------------
/**
 * One job a repo recommends, as declared in .clockwork/jobs.yaml (or .json).
 * Deliberately a SUBSET of TaskCreate: a repo may not choose its own
 * permission mode, engine, BYOK provider or budget. Those come from the
 * importing user's profile, so a hostile repo cannot escalate by shipping a
 * file.
 */
export const RepoJobSpec = z.object({
  /** stable key, unique within the repo — identity across re-discovery */
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/),
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(32_000),
  /** cron or RRULE the repo suggests; the user may change it at import */
  schedule: z
    .object({
      kind: z.enum(['cron', 'rrule']),
      cron: z.string().optional(),
      rrule: z.string().optional(),
      tz: z.string().default('UTC'),
    })
    .optional(),
  description: z.string().max(500).optional(),
});
export type RepoJobSpec = z.infer<typeof RepoJobSpec>;

export const RepoJobsFile = z.object({
  schema: z.literal('clockwork.jobs.v1'),
  jobs: z.array(RepoJobSpec).max(50),
});
export type RepoJobsFile = z.infer<typeof RepoJobsFile>;

export const repoJobStatuses = ['offered', 'imported', 'dismissed'] as const;
export const RepoJobStatus = z.enum(repoJobStatuses);
export type RepoJobStatus = (typeof repoJobStatuses)[number];

export const RepoJobOffer = z.object({
  id: z.string(),
  repoPath: z.string(),
  sourcePath: z.string(),
  jobKey: z.string(),
  name: z.string(),
  spec: RepoJobSpec,
  digest: z.string(),
  /** the same flag shape templates.ts securityPreview() returns (S-74) */
  preview: z
    .object({
      flags: z.array(z.object({ level: z.enum(['red', 'yellow', 'info']), text: z.string() })),
      arrivesDisabled: z.literal(true),
    })
    .nullable(),
  status: RepoJobStatus,
  taskId: z.string().nullable(),
  discoveredAt: z.number(),
  decidedAt: z.number().nullable(),
});
export type RepoJobOffer = z.infer<typeof RepoJobOffer>;

// ---------------------------------------------------------------------------
// F6 accept-with-note — the acceptance signal
// ---------------------------------------------------------------------------
export const outcomeDecisions = ['accepted', 'accepted_with_note', 'rejected'] as const;
export const OutcomeDecision = z.enum(outcomeDecisions);
export type OutcomeDecision = (typeof outcomeDecisions)[number];

/**
 * NAME NOTE: `RunOutcome` is already taken in runner.ts for the ENGINE's
 * terminal outcome (state/summary/cost). This is the HUMAN's verdict on that
 * run — a different thing — so it carries the `Record` suffix. Do not "fix"
 * the name back; the two would collide in the barrel export.
 */
export const RunOutcomeRecord = z.object({
  runId: z.string(),
  taskId: z.string(),
  profileId: z.string().nullable(),
  decision: OutcomeDecision,
  note: z.string().nullable(),
  /** agent_memories row the note was written into (F2) */
  memoryId: z.string().nullable(),
  actor: z.string(),
  decidedAt: z.number(),
});
export type RunOutcomeRecord = z.infer<typeof RunOutcomeRecord>;

export const RunOutcomeWrite = z
  .object({
    decision: OutcomeDecision,
    note: z.string().max(8_000).optional(),
  })
  .refine((o) => o.decision !== 'accepted_with_note' || (o.note?.trim().length ?? 0) > 0, {
    message: 'accepted_with_note requires a non-empty note',
  });
export type RunOutcomeWrite = z.infer<typeof RunOutcomeWrite>;

// ---------------------------------------------------------------------------
// F7 earned-autonomy
// ---------------------------------------------------------------------------
/**
 * The autonomy ladder. Each rung maps to a CONCRETE profile configuration —
 * there is no fourth rung, and 'bypassPermissions' is banned in H1 (S-74), so
 * 'unattended' is acceptEdits with the approval flag cleared, not a new
 * permission mode:
 *
 *   plan        -> permissionMode 'plan',       mayRequireApproval 1
 *   acceptEdits -> permissionMode 'acceptEdits', mayRequireApproval 1
 *   unattended  -> permissionMode 'acceptEdits', mayRequireApproval 0
 */
export const autonomyRungs = ['plan', 'acceptEdits', 'unattended'] as const;
export const AutonomyRung = z.enum(autonomyRungs);
export type AutonomyRung = (typeof autonomyRungs)[number];

/** The one place the rung -> profile-settings mapping is defined. */
export const AUTONOMY_RUNG_SETTINGS: Record<
  AutonomyRung,
  { permissionMode: 'plan' | 'acceptEdits'; mayRequireApproval: boolean }
> = {
  plan: { permissionMode: 'plan', mayRequireApproval: true },
  acceptEdits: { permissionMode: 'acceptEdits', mayRequireApproval: true },
  unattended: { permissionMode: 'acceptEdits', mayRequireApproval: false },
};

/** The rung above `rung`, or null at the top. */
export function nextRung(rung: AutonomyRung): AutonomyRung | null {
  const i = autonomyRungs.indexOf(rung);
  return i >= 0 && i < autonomyRungs.length - 1 ? (autonomyRungs[i + 1] as AutonomyRung) : null;
}

export const autonomyOfferStatuses = ['offered', 'accepted', 'declined'] as const;
export const AutonomyOfferStatus = z.enum(autonomyOfferStatuses);
export type AutonomyOfferStatus = (typeof autonomyOfferStatuses)[number];

export const AutonomyOffer = z.object({
  id: z.string(),
  profileId: z.string(),
  fromRung: AutonomyRung,
  toRung: AutonomyRung,
  streak: z.number().int().nonnegative(),
  status: AutonomyOfferStatus,
  offeredAt: z.number(),
  decidedAt: z.number().nullable(),
});
export type AutonomyOffer = z.infer<typeof AutonomyOffer>;

// ---------------------------------------------------------------------------
// F8 self-healing
// ---------------------------------------------------------------------------
export const remediationTargets = ['prompt', 'profile'] as const;
export const RemediationTarget = z.enum(remediationTargets);
export type RemediationTarget = (typeof remediationTargets)[number];

export const remediationStatuses = ['proposed', 'applied', 'rejected'] as const;
export const RemediationStatus = z.enum(remediationStatuses);
export type RemediationStatus = (typeof remediationStatuses)[number];

/**
 * A diagnostic run's proposal. The agent never applies it — status moves to
 * 'applied' only through an explicit human action on the approval item.
 */
export const RemediationProposal = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string().nullable(),
  approvalId: z.string().nullable(),
  target: RemediationTarget,
  currentValue: z.string().nullable(),
  proposedValue: z.string(),
  rationale: z.string().nullable(),
  status: RemediationStatus,
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
});
export type RemediationProposal = z.infer<typeof RemediationProposal>;

// ---------------------------------------------------------------------------
// F9 proposed-events
// ---------------------------------------------------------------------------
/**
 * A calendar event the agent SUGGESTS ("review PR 42, 10 min"). Clockwork
 * never writes to the user's real calendar — the only output is a .ics file
 * the user downloads and imports themselves.
 */
export const ProposedEvent = z.object({
  /** stable within one report, so the UI can address a single suggestion */
  key: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  notes: z.string().max(2_000).nullable().default(null),
  durationMin: z.number().int().min(1).max(1_440).default(15),
  /** epoch ms the agent suggests; null = the user picks a time */
  suggestedAt: z.number().nullable().default(null),
});
export type ProposedEvent = z.infer<typeof ProposedEvent>;

// ---------------------------------------------------------------------------
// F10 timesheets
// ---------------------------------------------------------------------------
/** One agent's punch card over a window. Every field is plain SQL over runs. */
export const TimesheetRow = z.object({
  profileId: z.string().nullable(),
  profileSlug: z.string().nullable(),
  profileName: z.string(),
  runs: z.number().int().nonnegative(),
  /** summed (ended_at - started_at) across the window */
  hoursWorked: z.number().nonnegative(),
  dollarsSpent: z.number().nonnegative(),
  outcomesAccepted: z.number().int().nonnegative(),
  outcomesRejected: z.number().int().nonnegative(),
  /** dollarsSpent / hoursWorked; null when the agent logged no time */
  effectiveHourlyRateUsd: z.number().nonnegative().nullable(),
});
export type TimesheetRow = z.infer<typeof TimesheetRow>;

export const Timesheet = z.object({
  fromMs: z.number(),
  toMs: z.number(),
  humanHourlyRateUsd: z.number().nonnegative().nullable(),
  rows: z.array(TimesheetRow),
});
export type Timesheet = z.infer<typeof Timesheet>;

// ---------------------------------------------------------------------------
// F11 performance-reviews
// ---------------------------------------------------------------------------
/**
 * The numbers half of a review. The written verdict is a separate scheduled
 * run by a reviewer profile — this object is what that run reads, and what the
 * UI renders without waiting for prose.
 */
export const PerformanceScorecard = z.object({
  profileId: z.string().nullable(),
  profileSlug: z.string().nullable(),
  profileName: z.string(),
  fromMs: z.number(),
  toMs: z.number(),
  runs: z.number().int().nonnegative(),
  /** accepted / decided; null when nothing was decided in the window */
  acceptanceRate: z.number().min(0).max(1).nullable(),
  /** failed+timed_out / runs; null when there were no runs */
  failureRate: z.number().min(0).max(1).nullable(),
  costUsd: z.number().nonnegative(),
  /** mean cost per run this window minus the previous window; null if no prior window */
  costTrendUsd: z.number().nullable(),
  decided: z.number().int().nonnegative(),
});
export type PerformanceScorecard = z.infer<typeof PerformanceScorecard>;

// ---------------------------------------------------------------------------
// F12 proof-of-work-export
// ---------------------------------------------------------------------------
/**
 * Options for the redacted single-file HTML export. There is no
 * Clockwork-hosted anything: the daemon returns the file bytes and the user
 * hosts them. Secret masking always runs — it is not an option.
 */
export const ProofOfWorkOptions = z.object({
  includeTranscript: z.boolean().default(false),
  includeDiffStat: z.boolean().default(true),
  /** strip repo paths and branch names as well as secrets */
  redactPaths: z.boolean().default(false),
});
export type ProofOfWorkOptions = z.infer<typeof ProofOfWorkOptions>;
