/**
 * One row of the "NEEDS YOU" inbox list.
 *
 * THREE DIFFERENT DECISIONS ARRIVE THROUGH ONE TABLE. `approvals` holds the
 * live permission prompts a running child asks for (run-manager.ts), F1's
 * plan approvals (plan-execute.ts) and F8's remediation proposals
 * (self-healing.ts) — and `GET /approvals` returns every unresolved row with
 * no `kind` filter. Both workforce features write `kind='question'`, so the
 * row's `kind` column alone cannot tell them apart; the payload shape can.
 *
 * The card must describe the decision it is asking for, because the decision
 * is not reversible in the same way for all three:
 *   - plan (F1)          Approve BOOKS A REAL AGENT RUN with this plan bound.
 *   - remediation (F8)   Approve REWRITES the task's prompt or profile. This
 *                        click is the whole of ADR-039's "only a human applies
 *                        it" guarantee, so the human has to see the change.
 *   - permission         Approve steers a child that is running right now.
 *
 * The "~2 min, then auto-denied" copy is TRUE ONLY OF THE LAST ONE. F1 and F8
 * set `timeout_at` 30 days out and nothing sweeps the table on it — see
 * plan-execute.ts:247 and self-healing.ts:250, "these items wait for a human
 * indefinitely, by design". Showing that copy on a workforce row tells the
 * reader a deadline exists where none does, so it is gated on positive
 * evidence of a live prompt, never on the absence of the other two shapes.
 */
import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../useAsync';
import { registerFeatureSurface } from './featureSurfaces';

/**
 * The generic approval gate — every kind this card draws (plan, remediation,
 * permission, unknown) is a human approval decision. Anchor lives on
 * InboxView's "needs you" filter chip (always rendered); this card itself
 * only mounts once an approval is pending.
 */
export const APPROVALS_SURFACE = registerFeatureSurface({
  key: 'approvals',
  tab: 'inbox',
  where: 'Inbox › Approvals',
  anchorId: 'approvals',
});

/**
 * F8 self-healing: the 'remediation' kind of this same card is the
 * self-healing screen — a diagnostic run's proposed fix, applied only on a
 * human's click (RemediationBody below). Same anchor as `approvals` (that
 * card is where a remediation proposal actually surfaces); distinct `where`
 * copy names the specific feature.
 */
export const SELF_HEALING_SURFACE = registerFeatureSurface({
  key: 'self_healing',
  tab: 'inbox',
  where: 'Inbox › Approvals (remediation proposals)',
  anchorId: 'approvals',
});

export type ApprovalKind = 'plan' | 'remediation' | 'permission' | 'unknown';

function parsePayload(raw: unknown): any {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * What is this row actually asking? Payload shape first, because F1 and F8
 * share `kind='question'`. `unknown` is deliberate: a row nobody can describe
 * must not inherit the permission card's deadline claim.
 */
export function approvalKindOf(approval: any): ApprovalKind {
  const payload = parsePayload(approval?.payload_json);
  if (nonEmpty(payload.pairId)) return 'plan';
  if (nonEmpty(payload.proposalId)) return 'remediation';
  if (approval?.kind === 'permission' || nonEmpty(payload.reqId)) return 'permission';
  return 'unknown';
}

const VALUE_BLOCK: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 220,
  overflow: 'auto',
  margin: '2px 0 6px',
  fontSize: 12,
};

const LABELS: Record<ApprovalKind, { approve: string; deny: string }> = {
  plan: { approve: 'Approve & book execute run', deny: 'Reject plan' },
  remediation: { approve: 'Apply change', deny: 'Reject change' },
  permission: { approve: 'Approve', deny: 'Deny' },
  unknown: { approve: 'Approve', deny: 'Deny' },
};

/** F1 — the plan text is carried in the payload, so this never fetches. */
function PlanBody({ plan }: { plan: string }): JSX.Element {
  return (
    <>
      <strong>Plan ready for your approval</strong>
      <pre className="mono" style={VALUE_BLOCK}>
        {plan || '(the plan run produced no plan text)'}
      </pre>
      <p className="hint" style={{ margin: 0 }}>
        Approving books the execute run now, with this plan bound to it. Rejecting closes the pair and
        books nothing. Nothing expires — this waits for you.
      </p>
    </>
  );
}

