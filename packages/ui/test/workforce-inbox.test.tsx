/**
 * The workforce UI components are only worth anything if the Inbox actually
 * mounts them. ProposedEvents and OutcomeControls shipped as standalone files
 * during the feature wave — reachable by nobody — and the integration pass is
 * what wired them in.
 *
 * ApprovalCard is the opposite failure: it was always mounted, and it lied.
 * F1 (plan-then-execute) and F8 (self-healing) insert their approvals into the
 * SAME `approvals` table as a live permission prompt, and `GET /approvals`
 * returns every unresolved row with no `kind` filter — so all three arrived at
 * one card hardcoded for the permission case. It read "Permission request",
 * rendered `payload.tool` (a key neither F1 nor F8 has, so the body was EMPTY)
 * and promised a ~2-minute auto-deny that does not exist for those rows
 * (plan-execute.ts:247, self-healing.ts:250: "timeout_at is inert here...
 * these items wait for a human indefinitely, by design"). Approve on that
 * blank card rewrites a task's prompt or books a real agent run. The tests
 * below are the display half of spec §2.4.
 *
 * Two kinds of assertion here, deliberately:
 *   1. Source-level: InboxView imports and RENDERS each component. An
 *      unmounted component is a feature the user cannot reach, and no render
 *      test of the component in isolation would notice.
 *   2. Behaviour-level (jsdom + createRoot, the approach the existing UI tests
 *      use — no new dependency): each component renders what it claims to and
 *      refuses to render when it has nothing to say.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const INBOX = readFileSync(resolve(SRC, 'components/InboxView.tsx'), 'utf8');

describe('the Inbox mounts the workforce components (F6, F9)', () => {
  it('imports both components from the report detail view', () => {
    expect(INBOX).toContain("import { ProposedEvents } from './ProposedEvents'");
    expect(INBOX).toContain("import { OutcomeControls } from './OutcomeControls'");
  });

  it('renders the approvals list through the shared ApprovalCard', () => {
    // Same lesson as above: a card nobody mounts decides nothing. The card is
    // its own module so it can be rendered — and therefore read — in a test.
    expect(INBOX).toContain("import { ApprovalCard } from './ApprovalCard'");
    expect(INBOX).toContain('<ApprovalCard key={a.id} approval={a} onChanged={approvals.reload} />');
  });

  it('renders ProposedEvents with the run id and the report’s proposals', () => {
    // The report field is optional, so the mount must default it — a report
    // predating the field would otherwise crash the whole detail pane.
    expect(INBOX).toContain('<ProposedEvents runId={runId} events={report?.proposedEvents ?? []} />');
  });

  it('renders OutcomeControls only for a run that has stopped', () => {
    // The daemon route does not itself refuse a verdict on a live run, so the
    // `!active` gate is the only thing keeping accept/reject off one.
    expect(INBOX).toContain('{!active && <OutcomeControls runId={runId} />}');
  });

  it('exposes recordOutcome and proposedEvents on the shared api client', () => {
    const api = readFileSync(resolve(SRC, 'api.ts'), 'utf8');
    expect(api).toContain('/workforce/runs/${runId}/outcome');
    expect(api).toContain('/workforce/runs/${runId}/proposed-events');
  });
});

async function render(node: JSX.Element): Promise<HTMLDivElement> {
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  createRoot(container).render(node);
  await new Promise((r) => setTimeout(r, 30));
  return container;
}

describe('ProposedEvents (F9)', () => {
  it('lists every suggestion and offers the .ics download', async () => {
    const { ProposedEvents } = await import('../src/components/ProposedEvents');
    const container = await render(
      <ProposedEvents
        runId="run_1"
        events={[
          { key: 'a', title: 'Review PR 42', notes: 'before Friday', durationMin: 30, suggestedAt: null },
          { key: 'b', title: 'Retro', notes: null, durationMin: 60, suggestedAt: null },
        ]}
      />,
    );
    expect(container.textContent).toContain('Review PR 42');
    expect(container.textContent).toContain('Retro');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.textContent).toContain('Download .ics');
  });

  it('renders nothing at all when the run proposed nothing', async () => {
    const { ProposedEvents } = await import('../src/components/ProposedEvents');
    const container = await render(<ProposedEvents runId="run_1" events={[]} />);
    expect(container.textContent).toBe('');
  });

  it('formats a suggested time without seconds — meaningless precision for a calendar suggestion', async () => {
    const { ProposedEvents } = await import('../src/components/ProposedEvents');
    // A time chosen to land on :26 seconds, matching the bug report's capture
    // ('9/8/2026, 2:13:26 PM') — if seconds ever crept back in, this ':26' would show.
    const suggestedAt = new Date(2026, 8, 8, 14, 13, 26).getTime();
    const container = await render(
      <ProposedEvents
        runId="run_1"
        events={[{ key: 'a', title: 'Add a linter to the fixture repo', notes: null, durationMin: 60, suggestedAt }]}
      />,
    );
    expect(container.textContent).not.toMatch(/:\d{2}:\d{2}\s*(AM|PM)?/i); // no hh:mm:ss anywhere
    expect(container.textContent).toContain('2:13');
  });
});

describe('OutcomeControls (F6)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers accept / reject / accept-with-note for a run with no verdict yet', async () => {
    // 404 = "no decision recorded yet", which the component treats as a
    // fresh run rather than an error.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })),
    );
    const { OutcomeControls } = await import('../src/components/OutcomeControls');
    const container = await render(<OutcomeControls runId="run_1" />);
    expect(container.querySelector('[data-testid="outcome-accept"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="outcome-reject"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="outcome-note-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="outcome-current"]'), 'no verdict exists yet').toBeNull();
  });

  it('shows the verdict already on record instead of pretending the run is undecided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ decision: 'accepted_with_note', note: 'rename the flag' }), { status: 200 }),
      ),
    );
    const { OutcomeControls } = await import('../src/components/OutcomeControls');
    const container = await render(<OutcomeControls runId="run_2" />);
    const current = container.querySelector('[data-testid="outcome-current"]');
    expect(current).not.toBeNull();
    expect(current!.textContent).toContain('accepted with note');
    expect(current!.textContent).toContain('rename the flag');
  });
});

// ---------------------------------------------------------------------------
// ApprovalCard — one table, three very different decisions (spec §2.4)
// ---------------------------------------------------------------------------

const PLAN_TEXT = 'Step 1: rename the --force flag to --overwrite\nStep 2: update the README';
const PROPOSED_PROMPT = 'NEW PROMPT: name the repository explicitly before editing any file';
const CURRENT_PROMPT = 'OLD PROMPT: fix the build';

/** An F1 plan approval, exactly as plan-execute.ts:251-254 writes it. */
const planApproval = {
  id: 'ap_plan',
  run_id: 'run_plan',
  kind: 'question',
  payload_json: JSON.stringify({ pairId: 'pair_1', plan: PLAN_TEXT }),
  requested_at: 1_700_000_000_000,
  timeout_at: 1_700_000_000_000 + 30 * 86_400_000,
  fallback: 'deny-and-continue',
};

