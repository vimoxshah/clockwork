/**
 * F5 repo-shipped jobs, inside Tasks.
 *
 * A repository can recommend jobs in `.clockwork/jobs.json` (or `.yaml`).
 * Clockwork reads that file, OFFERS what it finds, and imports nothing on its
 * own.
 *
 * THIS SCREEN IS PART OF THE DEFENCE, NOT A LIST OF BUTTONS.
 * The jobs file is untrusted input from a repository, so the card shows the
 * whole of what would be imported — the prompt verbatim, the security flags,
 * and the fixed terms the import runs on — before it offers the button. Three
 * facts are stated on every offered card because a user cannot check them for
 * themselves:
 *   - the imported task arrives DISABLED and UNSCHEDULED; nothing runs until a
 *     human enables it (repo-jobs.ts:616, `schedule: {kind:'queue'}`);
 *   - permission mode, budget and engine are Clockwork's own conservative
 *     defaults, not the repo's — `RepoJobSpec` has no such fields, so a repo
 *     cannot ask for more power or more money (shared/workforce.ts:207);
 *   - the schedule the repo suggests is NOT applied at import.
 * `Import` is deliberately not the primary-styled, first-reachable control.
 *
 * Import and Dismiss are drawn only for `status: 'offered'`: both routes CAS on
 * that status and answer 422 "this job offer has already been decided"
 * otherwise (repo-jobs.ts:577). A red security flag is refused by the import
 * route as well, so that button is disabled with the reason rather than left
 * to fail.
 */
import { useState } from 'react';
import { api, type RepoJobOfferT, type RepoJobStatusT } from '../api';
import { useAsync } from '../useAsync';
import { FolderBrowserDialog } from './FolderBrowserDialog';

type Filter = 'offered' | 'imported' | 'dismissed' | 'all';

const FILTERS: Filter[] = ['offered', 'imported', 'dismissed', 'all'];

const PROMPT_BLOCK: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 260,
  overflow: 'auto',
  margin: '4px 0 6px',
  fontSize: 12,
};

const FLAG_CHIP: Record<'red' | 'yellow' | 'info', string> = {
  red: 'failed',
  yellow: 'needs-you',
  info: '',
};

