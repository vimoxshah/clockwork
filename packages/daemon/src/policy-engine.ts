/**
 * Policy engine (ADR-032, goal #38): enterprise guardrails evaluated at
 * enqueue time — BEFORE any run starts. Fail-closed: a task that violates
 * policy is rejected with an explicit reason, never silently allowed.
 *
 * Policies:
 *  - allowedEngines: CLI/BYOK engines a task may use ('*' = all)
 *  - maxCostPerRunUsd: hard ceiling overriding any task budget
 *  - requireApprovalOverUsd: budget above this needs explicit opt-in
 */
import type { DB } from './db.js';

export interface PolicySet {
  allowedEngines: string[] | '*';
  maxCostPerRunUsd: number | null;
  requireApprovalOverUsd: number | null;
}

export interface PolicyViolation {
  code: string;
  message: string;
}

export class PolicyEngine {
  constructor(private readonly db: DB) {}

  private ensureSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      allowed_engines_json TEXT NOT NULL DEFAULT '*',
      max_cost_per_run_usd REAL,
      require_approval_over_usd REAL
    )`);
    this.db.exec(`INSERT OR IGNORE INTO policies (id, allowed_engines_json, max_cost_per_run_usd, require_approval_over_usd) VALUES (1, '*', NULL, NULL)`);
  }

  get(): PolicySet {
    this.ensureSchema();
    const row = this.db.prepare('SELECT allowed_engines_json, max_cost_per_run_usd, require_approval_over_usd FROM policies WHERE id = 1').get() as
      | { allowed_engines_json: string; max_cost_per_run_usd: number | null; require_approval_over_usd: number | null }
      | undefined;
    let engines: string[] | '*' = '*';
    try {
      const parsed = JSON.parse(row?.allowed_engines_json ?? '*');
      if (Array.isArray(parsed)) engines = parsed.map(String);
    } catch { /* default stays '*' */ }
    return {
      allowedEngines: engines,
      maxCostPerRunUsd: row?.max_cost_per_run_usd ?? null,
      requireApprovalOverUsd: row?.require_approval_over_usd ?? null,
    };
  }

  set(p: Partial<{ allowedEngines: string[]; maxCostPerRunUsd: number | null; requireApprovalOverUsd: number | null }>): void {
    this.ensureSchema();
    const cur = this.get();
    const engines = p.allowedEngines ?? (cur.allowedEngines as unknown);
    if (engines === '*') {
      // wildcard: keep as-is
    } else if (!Array.isArray(engines) || engines.length === 0) {
      throw new Error('allowedEngines must be "*" or a non-empty array');
    }
    const maxCost = p.maxCostPerRunUsd !== undefined ? p.maxCostPerRunUsd : cur.maxCostPerRunUsd;
    if (maxCost !== null && (typeof maxCost !== 'number' || maxCost <= 0)) throw new Error('maxCostPerRunUsd must be a positive number or null');
    const approval = p.requireApprovalOverUsd !== undefined ? p.requireApprovalOverUsd : cur.requireApprovalOverUsd;
    if (approval !== null && (typeof approval !== 'number' || approval <= 0)) throw new Error('requireApprovalOverUsd must be a positive number or null');
    this.db
      .prepare('UPDATE policies SET allowed_engines_json=?, max_cost_per_run_usd=?, require_approval_over_usd=? WHERE id=1')
      .run(JSON.stringify(engines), maxCost, approval);
  }

  /**
   * Evaluate a prospective job. `engine` is the resolved engine id,
   * byokId set → ':byok' suffix applies, requestedBudgetUsd is the task's ask.
   * Returns the first violation or null.
   */
  evaluate(input: { engine: string; byokId?: string | null; requestedBudgetUsd: number }): PolicyViolation | null {
    const p = this.get();
    const effectiveEngine = input.byokId ? `${input.engine}:byok` : input.engine;

    if (Array.isArray(p.allowedEngines)) {
      const list = p.allowedEngines as string[];
      // BYOK variants are a distinct billing surface: they must be explicitly
      // allow-listed as 'engine:byok'; the bare engine entry does NOT admit them.
      const ok = input.byokId ? list.includes(effectiveEngine) : list.includes(input.engine);
      if (!ok) {
        return {
          code: 'engine_not_allowed',
          message: `Policy: engine "${effectiveEngine}" is not in the approved list (${list.join(', ')})`,
        };
      }
    }

    if (p.maxCostPerRunUsd !== null && input.requestedBudgetUsd > p.maxCostPerRunUsd) {
      return {
        code: 'budget_over_policy',
        message: `Policy: requested budget $${input.requestedBudgetUsd} exceeds the per-run ceiling $${p.maxCostPerRunUsd}`,
      };
    }

    return null;
  }

  /** Approval-gate check (goal #18/#19): does this budget need human sign-off? */
  requiresApproval(requestedBudgetUsd: number): boolean {
    const p = this.get();
    return p.requireApprovalOverUsd !== null && requestedBudgetUsd > p.requireApprovalOverUsd;
  }
}
