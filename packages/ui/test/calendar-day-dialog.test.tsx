/**
 * A busy day has to be readable.
 *
 * The bug, from a real screenshot: a month cell draws at most `MAX_PER_CELL`
 * names and then a "+N more" button — but that button called the same handler
 * as a plain cell click, so it selected the day and revealed nothing. The day
 * it selected was listed in the narrow side panel, which shows no time at all
 * and clips a name to its column: "ASAP verify (temp)" rendered as
 * "ASAP verify (te…". So on a day with several agents booked there was no way
 * to read what was scheduled, or in what order.
 *
 * `DayDialog` is the full view. What is pinned here:
 *   - "+N more" opens it, and it lists EVERY item on the day, not just the
 *     `MAX_PER_CELL` the cell had room for.
 *   - the full name survives — the clipping is a CSS column, so the assertion
 *     is on the text the dialog actually contains.
 *   - each row carries a time, which the side panel never showed.
 *   - rows still open the per-event dialog, so the fix adds a view rather than
 *     replacing the one that worked.
 *
 * Same `stubFetch` discipline as calendar-year-aggregate.test.tsx: an unrouted
 * request throws, so a blank screen cannot pass as green.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent, waitFor, waitForText } from './helpers/dom';

interface Call {
  url: string;
  method: string;
}

function stubFetch(routes: Array<[RegExp, (call: Call) => Response]>): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const call: Call = { url: String(url), method: init?.method ?? 'GET' };
      calls.push(call);
      for (const [pattern, handler] of routes) {
        if (pattern.test(call.url)) return handler(call);
      }
      throw new Error(`unexpected request: ${call.method} ${call.url}`);
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

const byText = (root: ParentNode, sel: string, text: string): Element | null =>
  [...root.querySelectorAll(sel)].find((e) => (e.textContent ?? '').trim().includes(text)) ?? null;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  document.body.innerHTML = '';
});

// Midday so the local day never straddles a boundary in any zone.
const TODAY = new Date(2026, 8, 7, 12, 0);
const NOON = new Date(2026, 8, 7).getTime();
const H = 3_600_000;

/** The long name that the side panel's column was clipping. */
const LONG_NAME = 'ASAP verify (temp) — dependency sweep';

/** Six runs on 7 Sep: two more than a cell can draw, so "+2 more" appears. */
const RUNS = [
  { name: 'Nightly dependency sweep', at: NOON + 9 * H, state: 'completed', cost: 0.9 },
  { name: LONG_NAME, at: NOON + 10 * H, state: 'cancelled', cost: 0 },
  { name: 'Flaky test doctor', at: NOON + 11 * H, state: 'failed', cost: 0.4 },
  { name: 'Security auditor', at: NOON + 13 * H, state: 'running', cost: 0.2 },
  { name: 'Docs drift check', at: NOON + 15 * H, state: 'completed', cost: 0.1 },
  { name: 'Release notes writer', at: NOON + 17 * H, state: 'completed', cost: 0.3 },
].map((r, i) => ({
  id: `run_${i}`,
  task_id: `t${i}`,
  task_name: r.name,
  scheduled_for: r.at,
  state: r.state,
  cost_usd: r.cost,
  outcome_reason: null,
  started_at: null,
  ended_at: null,
  turns: 1,
}));

const routes = (): Array<[RegExp, (call: Call) => Response]> => [
  [
    /\/calendar\?from=/,
    () => json({ from: 0, to: 0, runs: RUNS, bookings: [], humans: [], limits: null }),
  ],
  [/\/report\//, () => json({ available: false })],
  [/\/transcript\//, () => json({ available: false, lines: [] })],
];

async function mountMonth(): Promise<HTMLDivElement> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
  localStorage.setItem('clockwork.calview', 'month');
  stubFetch(routes());
  const { default: CalendarView } = await import('../src/components/CalendarView');
  const container = await renderComponent(
    <CalendarView version={1} onBookOnDate={() => {}} onOpenTask={() => {}} />,
  );
  await waitFor(
    () => byText(container, '.cal-more', 'more'),
    'the "+N more" overflow button on the busy day',
    { describe: () => `html = ${container.innerHTML.slice(0, 600)}` },
  );
  return container;
}

describe('a day with more agents than the cell can draw', () => {
  it('"+N more" opens a dialog listing every item, not just the four that fit', async () => {
    const container = await mountMonth();

    // The cell itself draws only MAX_PER_CELL of the six.
    const cellNames = [...container.querySelectorAll('.cal-cell.today .cal-event')].map((e) =>
      (e.textContent ?? '').trim(),
    );
    expect(cellNames).toHaveLength(4);
    expect(byText(container, '.cal-more', '+2 more'), 'overflow button should say +2 more').not.toBeNull();
    expect(container.querySelector('[data-testid="day-dialog"]'), 'dialog is closed until asked for').toBeNull();

    click(byText(container, '.cal-more', 'more'));

    const dialog = await waitFor(
      () => document.querySelector('[data-testid="day-dialog"]'),
      'the day dialog',
      { describe: () => `html = ${document.body.innerHTML.slice(0, 600)}` },
    );

    // All six, including the two the cell had no room for.
    const rows = dialog.querySelectorAll('.day-list-row');
    expect(rows).toHaveLength(6);
    expect(dialog.textContent).toContain('6 items');
    for (const r of RUNS) {
      expect(dialog.textContent, `"${r.task_name}" missing from the day list`).toContain(r.task_name);
    }
  });

  it('shows the full name the side panel was clipping, and a time per row', async () => {
    const container = await mountMonth();
    click(byText(container, '.cal-more', 'more'));
    const dialog = await waitFor(
      () => document.querySelector('[data-testid="day-dialog"]'),
      'the day dialog',
    );

    // The panel rendered this as "ASAP verify (te…" — the dialog must carry it whole.
    expect(dialog.textContent).toContain(LONG_NAME);

    // Every row states when it runs. The side panel showed state only.
    const times = [...dialog.querySelectorAll('.day-list-time')].map((e) => (e.textContent ?? '').trim());
    expect(times).toHaveLength(6);
    expect(times.every((t) => t.length > 0), `blank time cell in ${JSON.stringify(times)}`).toBe(true);
  });

  it('still opens the per-event dialog from a row', async () => {
    const container = await mountMonth();
    click(byText(container, '.cal-more', 'more'));
    const dialog = await waitFor(
      () => document.querySelector('[data-testid="day-dialog"]'),
      'the day dialog',
    );

    click(byText(dialog, '.day-list-row', 'Flaky test doctor'));
    await waitForText(document.body as unknown as HTMLElement, 'Flaky test doctor');
    const dialogs = document.querySelectorAll('[role="dialog"]');
    expect(dialogs.length, 'event dialog should open on top of the day list').toBeGreaterThan(1);
  });

  it('is reachable from the day panel too, for a day that never overflowed', async () => {
    const container = await mountMonth();
    const viewAll = container.querySelector('[data-testid="view-all-day"]');
    expect(viewAll, '"View all" button missing from the day panel').not.toBeNull();
    expect((viewAll!.textContent ?? '').trim()).toContain('6 items');

    click(viewAll);
    const dialog = await waitFor(
      () => document.querySelector('[data-testid="day-dialog"]'),
      'the day dialog opened from the panel',
    );
    expect(dialog.querySelectorAll('.day-list-row')).toHaveLength(6);
  });
});
