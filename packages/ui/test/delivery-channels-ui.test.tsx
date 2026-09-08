/**
 * The screens for the two delivery channels that landed with no screen:
 * Slack (Block Kit over an incoming webhook) and email (SMTP). Both adapters
 * shipped in `packages/daemon/src/delivery.ts` and neither was reachable from
 * the app, which is the failure this repo already paid for once — a capability
 * that exists in the daemon and nowhere a user can touch is not shipped.
 *
 * What these tests hold, and why each one is here rather than being obvious:
 *
 *   1. **A saved credential is never rendered back.** The Slack webhook URL
 *      and the SMTP URL are bearer credentials — the URL alone posts to that
 *      channel, and the SMTP URL carries the mailbox password. The input is
 *      write-only and only the daemon's mask is ever shown, so the assertions
 *      are on the DOM as a whole ("the password appears nowhere"), not on one
 *      element.
 *   2. **A failed self-test is reported as a failure.** The point of "send
 *      test" is to learn what the provider said. Rendering Slack's
 *      `invalid_token` in a green banner is the same bug as swallowing it, so
 *      the class of the banner is asserted alongside the text.
 *   3. **A blank From does not clear a stored one.** Saving a new relay URL
 *      with the From field left empty must omit the key, not send `null` —
 *      otherwise every URL edit silently drops the sender address.
 *   4. **An older daemon does not blank the page.** `GET /delivery-config`
 *      from a pre-T-310 daemon has no `slack`/`smtp` members, and a bare
 *      `data.slack.configured` would throw inside render and take all of
 *      Settings with it. The version-skew trap this repo already guards for
 *      `/health` applies here too.
 *
 * jsdom + `createRoot` through `renderComponent`, the same approach as
 * `workforce-settings.test.tsx`, and every wait is on a condition rather than
 * a duration (see `test/helpers/dom.tsx` for why).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeliveryCard } from '../src/components/SettingsView';
// Statically imported, the pattern composer-schedule-hint.test.tsx:14-25
// records: ComposerView drags Radix Select/Switch/Dialog, react-day-picker and
// the lucide barrel through the transform, and an `await import()` inside a
// test body pays that under the per-test timeout instead of during collection.
import ComposerView from '../src/components/ComposerView';
import { neverHappens, renderComponent, waitFor, waitForElement, waitForText } from './helpers/dom';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SETTINGS = readFileSync(resolve(SRC, 'components', 'SettingsView.tsx'), 'utf8');
const COMPOSER = readFileSync(resolve(SRC, 'components', 'ComposerView.tsx'), 'utf8');

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Routes only what this card is allowed to ask for. An unrouted request
 * throws rather than resolving empty — a silently swallowed fetch would let a
 * blank card pass as a green test.
 */
function stubFetch(routes: Array<[RegExp, (call: Call) => Response | Promise<Response>]>): { calls: Call[] } {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    for (const [pattern, handler] of routes) {
      if (pattern.test(call.url)) return handler(call);
    }
    throw new Error(`unexpected request: ${call.method} ${call.url}`);
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

type Status = Record<string, unknown>;

const UNCONFIGURED: Status = {
  telegram: { configured: false, botTokenMasked: null },
  webhook: { configured: false },
  slack: { configured: false, webhookUrlMasked: null },
  smtp: { configured: false, endpointMasked: null, from: null },
};

const SLACK_MASK = 'hooks.slack.com/…/Zz…rQq';
const SMTP_MASK = 'smtp://clockwork@example.com@smtp.example.com:2525';
const SMTP_PASSWORD = 'sup3r-s3cret';

const CONFIGURED: Status = {
  telegram: { configured: false, botTokenMasked: null },
  webhook: { configured: false },
  slack: { configured: true, webhookUrlMasked: SLACK_MASK },
  smtp: { configured: true, endpointMasked: SMTP_MASK, from: 'clockwork@example.com' },
};

/** Mounts the card with `GET /delivery-config` answering `status`. */
async function mount(
  status: Status,
  extra: Array<[RegExp, (call: Call) => Response | Promise<Response>]> = [],
): Promise<{ container: HTMLDivElement; calls: Call[] }> {
  const { calls } = stubFetch([...extra, [/^\/delivery-config$/, () => json(status)]]);
  const container = await renderComponent(<DeliveryCard version={1} />);
  await waitForElement(container, '[data-testid="slack-webhook-input"]');
  return { container, calls };
}

/**
 * React tracks a controlled input's value on the NODE (it installs its own
 * `value` accessor per element), so `el.value = x` writes through React's own
 * setter, updates the tracked value, and the `input` event that follows is
 * deduped as "nothing changed" — the handler never runs. Reaching for the
 * prototype's native setter is what actually gets past it. Same helper as
 * `workforce-settings.test.tsx`.
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

/** The button whose visible label is exactly `label`, within `scope`. */
function buttonByText(scope: Element, label: string): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label) ?? null
  ) as HTMLButtonElement | null;
}

