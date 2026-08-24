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
  { key: 'cloud_agents',        label: 'Cloud execution targets',      category: 'execution',  tiers: { free: { available: false }, pro: { available: false }, team: { available: true, limit: 'fair use' }, enterprise: { available: true } }, status: 'planned' },
  { key: 'agent_chains',        label: 'Agent chains',                 category: 'execution',  tiers: { free: { available: true }, pro: { available: true }, team: { available: true }, enterprise: { available: true } }, status: 'available' },
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
