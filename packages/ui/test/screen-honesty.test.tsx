/**
 * Screens that stated something false, found by driving the real app against a
 * live daemon. Four claims, four guards:
 *
 *   1. Calendar ▸ Week — the header named a different week from its own grid,
 *      and the fetch window skipped the days before the anchor, so the columns
 *      it did draw were guaranteed empty. Weeks start Monday in this product
 *      (calendar.ts, the DOW row, buildMonthGrid), so the GRID is right and the
 *      title had to move.
 *   2. The topbar's `next …` printed a bare clock time: a booking on 20 Dec
 *      read exactly like one fourteen minutes away.
 *   3. The earned-autonomy card told every visitor `Every profile is already
 *      enrolled` for the seconds before GET /profiles answered.
 *   4. The capability matrix was capped at 300px — four of its six categories
 *      could not be reached — and its only toggle looked like caption text.
 *
 * jsdom + createRoot, the approach the rest of this suite uses. Every expected
 * string is re-derived through the same Intl formatter the component uses, so
 * these assertions hold under any ICU locale rather than pinning en-US.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Statically, not with await import() inside a test: App pulls the whole
// component graph, and paying that transform inside a 5s test timeout made
// this file fail under a loaded full-suite run.
import { formatNextFire } from '../src/App';
import { renderComponent, waitFor, waitForElement, waitForText } from './helpers/dom';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const render = renderComponent;

function click(el: Element | null): void {
  expect(el, 'control missing from the DOM').not.toBeNull();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

interface Call {
  url: string;
  method: string;
}

/**
 * Routes only the calls a card is allowed to make. An unrouted request throws
 * rather than resolving empty: a silently-swallowed fetch would let a blank
 * screen pass as a green test. Handlers may return a promise, which is how the
 * autonomy test holds GET /profiles open for ever.
 */