/** The first PUT the card issued, once it has been issued. */
function waitForPut(calls: Call[]): Promise<Call> {
  return waitFor(() => calls.find((c) => c.method === 'PUT'), 'a PUT /delivery-config', {
    describe: () => JSON.stringify(calls),
  });
}

/** The credential row that holds the control with this test id. */
function rowFor(container: HTMLElement, testid: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testid}"]`);
  expect(el, `no element with data-testid=${testid}`).not.toBeNull();
  // `.cred-row` since the delivery rows moved off `.tasklist-row`: that row
  // was flex-centred, which put SMTP's Save/Clear beside the helper text.
  return el!.closest('.cred-row') as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 1. Slack
// ---------------------------------------------------------------------------

describe('Settings ▸ Notifications & delivery — Slack incoming webhook', () => {
  it('offers a field for the webhook URL at all (the gap this closes)', async () => {
    const { container } = await mount(UNCONFIGURED);
    const input = container.querySelector<HTMLInputElement>('[data-testid="slack-webhook-input"]')!;
    expect(input.type).toBe('password'); // a credential, not a setting
    expect(container.textContent).toContain('Slack incoming webhook');
    expect(container.textContent).toContain('Not configured');
  });

  it('shows the daemon mask once configured and never a whole path segment', async () => {
    const { container } = await mount(CONFIGURED);
    await waitForText(container, `Configured — ${SLACK_MASK}`);
    const input = container.querySelector<HTMLInputElement>('[data-testid="slack-webhook-input"]')!;
    // Write-only: the field is empty and only hints at what is stored.
    expect(input.value).toBe('');
    expect(input.placeholder).toBe(SLACK_MASK);
    // Nothing in the card may read as a usable webhook URL.
    expect(container.innerHTML).not.toContain('https://hooks.slack.com/services/T');
  });

  it('Save PUTs slackWebhookUrl alone — no sibling credential is touched', async () => {
    const { container, calls } = await mount(UNCONFIGURED, [
      [/^\/delivery-config$/, (c) => json(c.method === 'PUT' ? CONFIGURED : UNCONFIGURED)],
    ]);
    const url = 'https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/ZzYyXxWwVvUuTtSsRrQq';
    type(container.querySelector('[data-testid="slack-webhook-input"]'), `  ${url}  `);
    click(container.querySelector('[data-testid="slack-webhook-save"]'));
    const put = await waitForPut(calls);
    expect(put.body).toEqual({ slackWebhookUrl: url }); // trimmed, and nothing else
    await waitForText(container, 'Slack webhook saved.');
  });

  it('will not send a test before a webhook is stored', async () => {
    const { container, calls } = await mount(UNCONFIGURED);
    const button = container.querySelector<HTMLButtonElement>('[data-testid="slack-test-send"]')!;
    expect(button.disabled).toBe(true);
    click(button);
    await neverHappens(
      () => calls.some((c) => c.url.includes('test-slack')),
      'a test-send with no webhook configured',
      { describe: () => JSON.stringify(calls) },
    );
  });

  it("reports Slack's own refusal as a failure, in an alert, not a success banner", async () => {
    const { container } = await mount(CONFIGURED, [
      [/^\/delivery-config\/test-slack$/, () => json({ ok: false, error: 'invalid_token' })],
    ]);
    click(container.querySelector('[data-testid="slack-test-send"]'));
    const result = await waitForElement(container, '[data-testid="slack-result"]');
    expect(result.textContent).toBe('invalid_token'); // Slack's word, not ours
    expect(result.className).toBe('error-banner');
    expect(result.getAttribute('role')).toBe('alert');
  });

  it('reports a delivered test as a success', async () => {
    const { container } = await mount(CONFIGURED, [
      [/^\/delivery-config\/test-slack$/, () => json({ ok: true })],
    ]);
    click(container.querySelector('[data-testid="slack-test-send"]'));
    const result = await waitForElement(container, '[data-testid="slack-result"]');
    expect(result.textContent).toContain('check the Slack channel');
    expect(result.className).toBe('ok-banner');
  });

  it('reports an unreachable daemon rather than throwing out of the click handler', async () => {
    const { container } = await mount(CONFIGURED, [
      [/^\/delivery-config\/test-slack$/, () => json({ error: 'boom' }, 500)],
    ]);
    click(container.querySelector('[data-testid="slack-test-send"]'));
    const result = await waitForElement(container, '[data-testid="slack-result"]');
    expect(result.className).toBe('error-banner');
    expect(result.textContent).toContain('boom');
  });

  it('Clear asks first, then PUTs null', async () => {
    const { container, calls } = await mount(CONFIGURED, [
      [/^\/delivery-config$/, (c) => json(c.method === 'PUT' ? UNCONFIGURED : CONFIGURED)],
    ]);
    const row = rowFor(container, 'slack-webhook-input');

    vi.stubGlobal('confirm', () => false);
    click(buttonByText(row, 'Clear'));
    await neverHappens(() => calls.some((c) => c.method === 'PUT'), 'a PUT after a declined confirm', {
      describe: () => JSON.stringify(calls),
    });

    vi.stubGlobal('confirm', () => true);
    click(buttonByText(row, 'Clear'));
    const put = await waitForPut(calls);
    expect(put.body).toEqual({ slackWebhookUrl: null });
  });
});

