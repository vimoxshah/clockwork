/**
 * S-64 on screen — Calendar ▸ Year, fed by the per-day aggregate.
 *
 * WHY THIS FILE EXISTS. `GET /calendar?group=day` is only worth having if a
 * screen reaches it. S-64 names the year view specifically ("user on 5,000-run
 * history opens calendar year view"), and before this change the calendar had
 * no year mode at all — the only thing that ever asked for a year-wide window
 * was the benchmark. So these tests pin the wiring, not just the rendering:
 *
 *   - Year mode asks for COUNTS (`group=day`); month and week still ask for
 *     events, because their cells draw named chips.
 *   - Clicking a day in year mode asks for THAT DAY'S events, one local day
 *     wide, and the panel lists the runs that came back. The detail view is
 *     what the aggregate has to keep working, not replace.
 *   - A capped answer is visible on screen. `limits.truncated` is the server
 *     saying "this is partial"; a UI that ignored it would turn a bound into a
 *     silent lie.
 *   - A response with NO `limits` still renders. Every mock written before
 *     this change omits the field, and so does any older daemon.
 *
 * jsdom + createRoot, and the `stubFetch` harness the rest of this suite uses:
 * an unrouted request throws rather than resolving empty, so a blank screen
 * cannot pass as green.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent, waitFor, waitForText } from './helpers/dom';

const render = renderComponent;

interface Call {
  url: string;
  method: string;
}

function stubFetch(routes: Array<[RegExp, (call: Call) => Response]>): { calls: Call[] } {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? 'GET' };
    calls.push(call);
    for (const [pattern, handler] of routes) {
      if (pattern.test(call.url)) return handler(call);
    }
    throw new Error(`unexpected request: ${call.method} ${call.url}`);
  });
  vi.stubGlobal('fetch', fn);
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

// 15 March 2026, so "this year" is 2026 in every zone.
const TODAY = new Date(2026, 2, 15, 12, 0);
const localMidnight = (y: number, m: number, d: number): number => new Date(y, m, d).getTime();

/** Two busy days in 2026 and nothing else — sparse, exactly as the route answers. */
const DAYS = [
  {
    day: '2026-03-04',
    runs: 3,
    bookings: 1,
    humans: 0,
    costUsd: 1.5,
    outcomes: { completed: 2, failed: 1, cancelled: 0, running: 0, needsYou: 0, other: 0 },
  },
  {
    day: '2026-07-21',
    runs: 1,
    bookings: 0,
    humans: 0,
    costUsd: 0.2,
    outcomes: { completed: 0, failed: 0, cancelled: 0, running: 0, needsYou: 1, other: 0 },
  },
];

const fullLimits = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  rowLimit: 5_000,
  truncated: false,
  days: { returned: 2, total: 2, truncated: false },
  runs: { returned: 4, total: 4, truncated: false },
  bookings: { returned: 1, total: 1, truncated: false },
  humans: { returned: 0, total: 0, truncated: false },
  ...over,
});

const MARCH_4_RUNS = [
  {
    id: 'run_a',
    task_id: 't1',
    task_name: 'Nightly dependency sweep',
    scheduled_for: localMidnight(2026, 2, 4) + 9 * 3_600_000,
    state: 'completed',
    cost_usd: 0.9,
    outcome_reason: null,
    started_at: null,
    ended_at: null,
    turns: 3,
  },
  {
    id: 'run_b',
    task_id: 't1',
    task_name: 'Docs proofread',
    scheduled_for: localMidnight(2026, 2, 4) + 14 * 3_600_000,
    state: 'failed',
    cost_usd: 0.1,
    outcome_reason: 'transient',
    started_at: null,
    ended_at: null,
    turns: 1,
  },
];

/**
 * Routes the two calls the year view is allowed to make. The `group=day`
 * pattern is first and the detail pattern excludes it, so a request that
 * forgot the parameter cannot be answered by the aggregate handler and pass
 * by accident.
 */
