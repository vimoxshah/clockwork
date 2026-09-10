/**
 * The report is worth opening (T4-6): the next action and the verdict are
 * both in it, and re-deciding changes the verdict instead of adding one.
 *
 * The north-star metric is accepted outcomes per user per week — a run whose
 * output the user acted on — so the two things this file proves are the two
 * things that metric depends on: that acting is one click from the report, and
 * that the F6 verdict is recordable there without hunting.
 *
 * "Re-deciding updates rather than stacks" has two halves and they are tested
 * in two places. The row-level half is SQL and lives in
 * `packages/daemon/test/report-verdict-update.test.ts`. The half here is that
 * the report has exactly ONE verdict path: the second decision goes to the
 * same endpoint as the first, through the same control, and the panel shows
 * the new verdict rather than listing both.
 *
 * The run driven below is `r-005` from the seeded corpus — a completed repo
 * run that really committed — so the branch commands are exercised against a
 * row the daemon wrote rather than one invented for the test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent, waitForElement, waitForText } from './helpers/dom';
import { NOW, WEEK_OF_RUNS } from './helpers/overnight-corpus';

const UNREAD_KEY = 'clockwork.inbox.lastRead';

/** A completed repo run that committed: the case with a branch to act on. */
const COMMITTED_RUN = WEEK_OF_RUNS.find((r) => r.id === 'r-005')!;
const REPORT = JSON.parse(COMMITTED_RUN.report_json!) as Record<string, unknown>;

interface Call {
  url: string;
  method: string;
  body: string | null;
}

/**
 * Every request the report makes, recorded. An unrouted call throws rather
 * than resolving empty — a swallowed fetch would let a blank report pass.
 */