/** An F8 remediation proposal, exactly as self-healing.ts:254-262 writes it. */
const remediationApproval = {
  id: 'ap_rem',
  run_id: 'run_diagnostic',
  kind: 'question',
  payload_json: JSON.stringify({ proposalId: 'rem_1', target: 'prompt', proposedValue: PROPOSED_PROMPT }),
  requested_at: 1_700_000_000_000,
  timeout_at: 1_700_000_000_000 + 30 * 86_400_000,
  fallback: 'deny-and-continue',
};

/** A live permission prompt, exactly as run-manager.ts:404-405 writes it. */
const permissionApproval = {
  id: 'ap_perm',
  run_id: 'run_live',
  kind: 'permission',
  payload_json: JSON.stringify({ tool: 'Bash(rm -rf /tmp/scratch)', reqId: 'req_9' }),
  requested_at: 1_700_000_000_000,
  timeout_at: 1_700_000_000_000 + 120_000,
  fallback: 'deny-and-continue',
};

const PROPOSAL_BODY = {
  id: 'rem_1',
  taskId: 'task_1',
  runId: 'run_diagnostic',
  approvalId: 'ap_rem',
  target: 'prompt',
  currentValue: CURRENT_PROMPT,
  proposedValue: PROPOSED_PROMPT,
  rationale: 'three runs in a row edited the wrong repository',
  status: 'proposed',
  createdAt: 1_700_000_000_000,
  decidedAt: null,
};

/**
 * Routes the two calls this card can make. Anything else is a hard failure —
 * a silently-swallowed request would let a blank card pass as a green test.
 */
