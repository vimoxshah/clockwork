/**
 * F12 proof-of-work export (plan/AGENT-WORKFORCE-SPEC.md §F12,
 * docs/agent-workforce.md "F12 — Proof-of-work export").
 *
 * Downloads a run's report as a single, self-contained HTML file: no
 * `<script>`, no remote `<img>`/`<link>`, secrets masked unconditionally by
 * the daemon (proof-of-work.ts) with no flag to turn that off. Clockwork
 * uploads nothing anywhere — the file is the user's to host.
 *
 * Mirrors ProposedEvents' download pattern (blob → object URL → synthetic
 * `<a download>` click) but goes through `api.proofOfWork()`, which already
 * returns a typed `Blob` through the shared `send()`/`ApiError` pipeline —
 * no second bearer-token fetch needed here, unlike ProposedEvents' `.ics`
 * route (which api.ts does not wrap).
 *
 * `api.proofOfWorkUrl()` deliberately is NOT rendered as a link or copied to
 * the user: every data route requires the bearer header, so a bare URL 401s
 * the moment anyone opens it (api.ts:679-682) — showing it would invite the
 * one click guaranteed to fail.
 */
import { useState } from 'react';
import { api, type ProofOfWorkOptionsT } from '../api';

function filenameFor(runId: string): string {
  return `clockwork-proof-${runId}.html`;
}

export function ProofOfWorkExport({ runId }: { runId: string }): JSX.Element {
  const [includeTranscript, setIncludeTranscript] = useState(false); // off by default — most sensitive artifact a run produces
  const [includeDiffStat, setIncludeDiffStat] = useState(true);
  const [redactPaths, setRedactPaths] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const exportNow = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    setDone(false);
    const opts: ProofOfWorkOptionsT = { includeTranscript, includeDiffStat, redactPaths };
    try {
      const blob = await api.proofOfWork(runId, opts);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filenameFor(runId);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDone(true);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="proof-of-work mt-4 border-t border-border pt-3">
      <h3 className="section-title">Proof-of-work export</h3>
      <p className="hint" style={{ margin: '0 0 8px' }}>
        A single self-contained HTML file — no scripts, no remote assets, secrets always masked. Nothing is
        uploaded to Clockwork or anywhere else; download it and host it yourself, or send it to whoever asked
        for evidence of the work.
      </p>
      <div className="flex flex-col gap-1 text-compact text-muted">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeDiffStat}
            onChange={(e) => setIncludeDiffStat(e.target.checked)}
            aria-label="Include diff stat"
          />
          Include diff stat
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeTranscript}
            onChange={(e) => setIncludeTranscript(e.target.checked)}
            aria-label="Include transcript"
          />
          Include transcript (the most sensitive artifact this run produced)
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={redactPaths}
            onChange={(e) => setRedactPaths(e.target.checked)}
            aria-label="Also redact file paths and branch names"
          />
          Also redact repo path, worktree path and branch name
        </label>
      </div>
      {err && (
        <div className="error-banner" role="alert">
          Couldn’t export: {err}
        </div>
      )}
      {done && !err && <div className="ok-banner">Downloaded. Open the .html file in any browser — it needs nothing else.</div>}
      <div className="mt-2">
        <button
          className="btn primary small"
          data-testid="proof-of-work-export"
          disabled={busy}
          onClick={() => void exportNow()}
        >
          {busy ? 'Exporting…' : 'Export proof-of-work (.html)'}
        </button>
      </div>
    </div>
  );
}
