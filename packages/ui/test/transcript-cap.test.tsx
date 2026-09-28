/**
 * The transcript route sends only the tail of a long transcript
 * (`/runs/:id/transcript` returns `lines` plus `totalLines`). A report that
 * shows 400 rows under a "1,200 lines" button, with no word about the rest,
 * reads as the whole run. When `totalLines` exceeds what arrived, the view
 * says how much it shows; when nothing was cut, it says nothing.
 *
 * Harness follows report-verdict.test.tsx: the seeded committed run `r-005`,
 * every request routed, an unrouted one throws.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent, waitForElement, waitForText } from './helpers/dom';
import { NOW, WEEK_OF_RUNS } from './helpers/overnight-corpus';

const UNREAD_KEY = 'clockwork.inbox.lastRead';
const RUN = WEEK_OF_RUNS.find((r) => r.id === 'r-005')!;
const REPORT = JSON.parse(RUN.report_json!) as Record<string, unknown>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(transcript: { available: boolean; totalLines?: number; lines: string[] }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.startsWith('/runs?')) return json([RUN]);
      if (u === '/approvals') return json([]);
      if (u === `/runs/${RUN.id}/report`) return json({ run: RUN, report: REPORT });
      if (u === `/runs/${RUN.id}/transcript`) return json(transcript);
      if (u.startsWith('/workforce/handoff/')) return json({ memories: [] });
      if (u.endsWith('/outcome') && method === 'GET') return json(null);
      throw new Error(`unexpected request in transcript test: ${method} ${u}`);
    }),
  );
}

async function openTranscript(transcript: { available: boolean; totalLines?: number; lines: string[] }): Promise<HTMLDivElement> {
  localStorage.setItem(UNREAD_KEY, String(NOW));
  stubFetch(transcript);
  const { default: InboxView } = await import('../src/components/InboxView');
  const container = await renderComponent(<InboxView version={0} />);
  await waitForText(container, 'Nightly deps sweep');
  container.querySelector('.inbox-row')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const toggle = await waitForElement(container, '[data-testid="transcript-toggle"]');
  toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await waitForElement(container, '[data-testid="unified-diff"]');
  return container;
}

const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i}`);

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('transcript cap', () => {
  it('says it shows only the last lines when the route cut the transcript', async () => {
    const container = await openTranscript({ available: true, totalLines: 1200, lines: lines(400) });
    const note = container.querySelector('[data-testid="transcript-truncated"]');
    expect(note?.textContent).toMatch(/Showing the last 400 of 1,200 lines/);
  });

  it('says nothing when the whole transcript arrived', async () => {
    const container = await openTranscript({ available: true, totalLines: 30, lines: lines(30) });
    expect(container.querySelector('[data-testid="transcript-truncated"]')).toBeNull();
  });
});
