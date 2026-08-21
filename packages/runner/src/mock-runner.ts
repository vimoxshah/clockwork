/**
 * MockRunner — deterministic engine for the full-loop test suite (stack #16).
 * Scripted behaviors let scenario tests exercise budget/turn/timeout/approval
 * paths without API spend.
 */
import type {
  AgentRunner,
  JobContext,
  JobSpecLike,
  RunOutcome,
} from '@clockwork/shared';

export interface MockScriptStep {
  /** emit usage sample after this many ms */
  delayMs: number;
  costUsd?: number;
  turns?: number;
  permissionRequest?: { tool: string; input?: unknown };
}

export interface MockConfig {
  outcome?: RunOutcome['state'];
  failureReason?: string;
  steps?: MockScriptStep[];
  finalSummary?: string;
  /** simulate crash: throw instead of resolving */
  crashAfterMs?: number;
  /** hold a permission request open until released via returned handle */
  holdPermissionMs?: number;
}

export class MockRunner implements AgentRunner {
  readonly engine = 'mock' as const;
  public started = 0;
  public cancelled = 0;
  private abort?: AbortController;

  constructor(private cfg: MockConfig = {}) {}

  async start(job: JobSpecLike, ctx: JobContext): Promise<RunOutcome> {
    return this.execute(job, ctx);
  }

  // ADR-014 fallback path — mock replays identically.
  async resume(_sessionRef: string, job: JobSpecLike, ctx: JobContext): Promise<RunOutcome> {
    return this.execute(job, ctx);
  }

  private async execute(job: JobSpecLike, ctx: JobContext): Promise<RunOutcome> {
    this.started++;
    const start = Date.now();
    let cost = 0;
    let turns = 0;

    for (const step of this.cfg.steps ?? []) {
      if (ctx.signal.aborted) return this.outcome('cancelled', cost, turns, start);
      await sleep(step.delayMs, ctx.signal);
      if (ctx.signal.aborted) return this.outcome('cancelled', cost, turns, start);
      if (this.cfg.crashAfterMs !== undefined && Date.now() - start > this.cfg.crashAfterMs) {
        throw new Error('MOCK_RUNNER_CRASH');
      }
      if (step.permissionRequest) {
        const decision = await ctx.io.onPermissionRequest({
          tool: step.permissionRequest.tool,
          input: step.permissionRequest.input,
        });
        if (decision === 'ESCALATE') {
          return this.outcome('failed', cost, turns, start);
        }
      }
      if (step.costUsd !== undefined) cost += step.costUsd;
      if (step.turns !== undefined) turns += step.turns;
      ctx.io.onUsage({ costUsd: cost, turns });
      ctx.io.onHeartbeat();
    }

    return {
      state: this.cfg.outcome ?? 'completed',
      ...(this.cfg.outcome && this.cfg.outcome !== 'completed' ? { failureReason: this.cfg.failureReason } : {}),
      sessionId: `mock-${job.runId}`,
      summary: this.cfg.finalSummary ?? 'Mock run completed.',
      artifacts: [],
      costUsd: cost,
      turns,
    };
  }

  private outcome(state: RunOutcome['state'], cost: number, turns: number, start: number): RunOutcome {
    return {
      state,
      sessionId: 'mock-session',
      summary: `${state} at +${Date.now() - start}ms`,
      artifacts: [],
      costUsd: cost,
      turns,
    };
  }

  async cancel(_sessionRef: string | undefined): Promise<void> {
    this.cancelled++;
    this.abort?.abort();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