function stubReportFetch(
  overrides: Array<[RegExp, (call: Call) => Response]> = [],
): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      };
      calls.push(call);
      for (const [pattern, handler] of overrides) {
        if (pattern.test(call.url)) return handler(call);
      }
      const u = call.url;
      if (u.startsWith('/runs?')) return json([COMMITTED_RUN]);
      if (u === '/approvals') return json([]);
      if (u === `/runs/${COMMITTED_RUN.id}/report`) return json({ run: COMMITTED_RUN, report: REPORT });
      if (u === `/runs/${COMMITTED_RUN.id}/transcript`) return json({ available: false, lines: [] });
      if (u.startsWith('/workforce/handoff/')) return json({ memories: [] });
      if (u.endsWith('/outcome') && call.method === 'GET') return json(null);
      if (u.endsWith('/outcome') && call.method === 'POST') {
        const sent = JSON.parse(call.body ?? '{}') as { decision: string; note?: string };
        return json({
          runId: COMMITTED_RUN.id,
          taskId: COMMITTED_RUN.task_id,
          decision: sent.decision,
          note: sent.note ?? null,
        });
      }
      throw new Error(`unexpected request in report test: ${call.method} ${u}`);
    }),
  );
  return { calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function click(el: Element | null): void {
  expect(el, 'control missing from the DOM').not.toBeNull();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Renders the Inbox and opens the committed run's report. */
async function openReport(
  overrides?: Array<[RegExp, (call: Call) => Response]>,
): Promise<{ container: HTMLDivElement; calls: Call[] }> {
  localStorage.setItem(UNREAD_KEY, String(NOW)); // nothing unread: no digest in the way
  const { calls } = stubReportFetch(overrides);
  const { default: InboxView } = await import('../src/components/InboxView');
  const container = await renderComponent(<InboxView version={0} />);
  await waitForText(container, 'Nightly deps sweep');
  click(container.querySelector('.inbox-row'));
  await waitForElement(container, '[data-testid="report-actions"]');
  return { container, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('the report says what to do next', () => {
  it('offers the branch commands for a run that committed, spelled out in full', async () => {
    const { container } = await openReport();
    const actions = container.querySelector('[data-testid="report-actions"]')!;
    const text = actions.textContent ?? '';
    expect(text).toContain(`git -C /Users/dev/demo-app checkout ${COMMITTED_RUN.branch}`);
    expect(text).toContain(`git -C /Users/dev/demo-app diff main...${COMMITTED_RUN.branch}`);
    expect(text).toContain('gh pr create --base main');
    expect(text, 'the PR command makes an assumption and must say so').toContain('origin');
  });

  it('copies a command to the clipboard, and says it did', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const { container } = await openReport();
      click(container.querySelector('[data-testid="report-action-copy-checkout"]'));
      await waitForText(container, 'Copied');
      expect(writeText).toHaveBeenCalledWith(`git -C /Users/dev/demo-app checkout ${COMMITTED_RUN.branch}`);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('books another run of the same task in one click', async () => {
    const { container, calls } = await openReport([
      [/\/run-now$/, () => json({ runId: 'r-020' })],
    ]);
    click(container.querySelector('[data-testid="report-action-rerun"]'));
    await waitForText(container, 'Booked.');
    const booked = calls.filter((c) => c.url.endsWith('/run-now'));
    expect(booked).toHaveLength(1);
    expect(booked[0]!.url).toBe(`/tasks/${COMMITTED_RUN.task_id}/run-now`);
    expect(booked[0]!.method).toBe('POST');
  });

  it('shows a refusal instead of swallowing it', async () => {
    // The plan-then-execute gate answers 409 for an execute half whose pair is
    // unapproved. A button that quietly did nothing would be worse than none.
    const { container } = await openReport([
      [/\/run-now$/, () => json({ error: 'execute half is not approved' }, 409)],
    ]);
    click(container.querySelector('[data-testid="report-action-rerun"]'));
    await waitForElement(container, '[data-testid="report-action-rerun-error"]');
    expect(container.querySelector('[data-testid="report-action-rerun-error"]')!.textContent).toContain(
      'execute half is not approved',
    );
  });
});

describe('the verdict is recordable from the report', () => {
  it('records an accept without leaving the report', async () => {
    const { container, calls } = await openReport();
    expect(container.querySelector('[data-testid="outcome-accept"]'), 'no verdict control in the report').not.toBeNull();

    click(container.querySelector('[data-testid="outcome-accept"]'));
    await waitForText(container, 'Decision: accepted');

    const posted = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/outcome'));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(`/workforce/runs/${COMMITTED_RUN.id}/outcome`);
    expect(JSON.parse(posted[0]!.body!)).toEqual({ decision: 'accepted' });
  });

  it('sits above the diffstat and the transcript, not below them', async () => {
    // The F6 verdict is what F7, F10 and F11 read. A verdict you have to
    // scroll past a diffstat to reach is a verdict nobody records.
    const { container } = await openReport();
    const order = Array.from(
      container.querySelectorAll('.diffstat-table, .outcome-controls, .transcript, .proof-of-work'),
    ).map((el) => el.className.split(' ')[0]);
    expect(order[0]).toBe('outcome-controls');
  });

  it('re-deciding updates the verdict on screen instead of stacking a second one', async () => {
    const { container, calls } = await openReport();
    click(container.querySelector('[data-testid="outcome-accept"]'));
    await waitForText(container, 'Decision: accepted');
    click(container.querySelector('[data-testid="outcome-reject"]'));
    await waitForText(container, 'Decision: rejected');

    expect(container.querySelectorAll('[data-testid="outcome-current"]'), 'two verdicts on screen').toHaveLength(1);
    expect(container.textContent, 'the replaced verdict must not linger').not.toContain('Decision: accepted');

    const posted = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/outcome'));
    expect(posted).toHaveLength(2);
    expect(
      new Set(posted.map((c) => c.url)).size,
      'a second verdict path would post somewhere else',
    ).toBe(1);
    expect(JSON.parse(posted[1]!.body!)).toEqual({ decision: 'rejected' });
  });

  it('records an accept-with-note through the same control and the same endpoint', async () => {
    const { container, calls } = await openReport();
    click(container.querySelector('[data-testid="outcome-note-toggle"]'));
    const input = (await waitForElement(container, '[data-testid="outcome-note-input"]')) as HTMLTextAreaElement;
    // React tracks the value setter, so assigning `.value` directly leaves its
    // state behind — the prototype setter is what the rest of this suite uses
    // (handoff-memory.test.tsx:127).
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setValue.call(input, 'Pin the version next time.');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    click(container.querySelector('[data-testid="outcome-note-submit"]'));
    await waitForText(container, 'Decision: accepted with note');

    const posted = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/outcome'));
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!.body!)).toEqual({
      decision: 'accepted_with_note',
      note: 'Pin the version next time.',
    });
  });
});
