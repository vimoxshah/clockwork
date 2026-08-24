/**
 * Policy engine tests (goal #38): fail-closed guardrails.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PolicyEngine } from '../src/policy-engine.js';

describe('policy engine', () => {
  let db: InstanceType<typeof Database>;
  let pe: PolicyEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    pe = new PolicyEngine(db as never);
  });

  it('defaults to allow-all with no ceilings', () => {
    const p = pe.get();
    expect(p.allowedEngines).toBe('*');
    expect(p.maxCostPerRunUsd).toBeNull();
    expect(pe.evaluate({ engine: 'hermes', requestedBudgetUsd: 100 })).toBeNull();
  });

  it('rejects disallowed engines with an explicit reason', () => {
    pe.set({ allowedEngines: ['cli', 'codex'] });
    const v = pe.evaluate({ engine: 'opencode', requestedBudgetUsd: 1 });
    expect(v?.code).toBe('engine_not_allowed');
    expect(v?.message).toContain('opencode');
    // allowed engine passes
    expect(pe.evaluate({ engine: 'codex', requestedBudgetUsd: 1 })).toBeNull();
  });

  it('treats BYOK variants as their own policy class', () => {
    pe.set({ allowedEngines: ['cli'] });
    // cli without BYOK → ok
    expect(pe.evaluate({ engine: 'cli', byokId: null, requestedBudgetUsd: 1 })).toBeNull();
    // BYOK usage of the same base engine → blocked (separate billing surface)
    const v = pe.evaluate({ engine: 'cli', byokId: '01BYOK', requestedBudgetUsd: 1 });
    expect(v?.code).toBe('engine_not_allowed');
    // explicitly allowlisting 'cli:byok' admits it
    pe.set({ allowedEngines: ['cli', 'cli:byok'] });
    expect(pe.evaluate({ engine: 'cli', byokId: '01BYOK', requestedBudgetUsd: 1 })).toBeNull();
  });

  it('enforces a hard per-run cost ceiling over any task budget', () => {
    pe.set({ maxCostPerRunUsd: 5 });
    expect(pe.evaluate({ engine: 'cli', requestedBudgetUsd: 4 })).toBeNull();
    const v = pe.evaluate({ engine: 'cli', requestedBudgetUsd: 10 });
    expect(v?.code).toBe('budget_over_policy');
  });

  it('flags budgets above the approval threshold', () => {
    pe.set({ requireApprovalOverUsd: 10 });
    expect(pe.requiresApproval(9.5)).toBe(false);
    expect(pe.requiresApproval(25)).toBe(true);
  });

  it('persists settings across instances', () => {
    pe.set({ allowedEngines: ['hermes'], maxCostPerRunUsd: 2 });
    const again = new PolicyEngine(db as never);
    const p = again.get();
    expect(p.allowedEngines).toEqual(['hermes']);
    expect(p.maxCostPerRunUsd).toBe(2);
  });
});