// ---------------------------------------------------------------------------
// 2. SMTP / email
// ---------------------------------------------------------------------------

describe('Settings ▸ Notifications & delivery — SMTP relay', () => {
  it('offers the relay URL and the From address, and masks the stored relay', async () => {
    const { container } = await mount(CONFIGURED);
    await waitForText(container, `Configured — ${SMTP_MASK}`);
    const url = container.querySelector<HTMLInputElement>('[data-testid="smtp-url-input"]')!;
    expect(url.type).toBe('password');
    expect(url.value).toBe('');
    expect(url.placeholder).toBe(SMTP_MASK);
    // The relay password lives in that URL and must never reach the DOM.
    expect(container.innerHTML).not.toContain(SMTP_PASSWORD);
    expect(container.textContent).toContain('Sending as clockwork@example.com');
  });

  it('a blank From on save omits the key — it does not clear the stored one', async () => {
    const { container, calls } = await mount(CONFIGURED, [
      [/^\/delivery-config$/, (c) => json(c.method === 'PUT' ? CONFIGURED : CONFIGURED)],
    ]);
    type(container.querySelector('[data-testid="smtp-url-input"]'), `smtp://user:${SMTP_PASSWORD}@relay.example.com:587`);
    click(container.querySelector('[data-testid="smtp-save"]'));
    const put = await waitForPut(calls);
    expect(put.body).toEqual({ smtpUrl: `smtp://user:${SMTP_PASSWORD}@relay.example.com:587` });
    expect(Object.keys(put.body as object)).not.toContain('smtpFrom');
  });

  it('a typed From is sent with the relay', async () => {
    const { container, calls } = await mount(UNCONFIGURED, [
      [/^\/delivery-config$/, (c) => json(c.method === 'PUT' ? CONFIGURED : UNCONFIGURED)],
    ]);
    type(container.querySelector('[data-testid="smtp-url-input"]'), 'smtp://relay.example.com:587');
    type(container.querySelector('[data-testid="smtp-from-input"]'), '  clockwork@example.com ');
    click(container.querySelector('[data-testid="smtp-save"]'));
    const put = await waitForPut(calls);
    expect(put.body).toEqual({ smtpUrl: 'smtp://relay.example.com:587', smtpFrom: 'clockwork@example.com' });
  });

  it('changing only the From address does not require re-pasting the relay URL', async () => {
    const { container, calls } = await mount(CONFIGURED, [
      [/^\/delivery-config$/, () => json(CONFIGURED)],
    ]);
    const save = container.querySelector<HTMLButtonElement>('[data-testid="smtp-save"]')!;
    // Nothing typed: there is nothing to save.
    expect(save.disabled).toBe(true);
    type(container.querySelector('[data-testid="smtp-from-input"]'), 'reports@example.com');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="smtp-save"]')!.disabled).toBe(false);
    click(container.querySelector('[data-testid="smtp-save"]'));
    const put = await waitForPut(calls);
    // smtpUrl must be ABSENT, not ''. Sending an empty string would fail the
    // daemon's parse (422) and, if it ever stopped failing, would clear the
    // relay while the user was only editing the sender.
    expect(put.body).toEqual({ smtpFrom: 'reports@example.com' });
  });

  it('will not send a test email before a relay is stored', async () => {
    const { container } = await mount(UNCONFIGURED);
    const to = container.querySelector<HTMLInputElement>('[data-testid="smtp-test-to"]')!;
    expect(to.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="smtp-test-send"]')!.disabled).toBe(true);
  });

  it("reports the relay's own rejection text as a failure", async () => {
    const { container, calls } = await mount(CONFIGURED, [
      [/^\/delivery-config\/test-smtp$/, () => json({ ok: false, error: 'smtp: 550 5.1.1 Recipient address rejected' })],
    ]);
    type(container.querySelector('[data-testid="smtp-test-to"]'), 'dana@example.com');
    click(container.querySelector('[data-testid="smtp-test-send"]'));
    const result = await waitForElement(container, '[data-testid="smtp-result"]');
    expect(result.textContent).toContain('550 5.1.1 Recipient address rejected');
    expect(result.className).toBe('error-banner');
    expect(result.getAttribute('role')).toBe('alert');
    const test = calls.find((c) => c.url.includes('test-smtp'))!;
    expect(test.body).toEqual({ to: 'dana@example.com' });
  });

  it('reports a delivered test email as a success', async () => {
    const { container } = await mount(CONFIGURED, [
      [/^\/delivery-config\/test-smtp$/, () => json({ ok: true })],
    ]);
    type(container.querySelector('[data-testid="smtp-test-to"]'), 'dana@example.com');
    click(container.querySelector('[data-testid="smtp-test-send"]'));
    const result = await waitForElement(container, '[data-testid="smtp-result"]');
    expect(result.textContent).toContain('check the inbox');
    expect(result.className).toBe('ok-banner');
  });

  it('Clear drops the relay and the From address together', async () => {
    const { container, calls } = await mount(CONFIGURED, [
      [/^\/delivery-config$/, (c) => json(c.method === 'PUT' ? UNCONFIGURED : CONFIGURED)],
    ]);
    vi.stubGlobal('confirm', () => true);
    click(buttonByText(rowFor(container, 'smtp-url-input'), 'Clear'));
    const put = await waitForPut(calls);
    // A relay with no URL cannot use a From address, so both go at once.
    expect(put.body).toEqual({ smtpUrl: null, smtpFrom: null });
  });
});