function stubFetch(routes: Array<[RegExp, (call: Call) => Response | Promise<Response>]>): { calls: Call[] } {
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 1. Calendar ▸ Week: the header and the grid are the same seven days
// ---------------------------------------------------------------------------

describe('Calendar ▸ Week header names the week its own grid draws', () => {
  const midnight = (y: number, m: number, d: number): number => new Date(y, m, d).getTime();
  /** The component's own two formatters, so the test is locale-agnostic. */
  const titleEnd = (ts: number): string =>
    new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const columnHead = (ts: number): string =>
    new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });

  /**
   * Stands in for GET /calendar, INCLUDING its window: the route only returns
   * what falls inside from…to. A week whose fetch window starts after its own
   * Monday therefore draws empty columns here exactly as it did in the browser.
   */
  const mountWeek = async (
    today: Date,
    runs: Array<{ ts: number; name: string }> = [],
  ): Promise<{ container: HTMLDivElement; calls: Call[] }> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(today);
    localStorage.setItem('clockwork.calview', 'week');
    const { calls } = stubFetch([
      [
        /^\/calendar\?/,
        (call) => {
          const q = new URL(call.url, 'http://x').searchParams;
          const from = Number(q.get('from'));
          const to = Number(q.get('to'));
          return json({
            runs: runs
              .filter((r) => r.ts >= from && r.ts <= to)
              .map((r, i) => ({
                id: `run_${i}`,
                task_id: 't1',
                task_name: r.name,
                scheduled_for: r.ts,
                state: 'completed',
                cost_usd: 0,
              })),
            bookings: [],
          });
        },
      ],
    ]);
    const { default: CalendarView } = await import('../src/components/CalendarView');
    const container = await render(
      <CalendarView version={1} onBookOnDate={() => {}} onOpenTask={() => {}} />,
    );
    // The seven columns are what every case below reads, so they are the wait.
    await waitFor(
      () => container.querySelectorAll('.week-col .daynum').length === 7,
      'the seven week columns',
      { describe: () => `columns = ${container.querySelectorAll('.week-col .daynum').length}` },
    );
    return { container, calls };
  };

  const cases: Array<{ what: string; today: Date; monday: number; sunday: number }> = [
    {
      // The reported case: header read "Sep 6 – Sep 12" over columns 31 Aug…6 Sep.
      what: 'a Sunday — the last day of its week, and the week spans a month end',
      today: new Date(2026, 8, 6, 12, 0),
      monday: midnight(2026, 7, 31),
      sunday: midnight(2026, 8, 6),
    },
    {
      // The one day in seven where the old code was accidentally right. It must
      // stay right: this is the case a naive "shift the title back" would break.
      what: 'a Monday — the day the old title happened to agree with the grid',
      today: new Date(2026, 8, 7, 12, 0),
      monday: midnight(2026, 8, 7),
      sunday: midnight(2026, 8, 13),
    },
    {
      what: 'a midweek day whose week spans a month end',
      today: new Date(2026, 8, 2, 9, 30),
      monday: midnight(2026, 7, 31),
      sunday: midnight(2026, 8, 6),
    },
    {
      what: 'a week that spans a year end',
      today: new Date(2026, 11, 31, 18, 0),
      monday: midnight(2026, 11, 28),
      sunday: midnight(2027, 0, 3),
    },
  ];

  for (const c of cases) {
    it(`${c.what}`, async () => {
      const { container } = await mountWeek(c.today);

      const cols = [...container.querySelectorAll('.week-col .daynum')];
      expect(cols, 'seven columns').toHaveLength(7);
      expect(cols[0]!.textContent, 'the grid starts on Monday').toBe(columnHead(c.monday));
      expect(cols[6]!.textContent, 'the grid ends on Sunday').toBe(columnHead(c.sunday));

      const title = container.querySelector('.cal-title')!.textContent;
      expect(title, 'the header must name the seven days below it, not another week').toBe(
        `${titleEnd(c.monday)} – ${titleEnd(c.sunday)}`,
      );
    });
  }

  it('fetches from the start of the week it draws, not from the anchor day', async () => {
    // The anchor was also the fetch origin, so on any non-Monday the request
    // began mid-week and the earlier columns could not have shown anything.
    const { calls } = await mountWeek(new Date(2026, 8, 6, 12, 0));
    const from = Number(new URL(calls[0]!.url, 'http://x').searchParams.get('from'));
    expect(from, 'Monday 31 Aug is inside the window').toBeLessThanOrEqual(midnight(2026, 7, 31));
  });

  it('a run booked on the Monday appears in the Monday column', async () => {
    const mondayRun = midnight(2026, 7, 31) + 9 * 3_600_000;
    const { container } = await mountWeek(new Date(2026, 8, 6, 12, 0), [
      { ts: mondayRun, name: 'Verify sweep' },
    ]);
    // The columns draw before GET /calendar answers, so the booked run needs
    // its own wait — the grid being there is not the run being there.
    await waitForText(container, 'Verify sweep');
    const first = container.querySelectorAll('.week-col')[0]!;
    expect(first.textContent, 'the week that is drawn must be the week that is fetched').toContain(
      'Verify sweep',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The topbar's next-fire stamp says which day
// ---------------------------------------------------------------------------

describe('topbar next-fire stamp carries enough date to mean something', () => {
  const clock = { hour: 'numeric', minute: '2-digit' } as const;
  // 14:07 on Sunday 6 Sep 2026 — the moment the browser run captured.
  const NOW = new Date(2026, 8, 6, 14, 7);

  it('a booking months away is not printed as a bare clock time', async () => {
    const dec20 = new Date(2026, 11, 20, 14, 0);
    const out = formatNextFire(dec20.getTime(), NOW);
    expect(out, 'this is the bug: “next 2:00 PM” for a run 105 days out').not.toBe(
      dec20.toLocaleTimeString(undefined, clock),
    );
    expect(out).toContain(dec20.toLocaleString(undefined, { month: 'short', day: 'numeric' }));
    expect(out).toContain(dec20.toLocaleTimeString(undefined, clock));
  });

  it('today is the time alone — and without seconds', async () => {
    const later = new Date(2026, 8, 6, 21, 30);
    expect(formatNextFire(later.getTime(), NOW)).toBe(later.toLocaleTimeString(undefined, clock));
  });

  it('the next six days carry the weekday', async () => {
    for (const d of [7, 8, 12]) {
      const at = new Date(2026, 8, d, 9, 0);
      expect(formatNextFire(at.getTime(), NOW)).toBe(
        at.toLocaleString(undefined, { weekday: 'short', ...clock }),
      );
    }
  });

  it('a week out or more carries the date, and another year carries the year', async () => {
    const nextSunday = new Date(2026, 8, 13, 9, 0);
    expect(formatNextFire(nextSunday.getTime(), NOW)).toBe(
      nextSunday.toLocaleString(undefined, { month: 'short', day: 'numeric', ...clock }),
    );
    const nextYear = new Date(2027, 0, 4, 9, 0);
    expect(formatNextFire(nextYear.getTime(), NOW)).toBe(
      nextYear.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', ...clock }),
    );
  });

  it('1am tomorrow is tomorrow, not “today” — calendar days, not a 24h window', async () => {
    const lateNight = new Date(2026, 8, 6, 23, 30);
    const at = new Date(2026, 8, 7, 1, 0);
    expect(formatNextFire(at.getTime(), lateNight)).toBe(
      at.toLocaleString(undefined, { weekday: 'short', ...clock }),
    );
  });

  it('the topbar renders through the formatter, not through a bare time', () => {
    const app = readFileSync(resolve(SRC, 'App.tsx'), 'utf8');
    expect(app).toContain('formatNextFire(health.nextFire)');
    expect(
      /health\.nextFire\)\.toLocaleTimeString\(\)/.test(app),
      'the bare clock time is the bug',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The autonomy card claims nothing before it has the data
// ---------------------------------------------------------------------------

describe('AutonomyCard states no enrolment fact while it is still loading', () => {
  const OFFERS: Array<[RegExp, (call: Call) => Response | Promise<Response>]> = [
    [/^\/workforce\/autonomy\/offers\?/, () => json({ offers: [] })],
  ];

  const mount = async (
    profiles: (call: Call) => Response | Promise<Response>,
  ): Promise<HTMLDivElement> => {
    stubFetch([...OFFERS, [/^\/profiles$/, profiles]]);
    const { AutonomyCard } = await import('../src/components/AutonomyCard');
    const container = await render(<AutonomyCard version={1} />);
    await waitForElement(container, '[data-testid="autonomy-enrol-open"]');
    return container;
  };

  /**
   * The three cases below are about what the button says AFTER GET /profiles
   * answers. Waiting for the label to stop being the loading one is the honest
   * anchor: it does not wait for the answer the test asserts, so a wrong label
   * still fails as a wrong label.
   */
  const profilesRead = (btn: Element): Promise<true> =>
    waitFor(() => btn.textContent !== 'Reading profiles…' || undefined, 'GET /profiles to answer', {
      describe: () => `button reads ${JSON.stringify(btn.textContent)}`,
    });

  it('says it is still reading, instead of “Every profile is already enrolled”', async () => {
    // GET /profiles measured at 4.7-5.3s behind provider detection on a real
    // Settings load. Hold it open: that is the whole window this bug lives in.
    const container = await mount(() => new Promise<Response>(() => {}));
    const btn = container.querySelector('[data-testid="autonomy-enrol-open"]')!;
    expect(btn.textContent, 'nothing is enrolled; the card had not been told anything yet').not.toBe(
      'Every profile is already enrolled',
    );
    expect(btn.textContent).toBe('Reading profiles…');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the read failed when it failed, which is also not a claim about enrolment', async () => {
    const container = await mount(() => json({ error: 'database is locked' }, 500));
    const btn = container.querySelector('[data-testid="autonomy-enrol-open"]')!;
    await profilesRead(btn);
    expect(btn.textContent).toBe('Profiles couldn’t be read');
  });

  it('still says every profile is enrolled once that is actually true', async () => {
    const container = await mount(() =>
      json([{ id: 'p_2', slug: 'test-doctor', name: 'Test Doctor', permission_mode: 'plan', autonomy_rung: 'plan' }]),
    );
    const btn = container.querySelector('[data-testid="autonomy-enrol-open"]')!;
    await profilesRead(btn);
    expect(btn.textContent).toBe('Every profile is already enrolled');
  });

  it('offers the picker once there is somebody to enrol', async () => {
    const container = await mount(() =>
      json([{ id: 'p_1', slug: 'docs-scribe', name: 'Docs Scribe', permission_mode: 'acceptEdits', autonomy_rung: null }]),
    );
    const btn = container.querySelector('[data-testid="autonomy-enrol-open"]')!;
    await profilesRead(btn);
    expect(btn.textContent).toBe('Choose a profile to enrol');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. The capability list can be read, and its toggle looks like one
// ---------------------------------------------------------------------------

describe('capability matrix is readable and its toggle is visibly a control', () => {
  const CATEGORIES = ['execution', 'providers', 'scheduling', 'governance', 'analytics', 'integrations'];
  const CAPS = {
    tier: 'free',
    entitlement: { tier: 'free', state: 'none' },
    features: CATEGORIES.map((category, i) => ({
      key: `feat_${i}`,
      label: `Capability ${i}`,
      category,
      enabled: true,
      status: 'available',
    })),
  };

  const open = async (): Promise<HTMLDivElement> => {
    stubFetch([[/^\/capabilities$/, () => json(CAPS)]]);
    const { LicenseCard } = await import('../src/components/LicenseCard');
    const container = await render(<LicenseCard version={1} />);
    await waitForElement(container, '[data-testid="capability-matrix-toggle"]');
    click(container.querySelector('[data-testid="capability-matrix-toggle"]'));
    await waitForElement(container, '[data-testid="capability-matrix"]');
    return container;
  };

  it('is not clipped to a fraction of itself', async () => {
    const container = await open();
    const matrix = container.querySelector('[data-testid="capability-matrix"]') as HTMLElement | null;
    expect(matrix, 'the matrix panel').not.toBeNull();
    expect(matrix!.style.maxHeight, '300px showed two of six categories and sliced the third heading').toBe('');
    expect(matrix!.style.overflow, 'no scroll region, so nothing to overlook').toBe('');
    for (const category of CATEGORIES) {
      expect(matrix!.textContent!.toLowerCase(), `${category} must be reachable`).toContain(category);
    }
  });

  it('the only way in looks clickable without hovering it', async () => {
    stubFetch([[/^\/capabilities$/, () => json(CAPS)]]);
    const { LicenseCard } = await import('../src/components/LicenseCard');
    const container = await render(<LicenseCard version={1} />);
    await waitForElement(container, '[data-testid="capability-matrix-toggle"]');
    const toggle = container.querySelector('[data-testid="capability-matrix-toggle"]')!;
    const classes = toggle.className.split(/\s+/);
    expect(classes, 'a hover-only underline is invisible until you find it').toContain('underline');
    expect(toggle.querySelector('svg'), 'a chevron states which way the disclosure goes').not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    click(toggle);
    await waitFor(() => toggle.getAttribute('aria-expanded') === 'true', 'the disclosure to report itself open', {
      describe: () => `aria-expanded = ${JSON.stringify(toggle.getAttribute('aria-expanded'))}`,
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});
