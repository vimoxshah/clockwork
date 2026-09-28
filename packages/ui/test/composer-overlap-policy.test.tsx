/**
 * New task ▸ Schedule ▸ Overlap policy.
 *
 * `TaskCreate.overlapPolicy` (packages/shared/src/schemas.ts) has always taken
 * `'skip' | 'queue'`, defaulting to `'skip'` — but `ComposerView.tsx` hard-coded
 * `overlapPolicy: 'skip'` in its `submit()` payload, so `'queue'` was reachable
 * only through the API, never through the app. This file closes that gap, the
 * same shape of gap `composer-webhook-url.test.tsx` closed for the webhook URL
 * field.
 *
 * Overlap policy only means anything for a RECURRING schedule — a one-off or
 * ASAP booking never has a previous occurrence still running to collide with
 * — so the control lives inside the Recurring tab of the Schedule section, not
 * beside the schedule-type picker itself, and is asserted absent under
 * One-off/ASAP rather than merely untested there.
 *
 * jsdom + `createRoot` through `renderComponent`, driving the real Radix
 * Select through `test/helpers/radix.ts` (the same helper `quiet-hours-card`
 * and `composer-interval-schedule` already prove works in this suite).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposerView from '../src/components/ComposerView';
import { renderComponent, waitForElement, waitFor } from './helpers/dom';
import { pickOption } from './helpers/radix';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Every route the composer touches once it opens the Recurring tab. */
function stub(calls: Call[]): (url: unknown, init?: RequestInit) => Promise<Response> {
  return async (url: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const path = call.url.split('?')[0];
    if (path === '/profiles' || path === '/providers') return json([]);
    if (path === '/byok') return json({ configs: [] });
    // NextRunsPanel previews the rule as soon as Recurring is open — a
    // five-run answer keeps it out of an error state no test here reads.
    if (path === '/schedule/preview' && init?.method === 'POST') {
      return json({ runs: [1, 2, 3, 4, 5].map((n) => Date.UTC(2026, 8, 8, 9, 0) + n * 86_400_000), tz: 'UTC', count: 5 });
    }
    if (path === '/tasks' && init?.method === 'POST') return json({ id: 'task-1' }, 201);
    return json({});
  };
}

function type(el: Element | null, value: string): void {
  expect(el, 'field missing from the DOM').not.toBeNull();
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el!.dispatchEvent(new Event('input', { bubbles: true }));
}

function click(el: Element | null): void {
  expect(el, 'control missing from the DOM').not.toBeNull();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const buttonByText = (scope: Element, label: string): HTMLButtonElement | null =>
  ([...scope.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label) ?? null) as HTMLButtonElement | null;

const tabByLabel = (scope: Element, label: string): HTMLButtonElement | null =>
  ([...scope.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((b) => (b.textContent ?? '').trim() === label) ?? null);

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('New task ▸ Schedule ▸ Overlap policy', () => {
  it('is absent under One-off (the default tab) — nothing to collide with on a single fire', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(stub(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');

    expect(container.querySelector('[data-testid="composer-overlap-policy"]')).toBeNull();
  });

  it('is absent under ASAP too', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(stub(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');
    click(tabByLabel(container, 'ASAP'));

    expect(container.querySelector('[data-testid="composer-overlap-policy"]')).toBeNull();
  });

  it('appears under Recurring, defaulting to Skip', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(stub(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');
    click(tabByLabel(container, 'Recurring'));

    const trigger = await waitForElement(container, '[data-testid="composer-overlap-policy"]');
    expect(trigger.textContent).toContain('Skip');
  });

  it('leaving it at Skip books exactly what the composer always booked', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(stub(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');
    type(container.querySelector('#c-prompt'), 'Nightly digest.');
    click(tabByLabel(container, 'Recurring'));
    await waitForElement(container, '[data-testid="composer-overlap-policy"]');
    click(buttonByText(container, 'Book it'));

    const created = await waitFor(
      () => calls.find((c) => c.method === 'POST' && c.url === '/tasks'),
      'POST /tasks',
      { describe: () => JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)) },
    );
    expect((created.body as { overlapPolicy: string }).overlapPolicy).toBe('skip');
  });

  it('picking Queue reaches POST /tasks as overlapPolicy: "queue"', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(stub(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');
    type(container.querySelector('#c-prompt'), 'Nightly digest.');
    click(tabByLabel(container, 'Recurring'));
    const trigger = await waitForElement(container, '[data-testid="composer-overlap-policy"]');
    await pickOption(trigger, 'Queue — book it anyway; same-repo runs take turns, a task with no repo just waits for a free slot');
    await waitFor(() => (trigger.textContent ?? '').includes('Queue'), 'the trigger to show the new selection');

    click(buttonByText(container, 'Book it'));
    const created = await waitFor(
      () => calls.find((c) => c.method === 'POST' && c.url === '/tasks'),
      'POST /tasks',
      { describe: () => JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)) },
    );
    expect((created.body as { overlapPolicy: string }).overlapPolicy).toBe('queue');
  });

  it('picking Queue under Recurring, then switching to One-off, still books "skip" — no leaked value', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(stub(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');
    type(container.querySelector('#c-prompt'), 'Nightly digest.');
    click(tabByLabel(container, 'Recurring'));
    const trigger = await waitForElement(container, '[data-testid="composer-overlap-policy"]');
    await pickOption(trigger, 'Queue — book it anyway; same-repo runs take turns, a task with no repo just waits for a free slot');
    await waitFor(() => (trigger.textContent ?? '').includes('Queue'), 'the trigger to show the new selection');

    click(tabByLabel(container, 'One-off'));
    await waitFor(
      () => container.querySelector('[data-testid="composer-overlap-policy"]') === null,
      'the overlap-policy control to disappear under One-off',
    );

    click(buttonByText(container, 'Book it'));
    const created = await waitFor(
      () => calls.find((c) => c.method === 'POST' && c.url === '/tasks'),
      'POST /tasks',
      { describe: () => JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)) },
    );
    expect((created.body as { overlapPolicy: string }).overlapPolicy).toBe('skip');
  });
});