// ---------------------------------------------------------------------------
// 3. Version skew — an older daemon must not blank the card
// ---------------------------------------------------------------------------

describe('a pre-T-310 daemon still renders the card', () => {
  it('renders Telegram and the two new rows when GET /delivery-config omits slack/smtp', async () => {
    // Exactly the body the daemon returned before this wave: two members.
    const { container } = await mount({
      telegram: { configured: true, botTokenMasked: '12345678:AAE…xQ7' },
      webhook: { configured: false },
    });
    // Rendered, not thrown: the card is present and reports both new channels
    // as unconfigured rather than taking Settings down with a TypeError.
    expect(container.textContent).toContain('Telegram bot token');
    expect(container.textContent).toContain('Slack incoming webhook');
    expect(container.textContent).toContain('SMTP relay');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="slack-test-send"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="smtp-test-send"]')!.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. The composer's per-task fields, driven end to end
// ---------------------------------------------------------------------------

describe('New task ▸ Slack and email — the per-task fields reach POST /tasks', () => {
  /** Every route the composer touches before it can draw its form. */
  function composerRoutes(calls: Call[]): (url: unknown, init?: RequestInit) => Promise<Response> {
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

  it('a Slack opt-in and two recipients arrive in the task the daemon stores', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(composerRoutes(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');

    // The two controls exist on screen — this is the gap being closed.
    const slackSwitch = container.querySelector('#c-slack');
    const emailTo = container.querySelector('#c-email-to');
    expect(slackSwitch, 'no per-task Slack control in the composer').not.toBeNull();
    expect(emailTo, 'no per-task email recipients field in the composer').not.toBeNull();

    // What the reader actually sees. The source-level guard further down pins
    // these strings in the file; this pins that they reach the DOM — and that
    // the decision sentence arrives as one sentence, not as the two fragments
    // its wrapped source line would produce if the JSX ever grew a tag between
    // them.
    expect(container.textContent).toContain('Slack and email (optional)');
    expect(container.textContent).toContain(
      'Approving or denying still happens in this app or in Telegram.',
    );

    const prompt = container.querySelector<HTMLTextAreaElement>('#c-prompt')!;
    const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    textareaSetter.call(prompt, 'Audit the dependency tree.');
    prompt.dispatchEvent(new Event('input', { bubbles: true }));

    click(slackSwitch);
    // MEASURED, not assumed: a Radix Switch (@radix-ui/react-switch 1.3.7)
    // does not settle inside the discrete-event flush that `helpers/dom.tsx`
    // documents for a plain `onChange` — a synchronous `data-state` read right
    // after the click still says "unchecked", with `.click()` and a dispatched
    // MouseEvent alike. Where inside Radix/React the deferral sits does not
    // matter; waiting for the control to report its own state is the fix, and
    // skipping the wait submits the form from before the click.
    await waitFor(
      () => container.querySelector('#c-slack')!.getAttribute('data-state') === 'checked' || undefined,
      'the Slack switch to report itself checked',
      { describe: () => `data-state = ${container.querySelector('#c-slack')!.getAttribute('data-state')}` },
    );
    type(emailTo, 'dana@example.com, marcus@example.com');
    click(buttonByText(container, 'Book it'));

    const created = await waitFor(
      () => calls.find((c) => c.method === 'POST' && c.url === '/tasks'),
      'POST /tasks',
      { describe: () => JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)) },
    );
    const delivery = (created.body as { delivery: Record<string, unknown> }).delivery;
    expect(delivery.slack).toEqual({ enabled: true });
    expect(delivery.email).toEqual({ to: ['dana@example.com', 'marcus@example.com'] });
    // The credentials stay in Settings: a task row reaches SQLite, so a
    // webhook URL or an SMTP password in here would be a credential at rest
    // in the wrong place.
    expect(JSON.stringify(delivery)).not.toMatch(/hooks\.slack\.com|smtp:\/\//i);
  });

  it('leaving both alone books exactly the delivery object that shipped before', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(composerRoutes(calls)));
    const container = await renderComponent(<ComposerView onDone={() => {}} prefill={null} />);
    await waitForElement(container, '#c-prompt');

    const prompt = container.querySelector<HTMLTextAreaElement>('#c-prompt')!;
    const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    textareaSetter.call(prompt, 'Audit the dependency tree.');
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    click(buttonByText(container, 'Book it'));

    const created = await waitFor(
      () => calls.find((c) => c.method === 'POST' && c.url === '/tasks'),
      'POST /tasks',
      { describe: () => JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)) },
    );
    expect((created.body as { delivery: unknown }).delivery).toEqual({ osNotify: true });
  });
});

