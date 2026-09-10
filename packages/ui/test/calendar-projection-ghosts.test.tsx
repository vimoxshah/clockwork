/**
 * T4-4 — a projected occurrence is drawn as a ghost, and a ghost is not a booking.
 *
 * The daemon now projects every enabled recurring task across the visible range
 * and marks each occurrence `projected`. Three marks have to stay three marks
 * in the grid, or the extra information is thrown away at the last step:
 *
 *   RUN       a filled chip in the run-state colour. It happened.
 *   BOOKED    `projected: false` — the one occurrence `next_fire` has
 *             materialized. Drawn with a SOLID outline.
 *   PROJECTED `projected: true` — the rule's arithmetic. Drawn with the
 *             stylesheet's DASHED outline, dimmed.
 *
 * WHAT THIS FILE PINS
 *   1. A weekly job shows up on every remaining week of the month grid, and
 *      exactly one of those marks is the booked one.
 *   2. The three marks are distinguishable in the DOM and in the accessible
 *      name — the dash alone would say nothing to a screen reader.
 *   3. The truncation notice does NOT print "1008 of 1008". When the daemon
 *      stops the expansion early it does not know the true total, so the notice
 *      has to say "at least", or the bound becomes a silent lie one word later.
 *   4. A schedule the daemon refused to expand is reported, not swallowed.
 *
 * Same `stubFetch` discipline as calendar-day-dialog.test.tsx: an unrouted
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  document.body.innerHTML = '';
});

// Monday 7 September 2026, midday. The month grid for September 2026 starts on
// Monday 31 August (the Monday on or before the 1st) and runs six rows to
// Sunday 11 October — the same window `CalendarView`'s `range` memo asks for.
const TODAY = new Date(2026, 8, 7, 12, 0);
const H = 3_600_000;
const at9 = (m: number, d: number): number => new Date(2026, m, d).getTime() + 9 * H;

/** Every Wednesday of the grid that is still ahead of TODAY. */
const WEDNESDAYS = [at9(8, 9), at9(8, 16), at9(8, 23), at9(8, 30), at9(9, 7)];

/** The first one is what `next_fire` holds; everything after it is arithmetic. */
const BOOKINGS = WEDNESDAYS.map((at, i) => ({
  taskId: 'task-weekly',
  name: 'Weekly dep triage',
  at,
  kind: 'booking' as const,
  projected: i > 0,
}));

/** One run that already happened, so the third kind of mark is on screen too. */
const RUNS = [
  {
    id: 'run-past',
    task_id: 'task-weekly',
    task_name: 'Weekly dep triage',
    scheduled_for: at9(8, 2),
    state: 'completed',
    cost_usd: 0.42,
    outcome_reason: null,
    started_at: null,
    ended_at: null,
    turns: 2,
  },
];

const CLEAN_LIMITS = {
  rowLimit: 5000,
  truncated: false,
  projection: { perSchedule: 1008, truncated: false, refused: 0 },
  runs: { returned: 1, total: 1, truncated: false },
  bookings: { returned: BOOKINGS.length, total: BOOKINGS.length, truncated: false },
  humans: { returned: 0, total: 0, truncated: false },
};

