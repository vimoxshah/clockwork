/**
 * Regression coverage for the "needs you" filter bug: F1 plan approvals and
 * F8 remediation proposals open once their run has already FINALIZED
 * (plan-execute.ts, self-healing.ts), so the run's own state is `completed`
 * by the time the approval exists. The old filter matched only on run
 * state (`waiting_approval`/`awaiting_user`), so clicking the "needs you"
 * chip could never surface either case — the one filter meant to show work
 * needing a human showed nothing, with an empty-state that claimed
 * "No runs yet" even though runs existed.
 *
 * Two kinds of assertion, same split as workforce-inbox.test.tsx:
 *   1. Pure-logic: the exported `matchesFilter`/`emptyMessageFor` helpers,
 *      unit-tested directly — cheap and precise about the fix itself.
 *   2. Behaviour-level: a full `<InboxView>` render (jsdom + createRoot)
 *      proving the filter and the empty-state text as the user sees them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesFilter, emptyMessageFor } from '../src/components/InboxView';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const INBOX = readFileSync(resolve(SRC, 'components/InboxView.tsx'), 'utf8');

describe('matchesFilter (pure)', () => {
  it('needsyou matches a run in a live waiting state even with no approval on record', () => {
    expect(matchesFilter({ id: 'r1', state: 'waiting_approval' }, 'needsyou', new Set())).toBe(true);
    expect(matchesFilter({ id: 'r1', state: 'awaiting_user' }, 'needsyou', new Set())).toBe(true);
  });

  it('needsyou matches a FINALIZED (completed) run that has a pending F1/F8 approval — the bug', () => {
    const needsYouRunIds = new Set(['r1']);
    expect(matchesFilter({ id: 'r1', state: 'completed' }, 'needsyou', needsYouRunIds)).toBe(true);
  });

  it('needsyou does NOT match a completed run with no pending approval', () => {
    expect(matchesFilter({ id: 'r2', state: 'completed' }, 'needsyou', new Set(['r1']))).toBe(false);
  });

  it('other filters are unaffected by needsYouRunIds', () => {
    const needsYouRunIds = new Set(['r1']);
    expect(matchesFilter({ id: 'r1', state: 'completed' }, 'completed', needsYouRunIds)).toBe(true);
    expect(matchesFilter({ id: 'r1', state: 'failed' }, 'failed', needsYouRunIds)).toBe(true);
    expect(matchesFilter({ id: 'r1', state: 'running' }, 'active', needsYouRunIds)).toBe(true);
    expect(matchesFilter({ id: 'r1', state: 'completed' }, 'all', new Set())).toBe(true);
  });
});

describe('emptyMessageFor (pure)', () => {
  it('says "No runs yet" only when there truly are no runs', () => {
    expect(emptyMessageFor('', 'all', 0)).toBe('No runs yet. Book one from the calendar.');
  });

  it('does NOT say "No runs yet" when runs exist and only the filter is empty', () => {
    const msg = emptyMessageFor('', 'needsyou', 5);
    expect(msg).not.toContain('No runs yet');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('gives each filter its own honest empty copy', () => {
    expect(emptyMessageFor('', 'failed', 3)).not.toContain('No runs yet');
    expect(emptyMessageFor('', 'active', 3)).not.toContain('No runs yet');
    expect(emptyMessageFor('', 'completed', 3)).not.toContain('No runs yet');
  });

  it('a search query still wins over the filter-empty copy', () => {
    expect(emptyMessageFor('flaky test', 'needsyou', 5)).toBe('No runs match “flaky test”.');
  });
});

describe('InboxView mounts the new F2/F12 surfaces (source-level, same philosophy as workforce-inbox.test.tsx)', () => {
  it('imports and renders TaskMemoryPanel keyed off the run\'s task', () => {
    expect(INBOX).toContain("import { TaskMemoryPanel } from './TaskMemoryPanel'");
    expect(INBOX).toContain('<TaskMemoryPanel taskId={run.task_id} runId={runId} version={version} />');
  });

  it('imports and renders ProofOfWorkExport only once a run has stopped', () => {
    expect(INBOX).toContain("import { ProofOfWorkExport } from './ProofOfWorkExport'");
    expect(INBOX).toContain('{!active && <ProofOfWorkExport runId={runId} />}');
  });

  it('does not disturb the three lines workforce-inbox.test.tsx byte-asserts', () => {
    expect(INBOX).toContain("<ApprovalCard key={a.id} approval={a} onChanged={approvals.reload} />");
    expect(INBOX).toContain('<ProposedEvents runId={runId} events={report?.proposedEvents ?? []} />');
    expect(INBOX).toContain("{!active && <OutcomeControls runId={runId} />}");
  });
});

// ---------------------------------------------------------------------------
// Behaviour-level: a full InboxView render
// ---------------------------------------------------------------------------

async function render(node: JSX.Element): Promise<HTMLDivElement> {
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  createRoot(container).render(node);
  await new Promise((r) => setTimeout(r, 60));
  return container;
}

const now = 1_700_000_000_000;

/** A recurring task's run whose F1 plan approval opened after it finalized. */
const runWithApproval = {
  id: 'run_alpha',
  task_id: 'task_alpha',
  state: 'completed',
  outcome_reason: null,
  cost_usd: 0.12,
  turns: 4,
  started_at: now - 200_000,
  ended_at: now - 100_000,
  scheduled_for: null,
  branch: null,
  worktree_path: null,
  report_json: null,
  jobspec_json: JSON.stringify({ taskName: 'Nightly deps sweep', engine: 'claude' }),
};

