/**
 * Pairing has to actually check the token.
 *
 * The bug: the connect gate validated the pasted token by calling `/health`,
 * which `requiresAuth` (packages/daemon/src/api.ts) leaves OPEN by design — it
 * carries no user data and the UI polls it before pairing. So the probe
 * answered 200 to any string. The gate accepted junk, the app loaded, and then
 * every real route 401'd, which presents as "the app is broken" rather than
 * "that is the wrong token".
 *
 * Verified against a live daemon before the fix:
 *   Bearer TOTALLY-WRONG-TOKEN → /health 200, /tasks 401
 *
 * So the gate must probe a route the daemon actually guards. What is pinned
 * here is that property — a 401 from the authed probe keeps the user on the
 * gate and clears the stored token — not the specific endpoint.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { renderComponent, waitFor, waitForElement } from './helpers/dom';
import App from '../src/App';

const TOKEN_KEY = 'clockwork.token';

/** Routes the daemon leaves anonymous. A pairing probe must not rely on these. */
const OPEN_ROUTES = ['/health'];

interface Probe {
  authedHit: () => boolean;
  openOnlyHit: () => boolean;
}

/**
 * Stands in for a daemon that is reachable but rejects this token: every guarded
 * route 401s, while the open ones still answer 200 exactly as the real one does.
 */
function stubDaemonRejectingToken(): Probe {
  let authed = false;
  let openOnly = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const path = String(url).split('?')[0].replace('http://127.0.0.1:4747', '');
      if (OPEN_ROUTES.some((r) => path.startsWith(r))) {
        openOnly = true;
        return new Response(JSON.stringify({ ok: true, daemonVersion: 'test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      authed = true;
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { authedHit: () => authed, openOnlyHit: () => openOnly };
}

/**
 * jsdom ships no `matchMedia`, and this is the only test that mounts the whole
 * App (theme.tsx reads the colour-scheme query on first render). Reports "no
 * preference" so the theme resolver takes its default branch.
 */
function stubMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

const typeInto = (el: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('the connect gate rejects a token the daemon would reject', () => {
  it('keeps the user on the gate, and clears the token, when the authed probe 401s', async () => {
    localStorage.clear();
    stubMatchMedia();
    const probe = stubDaemonRejectingToken();
    const container = await renderComponent(<App />);
    const input = await waitForElement<HTMLInputElement>(container, '[data-testid="token-input"]');

    typeInto(input, 'TOTALLY-WRONG-TOKEN');
    const connect = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.textContent ?? '').trim() === 'Connect',
    );
    expect(connect, '"Connect" button missing').not.toBeUndefined();
    connect!.click();

    await waitFor(
      () => container.querySelector('[role="alert"]') !== null,
      'the pairing error banner',
      { describe: () => `body = ${JSON.stringify((container.textContent ?? '').slice(0, 300))}` },
    );

    // The gate reached a GUARDED route — probing only an open one is the bug.
    expect(probe.authedHit(), 'gate never called a route the daemon guards').toBe(true);
    // A rejected token must not be left behind for the next reload to trust.
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    // And the gate is still on screen rather than a half-loaded app.
    expect(container.querySelector('[data-testid="token-input"]')).not.toBeNull();
  });
});
