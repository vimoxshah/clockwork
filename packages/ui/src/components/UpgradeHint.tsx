/**
 * UpgradeHint (gauntlet §12): renders a gated capability as an explanation —
 * what it does, which plan includes it, what the user gets — never a bare
 * "PRO ONLY". Used inline wherever an entitlement 402 surfaces.
 */
import { Lock } from 'lucide-react';

const FEATURE_COPY: Record<string, { title: string; value: string }> = {
  event_triggers: {
    title: 'Event-triggered agents',
    value: 'Fire a scheduled agent automatically when something happens — a PR opens, CI fails, a webhook arrives.',
  },
  audit_log: {
    title: 'Audit log',
    value: 'A tamper-evident ledger of every control-plane action — who changed what, when. Your run history is unaffected.',
  },
  policy_engine: {
    title: 'Policy guardrails',
    value: 'Restrict which engines run, cap spend per run, and require approval above thresholds.',
  },
  retention: {
    title: 'Extended history retention',
    value: 'Keep every report, transcript, and artifact searchable for years instead of weeks.',
  },
  cloud_agents: {
    title: 'Cloud execution targets',
    value: 'Run agents on always-on machines so schedules survive your Mac sleeping.',
  },
};

export function upgradeCopy(feature?: string, requiresPlan?: string): { title: string; value: string; plan: string } {
  const known = feature ? FEATURE_COPY[feature] : undefined;
  return {
    title: known?.title ?? 'This capability',
    value: known?.value ?? 'Part of a paid Clockwork plan.',
    plan: requiresPlan === 'team' ? 'Team' : requiresPlan === 'enterprise' ? 'Enterprise' : 'Pro',
  };
}

export function UpgradeHint({
  message,
  feature,
  requiresPlan,
  onDismiss,
  onLearnMore,
}: {
  message: string;
  feature?: string;
  requiresPlan?: string;
  onDismiss?: () => void;
  onLearnMore?: () => void;
}): JSX.Element {
  const copy = upgradeCopy(feature, requiresPlan);
  return (
    <div
      role="status"
      data-testid="upgrade-hint"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
    >
      <span className="flex items-center gap-2">
        <Lock className="h-4 w-4 shrink-0 text-dim" aria-hidden />
        <strong className="text-ui">{copy.title}</strong>
        <span className="chip" style={{ marginLeft: 'auto' }}>Included with {copy.plan}</span>
        {onDismiss && (
          <button onClick={onDismiss} aria-label="Dismiss" className="rounded p-0.5 text-dim hover:text-fg">✕</button>
        )}
      </span>
      <p className="m-0 text-xs leading-relaxed text-muted">{copy.value}</p>
      <p className="m-0 text-xs leading-relaxed text-dim">{message}</p>
      <span className="flex gap-2">
        <button className="btn small primary" onClick={onLearnMore} data-testid="upgrade-learn-more">
          View plans
        </button>
        {onDismiss && <button className="btn small" onClick={onDismiss}>Not now</button>}
      </span>
      <p className="m-0 text-xxs text-dim">
        Your existing runs, keys, and history stay exactly as they are.
      </p>
    </div>
  );
}