export default function RepoJobsSection({
  version,
  onFindInTasks,
  onTasksChanged,
}: {
  version: number;
  onFindInTasks: (query: string) => void;
  onTasksChanged: () => void;
}): JSX.Element {
  const offers = useAsync(() => api.repoJobs(), [version]);
  const [filter, setFilter] = useState<Filter>('offered');
  const [repoPath, setRepoPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = offers.data?.offers ?? [];
  const visible = filter === 'all' ? rows : rows.filter((o) => o.status === filter);
  const countOf = (s: Filter): number => (s === 'all' ? rows.length : rows.filter((o) => o.status === s).length);

  const scan = async (): Promise<void> => {
    const path = repoPath.trim();
    if (!path) return;
    setScanning(true);
    setScanErr(null);
    setScanMsg(null);
    try {
      const res = await api.repoJobsDiscover(path);
      // A repo with no jobs file is not an error — it is an answer, and it has
      // to read differently from "you have not scanned anything yet".
      setScanMsg(
        res.offers.length === 0
          ? `No .clockwork/jobs.json, jobs.yaml or jobs.yml in ${path}, so that repository recommends nothing.`
          : `${path} recommends ${res.offers.length} job${res.offers.length === 1 ? '' : 's'}. Nothing was imported — review each one below.`,
      );
      setFilter('offered');
      offers.reload();
    } catch (e) {
      setScanErr(String((e as Error).message ?? e));
    } finally {
      setScanning(false);
    }
  };

  const announce = (msg: string): void => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 6000);
  };

  return (
    <div>
      <div className="tasks-toolbar">
        <div className="grow">
          <h3 className="section-title" style={{ margin: 0 }}>Jobs a repository recommends</h3>
          <p className="hint" style={{ marginTop: 2 }}>
            Point Clockwork at a repository and it reads <span className="mono">.clockwork/jobs.json</span> (or
            <span className="mono"> .yaml</span>) and offers what it finds. Nothing is imported until you say so,
            and an imported job arrives switched off.
          </p>
        </div>
        <button className="btn small" onClick={offers.reload} aria-label="Refresh offers">⟳</button>
      </div>

      <div className="tasklist-row">
        <div className="grow">
          <label className="f" htmlFor="rj-path">Repository folder</label>
          <input
            id="rj-path"
            className="mono"
            type="text"
            value={repoPath}
            placeholder="/Users/you/dev/my-repo"
            onChange={(e) => setRepoPath(e.target.value)}
          />
        </div>
        <button className="btn small" onClick={() => setBrowsing(true)}>Browse…</button>
        <button className="btn primary small" disabled={scanning || !repoPath.trim()} data-testid="rj-scan" onClick={() => void scan()}>
          {scanning ? 'Reading…' : 'Read this repo'}
        </button>
      </div>
      {scanErr && <div className="error-banner" role="alert">Couldn’t read that repository: {scanErr}</div>}
      {scanMsg && <div className="ok-banner" data-testid="rj-scan-result">{scanMsg}</div>}
      {notice && <div className="ok-banner">{notice}</div>}

      <div className="filter-chips" role="tablist" aria-label="Filter offers" style={{ marginTop: 10 }}>
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
            {f} {countOf(f)}
          </button>
        ))}
      </div>

      {offers.loading && <div className="state-line"><span className="spinner" /> Loading offers…</div>}
      {offers.error && (
        <div className="error-banner" role="alert">
          Couldn’t load repository jobs: {offers.error}
          <div><button className="btn small" style={{ marginTop: 8 }} onClick={offers.reload}>Retry</button></div>
        </div>
      )}

      {!offers.loading && !offers.error && rows.length === 0 && (
        <div className="empty" data-testid="rj-empty">
          No repository has been read yet.
          <p className="hint">
            A repo can ship the jobs it thinks it needs — a nightly dependency sweep, a docs check — in
            <span className="mono"> .clockwork/jobs.json</span>. Put its folder in the box above and read it;
            you will see the exact prompt of every job it recommends before anything is imported.
          </p>
        </div>
      )}
      {!offers.loading && !offers.error && rows.length > 0 && visible.length === 0 && (
        <div className="empty">
          No {filter} offers.
          <div><button className="btn small" style={{ marginTop: 8 }} onClick={() => setFilter('all')}>Show all</button></div>
        </div>
      )}

      {visible.map((o) => (
        <OfferCard
          key={o.id}
          offer={o}
          onDecided={(msg) => {
            announce(msg);
            offers.reload();
            onTasksChanged();
          }}
          onFindInTasks={onFindInTasks}
        />
      ))}

      <FolderBrowserDialog open={browsing} onClose={() => setBrowsing(false)} onPick={(p) => setRepoPath(p)} />
    </div>
  );
}

const STATUS_CHIP: Record<RepoJobStatusT, { cls: string; label: string }> = {
  offered: { cls: 'needs-you', label: 'awaiting your decision' },
  imported: { cls: 'completed', label: 'imported — paused' },
  dismissed: { cls: '', label: 'dismissed' },
};

