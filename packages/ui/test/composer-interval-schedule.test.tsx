/**
 * The interval scheduler, end to end through the composer (SCH-4, SCH-5).
 *
 * Two things are pinned. The PAYLOAD, because the whole point of the change is
 * that "every 15 minutes on weekdays" reaches the daemon as a rule the expander
 * can answer — the literal `FREQ=MINUTELY` spelling of it does not terminate.
 * And the PANEL, because these are the first schedule shapes a person can get
 * wrong, and a recurrence that never fires is otherwise invisible until the day
 * it does not run.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { renderComponent, waitForElement, waitFor } from './helpers/dom';
// Statically imported for the reason composer-schedule-hint.test.tsx records:
// ComposerView pulls Radix, react-day-picker and the lucide barrel through the
// transform, and a dynamic import here blows the per-test timeout.
import ComposerView from '../src/components/ComposerView';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Captured { schedule?: { kind?: string; rrule?: string; tz?: string } }

function stub(opts: { preview?: (rrule: string) => Response } = {}): {
  posted: () => Captured | null;
  previewed: () => string[];
} {
  let body: Captured | null = null;
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      if (path === '/profiles') return json([]);
      if (path === '/providers') return json([]);
      if (path === '/byok') return json({ configs: [] });
      if (path === '/schedule/preview' && init?.method === 'POST') {
        const sent = JSON.parse(String(init.body)) as { rrule: string };
        seen.push(sent.rrule);
        return opts.preview
          ? opts.preview(sent.rrule)
          : json({ runs: [1, 2, 3, 4, 5].map((n) => Date.UTC(2026, 8, 8, 9, 0) + n * 900_000), tz: 'UTC', count: 5 });
      }
      if (path === '/tasks' && init?.method === 'POST') {
        body = JSON.parse(String(init.body)) as Captured;
        return json({ id: 'task-1' }, 201);
      }
      return json({});
    }),
  );
  return { posted: () => body, previewed: () => seen };
}

const tabByLabel = (c: HTMLElement, label: string): HTMLButtonElement => {
  const tab = [...c.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  expect(tab, `"${label}" tab missing`).not.toBeUndefined();
  return tab!;
};

const buttonByText = (c: HTMLElement, text: string): HTMLButtonElement => {
  const btn = [...c.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').trim() === text,
  );
  expect(btn, `"${text}" button missing`).not.toBeUndefined();
  return btn!;
};

/** React tracks a controlled value on the node, so the prototype setter is the way in. */
const typeInto = (el: HTMLTextAreaElement | HTMLInputElement, value: string): void => {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const dayButton = (c: HTMLElement, label: string): HTMLButtonElement => {
  const btn = [...c.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').trim() === label && b.hasAttribute('aria-pressed'),
  );
  expect(btn, `day "${label}" missing`).not.toBeUndefined();
  return btn!;
};

/**
 * Click a toggle and wait for its own `aria-pressed` to flip.
 *
 * The render is not flushed synchronously here, so two clicks in a row — or a
 * click followed by "Book it" — both read the state as it was before either
 * landed. Waiting on the button's own attribute is the cheapest honest barrier.
 */
async function toggleDayAndSettle(c: HTMLElement, label: string): Promise<void> {
  const btn = dayButton(c, label);
  const before = btn.getAttribute('aria-pressed');
  btn.click();
  await waitFor(
    () => dayButton(c, label).getAttribute('aria-pressed') !== before,
    `"${label}" to toggle`,
    { describe: () => `aria-pressed = ${dayButton(c, label).getAttribute('aria-pressed')}` },
  );
}

/** Opens Recurring and switches to the interval mode. */
async function openInterval(): Promise<HTMLElement> {
  const container = await renderComponent(<ComposerView onDone={() => {}} />);
  await waitForElement(container, '#c-prompt');
  typeInto(container.querySelector<HTMLTextAreaElement>('#c-prompt')!, 'Poll the queue.');
  tabByLabel(container, 'Recurring').click();
  await waitForElement(container, '#c-rtime');
  tabByLabel(container, 'Every N min').click();
  await waitForElement(container, '#c-from-hour');
  return container;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the interval scheduler sends a rule the expander can answer', () => {
  it('posts FREQ=HOURLY with the minute grid, never FREQ=MINUTELY', async () => {
    const { posted } = stub();
    const container = await openInterval();

    buttonByText(container, 'Book it').click();
    await waitFor(() => posted() !== null, 'the POST /tasks body');

    const schedule = posted()!.schedule!;
    expect(schedule.kind).toBe('rrule');
    // The bug this replaces, in one assertion: the literal spelling hangs.
    expect(schedule.rrule).not.toMatch(/FREQ=MINUTELY/);
    expect(schedule.rrule).toBe('FREQ=HOURLY;BYMINUTE=0,15,30,45');
    expect(schedule.tz).toBeTruthy();
  });

  it('narrows to weekdays and an hour window when asked', async () => {
    const { posted } = stub();
    const container = await openInterval();

    for (const d of ['Sat', 'Sun']) await toggleDayAndSettle(container, d);
    typeInto(container.querySelector<HTMLInputElement>('#c-from-hour')!, '9');
    const toHour = [...container.querySelectorAll<HTMLInputElement>('input')].find(
      (i) => i.getAttribute('aria-label') === 'To hour',
    )!;
    typeInto(toHour, '17');
    await waitFor(
      () => container.querySelector<HTMLInputElement>('#c-from-hour')!.value === '9' && toHour.value === '17',
      'the hour window to settle',
      { describe: () => `from=${container.querySelector<HTMLInputElement>('#c-from-hour')!.value} to=${toHour.value}` },
    );

    buttonByText(container, 'Book it').click();
    await waitFor(() => posted() !== null, 'the POST /tasks body');

    expect(posted()!.schedule!.rrule)
      .toBe('FREQ=HOURLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10,11,12,13,14,15,16;BYMINUTE=0,15,30,45');
  });

  it('changing the interval changes the minute grid', async () => {
    const { posted } = stub();
    const container = await openInterval();
    buttonByText(container, '30 min').click();
    await waitFor(
      () => buttonByText(container, '30 min').getAttribute('aria-selected') === 'true',
      'the 30-minute option to become current',
      { describe: () => buttonByText(container, '30 min').outerHTML.slice(0, 200) },
    );
    buttonByText(container, 'Book it').click();
    await waitFor(() => posted() !== null, 'the POST /tasks body');
    expect(posted()!.schedule!.rrule).toBe('FREQ=HOURLY;BYMINUTE=0,30');
  });
});

