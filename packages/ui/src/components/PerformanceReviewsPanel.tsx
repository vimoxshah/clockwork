/**
 * PerformanceReviewsPanel (F11, plan/AGENT-WORKFORCE-SPEC.md): a scorecard per
 * agent profile over a period — acceptance rate, cost trend, failure rate —
 * plus the obvious action to get the written verdict.
 *
 * Mounted as an Analytics sub-tab (AnalyticsView), same reasoning as F10:
 * App.tsx owns the nav and is frozen, so this is the only reachable path.
 *
 * The written verdict is NOT produced here: `api.performanceReviewPrompt`
 * returns text only (daemon: performance.ts — "this module makes no model
 * call and writes no prose"). Booking the run that turns this prompt into a
 * verdict is left to the integrator by design. There is no helper on the
 * frozen `api` object to book an ad-hoc run from arbitrary prompt text, and
 * this component does not own App.tsx's Composer routing, so the reachable
 * action here is: fetch the prompt, show it in full, and tell the user
 * exactly what to do with it (paste into a new task run against a reviewer
 * profile). See the WIRING SNIPPET in the handoff notes for a deeper
 * integration (prefilling Composer directly) if App.tsx's owner wants it.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PerformanceScorecardT } from '../api';
import { Button } from './ui/button';
import { Textarea } from './ui/input';
import { registerFeatureSurface } from './featureSurfaces';

/** Mounted as the Analytics "Performance reviews" sub-tab — see AnalyticsView's Segmented switcher. */
export const PERFORMANCE_REVIEWS_SURFACE = registerFeatureSurface({
  key: 'performance_reviews',
  tab: 'analytics',
  where: 'Analytics › Performance reviews',
  anchorId: 'performance-reviews',
});

function pctText(rate: number | null, decided: number): string {
  if (rate === null) return `not yet reviewed (${decided} decided)`;
  return `${Math.round(rate * 100)}%`;
}

function failureText(rate: number | null): string {
  if (rate === null) return 'no runs';
  return `${Math.round(rate * 100)}%`;
}

function TrendBadge({ trendUsd }: { trendUsd: number | null }): JSX.Element {
  if (trendUsd === null) return <span className="hint" style={{ margin: 0 }}>no prior period</span>;
  if (Math.abs(trendUsd) < 0.00005) return <span className="hint" style={{ margin: 0 }}>flat</span>;
  const up = trendUsd > 0;
  return (
    <span style={{ color: up ? 'var(--danger)' : 'var(--success)', fontSize: 12.5 }}>
      {up ? '▲' : '▼'} ${Math.abs(trendUsd).toFixed(4)}/run
    </span>
  );
}

interface PromptState {
  open: boolean;
  loading: boolean;
  err: string | null;
  text: string | null;
  copied: boolean;
}

const canCopy = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';

export default function PerformanceReviewsPanel({ version, days }: { version: number; days: number }): JSX.Element {
  const [cards, setCards] = useState<PerformanceScorecardT[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Record<string, PromptState>>({});

  useEffect(() => {
    let alive = true;
    setCards(null);
    setErr(null);
    setPrompts({});
    const to = Date.now();
    const from = to - days * 86_400_000;
    api.performanceCards({ from, to })
      .then((r) => { if (alive) { setCards(r.cards); setErr(null); } })
      .catch((e: Error) => { if (alive) setErr(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [version, days]);

  const keyFor = (card: PerformanceScorecardT): string => card.profileId ?? '__unassigned__';

  const togglePrompt = (card: PerformanceScorecardT): void => {
    if (card.profileId === null) return; // no button renders for this case; defensive only
    const key = keyFor(card);
    const existing = prompts[key];
    if (existing?.open) {
      setPrompts((p) => ({ ...p, [key]: { ...existing, open: false } }));
      return;
    }
    if (existing?.text) {
      setPrompts((p) => ({ ...p, [key]: { ...existing, open: true } }));
      return;
    }
    setPrompts((p) => ({ ...p, [key]: { open: true, loading: true, err: null, text: null, copied: false } }));
    const to = Date.now();
    const from = to - days * 86_400_000;
    api.performanceReviewPrompt(card.profileId, { from, to })
      .then((r) => {
        setPrompts((p) => ({ ...p, [key]: { open: true, loading: false, err: null, text: r.prompt, copied: false } }));
      })
      .catch((e: Error) => {
        setPrompts((p) => ({ ...p, [key]: { open: true, loading: false, err: String(e.message ?? e), text: null, copied: false } }));
      });
  };

  const copyPrompt = async (key: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setPrompts((p) => ({ ...p, [key]: { ...p[key], copied: true } }));
    } catch {
      // clipboard permission denied or unavailable — the textarea is still
      // selectable, so this is a nicety, not a required path
    }
  };

  return (
    <div>
      {err && <div className="error-banner" role="alert">{err}</div>}
      {!cards && !err && <div className="state-line"><span className="spinner" /> Computing scorecards…</div>}

      {cards && cards.length === 0 && (
        <div className="empty">
          No runs in this window yet. Once agents run against a period with activity, each profile's
          acceptance rate, failure rate and cost trend shows up here — with a one-click prompt to get a
          written performance verdict.
        </div>
      )}

      {cards && cards.map((card) => {
        const key = keyFor(card);
        const promptState = prompts[key];
        return (
          <div key={key} className="tasklist-row" style={{ flexDirection: 'column', alignItems: 'stretch' }} data-testid={`scorecard-${key}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <strong>{card.profileName}</strong>
              <span className="hint" style={{ margin: 0 }}>{card.runs} run{card.runs === 1 ? '' : 's'}</span>
              <span className="grow" />
              <span style={{ fontSize: 12.5 }} title="accepted / decided">
                Acceptance: {pctText(card.acceptanceRate, card.decided)}
              </span>
              <span
                style={{ fontSize: 12.5, color: card.failureRate !== null && card.failureRate > 0.25 ? 'var(--danger)' : undefined }}
                title="failed + timed out / runs"
              >
                Failure: {failureText(card.failureRate)}
              </span>
              <span style={{ fontSize: 12.5 }}>${card.costUsd.toFixed(4)}</span>
              <TrendBadge trendUsd={card.costTrendUsd} />
              {card.profileId === null ? (
                <span className="hint" style={{ margin: 0 }} title="Unassigned runs have no agent profile to review">
                  no profile to review
                </span>
              ) : (
                <Button size="sm" onClick={() => togglePrompt(card)} data-testid={`review-prompt-toggle-${key}`}>
                  {promptState?.open ? 'Hide prompt' : 'Get review prompt'}
                </Button>
              )}
            </div>

            {promptState?.open && (
              <div style={{ marginTop: 10 }}>
                {promptState.loading && <div className="state-line"><span className="spinner" /> Loading prompt…</div>}
                {promptState.err && <div className="error-banner" role="alert">{promptState.err}</div>}
                {promptState.text !== null && (() => {
                  const promptText = promptState.text;
                  return (
                    <>
                      <p className="hint" style={{ marginTop: 0 }}>
                        This is text only — nothing here calls a model. Paste it into a new task run against a
                        reviewer profile (e.g. Code Reviewer); that run writes the prose verdict. The numbers
                        above are already computed, so a real reviewer must explain them, not recompute or
                        contradict them.
                      </p>
                      <Textarea readOnly value={promptText} rows={10} data-testid={`review-prompt-text-${key}`} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                      {canCopy && (
                        <Button size="sm" variant="outline" style={{ marginTop: 6 }} onClick={() => void copyPrompt(key, promptText)}>
                          {promptState.copied ? 'Copied' : 'Copy prompt'}
                        </Button>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
