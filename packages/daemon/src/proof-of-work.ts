/**
 * F12 proof-of-work-export (plan/AGENT-WORKFORCE-SPEC.md, §F12).
 *
 * Exports a run report as a redacted, self-contained single HTML file the
 * user hosts themselves. Reuses the existing secret masking
 * (`maskSecrets` from `@clockwork/runner`, `context.ts:75`) — masking is not
 * optional and has no flag. No Clockwork-hosted anything: one inline
 * `<style>`, zero `<script>`, zero remote `<img>`/`<link>`.
 *
 * Owns no table. Reads `runs` only (report_json + jobspec_json fallback for
 * runs whose report has not landed yet).
 */
import { existsSync, readFileSync } from 'node:fs';
import { maskSecrets } from '@clockwork/runner';
import { ProofOfWorkOptions } from '@clockwork/shared';
import type { DB } from './db.js';

interface RunRow {
  id: string;
  task_id: string;
  jobspec_json: string;
  state: string;
  worktree_path: string | null;
  branch: string | null;
  transcript_path: string | null;
  journal_path: string | null;
  cost_usd: number | null;
  turns: number | null;
  started_at: number | null;
  ended_at: number | null;
  scheduled_for: number | null;
  outcome_reason: string | null;
  report_json: string | null;
}

interface JobSpecShape {
  taskName?: string;
  engine?: string;
  repoPath?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  profile?: { name?: string } | null;
}

interface DiffStatShape {
  path?: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

interface TimelineShape {
  at?: number;
  kind?: string;
  text?: string;
}

interface ReportShape {
  summary?: string;
  failureReason?: string | null;
  timeline?: TimelineShape[];
  diffStat?: DiffStatShape[];
  profile?: { name?: string } | null;
  engine?: string;
  taskName?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Mask first, escape last: mask labels (e.g. `[AWS-KEY-MASKED]`) contain no
 * HTML metacharacters, so escaping afterward cannot re-expose anything the
 * mask removed. Every interpolated string in the document must go through
 * this — it is the one place masking and escaping happen. */
function safe(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return escapeHtml(maskSecrets(String(s)));
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const TRANSCRIPT_TAIL = 400;
const TRANSCRIPT_UNAVAILABLE = '(transcript not available for this run)';

/** Sync port of the masked-tail rendering in api.ts `/runs/:id/transcript`
 * (api.ts:617) — same source precedence, same journal unwrap, same
 * assistant/result extraction. Never throws; an unreadable or missing
 * transcript degrades to a marker line rather than failing the export. */
function transcriptTail(run: RunRow): string[] {
  const p = run.transcript_path ?? null;
  const fallback = run.journal_path ?? null;
  const source =
    (p && existsSync(p) ? { path: p, kind: 'raw' as const } : null) ??
    (fallback && existsSync(fallback) ? { path: fallback, kind: 'journal' as const } : null);
  if (!source) return [TRANSCRIPT_UNAVAILABLE];

  let raw: string;
  try {
    raw = readFileSync(source.path, 'utf8');
  } catch {
    return [TRANSCRIPT_UNAVAILABLE];
  }

  const allLines = raw.split('\n').filter((l) => l.trim().length > 0);
  const render = (line: string): string => {
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (source.kind === 'journal' && typeof o.line === 'string') return render(o.line);
      const message = o.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      if (o.type === 'assistant' && message?.content) {
        const texts = message.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
        if (texts.length) return `▸ ${texts.join(' ').slice(0, 400)}`;
      }
      if (o.type === 'result') return `■ result: ${String(o.result ?? '').slice(0, 400)}`;
    } catch {
      // not a JSON line — fall through to the raw-text branch below
    }
    return line.slice(0, 300);
  };
  return allLines.slice(-TRANSCRIPT_TAIL).map(render);
}

function fmtMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toISOString();
  } catch {
    // out-of-range epoch value (report content is agent-authored, never trusted)
    return '—';
  }
}

