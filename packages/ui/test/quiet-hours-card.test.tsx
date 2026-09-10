/**
 * T1-8: the UI half of "quiet hours gets a setter".
 *
 * `QuietHoursCard` (`SettingsView.tsx`) is the first screen that can write
 * `delivery.quietHours` on a task. This file proves the save button's PATCH
 * body carries exactly the shape `DeliveryConfig`/`TaskPatch` accept and
 * `scheduler.ts:readQuietHours` reads back off `delivery_json` — the join
 * between this file and `quiet-hours-schema.test.ts` (daemon side, which
 * parses that same literal shape through the real schema) is the matching
 * literal object, the same join every other per-task delivery field already
 * gets in `delivery-channels-ui.test.tsx` (Slack/email are asserted as UI
 * literals there too, never cross-checked against the schema from the UI
 * side — `packages/ui` imports nothing from `@clockwork/shared`, by design;
 * see `schedule-rule-emitter.test.ts`'s header for why).
 *
 * Mounts `QuietHoursCard` alone, the same reason `DeliveryCard` is exported
 * and driven the same way in `delivery-channels-ui.test.tsx`: mounting all of
 * `SettingsView` would route a dozen unrelated fetches for one Save click.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuietHoursCard } from '../src/components/SettingsView';
import { renderComponent, waitForElement, waitForText, neverHappens, waitFor } from './helpers/dom';
import { pickOption } from './helpers/radix';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TASKS = [
  { id: 't-1', name: 'Nightly repo sweep' },
  { id: 't-2', name: 'Weekly digest' },
];

/** Routes only what this card is allowed to ask for — an unrouted request throws. */
function stubFetch(): { calls: Call[] } {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const path = call.url.split('?')[0];
    if (path === '/tasks' && call.method === 'GET') return json(TASKS);
    if (path.startsWith('/tasks/') && call.method === 'PATCH') return json({ id: path.split('/')[2] });
    throw new Error(`unexpected request: ${call.method} ${call.url}`);
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

/**
 * React tracks a controlled input's value on the node itself, so a plain
 * `el.value = x` bypasses React's own setter and the following `input` event
 * is deduped as "nothing changed." Same helper as `delivery-channels-ui.test.tsx`
 * and `workforce-settings.test.tsx`.
 */
function type(input: Element | null, value: string): void {
  expect(input, 'field missing from the DOM').not.toBeNull();
  const el = input as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function click(el: Element | null): void {
  expect(el, 'control missing from the DOM').not.toBeNull();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function mount(): Promise<{ container: HTMLDivElement; calls: Call[] }> {
  const { calls } = stubFetch();
  const container = await renderComponent(<QuietHoursCard version={1} />);
  await waitForElement(container, '[data-testid="quiet-hours-task-select"]');
  return { container, calls };
}

/** The first PATCH the card issued, once it has been issued. */
function waitForPatch(calls: Call[]): Promise<Call> {
  return waitFor(() => calls.find((c) => c.method === 'PATCH'), 'a PATCH /tasks/:id', {
    describe: () => JSON.stringify(calls),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Settings ▸ Quiet hours — offers the fields at all (the gap this closes)', () => {
  it('renders a task picker and the two hour fields', async () => {
    const { container } = await mount();
    expect(container.querySelector('[data-testid="quiet-hours-start"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quiet-hours-end"]')).not.toBeNull();
    expect(container.textContent).toContain('Quiet from');
  });

  it('discloses that Save replaces the task delivery config, and that the fields cannot be pre-filled', async () => {
    const { container } = await mount();
    // The daemon's own GET /tasks projection withholds `delivery` (api.ts's
    // `view()`), so the card cannot show what a task's quiet hours already
    // are — it must say so rather than imply the blank fields mean "off".
    expect(container.textContent).toContain('does not send a task');
    expect((container.textContent ?? '').toLowerCase()).toContain('replaces this task');
  });
});

describe('Settings ▸ Quiet hours — Save reaches the config the scheduler reads', () => {
  it('PATCHes /tasks/:id with exactly { delivery: { quietHours } } for the picked task', async () => {
    const { container, calls } = await mount();

    await pickTask(container, 'Nightly repo sweep');
    type(container.querySelector('[data-testid="quiet-hours-start"]'), '23');
    type(container.querySelector('[data-testid="quiet-hours-end"]'), '7');
    click(container.querySelector('[data-testid="quiet-hours-save"]'));

    const patch = await waitForPatch(calls);
    expect(patch.url).toBe('/tasks/t-1');
    // The exact shape `DeliveryConfig`/`TaskPatch` accept
    // (quiet-hours-schema.test.ts parses this same literal) and the exact
    // shape `scheduler.ts:readQuietHours` reads back off `delivery_json`.
    expect(patch.body).toEqual({ delivery: { quietHours: { startHour: 23, endHour: 7 } } });
    await waitForText(container, 'Quiet hours saved.');
  });

  it('wraps midnight the same way the scheduler does — 23 start, 7 end is one window, not rejected', async () => {
    const { container, calls } = await mount();
    await pickTask(container, 'Weekly digest');
    type(container.querySelector('[data-testid="quiet-hours-start"]'), '23');
    type(container.querySelector('[data-testid="quiet-hours-end"]'), '7');
    click(container.querySelector('[data-testid="quiet-hours-save"]'));
    const patch = await waitForPatch(calls);
    expect(patch.url).toBe('/tasks/t-2');
    expect((patch.body as { delivery: { quietHours: { startHour: number; endHour: number } } }).delivery.quietHours).toEqual({
      startHour: 23,
      endHour: 7,
    });
  });
});

describe('Settings ▸ Quiet hours — refuses to save an incomplete or invalid form', () => {
  it('will not send a PATCH before a task is picked', async () => {
    const { container, calls } = await mount();
    type(container.querySelector('[data-testid="quiet-hours-start"]'), '23');
    type(container.querySelector('[data-testid="quiet-hours-end"]'), '7');
    const button = container.querySelector<HTMLButtonElement>('[data-testid="quiet-hours-save"]')!;
    expect(button.disabled).toBe(true);
    click(button);
    await neverHappens(() => calls.some((c) => c.method === 'PATCH'), 'a PATCH with no task picked', {
      describe: () => JSON.stringify(calls),
    });
  });

  it('will not send a PATCH with an hour outside 0–23', async () => {
    const { container, calls } = await mount();
    await pickTask(container, 'Nightly repo sweep');
    type(container.querySelector('[data-testid="quiet-hours-start"]'), '24');
    type(container.querySelector('[data-testid="quiet-hours-end"]'), '7');
    const button = container.querySelector<HTMLButtonElement>('[data-testid="quiet-hours-save"]')!;
    expect(button.disabled).toBe(true);
    click(button);
    await neverHappens(() => calls.some((c) => c.method === 'PATCH'), 'a PATCH with an out-of-range hour', {
      describe: () => JSON.stringify(calls),
    });
  });

  it('will not send a PATCH with a blank hour field', async () => {
    const { container, calls } = await mount();
    await pickTask(container, 'Nightly repo sweep');
    type(container.querySelector('[data-testid="quiet-hours-start"]'), '');
    type(container.querySelector('[data-testid="quiet-hours-end"]'), '7');
    const button = container.querySelector<HTMLButtonElement>('[data-testid="quiet-hours-save"]')!;
    expect(button.disabled).toBe(true);
    click(button);
    await neverHappens(() => calls.some((c) => c.method === 'PATCH'), 'a PATCH with a blank hour', {
      describe: () => JSON.stringify(calls),
    });
  });
});

/** Picks `label` from the card's Radix task Select. */
function pickTask(container: HTMLElement, label: string): Promise<void> {
  return pickOption(container.querySelector('[data-testid="quiet-hours-task-select"]'), label);
}
