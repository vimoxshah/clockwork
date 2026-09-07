/**
 * "ASAP" has to actually run.
 *
 * The bug: the composer's ASAP option saved `{kind:'queue'}`. That kind is the
 * daemon's REVIEW GATE — repo.ts stores it `enabled=0, next_fire=NULL` so an
 * imported or planned task waits for a human — and `Scheduler.tick` selects on
 * `enabled=1 AND next_fire IS NOT NULL`, so a queue row is unfireable by
 * construction. `/calendar` skips the kind outright too. The result was a task
 * that never ran, never appeared on the calendar, and only showed up once
 * someone pressed run by hand, under a control captioned "work the queue as
 * soon as a slot is free".
 *
 * The fix keeps `queue` for the gate and gives ASAP a near-future `once`
 * booking. What is pinned here is the payload, because that is where the two
 * concepts got crossed: ASAP must send a `once` schedule whose `runAt` is in
 * the future — far enough ahead to survive `POST /tasks`'s past-time refusal,
 * near enough to still mean ASAP.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { renderComponent, waitForElement, waitFor } from './helpers/dom';
// Statically imported for the same reason composer-schedule-hint.test.tsx
// records: ComposerView pulls Radix, react-day-picker and the lucide barrel
// through the transform, and a dynamic import inside the test body blows the
// per-test timeout under CPU oversubscription.
import ComposerView from '../src/components/ComposerView';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

interface Captured {
  schedule?: { kind?: string; runAt?: number; tz?: string };
}

/** Stubs the composer's reads and captures the POST /tasks body. */
function stubAndCapture(): { posted: () => Captured | null } {
  let body: Captured | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      if (path === '/profiles') return json([]);
      if (path === '/providers') return json([]);
      if (path === '/byok') return json({ configs: [] });
      if (path === '/tasks' && init?.method === 'POST') {
        body = JSON.parse(String(init.body)) as Captured;
        return new Response(JSON.stringify({ id: 'task-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return json({});
    }),
  );
  return { posted: () => body };
}

const tabByLabel = (container: HTMLElement, label: string): HTMLButtonElement => {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  expect(tab, `"${label}" schedule tab missing`).not.toBeUndefined();
  return tab!;
};

/**
 * React tracks a controlled value on the DOM node, so assigning `.value`
 * directly is swallowed on the next render. Same prototype-setter route
 * delivery-channels-ui.test.tsx:421 uses.
 */
const typeInto = (el: HTMLTextAreaElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const buttonByText = (container: HTMLElement, text: string): HTMLButtonElement => {
  const btn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').trim() === text,
  );
  expect(btn, `"${text}" button missing`).not.toBeUndefined();
  return btn!;
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('composer ASAP books a runnable schedule, not the review gate', () => {
  it('posts a future one-off — never kind:"queue", which the scheduler cannot fire', async () => {
    const { posted } = stubAndCapture();
    const container = await renderComponent(<ComposerView onDone={() => {}} />);
    await waitForElement(container, '#c-prompt');

    typeInto(container.querySelector<HTMLTextAreaElement>('#c-prompt')!, 'Summarize open TODOs.');

    tabByLabel(container, 'ASAP').click();
    await waitFor(
      () => (container.textContent ?? '').includes('next scheduler sweep'),
      'the ASAP explanation',
      { describe: () => `body = ${JSON.stringify((container.textContent ?? '').slice(0, 400))}` },
    );

    const before = Date.now();
    buttonByText(container, 'Book it').click();
    await waitFor(() => posted() !== null, 'the POST /tasks body');

    const schedule = posted()!.schedule!;
    // The whole bug in one assertion.
    expect(schedule.kind).not.toBe('queue');
    expect(schedule.kind).toBe('once');
    // Must clear the server's `runAt < Date.now()` refusal…
    expect(schedule.runAt!).toBeGreaterThan(before);
    // …and must still mean ASAP rather than "some time later today".
    expect(schedule.runAt!).toBeLessThan(before + 60_000);
    expect(schedule.tz).toBeTruthy();
  });

  it('leaves the one-off and recurring payloads alone', async () => {
    const { posted } = stubAndCapture();
    const container = await renderComponent(<ComposerView onDone={() => {}} />);
    await waitForElement(container, '#c-prompt');

    typeInto(container.querySelector<HTMLTextAreaElement>('#c-prompt')!, 'Weekly sweep.');

    tabByLabel(container, 'Recurring').click();
    await waitForElement(container, '#c-rtime');
    buttonByText(container, 'Book it').click();
    await waitFor(() => posted() !== null, 'the POST /tasks body');

    const schedule = posted()!.schedule as { kind?: string; rrule?: string };
    expect(schedule.kind).toBe('rrule');
    expect(schedule.rrule).toContain('FREQ=');
  });
});