export function OfferCard({
  offer,
  onDecided,
  onFindInTasks,
}: {
  offer: RepoJobOfferT;
  onDecided: (msg: string) => void;
  onFindInTasks: (query: string) => void;
}): JSX.Element {
  const decidable = offer.status === 'offered';
  const [showPrompt, setShowPrompt] = useState(decidable);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const flags = offer.preview?.flags ?? [];
  const blocked = flags.some((f) => f.level === 'red');
  const chip = STATUS_CHIP[offer.status];
  const sched = offer.spec.schedule;

  const act = async (fn: () => Promise<unknown>, msg: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onDecided(msg);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tasklist-row" style={{ display: 'block' }} data-testid={`offer-${offer.status}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className={`chip ${chip.cls}`}>{chip.label}</span>
        <strong className="grow">{offer.name}</strong>
        <span className="hint mono" style={{ margin: 0 }}>{offer.jobKey}</span>
      </div>

      <div className="hint" style={{ marginTop: 4 }}>
        from <span className="mono">{offer.sourcePath}</span> · read {new Date(offer.discoveredAt).toLocaleString()}
        {' · digest '}<span className="mono">{offer.digest.slice(0, 12)}</span>
      </div>
      {offer.spec.description && <div className="hint" style={{ marginTop: 2 }}>{offer.spec.description}</div>}

      <div style={{ marginTop: 6 }}>
        <button className="btn small" onClick={() => setShowPrompt((s) => !s)} data-testid="offer-prompt-toggle">
          {showPrompt ? 'Hide the prompt' : `Show the prompt this job would run (${offer.spec.prompt.length} characters)`}
        </button>
        {showPrompt && (
          <pre className="mono" style={PROMPT_BLOCK} data-testid="offer-prompt">
            {offer.spec.prompt}
          </pre>
        )}
      </div>

      {sched && (
        <div className="hint">
          The repo suggests {sched.kind === 'cron' ? <span className="mono">{sched.cron}</span> : <span className="mono">{sched.rrule}</span>}{' '}
          ({sched.tz}) — <strong>not applied</strong>. An imported job arrives unscheduled; you choose when, if
          ever, it runs.
        </div>
      )}

      <div style={{ marginTop: 6 }}>
        <strong className="hint" style={{ display: 'block' }}>Security review</strong>
        {offer.preview === null ? (
          <p className="hint" data-testid="offer-no-preview">
            No security preview was recorded for this offer, so Clockwork cannot summarise what it contains.
            Read the prompt above yourself before importing.
          </p>
        ) : (
          flags.map((f, i) => (
            <div key={i} className="hint" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span className={`chip ${FLAG_CHIP[f.level]}`}>{f.level}</span>
              <span className="grow">{f.text}</span>
            </div>
          ))
        )}
      </div>

      {decidable && (
        <div className="hint" style={{ marginTop: 6 }} data-testid="offer-import-terms">
          <strong>If you import this:</strong> it becomes a task that is <strong>switched off</strong> and
          unscheduled — nothing runs until you enable it yourself. It runs on Clockwork’s own terms, not the
          repo’s: permission mode <span className="mono">acceptEdits</span>, budget{' '}
          <span className="mono">$2 · 50 turns · 3600s</span>, working in{' '}
          <span className="mono">{offer.repoPath}</span>. A jobs file cannot ask for a permission mode, an
          engine, a BYOK provider or a budget — the format has no such fields, so a repository cannot give
          itself more power or more money than this.
        </div>
      )}

      {err && <div className="error-banner" role="alert">{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {decidable && (
          <>
            <button
              className="btn small"
              disabled={busy || blocked}
              data-testid="offer-import"
              title={blocked ? 'The security preview raised a red flag; the daemon refuses this import.' : undefined}
              onClick={() => void act(() => api.repoJobImport(offer.id), `“${offer.name}” imported as a paused task. Nothing runs until you enable it.`)}
            >
              Import as a paused task
            </button>
            <button
              className="btn danger small"
              disabled={busy}
              data-testid="offer-dismiss"
              onClick={() => void act(() => api.repoJobDismiss(offer.id), `“${offer.name}” dismissed.`)}
            >
              Dismiss
            </button>
          </>
        )}
        {offer.status === 'imported' && (
          <button className="btn small" data-testid="offer-find" onClick={() => onFindInTasks(offer.name)}>
            Find it in Tasks
          </button>
        )}
      </div>

      {blocked && decidable && (
        <p className="hint" data-testid="offer-blocked">
          Import is refused while the security preview carries a red flag — the daemon rejects it too, so the
          button would only fail. The repository has to fix the job before Clockwork will take it.
        </p>
      )}
      {offer.status === 'imported' && (
        <p className="hint" data-testid="offer-imported">
          Imported as a paused task. Read it in Tasks, then enable it when you are happy with it.
        </p>
      )}
      {offer.status === 'dismissed' && (
        <p className="hint">
          Dismissed. Reading this repository again leaves it dismissed unless the job itself changes — a
          different digest is offered afresh.
        </p>
      )}
    </div>
  );
}