/**
 * F8 — the payload carries the target and the proposed value; the CURRENT
 * value and the rationale live on the proposal row, so they are fetched. A
 * failed fetch must never blank the card: what would be applied is already in
 * hand, and the missing half is called out rather than silently dropped.
 */
function RemediationBody({
  proposalId,
  target,
  proposedValue,
}: {
  proposalId: string;
  target: string;
  proposedValue: string;
}): JSX.Element {
  const proposal = useAsync(() => api.remediation(proposalId), [proposalId]);
  const field = proposal.data?.target ?? (target || 'value');
  const proposed = proposal.data?.proposedValue ?? proposedValue;

  return (
    <>
      <strong>Change proposed by a diagnostic run</strong>
      <div className="meta mono" style={{ color: 'var(--dim)', fontSize: 12, margin: '3px 0' }}>
        target: {field}
      </div>

      <div className="hint">Current {field}</div>
      {proposal.loading && <div className="hint">Loading the current value…</div>}
      {proposal.error && (
        <div className="hint" data-testid="remediation-current-missing">
          Current value unavailable — {proposal.error}
        </div>
      )}
      {!proposal.loading && !proposal.error && (
        <pre className="mono" style={VALUE_BLOCK}>
          {proposal.data?.currentValue ?? '(none)'}
        </pre>
      )}

      <div className="hint">Proposed {field}</div>
      <pre className="mono" style={VALUE_BLOCK} data-testid="remediation-proposed">
        {proposed || '(empty)'}
      </pre>

      {proposal.data?.rationale && (
        <p className="hint" style={{ margin: '0 0 4px' }}>
          Why: {proposal.data.rationale}
        </p>
      )}
      <p className="hint" style={{ margin: 0 }}>
        Approving rewrites this task’s {field} to the proposed value — the agent cannot do that itself,
        only this click can. Nothing expires; this waits for you.
      </p>
    </>
  );
}

/** A live child is blocked on this answer. The only kind with a real deadline. */
function PermissionBody({ tool }: { tool: string }): JSX.Element {
  return (
    <>
      <strong>Permission request</strong>
      <div className="meta mono" style={{ color: 'var(--dim)', fontSize: 12, margin: '3px 0' }}>
        {tool.slice(0, 100)}
      </div>
      <p className="hint" style={{ margin: 0 }}>
        Answer within the engine’s decision window (~2 min) to steer this live run. After that it is
        auto-denied (unattended fail-safe) and shown for audit.
      </p>
    </>
  );
}

/** Shape we cannot describe: say so, show it raw, promise nothing. */
function UnknownBody({ payload }: { payload: any }): JSX.Element {
  return (
    <>
      <strong>Approval request</strong>
      <p className="hint" style={{ margin: '3px 0' }}>
        Clockwork does not recognise this request’s shape, so it cannot say what approving would do.
        The raw request is below.
      </p>
      <pre className="mono" style={VALUE_BLOCK}>
        {JSON.stringify(payload, null, 2)}
      </pre>
    </>
  );
}

export function ApprovalCard({ approval, onChanged }: { approval: any; onChanged: () => void }): JSX.Element {
  const payload = parsePayload(approval.payload_json);
  const kind = approvalKindOf(approval);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const respond = async (decision: 'approved' | 'denied'): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await api.respondApproval(approval.id, decision);
      onChanged();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval-card" data-testid={`approval-${kind}`}>
      {kind === 'plan' && <PlanBody plan={String(payload.plan ?? '')} />}
      {kind === 'remediation' && (
        <RemediationBody
          proposalId={String(payload.proposalId)}
          target={String(payload.target ?? '')}
          proposedValue={String(payload.proposedValue ?? '')}
        />
      )}
      {kind === 'permission' && <PermissionBody tool={String(payload.tool ?? '')} />}
      {kind === 'unknown' && <UnknownBody payload={payload} />}
      {err && <div className="error-banner">{err}</div>}
      <div className="approval-actions">
        <button
          className="btn primary small"
          data-testid="approval-approve"
          disabled={busy}
          onClick={() => void respond('approved')}
        >
          {LABELS[kind].approve}
        </button>
        <button
          className="btn danger small"
          data-testid="approval-deny"
          disabled={busy}
          onClick={() => void respond('denied')}
        >
          {LABELS[kind].deny}
        </button>
      </div>
    </div>
  );
}