function stubApprovalFetch(opts: { proposal?: () => Response } = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (/^\/workforce\/remediations\/[^/?]+$/.test(u)) {
      if (!opts.proposal) throw new Error(`unexpected proposal fetch: ${u}`);
      return opts.proposal();
    }
    if (/^\/approvals\/[^/?]+\/respond$/.test(u)) {
      return new Response(JSON.stringify({ resolved: true, forwarded: false }), { status: 200 });
    }
    throw new Error(`unexpected request: ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** The claim that is true ONLY of a live permission prompt. */
function expectNoAutoDenyClaim(container: HTMLDivElement): void {
  const text = container.textContent ?? '';
  expect(text, 'a row nothing sweeps must not claim a decision window').not.toContain('decision window');
  expect(text, 'a row that waits for a human indefinitely must not claim auto-denial').not.toContain('auto-denied');
  expect(text, 'this row is not a permission prompt').not.toContain('Permission request');
}

describe('ApprovalCard renders what the human is actually deciding (§2.4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the three kinds apart from the row the daemon actually writes', async () => {
    const { approvalKindOf } = await import('../src/components/ApprovalCard');
    expect(approvalKindOf(planApproval)).toBe('plan');
    expect(approvalKindOf(remediationApproval)).toBe('remediation');
    expect(approvalKindOf(permissionApproval)).toBe('permission');
    // An unrecognised 'question' row must NOT fall through to the permission
    // card, whose copy would then promise an auto-deny that never comes.
    expect(approvalKindOf({ id: 'x', kind: 'question', payload_json: '{}' })).toBe('unknown');
  });

  it('a plan approval shows the plan and says approving books the execute run (F1)', async () => {
    stubApprovalFetch();
    const { ApprovalCard } = await import('../src/components/ApprovalCard');
    const container = await render(<ApprovalCard approval={planApproval} onChanged={() => {}} />);
    const text = container.textContent ?? '';
    expect(text, 'the plan the human is approving must be on screen').toContain('rename the --force flag');
    expect(text).toContain('update the README');
    expect(text.toLowerCase(), 'Approve books a real agent run; say so').toContain('execute run');
    expectNoAutoDenyClaim(container);
  });

  it('a remediation proposal shows target, current value and proposed value (F8)', async () => {
    stubApprovalFetch({ proposal: () => new Response(JSON.stringify(PROPOSAL_BODY), { status: 200 }) });
    const { ApprovalCard } = await import('../src/components/ApprovalCard');
    const container = await render(<ApprovalCard approval={remediationApproval} onChanged={() => {}} />);
    const text = container.textContent ?? '';
    expect(text, 'which field of the task would be rewritten').toContain('prompt');
    expect(text, 'what the task says today').toContain(CURRENT_PROMPT);
    expect(text, 'what the agent wants it to say').toContain(PROPOSED_PROMPT);
    expect(text, 'why the agent proposed it').toContain('three runs in a row edited the wrong repository');
    expectNoAutoDenyClaim(container);
  });

  it('a remediation whose proposal will not load still shows what would be applied', async () => {
    // The current value comes from GET /workforce/remediations/:id; the
    // proposed value is in the approval payload. Losing the first must never
    // blank the second — a blank card is the defect being fixed.
    stubApprovalFetch({ proposal: () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }) });
    const { ApprovalCard } = await import('../src/components/ApprovalCard');
    const container = await render(<ApprovalCard approval={remediationApproval} onChanged={() => {}} />);
    const text = container.textContent ?? '';
    expect(text).toContain(PROPOSED_PROMPT);
    expect(text).toContain('prompt');
    expect(text, 'the gap must be visible, not silent').toContain('Current value unavailable');
    const approve = container.querySelector('[data-testid="approval-approve"]') as HTMLButtonElement;
    expect(approve.disabled, 'a failed lookup must not block the human either way').toBe(false);
    expectNoAutoDenyClaim(container);
  });

  it('a live permission prompt keeps its tool line and its decision window (unchanged)', async () => {
    stubApprovalFetch();
    const { ApprovalCard } = await import('../src/components/ApprovalCard');
    const container = await render(<ApprovalCard approval={permissionApproval} onChanged={() => {}} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Permission request');
    expect(text, 'the tool the live run is asking to use').toContain('Bash(rm -rf /tmp/scratch)');
    expect(text, 'true for this kind and only this kind').toContain('decision window');
    expect(text).toContain('auto-denied');
  });

  it('an unrecognised row is shown honestly rather than dressed as a permission prompt', async () => {
    stubApprovalFetch();
    const { ApprovalCard } = await import('../src/components/ApprovalCard');
    const container = await render(
      <ApprovalCard
        approval={{ id: 'ap_x', run_id: 'run_x', kind: 'question', payload_json: '{}' }}
        onChanged={() => {}}
      />,
    );
    expectNoAutoDenyClaim(container);
    expect(container.querySelector('[data-testid="approval-approve"]'), 'the decision is still the human\'s').not.toBeNull();
  });

  it('Approve on a plan card posts the human decision for that approval row', async () => {
    const fetchMock = stubApprovalFetch();
    const { ApprovalCard } = await import('../src/components/ApprovalCard');
    let changed = 0;
    const container = await render(<ApprovalCard approval={planApproval} onChanged={() => { changed += 1; }} />);
    const approve = container.querySelector('[data-testid="approval-approve"]') as HTMLButtonElement | null;
    expect(approve).not.toBeNull();
    approve!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/approvals/'));
    expect(call, 'Approve must reach POST /approvals/:id/respond').toBeDefined();
    expect(String(call![0])).toBe('/approvals/ap_plan/respond');
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ decision: 'approved' });
    expect(changed, 'the list must refresh once the row is resolved').toBe(1);
  });
});
