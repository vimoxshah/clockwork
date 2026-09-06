/**
 * Capability / feature-flag system (goal #43): a real capability registry
 * mapping features → tiers with availability and limits. The daemon exposes
 * it so UI and API can gate honestly; nothing is "fake gated" — every flag
 * here corresponds to an enforced or planned enforcement point.
 */
export type Tier = 'free' | 'pro' | 'team' | 'enterprise';

export interface FeatureDef {
  key: string;
  label: string;
  category: 'execution' | 'providers' | 'scheduling' | 'governance' | 'analytics' | 'integrations';
  tiers: Partial<Record<Tier, { available: boolean; limit?: string }>>;
  /** current implementation status — honesty over marketing */
  status: 'enforced' | 'available' | 'planned';
}

export const FEATURES: FeatureDef[] = [
  { key: 'local_agents',        label: 'Local agents',                 category: 'execution',  tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'byok_providers',      label: 'BYOK providers',               category: 'providers',  tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'cli_engines',         label: 'Subscription CLI engines',     category: 'providers',  tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'custom_endpoints',    label: 'Custom OpenAI-compatible endpoints', category: 'providers', tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'scheduling',          label: 'Recurring schedules (RRULE/cron)', category: 'scheduling', tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'quiet_hours',         label: 'Quiet hours',                  category: 'scheduling', tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'approvals',           label: 'Human approval gates',         category: 'governance', tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'budget_guards',       label: 'Budget guardrails',            category: 'governance', tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'analytics_basic',     label: 'Cost & reliability analytics', category: 'analytics',  tiers: { free: { available: true, limit: '90 days' }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  {
    key: 'retention',
    label: 'History retention',
    category: 'governance',
    tiers: {
      free: { available: true, limit: '30 days' },
      pro: { available: true, limit: '1 year' },
      team: { available: true, limit: '2 years' },
      enterprise: { available: true, limit: 'custom' },
    },
    status: 'available',
  },
  {
    key: 'audit_log',
    label: 'Audit log',
    category: 'governance',
    tiers: { free: { available: false }, pro: { available: true, limit: '30 days' }, team: { available: true }, enterprise: { available: true, limit: 'unlimited + export' } },
    status: 'enforced',
  },
  { key: 'policy_engine',       label: 'Policy engine',                category: 'governance', tiers: { free: { available: false }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'enforced' },
  { key: 'webhooks',            label: 'Webhook delivery',             category: 'integrations', tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'event_triggers',      label: 'Event-triggered agents',       category: 'integrations', tiers: { free: { available: true, limit: '2 triggers' }, pro: { available: true, limit: '50 triggers' }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  // Was `cloud_agents` (Clockwork-hosted execution, planned, team+). Removed:
  // hosted execution was dropped in iteration 3 because a hosted runner needs
  // the user's provider key, negating the keychain promise
  // (docs/architecture/byo-runner.md). Advertising a feature we have decided
  // NOT to build is exactly the 'fake gate' this registry forbids. Replaced by
  // the execution target that actually exists today — see GET /targets.
  { key: 'container_execution', label: 'Isolated container execution', category: 'execution', tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'agent_chains',        label: 'Agent chains',                 category: 'execution',  tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  // ---- Agent Workforce (plan/AGENT-WORKFORCE-SPEC.md) ----
  // Schema landed in migration 0008; the twelve daemon modules and their
  // wiring landed in the integration pass. The status below reports
  // IMPLEMENTATION, not intent:
  //   'enforced'  = daemon code OUTSIDE the /workforce/ routes refuses or
  //                 defers a user action because of this feature.
  //   'available' = a user can reach it through the API right now.
  // Only three qualify as enforced. F1 withholds the execute run until a
  // human resolves the pair's approval (run-manager finalize -> approvals
  // row; the execute task stays enabled=0 until resolve()). F3 defers a
  // scheduled fire out of the tick loop into the next office-hours window.
  // F7 returns 403 from POST /tasks, PATCH /tasks/:id and the webhook fire
  // path when a task asks for more autonomy than its profile has earned.
  // Everything else is reachable but gates nothing, so it says 'available'.
  // No upgrade-modal copy may reference any of these keys (feature-honesty.test.ts).
  { key: 'plan_then_execute',    label: 'Plan-then-execute bookings',    category: 'execution',    tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'enforced' },
  { key: 'shift_handoff',        label: 'Shift handoff memory',          category: 'execution',    tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'office_hours',         label: 'Office hours for approvals',    category: 'scheduling',   tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'enforced' },
  { key: 'sentinel_worker',      label: 'Sentinel + worker pairs',       category: 'scheduling',   tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'repo_shipped_jobs',    label: 'Repo-shipped jobs',             category: 'integrations', tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'accept_with_note',     label: 'Accept with a note',            category: 'governance',   tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'earned_autonomy',      label: 'Earned autonomy',               category: 'governance',   tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'enforced' },
  { key: 'self_healing',         label: 'Self-healing task diagnostics', category: 'governance',   tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'proposed_events',      label: 'Agent-proposed calendar events', category: 'integrations', tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'agent_timesheets',     label: 'Agent timesheets',              category: 'analytics',    tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'performance_reviews',  label: 'Agent performance reviews',     category: 'analytics',    tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'proof_of_work_export', label: 'Proof-of-work export',          category: 'analytics',    tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
  { key: 'sso_scim',            label: 'SSO / SCIM',                   category: 'governance', tiers: { enterprise: { available: true } }, status: 'planned' },
];

/** The product's current license tier (single-user local install = free). */
let currentTier: Tier = 'free';

export function setTier(t: Tier): void {
  currentTier = t;
}

export function getTier(): Tier {
  return currentTier;
}

export function featureEnabled(key: string): boolean {
  const f = FEATURES.find((x) => x.key === key);
  if (!f) return false;
  return Boolean(f.tiers[currentTier]?.available);
}

export function featureLimit(key: string): string | undefined {
  return FEATURES.find((x) => x.key === key)?.tiers[currentTier]?.limit;
}

/**
 * Machine-readable caps (gauntlet §7). Display strings in FEATURES stay
 * human copy; this map is what enforcement actually reads. Absent entry =
 * unlimited on that tier.
 */
export const NUMERIC_LIMITS: Record<string, Partial<Record<Tier, number>>> = {
  /** history retention window in days */
  retention: { free: 30, pro: 365, team: 730 },
  /** maximum enabled+total event triggers */
  event_triggers: { free: 2, pro: 50 },
};

export function numericLimit(key: string): number | undefined {
  return NUMERIC_LIMITS[key]?.[currentTier];
}

export function capabilityMatrix(): Array<{ key: string; label: string; category: string; enabled: boolean; limit?: string; status: string }> {
  return FEATURES.map((f) => ({
    key: f.key,
    label: f.label,
    category: f.category,
    enabled: featureEnabled(f.key),
    limit: featureLimit(f.key),
    status: f.status,
  }));
}
