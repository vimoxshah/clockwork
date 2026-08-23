import { z } from 'zod';

/**
 * Validation schemas — the single validation truth shared by daemon API,
 * composer UI, and runner. zod rejects bad rows at save (S-26); the daemon
 * never sees invalid schedules.
 */

// ---- Permission modes (FR-1/FR-11): bypassPermissions is NOT offered in H1.
export const permissionModes = ['plan', 'acceptEdits', 'default'] as const;
export const PermissionMode = z.enum(permissionModes);
export type PermissionMode = (typeof permissionModes)[number];

// ---- Engines/providers (ADR-016 + ADR-026): claude CLI default; codex & opencode CLIs opt-in.
export const engines = ['cli', 'sdk', 'codex', 'opencode', 'hermes'] as const;
export const Engine = z.enum(engines);
export type Engine = (typeof engines)[number];

/** Runtime provider metadata the daemon detects (ADR-026). */
export const PROVIDERS = [
  { id: 'cli', label: 'Claude Code', bin: 'claude' },
  { id: 'codex', label: 'Codex CLI', bin: 'codex' },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode' },
  { id: 'hermes', label: 'Hermes Agent', bin: 'hermes' },
] as const;

// ---- Scheduling (FR-4)
export const scheduleKinds = ['once', 'rrule', 'cron', 'queue'] as const;
export const ScheduleKind = z.enum(scheduleKinds);

export const ScheduleSpec = z
  .object({
    kind: ScheduleKind,
    /** iCal RRULE string, e.g. FREQ=WEEKLY;BYDAY=MO */
    rrule: z.string().min(2).optional(),
    /** cron expression for power users (croner syntax) */
    cron: z.string().optional(),
    /** epoch ms UTC for `once` */
    runAt: z.number().int().optional(),
    /** IANA zone; defaults to daemon-local zone at creation time */
    tz: z.string().min(1),
  })
  .superRefine((s, ctx) => {
    if (s.kind === 'once' && typeof s.runAt !== 'number') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['runAt'], message: 'once schedules require runAt' });
    }
    if (s.kind === 'rrule' && !s.rrule) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rrule'], message: 'rrule schedules require rrule' });
    }
    if (s.kind === 'cron' && !s.cron) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cron'], message: 'cron schedules require cron' });
    }
  });
export type ScheduleSpec = z.infer<typeof ScheduleSpec>;

// ---- Budgets (FR-10): turns/time are hard bounds; usd is a soft cap.
export const Budget = z.object({
  maxUsd: z.number().positive().max(100).default(2.0),
  maxTurns: z.number().int().positive().max(500).default(50),
  timeoutSec: z.number().int().positive().max(24 * 3600).default(3600),
});
export type Budget = z.infer<typeof Budget>;

// ---- Policies
export const overlapPolicies = ['skip', 'queue'] as const;
export const OverlapPolicy = z.enum(overlapPolicies);

export const missedPolicies = ['skip', 'run-late', 'ask'] as const;
export const MissedPolicy = z.enum(missedPolicies);

// ---- Delivery (FR-18) — M1: inbox always + OS notification default-on.
export const DeliveryConfig = z.object({
  osNotify: z.boolean().default(true),
  telegram: z
    .object({
      chatId: z.string(),
    })
    .optional(),
  webhook: z
    .object({
      url: z.string().url(),
      secretRef: z.string().optional(),
    })
    .optional(),
});
export type DeliveryConfig = z.infer<typeof DeliveryConfig>;

// ---- Context attachments (M1: FR-2a files only; URL/MCP is T-306)
export const FileAttachment = z.object({
  path: z.string().min(1),
  mode: z.enum(['live-ref', 'snapshot']).default('live-ref'),
});
export type FileAttachment = z.infer<typeof FileAttachment>;

export const ContextAttachments = z.object({
  files: z.array(FileAttachment).default([]),
});
export type ContextAttachments = z.infer<typeof ContextAttachments>;