function calendarRoutes(opts: {
  days?: unknown;
  limits?: Record<string, unknown> | null;
  detailRuns?: unknown[];
  /**
   * Answer the detail window WITHOUT filtering on `scheduled_for`.
   *
   * That is not laziness — it is what the route really does. `GET /calendar`
   * admits a run when ANY of `scheduled_for`/`started_at`/`ended_at` falls in
   * the window, so a single-day request legitimately returns a run that
   * belongs to the day before.
   */
  detailUnfiltered?: boolean;
} = {}): Array<[RegExp, (call: Call) => Response]> {
  return [
    [
      /^\/calendar\?[^]*group=day/,
      (call) => {
        const q = new URL(call.url, 'http://x').searchParams;
        const body: Record<string, unknown> = {
          from: Number(q.get('from')),
          to: Number(q.get('to')),
          group: 'day',
          days: opts.days ?? DAYS,
        };
        if (opts.limits !== null) body.limits = opts.limits ?? fullLimits();
        return json(body);
      },
    ],
    [
      /^\/calendar\?/,
      (call) => {
        const q = new URL(call.url, 'http://x').searchParams;
        const from = Number(q.get('from'));
        const to = Number(q.get('to'));
        const all = opts.detailRuns ?? MARCH_4_RUNS;
        const runs = opts.detailUnfiltered
          ? all
          : all.filter((r) => {
              const at = (r as { scheduled_for: number }).scheduled_for;
              return at >= from && at <= to;
            });
        return json({ from, to, runs, bookings: [], humans: [], limits: fullLimits() });
      },
    ],
  ];
}

async function mountYear(
  routeOpts: Parameters<typeof calendarRoutes>[0] = {},
): Promise<{ container: HTMLDivElement; calls: Call[] }> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
  localStorage.setItem('clockwork.calview', 'year');
  const { calls } = stubFetch(calendarRoutes(routeOpts));
  const { default: CalendarView } = await import('../src/components/CalendarView');
  const container = await render(
    <CalendarView version={1} onBookOnDate={() => {}} onOpenTask={() => {}} />,
  );
  await waitFor(
    () => container.querySelector('[data-testid="year-day-2026-03-04"]'),
    'the 4 March cell of the year grid',
    { describe: () => `html = ${container.innerHTML.slice(0, 400)}` },
  );
  return { container, calls };
}

describe('Calendar ▸ Year asks for per-day counts, not five thousand events', () => {
  it('fetches the aggregate for the whole calendar year', async () => {
    const { calls } = await mountYear();
    const cal = calls.filter((c) => c.url.startsWith('/calendar?'));
    expect(cal, 'exactly one calendar request on mount').toHaveLength(1);
    const q = new URL(cal[0]!.url, 'http://x').searchParams;
    expect(q.get('group'), 'the year view must ask for counts per day').toBe('day');
    expect(Number(q.get('from'))).toBe(localMidnight(2026, 0, 1));
    expect(Number(q.get('to'))).toBe(localMidnight(2027, 0, 1) - 1);
  });

  it('draws a cell per day with its item count, and leaves quiet days blank', async () => {
    const { container } = await mountYear();
    // 3 runs + 1 booked occurrence = 4 things on that day.
    expect(container.querySelector('[data-testid="year-day-2026-03-04"]')!.textContent).toBe('4');
    expect(container.querySelector('[data-testid="year-day-2026-07-21"]')!.textContent).toBe('1');
    expect(container.querySelector('[data-testid="year-day-2026-03-05"]')!.textContent).toBe('');
  });

  it('colours a day by its worst outcome, with the same classes an event chip uses', async () => {
    const { container } = await mountYear();
    // 4 March holds two completions and one failure: a failure has to be
    // visible in a cell that summarizes, or the summary hides the bad news.
    expect(container.querySelector('[data-testid="year-day-2026-03-04"]')!.className).toContain(
      'st-failed',
    );
    // 21 July is one run waiting on a human — the loudest state there is.
    expect(container.querySelector('[data-testid="year-day-2026-07-21"]')!.className).toContain(
      'st-needsyou',
    );
  });

  it('names the year it drew, and moves a whole year at a time', async () => {
    const { container, calls } = await mountYear();
    expect(container.querySelector('.cal-title')!.textContent).toBe('2026');
    click([...container.querySelectorAll('.cal-toolbar button')].find((b) => b.getAttribute('aria-label') === 'Previous')!);
    await waitFor(
      () => calls.some((c) => c.url.includes(`from=${localMidnight(2025, 0, 1)}`)),
      'a fetch for 2025',
      { describe: () => calls.map((c) => c.url).join('\n') },
    );
    expect(container.querySelector('.cal-title')!.textContent).toBe('2025');
  });

  it('is reachable from the toolbar, not only from a stored preference', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TODAY);
    const { calls } = stubFetch(calendarRoutes());
    const { default: CalendarView } = await import('../src/components/CalendarView');
    const container = await render(
      <CalendarView version={1} onBookOnDate={() => {}} onOpenTask={() => {}} />,
    );
    // Default is month, and month must NOT use the aggregate: its cells draw
    // named chips, which counts cannot supply.
    await waitFor(() => calls.length > 0, 'the month fetch');
    expect(calls[0]!.url, 'the month grid still asks for events').not.toContain('group=day');

    const year = [...container.querySelectorAll('.seg button')].find((b) => b.textContent === 'Year');
    click(year ?? null);
    await waitFor(
      () => container.querySelector('[data-testid="year-day-2026-03-04"]'),
      'the year grid after clicking the Year tab',
      { describe: () => `html = ${container.innerHTML.slice(0, 400)}` },
    );
    expect(calls.some((c) => c.url.includes('group=day'))).toBe(true);
    expect(localStorage.getItem('clockwork.calview')).toBe('year');
  });
});

