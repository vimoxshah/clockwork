/**
 * Budget guard (FR-10 / S-44 / S-45): usd = SOFT cap with bounded overshoot;
 * turns/time are HARD bounds. Enforcement points fire between messages, so
 * overshoot lands within one in-flight message (measured into the report).
 */
import type { RunnerIO } from '@clockwork/shared';

export interface BudgetLimits {
  maxUsd: number;
  maxTurns: number;
}

export interface BudgetState {
  costUsd: number;
  turns: number;
  stopped: false | 'budget_exceeded' | 'max_turns';
  overshootUsd: number;
}

export class BudgetGuard {
  private state: BudgetState = { costUsd: 0, turns: 0, stopped: false, overshootUsd: 0 };

  constructor(
    private readonly limits: BudgetLimits,
    private readonly io?: Pick<RunnerIO, 'onLog'>,
  ) {}

  get snapshot(): Readonly<BudgetState> {
    return this.state;
  }

  /** Returns true if the run must stop now. */
  observe(costUsd: number, turns: number): boolean {
    this.state.costUsd = Math.max(this.state.costUsd, costUsd);
    this.state.turns = Math.max(this.state.turns, turns);
    if (this.state.stopped) return true;

    if (this.state.turns >= this.limits.maxTurns) {
      this.state.stopped = 'max_turns';
      this.io?.onLog(`[budget] max_turns ${this.limits.maxTurns} reached — hard stop`);
      return true;
    }
    if (this.state.costUsd >= this.limits.maxUsd) {
      this.state.stopped = 'budget_exceeded';
      // Overshoot will be reconciled with the final cumulative figure at stop.
      this.io?.onLog(`[budget] soft cap $${this.limits.maxUsd} reached — stopping after in-flight message`);
      return true;
    }
    return false;
  }

  /** Reconcile final totals (the last message may have overshot the cap). */
  finalize(finalCostUsd: number): void {
    if (finalCostUsd > this.state.costUsd) this.state.costUsd = finalCostUsd;
    if (this.state.costUsd > this.limits.maxUsd && this.state.stopped === 'budget_exceeded') {
      this.state.overshootUsd = this.state.costUsd - this.limits.maxUsd;
    }
  }
}