// ---------------------------------------------------------------------------
// 5. What the copy is allowed to claim
// ---------------------------------------------------------------------------

describe('the copy claims what these channels do — no more, and no less', () => {
  // These three assertions were the mirror image until `notifyApprovalRequest`
  // (run-manager.ts) gave up its private telegram/webhook-only fan-out for the
  // shared `deliverApproval`. While it kept that copy, "approvals are not sent
  // here" was the honest line and the guard held it. It is now the false one,
  // so it is gone — a guard on a sentence the product has outgrown protects
  // nothing.
  //
  // The overclaim to guard moved rather than disappeared, because the two
  // halves of an approval split across the channels: the REQUEST now reaches
  // Slack and email, the DECISION still does not. Nothing on these screens may
  // suggest you can approve or deny from a Slack message or a mail client —
  // `formatApprovalText` sends every reader to the Inbox, and only Telegram
  // carries buttons wired to a poller.
  it('Settings says Slack and email are told when a run is waiting', () => {
    expect(SETTINGS).toContain('and a notice when a run is waiting for your OK');
    // and no longer claims the opposite alongside it
    expect(SETTINGS).not.toContain('They do not carry the approval request itself');
  });

  it('Settings names the only two places a decision can be made', () => {
    expect(SETTINGS).toContain('You answer in this app or from Telegram');
  });

  it('both Settings sentences reach the DOM whole, not as wrapped fragments', async () => {
    const { container } = await mount(UNCONFIGURED);
    const text = container.textContent ?? '';
    expect(text).toContain('and a notice when a run is waiting for your OK');
    expect(text).toContain('You answer in this app or from Telegram');
    expect(text).not.toContain('They do not carry the approval request itself');
  });

  it('the composer heads its Slack/email fields for both message types, and promises no decision from them', () => {
    expect(COMPOSER).toContain('Slack and email (optional)');
    expect(COMPOSER).toContain('Approving or denying still happens in this app or in Telegram');
    expect(COMPOSER).not.toContain('Run reports (optional)');
    expect(COMPOSER).not.toContain('Approvals are not sent here');
    // The Telegram section keeps its own approvals heading — it is still the
    // only channel a decision can be made FROM.
    expect(COMPOSER).toContain('Telegram approvals (optional)');
  });

  it('nothing in the UI offers a WhatsApp channel — the gateway is the generic webhook (ADR-018)', () => {
    for (const [name, src] of [
      ['SettingsView.tsx', SETTINGS],
      ['ComposerView.tsx', COMPOSER],
    ] as const) {
      expect(src.toLowerCase(), `${name} must not advertise a WhatsApp adapter`).not.toContain('whatsapp');
    }
  });
});

