/**
 * One-click PR screens (P0, PAT-only): the Settings GitHub card and the
 * Inbox Open PR button. Both are credential-adjacent, so the assertions are
 * the same shape as delivery-channels-ui.test.tsx's:
 *
 *   1. A saved PAT is never rendered back — assertions on the whole DOM,
 *      not one element.
 *   2. A refusal is shown as a failure with its reason, not swallowed.
 *   3. Created vs already-exists render differently (the duplicate path is
 *      the idempotency story; hiding it would teach retry-spam).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubCard } from '../src/components/SettingsView';
import { OpenPrAction, OPEN_PR_REASON_HINTS } from '../src/components/InboxView';
import { renderComponent, waitForElement, waitForText } from './helpers/dom';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * React tracks a controlled input's value on the node, so `el.value = x`
 * writes through React's own setter and the `input` event dedupes as
 * "nothing changed". The prototype's native setter gets past it — same
 * helper as delivery-channels-ui.test.tsx.
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

describe('GithubCard', () => {
  it('saves without ever rendering the value back, then validates to a login', async () => {
    let configured = false;
    const { calls } = stubFetch([
      [/^\/github\/status$/, () => json({ configured })],
      [
        /^\/github\/pat$/,
        (c) => {
          configured = (c.body as any)?.pat !== null;
          return json({ configured });
        },
      ],
      [/^\/github\/validate$/, () => json({ ok: true, login: 'octo' })],
    ]);
    const container = await renderComponent(<GithubCard version={1} />);
    await waitForElement(container, '[data-testid="github-pat-input"]');
    type(container.querySelector('[data-testid="github-pat-input"]'), 'ghp_test-secret-value');
    click(container.querySelector('[data-testid="github-pat-save"]'));
    await waitForText(container, 'GitHub PAT saved.');
    expect(container.innerHTML.includes('ghp_test-secret-value')).toBe(false);
    expect(calls.some((c) => c.url === '/github/pat' && (c.body as any)?.pat === 'ghp_test-secret-value')).toBe(true);
    click(container.querySelector('[data-testid="github-validate"]'));
    await waitForText(container, 'octo');
  });

  it('shows a refusal as a failure', async () => {
    stubFetch([
      [/^\/github\/status$/, () => json({ configured: true })],
      [/^\/github\/validate$/, () => json({ ok: false, error: 'auth_failed', message: 'GitHub rejected this PAT' })],
    ]);
    const container = await renderComponent(<GithubCard version={1} />);
    await waitForElement(container, '[data-testid="github-validate"]');
    click(container.querySelector('[data-testid="github-validate"]'));
    await waitForText(container, 'GitHub rejected this PAT');
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });
});

describe('OpenPrAction', () => {
  it('creates, then shows number + link + copy', async () => {
    const { calls } = stubFetch([
      [/^\/github\/status$/, () => json({ configured: true })],
      [/^\/runs\/run_1\/open-pr$/, () => json({ created: true, number: 12, url: 'https://github.com/o/r/pull/12' })],
    ]);
    const container = await renderComponent(<OpenPrAction runId="run_1" />);
    await waitForElement(container, '[data-testid="report-action-open-pr-button"]');
    click(container.querySelector('[data-testid="report-action-open-pr-button"]'));
    await waitForElement(container, '[data-testid="report-action-open-pr-confirm-button"]');
    click(container.querySelector('[data-testid="report-action-open-pr-confirm-button"]'));
    await waitForText(container, 'PR #12 created');
    const link = container.querySelector('[data-testid="report-action-open-pr-ok"] a') as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/o/r/pull/12');
    expect(calls.some((c) => c.url === '/runs/run_1/open-pr')).toBe(true);
  });

  it('renders the duplicate path distinctly', async () => {
    stubFetch([
      [/^\/github\/status$/, () => json({ configured: true })],
      [/^\/runs\/run_1\/open-pr$/, () => json({ created: false, number: 7, url: 'https://github.com/o/r/pull/7' })],
    ]);
    const container = await renderComponent(<OpenPrAction runId="run_1" />);
    await waitForElement(container, '[data-testid="report-action-open-pr-button"]');
    click(container.querySelector('[data-testid="report-action-open-pr-button"]'));
    await waitForElement(container, '[data-testid="report-action-open-pr-confirm-button"]');
    click(container.querySelector('[data-testid="report-action-open-pr-confirm-button"]'));
    await waitForText(container, 'already exists');
  });

  it('names the fix when the daemon refuses', async () => {
    stubFetch([
      [/^\/github\/status$/, () => json({ configured: false })],
      [
        /^\/runs\/run_1\/open-pr$/,
        () => json({ error: 'no_pat', message: 'No GitHub PAT saved' }, 422),
      ],
    ]);
    const container = await renderComponent(<OpenPrAction runId="run_1" />);
    await waitForElement(container, '[data-testid="report-action-open-pr-button"]');
    click(container.querySelector('[data-testid="report-action-open-pr-button"]'));
    await waitForElement(container, '[data-testid="report-action-open-pr-confirm-button"]');
    click(container.querySelector('[data-testid="report-action-open-pr-confirm-button"]'));
    await waitForText(container, 'No GitHub PAT saved');
    await waitForText(container, 'Settings → GitHub');
  });

  it('every daemon refusal code has a hint (keeps OPEN_PR_REASON_HINTS in sync with PrFailureReason)', () => {
    // pr_exists is the success path (returned as existing, never a refusal).
    const codes = [
      'no_pat',
      'no_remote',
      'not_github',
      'ssh_origin',
      'repo_invalid',
      'branch_missing',
      'worktree_missing',
      'empty_diff',
      'push_failed',
      'auth_failed',
      'network',
      'api_error',
    ];
    for (const code of codes) {
      expect(OPEN_PR_REASON_HINTS[code], `missing hint for ${code}`).toMatch(/.{10,}/);
    }
  });
});
