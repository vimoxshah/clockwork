/**
 * Drag/drop moves (P2) in the calendar: chip dragstart reads the schedule,
 * dragover previews the computed move, drop PATCHes it, Undo restores it.
 *
 * jsdom has no real DnD, so dataTransfer is a stub object defined onto a
 * plain Event — the handlers only touch setData/effectAllowed/preventDefault,
 * which is the whole contract they rely on in a browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import CalendarView from '../src/components/CalendarView';
import { renderComponent, waitForElement, waitForText } from './helpers/dom';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(handler: (call: Call) => Response | Promise<Response>): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      return handler(call);
    }) as any,
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function dragData(): Record<string, (k: string, v: string) => void> & { effectAllowed: string } {
  const store: Record<string, string> = {};
  return { setData: (k: string, v: string) => (store[k] = v), effectAllowed: '' } as any;
}

function fire(el: Element, type: string): void {
  const evt = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'dataTransfer', { value: dragData() });
  el.dispatchEvent(evt);
}

/**
 * Browsers repeat dragover continuously while hovering — that repetition (not
 * any fixed sleep) is what lets a late schedule fetch still paint its
 * preview. Mirror it: keep hovering until the expected text lands.
 */
async function hoverUntil(container: HTMLDivElement, target: Element, text: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    fire(target, 'dragover');
    await new Promise((r) => setTimeout(r, 25));
    if (container.textContent?.includes(text)) return;
    if (Date.now() - t0 > 5000) throw new Error(`hover timed out waiting for "${text}"`);
  }
}

/** Mount month view with one booked task; PATCH answers 200. */
async function mount(
  patches: unknown[] = [],
  schedule: Record<string, unknown> = {
    kind: 'rrule',
    rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=2;BYMINUTE=0',
    cron: null,
    runAt: null,
    tz: 'America/New_York',
    version: 3,
  },
  onScheduleRead?: (s: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ container: HTMLDivElement; calls: Call[] }> {
  // Next Monday from today, noon local — inside the 42-day month grid.
  const now = new Date();
  const daysToMon = (8 - now.getDay()) % 7 || 7;
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToMon, 12).getTime();
  const { calls } = stubFetch((call) => {
    if (call.url.startsWith('/calendar?')) {
      return json({ runs: [], bookings: [{ taskId: 't1', name: 'Nightly', at, projected: false }], humans: [], limits: {} });
    }
    if (call.url === '/tasks/t1/schedule') {
      return json(onScheduleRead ? onScheduleRead(schedule) : schedule);
    }
    if (call.url === '/tasks/t1' && call.method === 'PATCH') {
      patches.push(call.body);
      return json({ id: 't1', version: 4 });
    }
    throw new Error(`unexpected request: ${call.method} ${call.url}`);
  });
  const container = await renderComponent(<CalendarView version={1} onBookOnDate={() => {}} onOpenTask={() => {}} />);
  await waitForElement(container, '[data-testid="booking-chip-t1"]');
  return { container, calls };
}

describe('calendar drag/drop', () => {
  it('drags a booking chip onto another day and PATCHes the rewritten rule', async () => {
    const patches: unknown[] = [];
    const { container, calls } = await mount(patches);
    const chip = container.querySelector('[data-testid="booking-chip-t1"]')!;
    fire(chip, 'dragstart');
    const cells = [...container.querySelectorAll('[data-testid="cal-cell"]')] as HTMLElement[];
    const target = cells[cells.length - 1]!;
    await hoverUntil(container, target, 'Every ');
    fire(target, 'drop');
    await waitForText(container, 'moves all future occurrences');
    expect(calls.some((c) => c.url === '/tasks/t1/schedule')).toBe(true);
    expect(patches).toHaveLength(1);
    const body = patches[0] as any;
    expect(body.version).toBe(3);
    expect(body.schedule.kind).toBe('rrule');
    expect(body.schedule.tz).toBe('America/New_York');
    expect(body.schedule.rrule).toMatch(/^FREQ=WEEKLY;BYDAY=(MO|TU|WE|TH|FR|SA|SU);BYHOUR=2;BYMINUTE=0$/);
  });

  it('a meaningless move previews the refusal and PATCHes nothing', async () => {
    const patches: unknown[] = [];
    const { container } = await mount(patches, {
      kind: 'rrule',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      cron: null,
      runAt: null,
      tz: 'America/New_York',
      version: 3,
    });
    const chip = container.querySelector('[data-testid="booking-chip-t1"]')!;
    fire(chip, 'dragstart');
    const cells = [...container.querySelectorAll('[data-testid="cal-cell"]')] as HTMLElement[];
    await hoverUntil(container, cells[cells.length - 1]!, 'already fires every day');
    fire(cells[cells.length - 1]!, 'drop');
    await waitForText(container, "Couldn't move this job");
    expect(patches).toEqual([]);
  });

  it('offers Undo after a move', async () => {
    const patches: unknown[] = [];
    const { container } = await mount(patches);
    const chip = container.querySelector('[data-testid="booking-chip-t1"]')!;
    fire(chip, 'dragstart');
    const cells = [...container.querySelectorAll('[data-testid="cal-cell"]')] as HTMLElement[];
    await hoverUntil(container, cells[cells.length - 1]!, 'Every ');
    fire(cells[cells.length - 1]!, 'drop');
    await waitForElement(container, '[data-testid="move-undo"]');
  });

  it('Undo refuses when the job changed since the move', async () => {
    const patches: unknown[] = [];
    // After the move lands, the "daemon" reports an edited rule (as if the
    // user changed the time in Tasks) — Undo must refuse, not clobber it.
    let edited = false;
    const { container } = await mount(
      patches,
      {
        kind: 'rrule',
        rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=2;BYMINUTE=0',
        cron: null,
        runAt: null,
        tz: 'America/New_York',
        version: 3,
      },
      (s) => (edited ? { ...s, rrule: 'FREQ=WEEKLY;BYDAY=WE;BYHOUR=9;BYMINUTE=0', version: 5 } : s),
    );
    const chip = container.querySelector('[data-testid="booking-chip-t1"]')!;
    fire(chip, 'dragstart');
    const cells = [...container.querySelectorAll('[data-testid="cal-cell"]')] as HTMLElement[];
    await hoverUntil(container, cells[cells.length - 1]!, 'Every ');
    fire(cells[cells.length - 1]!, 'drop');
    await waitForElement(container, '[data-testid="move-undo"]');
    expect(patches).toHaveLength(1);
    edited = true;
    (container.querySelector('[data-testid="move-undo"]') as HTMLButtonElement).click();
    await waitForText(container, 'changed since the move');
    // No second PATCH with the stale snapshot.
    expect(patches).toHaveLength(1);
  });
});