function routes(body: Record<string, unknown>): Array<[RegExp, (call: Call) => Response]> {
  return [
    [/\/calendar\?from=/, () => json(body)],
    [/\/report\//, () => json({ available: false })],
    [/\/transcript\//, () => json({ available: false, lines: [] })],
  ];
}

async function mountMonth(body: Record<string, unknown>): Promise<HTMLDivElement> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
  localStorage.setItem('clockwork.calview', 'month');
  stubFetch(routes(body));
  const { default: CalendarView } = await import('../src/components/CalendarView');
  const container = await renderComponent(
    <CalendarView version={1} onBookOnDate={() => {}} onOpenTask={() => {}} />,
  );
  await waitFor(
    () => container.querySelector('.cal-grid .cal-cell'),
    'the month grid',
    { describe: () => `html = ${container.innerHTML.slice(0, 600)}` },
  );
  return container;
}

const FULL_MONTH = {
  from: 0,
  to: 0,
  runs: RUNS,
  bookings: BOOKINGS,
  humans: [],
  limits: CLEAN_LIMITS,
};

/** The cell for a local calendar day, found the way the grid labels it. */
function cell(container: ParentNode, month: number, day: number): Element | null {
  return container.querySelector(`.cal-cell[aria-label^="2026-${month}-${day}, "]`);
}

describe('a weekly job shows a rhythm, not a next fire', () => {
  it('draws a mark on every remaining week of the month grid', async () => {
    const container = await mountMonth(FULL_MONTH);
    // 9, 16, 23 and 30 September, then 7 October — the grid's last four
    // Wednesdays and the one in the overflow row.
    for (const [m, d] of [[9, 9], [9, 16], [9, 23], [9, 30], [10, 7]] as const) {
      const c = cell(container, m, d);
      expect(c, `no grid cell for 2026-${m}-${d}`).not.toBeNull();
      expect(
        c!.querySelector('.cal-event.booking'),
        `no upcoming occurrence drawn on 2026-${m}-${d}`,
      ).not.toBeNull();
    }
  });

  it('marks exactly one of them booked and the rest projected', async () => {
    const container = await mountMonth(FULL_MONTH);
    const marks = [...container.querySelectorAll('.cal-grid [data-projected]')];
    expect(marks).toHaveLength(5);
    expect(marks.filter((m) => m.getAttribute('data-projected') === 'false')).toHaveLength(1);
    expect(marks.filter((m) => m.getAttribute('data-projected') === 'true')).toHaveLength(4);
    // The booked one is the earliest: a projection can only be after it.
    expect(
      cell(container, 9, 9)!.querySelector('[data-projected="false"]'),
      'the materialized next fire is the 9th',
    ).not.toBeNull();
  });

  it('gives the ghost a different outline and a different accessible name', async () => {
    const container = await mountMonth(FULL_MONTH);
    const booked = cell(container, 9, 9)!.querySelector<HTMLElement>('[data-projected="false"]')!;
    const ghost = cell(container, 9, 16)!.querySelector<HTMLElement>('[data-projected="true"]')!;

    // The stylesheet draws `.cal-event.booking` dashed; a booking the scheduler
    // has actually materialized overrides that to solid, and the ghost keeps
    // the dash and is dimmed.
    expect(booked.style.borderStyle).toBe('solid');
    expect(ghost.style.borderStyle).toBe('');
    expect(Number(ghost.style.opacity)).toBeLessThan(1);
    expect(booked.style.opacity).toBe('');

    // A reader who cannot see either is told which is which.
    expect(booked.getAttribute('aria-label')).toContain('Booked');
    expect(ghost.getAttribute('aria-label')).toContain('Projected');
  });

  it('leaves a run that already happened as a run — no ghost marking at all', async () => {
    const container = await mountMonth(FULL_MONTH);
    const runChip = cell(container, 9, 2)!.querySelector('.cal-event')!;
    expect(runChip.className).toContain('st-completed');
    expect(runChip.hasAttribute('data-projected'), 'a run is not a booking').toBe(false);
    expect(runChip.className).not.toContain('booking');
  });

  it('says which kind it is in the event dialog, not just in the border', async () => {
    const container = await mountMonth(FULL_MONTH);

    click(cell(container, 9, 16)!.querySelector('[data-projected="true"]'));
    await waitForText(document.body as unknown as HTMLElement, 'Projected — not booked yet');
    expect(document.body.textContent).toContain('recurrence rule lands');
    click(document.querySelector('.dialog .actions .btn.primary'));

    click(cell(container, 9, 9)!.querySelector('[data-projected="false"]'));
    await waitForText(document.body as unknown as HTMLElement, 'Booked — future occurrence');
    expect(document.body.textContent).toContain('the scheduler has materialized');
  });
});

describe('the bound the daemon applied is reported without inventing a total', () => {
  it('says "at least N", never "N of N", when the projection stopped early', async () => {
    const container = await mountMonth({
      ...FULL_MONTH,
      limits: {
        ...CLEAN_LIMITS,
        truncated: true,
        projection: { perSchedule: 1008, truncated: true, refused: 0 },
        // What the daemon counted IS what it shipped, because it stopped
        // expanding rather than expanding and trimming. The old "X of Y"
        // wording would render this as "1008 of 1008" and read as complete.
        bookings: { returned: 1008, total: 1008, truncated: true },
      },
    });
    const notice = await waitFor(
      () => container.querySelector('[data-testid="calendar-truncated"]'),
      'the truncation notice',
      { describe: () => `html = ${container.innerHTML.slice(0, 600)}` },
    );
    const text = notice.textContent ?? '';
    expect(text).toContain('at least 1008 upcoming occurrences');
    expect(text, 'a capped count must not be printed as its own total').not.toContain('1008 of 1008');
    expect(text, 'the per-job bound is part of the answer').toContain('1008 upcoming occurrences');
  });

  it('keeps the plain "X of Y" wording when it is the ROW cap that bit', async () => {
    const container = await mountMonth({
      ...FULL_MONTH,
      limits: {
        ...CLEAN_LIMITS,
        truncated: true,
        projection: { perSchedule: 1008, truncated: false, refused: 0 },
        runs: { returned: 5000, total: 9001, truncated: true },
      },
    });
    const notice = await waitFor(
      () => container.querySelector('[data-testid="calendar-truncated"]'),
      'the truncation notice',
    );
    expect(notice.textContent).toContain('5000 of 9001 runs');
    expect(notice.textContent).not.toContain('at least');
  });

  it('reports a schedule that could not be projected at all', async () => {
    const container = await mountMonth({
      ...FULL_MONTH,
      limits: { ...CLEAN_LIMITS, projection: { perSchedule: 1008, truncated: false, refused: 2 } },
    });
    const notice = await waitFor(
      () => container.querySelector('[data-testid="calendar-refused"]'),
      'the refusal notice',
      { describe: () => `html = ${container.innerHTML.slice(0, 600)}` },
    );
    expect(notice.textContent).toContain('2 schedules could not be projected');
    expect(
      container.querySelector('[data-testid="calendar-truncated"]'),
      'a refusal is not a truncation, and must not claim to be one',
    ).toBeNull();
  });

  it('says nothing at all when nothing was cut and nothing was refused', async () => {
    const container = await mountMonth(FULL_MONTH);
    expect(container.querySelector('[data-testid="calendar-truncated"]')).toBeNull();
    expect(container.querySelector('[data-testid="calendar-refused"]')).toBeNull();
  });
});

describe('the day list separates the two kinds of upcoming mark', () => {
  it('counts booked and projected apart in the day dialog', async () => {
    const container = await mountMonth(FULL_MONTH);
    // Select 16 September (a ghost) and open its full list. The wait is for the
    // panel to follow the selection — a cell click re-derives `selectedEvents`
    // through a memo, and reading the button before that lands finds nothing.
    click(cell(container, 9, 16));
    const panel = await waitFor(
      () => {
        const p = container.querySelector('.day-panel');
        return (p?.textContent ?? '').includes('September 16') ? p : null;
      },
      'the day panel to follow the selection',
      { describe: () => `panel = ${container.querySelector('.day-panel')?.outerHTML.slice(0, 400)}` },
    );
    // The panel names the kind too, in the column that used to read "Booked"
    // for everything that was not a run.
    expect(panel.querySelector('.ev-row .mono')?.textContent?.trim()).toBe('Projected');
    click(panel.querySelector('[data-testid="view-all-day"]'));
    const dialog = await waitFor(
      () => document.querySelector('[data-testid="day-dialog"]'),
      'the day dialog',
      { describe: () => `html = ${document.body.innerHTML.slice(0, 600)}` },
    );
    expect(dialog.textContent).toContain('1 projected');
    expect(dialog.textContent).not.toContain('1 booked');
    expect(dialog.querySelector('.chip[data-projected="true"]')?.textContent?.trim()).toBe('Projected');
  });
});
