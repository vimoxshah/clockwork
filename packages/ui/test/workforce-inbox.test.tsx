/**
 * The two workforce UI components are only worth anything if the Inbox
 * actually mounts them. Both shipped as standalone files during the feature
 * wave — reachable by nobody — and the integration pass is what wired them in.
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