describe('weekly takes more than one day', () => {
  it('emits BYDAY=MO,WE,FR', async () => {
    const { posted } = stub();
    const container = await renderComponent(<ComposerView onDone={() => {}} />);
    await waitForElement(container, '#c-prompt');
    typeInto(container.querySelector<HTMLTextAreaElement>('#c-prompt')!, 'Weekly sweep.');
    tabByLabel(container, 'Recurring').click();
    await waitForElement(container, '#c-rtime');

    // Starts on Monday alone; add Wednesday and Friday.
    for (const d of ['Wed', 'Fri']) await toggleDayAndSettle(container, d);
    buttonByText(container, 'Book it').click();
    await waitFor(() => posted() !== null, 'the POST /tasks body');

    expect(posted()!.schedule!.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0');
  });
});

describe('the next-5-runs panel', () => {
  it('previews exactly the rule Book-it would send, and lists five times', async () => {
    const { previewed, posted } = stub();
    const container = await openInterval();

    await waitFor(() => previewed().length > 0, 'a preview request', {
      describe: () => `requests = ${JSON.stringify(previewed())}`,
    });
    await waitFor(
      () => (container.querySelector('[data-testid="next-runs"]')?.querySelectorAll('li').length ?? 0) === 5,
      'five rendered runs',
      { describe: () => `panel = ${container.querySelector('[data-testid="next-runs"]')?.textContent}` },
    );

    buttonByText(container, 'Book it').click();
    await waitFor(() => posted() !== null, 'the POST /tasks body');
    // One builder, so the preview cannot describe a different schedule from the
    // one that gets saved.
    expect(previewed().at(-1)).toBe(posted()!.schedule!.rrule);
  });

  it('shows the guard\'s refusal inline instead of five plausible times', async () => {
    const { previewed } = stub({
      preview: () => json({ error: 'BYHOUR=3 is unreachable from FREQ=HOURLY;INTERVAL=2', reason: 'unreachable' }, 422),
    });
    const container = await openInterval();

    await waitFor(() => previewed().length > 0, 'a preview request');
    await waitFor(
      () => (container.querySelector('[data-testid="next-runs"]')?.textContent ?? '').includes('unreachable'),
      'the refusal message',
      { describe: () => `panel = ${container.querySelector('[data-testid="next-runs"]')?.textContent}` },
    );
    expect(container.querySelector('[data-testid="next-runs"]')!.querySelectorAll('li')).toHaveLength(0);
  });

  it('reports a local validation error without asking the daemon', async () => {
    const { previewed } = stub();
    const container = await openInterval();
    // An end hour at or below the start hour cannot make a rule at all.
    typeInto(container.querySelector<HTMLInputElement>('#c-from-hour')!, '18');
    const toHour = [...container.querySelectorAll<HTMLInputElement>('input')].find(
      (i) => i.getAttribute('aria-label') === 'To hour',
    )!;
    typeInto(toHour, '9');

    await waitFor(
      () => (container.querySelector('[data-testid="next-runs"]')?.textContent ?? '').includes('end hour must be after'),
      'the local error',
      { describe: () => `panel = ${container.querySelector('[data-testid="next-runs"]')?.textContent}` },
    );
    const askedAfterError = previewed().filter((r) => /BYHOUR=18/.test(r));
    expect(askedAfterError).toEqual([]);
  });
});
