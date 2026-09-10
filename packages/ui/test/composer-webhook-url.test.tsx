/**
 * T1-10: the composer half of "an outbound webhook's URL gets a screen".
 *
 * `DeliveryConfig.webhook` (packages/shared/src/schemas.ts) and
 * `selectedChannels()` reading `cfg.webhook.url` (delivery-dispatch.ts) have
 * both worked since T-211/ADR-018 — proven end to end by
 * `delivery-channels.test.ts` and, at the `TaskCreate` boundary the composer
 * actually writes through, by `packages/daemon/test/webhook-delivery-schema.test.ts`.
 * The only gap was the screen: `ComposerView.tsx` had a Telegram chat id field
 * and no webhook URL field, even though `POST /tasks` always accepted one —
 * the same shape of gap `delivery-channels-ui.test.tsx`'s "New task ▸ Slack
 * and email" describe block closed for Slack/email. This file is that block's
 * sibling for the generic webhook, kept in its own file (rather than appended
 * to that 26K shared one) so a concurrent lane touching delivery UI does not
 * collide with this one on the same file.
 *
 * The wholesale-replace hazard T1-8's `QuietHoursCard` discloses on screen
 * (`TaskRepo.patch` replaces `delivery_json` whole; `view()` never returns it
 * back, so a patch cannot merge) does NOT apply here. The composer's only
 * write is `POST /tasks` → `TaskRepo.create` — a fresh INSERT. There is no
 * existing task row for a create to clobber. The last test below proves that
 * structurally: the whole submit flow issues a POST and never a PATCH.
 *
 * jsdom + `createRoot` through `renderComponent`. Does not touch any of the
 * twelve F1–F12 feature suites `claims-honesty.test.ts` counts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposerView, { buildTaskDelivery } from '../src/components/ComposerView';
import { neverHappens, renderComponent, waitFor, waitForElement } from './helpers/dom';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Every route the composer touches before it can draw its form. */
function stub(calls: Call[]): (url: unknown, init?: RequestInit) => Promise<Response> {
  return async (url: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const path = call.url.split('?')[0];
    if (path === '/profiles' || path === '/providers' || path === '/byok') return json([]);
    return json({});
  };
}

/**
 * React tracks a controlled input/textarea's value on the node itself, so a
 * plain `el.value = x` bypasses React's setter and the `input` event is
 * deduped as "nothing changed." Same pattern `delivery-channels-ui.test.tsx`
 * and `quiet-hours-card.test.tsx` use, unified over both element types since
 * this file types into both a textarea (`#c-prompt`) and plain inputs.
 */
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

/** The button whose visible label is exactly `label`, within `scope`. */
function buttonByText(scope: Element, label: string): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label) ?? null
  ) as HTMLButtonElement | null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('buildTaskDelivery — the pure builder the composer submits (webhookUrlRaw)', () => {
  it('attaches webhook.url only when a URL is entered', () => {
    expect(buildTaskDelivery('', false, '', { webhookUrlRaw: 'https://hooks.example.com/clockwork' })).toEqual({
      osNotify: true,
      webhook: { url: 'https://hooks.example.com/clockwork' },
    });
  });

  it('leaves webhook absent when the field is blank, whitespace, or omitted', () => {
    expect(buildTaskDelivery('', false, '', { webhookUrlRaw: '   ' })).toEqual({ osNotify: true });
    expect(buildTaskDelivery('', false, '', {})).toEqual({ osNotify: true });
    expect(buildTaskDelivery('', false, '')).toEqual({ osNotify: true });
  });

  it('composes alongside Telegram, Slack and email untouched', () => {
    const out = buildTaskDelivery('555', false, '', {
      slack: true,
      emailToRaw: 'a@example.com',
      webhookUrlRaw: 'https://hooks.example.com/clockwork',
    });
    expect(out).toEqual({
      osNotify: true,
      telegram: { chatId: '555' },
      slack: { enabled: true },
      email: { to: ['a@example.com'] },
      webhook: { url: 'https://hooks.example.com/clockwork' },
    });
  });
});

describe('New task ▸ Webhook URL — the per-task field reaches POST /tasks', () => {
  it('offers a field beside the Telegram chat id (the gap this closes)', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(stub(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');

    expect(container.querySelector('#c-telegram-chat'), 'the Telegram chat id field').not.toBeNull();
    const webhookField = container.querySelector('#c-webhook-url');
    expect(webhookField, 'no per-task webhook URL field in the composer').not.toBeNull();
    // "beside" — same section as the Telegram chat id, not a section of its own.
    const telegramSection = container.querySelector('#c-telegram-chat')!.closest('section');
    expect(telegramSection).not.toBeNull();
    expect(telegramSection!.contains(webhookField)).toBe(true);
  });

  it('a URL entered arrives in the task the daemon stores, at delivery.webhook.url', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(stub(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');

    type(container.querySelector('#c-prompt'), 'Ship an alert.');
    type(container.querySelector('#c-webhook-url'), 'https://hooks.example.com/clockwork');
    click(buttonByText(container, 'Book it'));

    const created = await waitFor(
      () => calls.find((c) => c.method === 'POST' && c.url === '/tasks'),
      'POST /tasks',
      { describe: () => JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)) },
    );
    const delivery = (created.body as { delivery: Record<string, unknown> }).delivery;
    expect(delivery.webhook).toEqual({ url: 'https://hooks.example.com/clockwork' });
  });

  it('refuses to book with a URL that is not absolute, before any request is sent', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(stub(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');

    type(container.querySelector('#c-prompt'), 'Ship an alert.');
    type(container.querySelector('#c-webhook-url'), 'not-a-url');
    click(buttonByText(container, 'Book it'));

    await waitForElement(container, '[data-testid="composer-error"]');
    expect(container.querySelector('[data-testid="composer-error"]')!.textContent).toContain('Webhook URL');
    await neverHappens(
      () => calls.some((c) => c.method === 'POST' && c.url === '/tasks'),
      'a POST with an invalid webhook URL',
      { describe: () => JSON.stringify(calls) },
    );
  });

  it('leaving it blank books exactly the delivery object that shipped before', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(stub(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');

    type(container.querySelector('#c-prompt'), 'Ship an alert.');
    click(buttonByText(container, 'Book it'));

    const created = await waitFor(
      () => calls.find((c) => c.method === 'POST' && c.url === '/tasks'),
      'POST /tasks',
      { describe: () => JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)) },
    );
    expect((created.body as { delivery: unknown }).delivery).toEqual({ osNotify: true });
  });

  it('never PATCHes an existing task — the wholesale-replace hazard does not apply, because this write only ever creates', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(stub(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');

    type(container.querySelector('#c-prompt'), 'Ship an alert.');
    type(container.querySelector('#c-webhook-url'), 'https://hooks.example.com/clockwork');
    click(buttonByText(container, 'Book it'));

    await waitFor(
      () => calls.some((c) => c.method === 'POST' && c.url === '/tasks'),
      'POST /tasks',
      { describe: () => JSON.stringify(calls) },
    );
    expect(
      calls.some((c) => c.method === 'PATCH'),
      'the composer only ever creates a task; it must never patch an existing one’s delivery',
    ).toBe(false);
  });
});
