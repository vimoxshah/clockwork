import type { RunState } from './states.js';

/**
 * The multi-vendor seam (ADR-007/ADR-016). NOTHING outside packages/runner may
 * import the Agent SDK or spawn `claude` (arch §3).
 *
 * HITL semantics (ADR-014): primary model keeps the runner process alive with a
 * pending permission callback; `resume()` is only the runner-death fallback.
 */
export interface UsageSample {
  costUsd: number;
  turns: number;
}

export interface PermissionRequest {
  /** e.g. Bash(git push --force), Read(~/.ssh/id_ed25519) */
  tool: string;
  input: unknown;
  /** deny-list classification already applied by runner before this reaches daemon */
  floorHit?: boolean;
}

export type Decision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string };

export type DecisionOrEscalate = Decision | 'ESCALATE';

export interface RunnerIO {
  onUsage(u: UsageSample): void;
  onPermissionRequest(p: PermissionRequest): Promise<DecisionOrEscalate>;
  onHeartbeat(): void;
  onArtifact(path: string): void;
  /** Claude rate_limit_event telemetry → capacity model (FR-7, estimate-grade). */
  onRateLimit?(info: Record<string, unknown>): void;
  onLog(line: string): void;
  /**
   * A PreToolUse policy-floor hit (FR-11/T-114): the deny-list floor denied a
   * command the CLI's own permission-prompt-tool path never asked about
   * (acceptEdits skips it for Bash). Optional so existing RunnerIO
   * implementers are unaffected until they choose to journal it.
   */
  onPolicyDeny?(p: { tool: string; command: string; reason: string }): void;
}

export interface RunOutcome {
  state: Extract<RunState, 'completed' | 'failed' | 'cancelled' | 'budget_exceeded' | 'timed_out'>;
  failureReason?: string;
  sessionId?: string;
  summary?: string;
  transcriptPath?: string;
  artifacts: string[];
  costUsd: number;
  turns: number;
}

export interface JobContext {
  worktreePath: string;
  scratchPath: string | null;
  io: RunnerIO;
  signal: AbortSignal;
}

export interface AgentRunner {
  readonly engine: 'cli' | 'sdk' | 'codex' | 'opencode' | 'hermes' | 'mock';
  start(job: JobSpecLike, ctx: JobContext): Promise<RunOutcome>;
  /** Fallback path only (ADR-014): restarts a turn with the decision injected. */
  resume(sessionRef: string, job: JobSpecLike, ctx: JobContext): Promise<RunOutcome>;
  cancel(sessionRef: string | undefined): Promise<void>;
}

/** Structural subset of shared JobSpec runners consume (avoids daemon import). */
export interface JobSpecLike {
  runId: string;
  prompt: string;
  model: string | null;
  permissionMode: string;
  budget: { maxUsd: number; maxTurns: number; timeoutSec: number };
  profile: {
    systemPromptExtra: string | null;
    skills: { name: string; version: string }[];
  } | null;
}
