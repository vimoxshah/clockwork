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

// ---- BYOK provider configs (ADR-027): user-configured API providers ----
export const byokKinds = [
  'anthropic',
  'openai',
  'openrouter',
  'google',
  'mistral',
  'deepseek',
  'xai',
  'custom_openai',
] as const;
export const ByokKind = z.enum(byokKinds);
export type ByokKind = (typeof byokKinds)[number];

export const authModes = ['keychain', 'env'] as const;
export const AuthMode = z.enum(authModes);

/**
 * A user-configured API provider. The credential itself NEVER lives here:
 * keychain mode stores it under service name `clockwork-byok-<id>` in the OS
 * keychain; env mode names an environment variable the daemon may read.
 */
export const ProviderConfig = z.object({
  id: z.string().min(6),
  kind: ByokKind,
  label: z.string().min(1).max(80),
  /** base URL override; required for custom_openai, optional elsewhere */
  base_url: z.string().url().optional(),
  auth: AuthMode,
  /** keychain mode: redacted hint like "••••9A2F"; never the key itself */
  hint: z.string().max(12).optional(),
  /** env mode: variable name to read */
  env_var: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  default_model: z.string().min(1),
  created_at: z.number().int(),
  last_validated_at: z.number().int().nullable(),
  last_error: z.string().nullable(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const PROVIDER_KIND_META: Record<ByokKind, {
  label: string;
  defaultBaseUrl: string;
  authOptions: Array<{ mode: 'subscription_cli' | 'api_key'; label: string; detail: string }>;
  models: Array<{ id: string; context: number; inPerM: number; outPerM: number; vision: boolean; tools: boolean; reasoning: boolean }>;
}> = {
  anthropic: {
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    authOptions: [
      { mode: 'subscription_cli', label: 'Claude subscription / Claude Code CLI', detail: 'Uses your installed claude credentials — billed to your Claude plan.' },
      { mode: 'api_key', label: 'API key', detail: 'Billed per-token to your Anthropic API account.' },
    ],
    models: [
      { id: 'claude-sonnet-4-5', context: 200000, inPerM: 3, outPerM: 15, vision: true, tools: true, reasoning: false },
      { id: 'claude-haiku-4-5', context: 200000, inPerM: 1, outPerM: 5, vision: true, tools: true, reasoning: false },
      { id: 'claude-opus-4-1', context: 200000, inPerM: 15, outPerM: 75, vision: true, tools: true, reasoning: false },
    ],
  },
  openai: {
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    authOptions: [
      { mode: 'subscription_cli', label: 'Codex CLI (ChatGPT plan)', detail: 'Uses installed codex credentials — governed by your ChatGPT subscription.' },
      { mode: 'api_key', label: 'API key', detail: 'Billed per-token to your OpenAI platform account.' },
    ],
    models: [
      { id: 'gpt-5.2-codex', context: 400000, inPerM: 1.25, outPerM: 10, vision: true, tools: true, reasoning: true },
      { id: 'gpt-5-mini', context: 400000, inPerM: 0.25, outPerM: 2, vision: true, tools: true, reasoning: true },
      { id: 'gpt-4.1-mini', context: 1000000, inPerM: 0.4, outPerM: 1.6, vision: true, tools: true, reasoning: false },
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    authOptions: [{ mode: 'api_key', label: 'API key', detail: 'One key, hundreds of models — usage billed through OpenRouter.' }],
    models: [
      { id: 'anthropic/claude-sonnet-4.5', context: 200000, inPerM: 3, outPerM: 15, vision: true, tools: true, reasoning: false },
      { id: 'google/gemini-2.5-pro', context: 1048576, inPerM: 1.25, outPerM: 10, vision: true, tools: true, reasoning: true },
      { id: 'deepseek/deepseek-chat-v3.1', context: 163840, inPerM: 0.2, outPerM: 0.8, vision: false, tools: true, reasoning: false },
    ],
  },
  google: {
    label: 'Google AI',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authOptions: [{ mode: 'api_key', label: 'API key', detail: 'Gemini API billing.' }],
    models: [{ id: 'gemini-2.5-pro', context: 1048576, inPerM: 1.25, outPerM: 10, vision: true, tools: true, reasoning: true }],
  },
  mistral: {
    label: 'Mistral',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    authOptions: [{ mode: 'api_key', label: 'API key', detail: 'La Plateforme billing.' }],
    models: [{ id: 'mistral-large-latest', context: 128000, inPerM: 2, outPerM: 6, vision: false, tools: true, reasoning: false }],
  },
  deepseek: {
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    authOptions: [{ mode: 'api_key', label: 'API key', detail: 'DeepSeek platform billing.' }],
    models: [{ id: 'deepseek-chat', context: 131072, inPerM: 0.28, outPerM: 0.42, vision: false, tools: true, reasoning: false }],
  },
  xai: {
    label: 'xAI',
    defaultBaseUrl: 'https://api.x.ai/v1',
    authOptions: [{ mode: 'api_key', label: 'API key', detail: 'xAI API billing.' }],
    models: [{ id: 'grok-4-fast', context: 2000000, inPerM: 0.2, outPerM: 0.5, vision: true, tools: true, reasoning: true }],
  },
  custom_openai: {
    label: 'Custom OpenAI-compatible',
    defaultBaseUrl: 'http://localhost:11434/v1',
    authOptions: [{ mode: 'api_key', label: 'API key (optional)', detail: 'Ollama, vLLM, LM Studio, or any enterprise gateway exposing /chat/completions.' }],
    models: [],
  },
};

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

/**
 * Quiet hours (ADR-030): never fire inside the local-time window
 * [startHour, endHour) — may wrap midnight. `critical` tasks bypass.
 * Deferred occurrences are pushed to the window's end, never silently dropped.
 */
export const QuietHours = z.object({
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
}).optional();
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
  /** BYOK provider config id — when set, task executes via the API agent adapter (ADR-027/028) */
  byokId: z.string().optional(),
  permissionMode: PermissionMode.default('acceptEdits'),
  budget: Budget.default({ maxUsd: 2.0, maxTurns: 50, timeoutSec: 3600 }),
  schedule: ScheduleSpec,
  overlapPolicy: OverlapPolicy.default('skip'),
  missedPolicy: MissedPolicy.default('run-late'),
  missedWindowSec: z.number().int().positive().default(21_600),
  retryOnTransient: z.boolean().default(false),
  /** Agent chains (goal #28): run this task after the named upstream task completes */
  chainAfter: z.string().optional(),
  /** Chain trigger: 'completed' (default) or 'any_terminal' (completed or failed) */
  chainOn: z.enum(['completed', 'any_terminal']).optional(),
  context: ContextAttachments.default({ files: [] }),
  delivery: DeliveryConfig.default({ osNotify: true }),
});
export type TaskCreate = z.infer<typeof TaskCreate>;

export const TaskPatch = z.object({
  engine: Engine.optional(),
  byokId: z.string().nullable().optional(),
  /** Agent chains (goal #28) — nullable to allow unchaining */
  chainAfter: z.string().nullable().optional(),
  chainOn: z.enum(['completed', 'any_terminal']).optional(),
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
  /** BYOK config id snapshot (ADR-027); credential itself is injected via env at spawn, never serialized */
  byokId: z.string().nullable(),
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