describe('clicking a day in the year view still shows that day’s real runs', () => {
  it('asks for one local day of events and lists them in the panel', async () => {
    const { container, calls } = await mountYear();
    click(container.querySelector('[data-testid="year-day-2026-03-04"]'));

    const detail = await waitFor(
      () => calls.find((c) => c.url.startsWith('/calendar?') && !c.url.includes('group=day')),
      'a detail fetch for the clicked day',
      { describe: () => calls.map((c) => c.url).join('\n') },
    );
    const q = new URL(detail.url, 'http://x').searchParams;
    expect(Number(q.get('from')), 'from is local midnight of the clicked day').toBe(
      localMidnight(2026, 2, 4),
    );
    expect(Number(q.get('to')), 'to is the last millisecond of the same local day').toBe(
      localMidnight(2026, 2, 5) - 1,
    );
    expect(q.get('group'), 'the day panel needs events, not counts').toBeNull();

    await waitForText(container, 'Nightly dependency sweep');
    const panel = container.querySelector('.day-panel')!;
    expect(panel.textContent).toContain('Nightly dependency sweep');
    expect(panel.textContent).toContain('Docs proofread');
  });

  it('lists only the runs the clicked day OWNS, not every row the window returned', async () => {
    // A run scheduled 3 March 23:55 that ended 4 March 00:05 is inside a
    // 4-March window by its `ended_at`, so the route returns it. The aggregate
    // files it under `COALESCE(scheduled_for, ...)` — 3 March — and counts it
    // in THAT cell. If the panel listed it too, the cell and the panel would
    // disagree about the same run: 4 March would show four items and then list
    // five, one of them stamped the previous night.
    const straddler = {
      id: 'run_straddle',
      task_id: 't1',
      task_name: 'Straddles midnight',
      scheduled_for: localMidnight(2026, 2, 3) + 23 * 3_600_000 + 55 * 60_000,
      state: 'completed',
      cost_usd: 0.3,
      outcome_reason: null,
      started_at: localMidnight(2026, 2, 3) + 23 * 3_600_000 + 56 * 60_000,
      ended_at: localMidnight(2026, 2, 4) + 5 * 60_000,
      turns: 2,
    };
    const { container } = await mountYear({
      detailRuns: [straddler, ...MARCH_4_RUNS],
      detailUnfiltered: true,
    });
    click(container.querySelector('[data-testid="year-day-2026-03-04"]'));
    await waitForText(container, 'Nightly dependency sweep');
    const panel = container.querySelector('.day-panel')!;
    expect(panel.textContent, 'the run belongs to 3 March, and 3 March counted it').not.toContain(
      'Straddles midnight',
    );
    expect(panel.textContent).toContain('Nightly dependency sweep');
    expect(panel.textContent, 'two runs own 4 March, so the panel says two items').toContain('2 items');
  });

  it('does not fetch a day’s events before a day is clicked', async () => {
    const { calls } = await mountYear();
    expect(
      calls.filter((c) => c.url.startsWith('/calendar?') && !c.url.includes('group=day')),
      'the year view must not pull a day of events nobody asked for',
    ).toHaveLength(0);
  });
});

describe('a capped answer says so on screen', () => {
  it('shows what was cut when limits.truncated is set', async () => {
    const { container } = await mountYear({
      limits: fullLimits({
        rowLimit: 2,
        truncated: true,
        days: { returned: 2, total: 400, truncated: true },
        runs: { returned: 4, total: 5_000, truncated: true },
      }),
    });
    const notice = await waitFor(
      () => container.querySelector('[data-testid="calendar-truncated"]'),
      'the truncation notice',
      { describe: () => container.textContent ?? '' },
    );
    expect(notice.textContent).toContain('400');
    expect(notice.textContent).toContain('5000');
  });

  it('says nothing when nothing was cut', async () => {
    const { container } = await mountYear();
    expect(container.querySelector('[data-testid="calendar-truncated"]')).toBeNull();
  });

  it('renders a response that carries no limits at all — an older daemon', async () => {
    const { container } = await mountYear({ limits: null });
    expect(container.querySelector('[data-testid="year-day-2026-03-04"]')!.textContent).toBe('4');
    expect(container.querySelector('[data-testid="calendar-truncated"]')).toBeNull();
  });
});