function fmtUsd(n: number | null): string {
  return `$${(n ?? 0).toFixed(4)}`;
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; border-bottom: 1px solid #8888; padding-bottom: .25rem; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: .3rem .6rem; border-bottom: 1px solid #8883; vertical-align: top; }
  .muted { color: #888; }
  .summary, .failure, .transcript { white-space: pre-wrap; word-break: break-word; background: #80808014; padding: .75rem 1rem; border-radius: 6px; }
  .failure { border-left: 3px solid #c33; }
  ul.timeline { list-style: none; padding: 0; }
  ul.timeline li { padding: .2rem 0; border-bottom: 1px solid #8882; }
  footer { margin-top: 3rem; font-size: .8rem; color: #888; }
`;

/**
 * Renders a run report as a redacted, self-contained HTML document.
 * Returns `'not_found'` when `runId` does not exist. Never throws on a
 * malformed or absent report — a run that has not finalized yet still
 * produces a page, sourced from the run row and its booked jobspec.
 */
export function proofOfWorkHtml(db: DB, runId: string, opts?: Partial<ProofOfWorkOptions>): string | 'not_found' {
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | undefined;
  if (!run) return 'not_found';

  const o = ProofOfWorkOptions.parse(opts ?? {});
  const jobspec = (parseJsonObject(run.jobspec_json) ?? {}) as JobSpecShape;
  const report = (parseJsonObject(run.report_json) ?? {}) as ReportShape;

  const taskName = report.taskName ?? jobspec.taskName ?? null;
  const profileName = report.profile?.name ?? jobspec.profile?.name ?? null;
  const engine = report.engine ?? jobspec.engine ?? null;
  const summary = report.summary ?? null;
  const failureReason = report.failureReason ?? null;
  // report_json is bare-JSON.parse'd and never re-validated (§F9/§F12
  // convention), so a malformed report may carry a non-array or an array of
  // non-objects here; drop anything that is not a plausible row rather than
  // throwing on `.map`/`.length` of the wrong shape.
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  const diffStat: DiffStatShape[] =
    o.includeDiffStat && Array.isArray(report.diffStat) ? report.diffStat.filter(isRecord) : [];
  const timeline: TimelineShape[] = Array.isArray(report.timeline) ? report.timeline.filter(isRecord) : [];

  const repoPathRaw = jobspec.repoPath ?? null;
  const worktreePathRaw = run.worktree_path ?? jobspec.worktreePath ?? null;
  const branchRaw = run.branch ?? jobspec.branch ?? null;
  const repoPath = o.redactPaths ? (repoPathRaw ? '[redacted]' : null) : repoPathRaw;
  const worktreePath = o.redactPaths ? (worktreePathRaw ? '[redacted]' : null) : worktreePathRaw;
  const branch = o.redactPaths ? (branchRaw ? '[redacted]' : null) : branchRaw;

  const metaRows: Array<[string, string]> = [
    ['Run ID', safe(run.id)],
    ['Task', safe(taskName ?? '(unnamed task)')],
    ['Profile', safe(profileName ?? '—')],
    ['Engine', safe(engine ?? '—')],
    ['State', safe(run.state)],
    ['Outcome reason', safe(run.outcome_reason ?? '—')],
    ['Scheduled for', fmtMs(run.scheduled_for)],
    ['Started', fmtMs(run.started_at)],
    ['Ended', fmtMs(run.ended_at)],
    ['Cost', safe(fmtUsd(run.cost_usd))],
    ['Turns', safe(run.turns ?? 0)],
    ['Repo path', safe(repoPath ?? '—')],
    ['Worktree path', safe(worktreePath ?? '—')],
    ['Branch', safe(branch ?? '—')],
  ];

  const metaHtml = metaRows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${v}</td></tr>`).join('\n');

  const failureHtml = failureReason
    ? `<h2>Failure</h2>\n<div class="failure">${safe(failureReason)}</div>`
    : '';

  const diffHtml = diffStat.length
    ? `<h2>Diff stat</h2>\n<table>
<tr><th>Path</th><th>+</th><th>−</th><th>Binary</th></tr>
${diffStat
  .map(
    (d) =>
      `<tr><td>${safe(d.path ?? '—')}</td><td>${safe(d.additions ?? 0)}</td><td>${safe(d.deletions ?? 0)}</td><td>${d.binary ? 'yes' : 'no'}</td></tr>`,
  )
  .join('\n')}
</table>`
    : o.includeDiffStat
      ? '<h2>Diff stat</h2>\n<p class="muted">No changes.</p>'
      : '';

  const timelineHtml = timeline.length
    ? `<h2>Timeline</h2>\n<ul class="timeline">
${timeline.map((t) => `<li><span class="muted">${fmtMs(t.at ?? null)}</span> [${safe(t.kind ?? '—')}] ${safe(t.text ?? '')}</li>`).join('\n')}
</ul>`
    : '<h2>Timeline</h2>\n<p class="muted">No timeline entries.</p>';

  const transcriptHtml = o.includeTranscript
    ? `<h2>Transcript (tail)</h2>\n<div class="transcript">${transcriptTail(run)
        .map((l) => safe(l))
        .join('\n')}</div>`
    : `<h2>Transcript</h2>\n<p class="muted">Not included. Pass <code>?includeTranscript=1</code> to include the masked tail.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Clockwork proof of work — ${safe(taskName ?? run.id)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Clockwork proof of work</h1>
<p class="muted">Generated ${escapeHtml(new Date().toISOString())} — self-contained export, no external resources.</p>
<table>
${metaHtml}
</table>
<h2>Summary</h2>
<div class="summary">${safe(summary ?? '(no summary — report not yet available)')}</div>
${failureHtml}
${diffHtml}
${timelineHtml}
${transcriptHtml}
<footer>Exported by Clockwork. This file contains no scripts, stylesheets or images loaded from the network — it is safe to host anywhere.</footer>
</body>
</html>
`;
}

/** Deterministic download filename for a run's proof-of-work export. */
export function proofFilenameFor(runId: string): string {
  return `clockwork-proof-${runId}.html`;
}
