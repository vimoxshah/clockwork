import { describe, expect, it } from 'vitest';
import { BudgetGuard } from '../src/budget-guard.js';

/** S-44/S-45: soft usd cap with bounded overshoot; hard turn cap. */
describe('budget guard', () => {
  it('stops on max_turns (hard bound)', () => {
    const g = new BudgetGuard({ maxUsd: 10, maxTurns: 5 });
    expect(g.observe(0.1, 4)).toBe(false);
    expect(g.observe(0.2, 5)).toBe(true);
    expect(g.snapshot.stopped).toBe('max_turns');
  });

  it('stops on usd soft cap', () => {
    const g = new BudgetGuard({ maxUsd: 2, maxTurns: 100 });
    expect(g.observe(1.5, 3)).toBe(false);
    expect(g.observe(2.01, 4)).toBe(true);
    expect(g.snapshot.stopped).toBe('budget_exceeded');
  });

  it('measures overshoot at finalize', () => {
    const g = new BudgetGuard({ maxUsd: 2, maxTurns: 100 });
    g.observe(1.9, 1);
    g.observe(2.0, 2); // crosses
    g.finalize(2.34); // in-flight message overshot
    expect(g.snapshot.overshootUsd).toBeCloseTo(0.34);
    expect(g.snapshot.costUsd).toBeCloseTo(2.34);
  });

  it('stays stopped once tripped', () => {
    const g = new BudgetGuard({ maxUsd: 1, maxTurns: 2 });
    expect(g.observe(0.5, 1)).toBe(false);
    expect(g.observe(1.0, 2)).toBe(true);
    expect(g.observe(0.1, 1)).toBe(true); // still stopped
  });
});