// ---- Profiles (FR-28)
export const ProfileCreate = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,31}$/, 'slug: lowercase alphanum + dashes, 2–32 chars'),
  name: z.string().min(1).max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  glyph: z.string().max(4).optional(),
  engine: Engine.default('cli'),
  model: z.string().optional(),
  permissionMode: PermissionMode.default('acceptEdits'),
  budget: Budget.default({ maxUsd: 2.0, maxTurns: 50, timeoutSec: 3600 }),
  skills: z.array(z.object({ name: z.string(), version: z.string() })).default([]),
  mcpAllow: z.array(z.string()).default([]),
  contextRoots: z.array(z.string()).default([]),
  systemPromptExtra: z.string().max(8000).optional(),
  delivery: DeliveryConfig.default({ osNotify: true }),
});
export type ProfileCreate = z.infer<typeof ProfileCreate>;

export const ProfilePatch = ProfileCreate.partial();
export type ProfilePatch = z.infer<typeof ProfilePatch>;

// ---- Tasks (FR-1)
export const TaskCreate = z.object({
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(32_000),
  profileId: z.string().optional(),
  profileSlugMention: z.string().optional(), // @mention resolved server-side
  repoPath: z.string().optional(), // absent/empty => scratch (no-repo) task
  baseBranch: z.string().optional(),
  model: z.string().optional(),
  engine: Engine.optional(), // per-task provider override (ADR-026); default = profile/cli
  permissionMode: PermissionMode.default('acceptEdits'),
  budget: Budget.default({ maxUsd: 2.0, maxTurns: 50, timeoutSec: 3600 }),
  schedule: ScheduleSpec,
  overlapPolicy: OverlapPolicy.default('skip'),
  missedPolicy: MissedPolicy.default('run-late'),
  missedWindowSec: z.number().int().positive().default(21_600),
  retryOnTransient: z.boolean().default(false),
  context: ContextAttachments.default({ files: [] }),
  delivery: DeliveryConfig.default({ osNotify: true }),
});
export type TaskCreate = z.infer<typeof TaskCreate>;

export const TaskPatch = z.object({
  engine: Engine.optional(),
  name: z.string().min(1).max(120).optional(),
  prompt: z.string().min(1).max(32_000).optional(),
  profileId: z.string().nullable().optional(),
  repoPath: z.string().nullable().optional(),
  baseBranch: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  permissionMode: PermissionMode.optional(),
  budget: Budget.optional(),
  schedule: ScheduleSpec.optional(),
  overlapPolicy: OverlapPolicy.optional(),
  missedPolicy: MissedPolicy.optional(),
  missedWindowSec: z.number().int().positive().optional(),
  retryOnTransient: z.boolean().optional(),
  context: ContextAttachments.optional(),
  delivery: DeliveryConfig.optional(),
  enabled: z.boolean().optional(),
  /** optimistic concurrency (S-82) — must match current row version or 409 */
  version: z.number().int().optional(),
});
export type TaskPatch = z.infer<typeof TaskPatch>;

// ---- JobSpec: frozen snapshot of task+profile at enqueue (arch §1, S-5)
export const JobSpec = z.object({
  runId: z.string(),
  taskId: z.string(),
  taskName: z.string(),
  taskSlug: z.string(),
  prompt: z.string(),
  engine: Engine,
  model: z.string().nullable(),
  permissionMode: PermissionMode,
  budget: Budget,
  repoPath: z.string().nullable(),
  baseBranch: z.string().nullable(),
  worktreePath: z.string(),
  branch: z.string(),
  scratchPath: z.string().nullable(),
  profile: z
    .object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      color: z.string().nullable(),
      glyph: z.string().nullable(),
      systemPromptExtra: z.string().nullable(),
      skills: z.array(z.object({ name: z.string(), version: z.string() })),
      contextRoots: z.array(z.string()),
      mcpAllow: z.array(z.string()),
    })
    .nullable(),
  contextFiles: z.array(FileAttachment),
  occurrenceAt: z.number().nullable(),
  scheduledFor: z.number(),
  createdAt: z.number(),
});
export type JobSpec = z.infer<typeof JobSpec>;