/** An unrelated completed run with nothing pending on it. */
const runWithoutApproval = {
  ...runWithApproval,
  id: 'run_beta',
  task_id: 'task_beta',
  jobspec_json: JSON.stringify({ taskName: 'Docs freshness pass', engine: 'claude' }),
};

const planApproval = {
  id: 'ap_1',
  run_id: 'run_alpha',
  kind: 'question',
  payload_json: JSON.stringify({ pairId: 'pair_1', plan: 'Step 1: bump lodash' }),
  requested_at: now,
  timeout_at: now + 30 * 86_400_000,
  fallback: 'deny-and-continue',
};

function findChip(container: HTMLDivElement, label: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('.filter-chips button')).find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`no filter chip labelled "${label}"`);
  return btn;
}

function stubInboxFetch(runs: unknown[], approvals: unknown[] | { status: number; body: unknown }): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.startsWith('/runs?')) return new Response(JSON.stringify(runs), { status: 200 });
    if (u === '/approvals') {
      if (Array.isArray(approvals)) return new Response(JSON.stringify(approvals), { status: 200 });
      return new Response(JSON.stringify(approvals.body), { status: approvals.status });
    }
    throw new Error(`unexpected fetch in InboxView test: ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('Inbox "needs you" filter (behaviour)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces a FINALIZED run with a pending approval, and excludes one with none', async () => {
    stubInboxFetch([runWithApproval, runWithoutApproval], [planApproval]);
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await render(<InboxView version={0} />);

    // Sanity: with the default 'all' filter both rows already show.
    expect(container.textContent).toContain('Nightly deps sweep');
    expect(container.textContent).toContain('Docs freshness pass');

    findChip(container, 'needs you').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));

    expect(container.textContent, 'the run behind the pending approval must show up').toContain('Nightly deps sweep');
    expect(container.textContent, 'a run with nothing pending must not').not.toContain('Docs freshness pass');
    expect(container.textContent, 'the row should say why it is listed').toContain('awaiting your decision');
    expect(container.textContent, 'no "empty" placeholder when a match exists').not.toContain('No runs yet');
  });

  it('shows an honest empty state (not "No runs yet") when a filter matches nothing but runs exist', async () => {
    // Neither run is failed, and neither has any pending approval.
    stubInboxFetch([runWithoutApproval], []);
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await render(<InboxView version={0} />);
    expect(container.textContent).toContain('Docs freshness pass');

    findChip(container, 'failed').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));

    expect(container.textContent).not.toContain('No runs yet');
    expect(container.textContent).toContain('No failed runs');
  });

  it('a genuinely empty inbox still gets the "book one from the calendar" copy', async () => {
    stubInboxFetch([], []);
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await render(<InboxView version={0} />);
    expect(container.textContent).toContain('No runs yet. Book one from the calendar.');
  });

  it('surfaces a failed approvals fetch instead of silently showing an empty needs-you filter', async () => {
    stubInboxFetch([runWithoutApproval], { status: 500, body: { error: 'daemon exploded' } });
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await render(<InboxView version={0} />);
    expect(container.textContent).toContain('daemon exploded');
    expect(container.querySelector('.error-banner')).not.toBeNull();
  });
});
