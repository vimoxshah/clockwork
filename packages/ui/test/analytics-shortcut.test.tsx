/**
 * T4-10: ⌘5 has to actually reach Analytics, not just exist in source.
 *
 * Analytics was reachable by mouse (App.tsx's tab bar) but by neither
 * keyboard nor the command palette — `docs/SHORTCUTS.md` said so outright
 * ("has no shortcut of its own"), and `App.tsx`'s `commands` array (the
 * palette's own command list) had no `nav-analytics` entry at all. This
 * drives the real listener with a real KeyboardEvent and reads the result
 * back out of the DOM — a source-text assertion ("does App.tsx contain
 * `case '5'`") would have passed even if the handler were wired to the wrong
 * tab or never attached, which is exactly the class of bug this track exists
 * to catch (see T4-1's rescope note).
 *
 * Full `<App/>` mount, same shape as connect-gate-token.test.tsx: a token in
 * localStorage skips ConnectGate, and `fetch` is stubbed rather than hitting
 * a real daemon. `/events` answers 401 like that test's stub does — App.tsx's
 * `es.onerror` is a no-op, so this never flips `unauthorized` — and every
 * other route gets an empty 200 EXCEPT `/analytics`, which AnalyticsView
 * reads with unguarded property access (`data.totals.costUsd`, no
 * `useAsync`/optional-chaining) and would throw during render into the
 * top-level ErrorBoundary on a shape it doesn't expect — verified against
 * the live component before relying on it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { renderComponent, waitFor } from './helpers/dom';
import type { Health } from '../src/api';

const TOKEN_KEY = 'clockwork.token';

const HEALTH: Health = {
  ok: true,
  apiVersion: 1,
  daemonVersion: 'test',
  installedVersion: 'test',
  versionSkew: false,
  paused: false,
  activeRuns: 0,
  queuedRuns: 0,
  nextFire: null,
} as unknown as Health;

const EMPTY_ANALYTICS = {
  range: { from: 0, to: 0, days: 30 },
  totals: { runs: 0, completed: 0, failed: 0, successRate: 0, costUsd: 0, turns: 0, avgCostPerRun: 0 },
  byTask: [],
  byProvider: [],
  daily: [],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Same three routes connect-gate-token.test.tsx proved safe, plus /analytics (see header). */
function stubDaemon(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const path = String(url).split('?')[0].replace('http://127.0.0.1:4747', '');
      if (path === '/health') return json(HEALTH);
      if (path === '/events') return new Response(null, { status: 401 });
      if (path === '/analytics') return json(EMPTY_ANALYTICS);
      return json({});
    }),
  );
}

/** jsdom ships no `matchMedia`; theme.tsx reads it on first render of the full App. */
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

/**
 * The shortcut's `window.addEventListener('keydown', ...)` is registered
 * inside a PASSIVE `useEffect`, which React schedules to run after commit —
 * unlike a click on a real DOM button (delegated through React's own
 * synthetic system, wired at the root on the first commit) or a
 * `useLayoutEffect` (synchronous, inside commit — what `renderComponent`'s
 * CommitProbe uses). `renderComponent` proves the first commit happened, not
 * that passive effects have flushed, and this harness renders without
 * `act()` (see test/helpers/dom.tsx's header), so there is no hook forcing
 * that flush before the next line runs. Retrying the dispatch — a live
 * keyboard event is idempotent here, `setTab('analytics')` on an
 * already-active tab is a no-op re-render — turns that race into a bounded
 * wait instead of a flaky fixed sleep, and it still fails loudly (via
 * `waitFor`'s own timeout) if the shortcut genuinely never fires.
 */
async function pressUntil(key: string, until: () => boolean, what: string): Promise<void> {
  await waitFor(
    () => {
      if (until()) return true;
      window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }));
      return false; // React 18 auto-batches the resulting state update; read it on the NEXT poll, not this tick.
    },
    what,
    { intervalMs: 20 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = '';
  window.location.hash = '';
});

describe('⌘5 reaches Analytics', () => {
  it('switches the shell to Analytics — hash, nav state, and the mounted view', async () => {
    localStorage.setItem(TOKEN_KEY, 'test-token');
    stubMatchMedia();
    stubDaemon();

    const container = await renderComponent(<App />);
    await waitFor(
      () => [...container.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === '+ New task'),
      'the shell to render past the connect gate',
      { describe: () => `body = ${JSON.stringify((container.textContent ?? '').slice(0, 300))}` },
    );

    // Starts elsewhere — the default tab is Calendar, not Analytics — so the
    // shortcut has to do real work, not just find the tab already active.
    expect(window.location.hash).not.toBe('#/analytics');

    await pressUntil('5', () => window.location.hash === '#/analytics', 'the hash to move to #/analytics');

    const activeTab = container.querySelector('nav[aria-label="Sections"] button[aria-current="page"]');
    expect(activeTab, 'no tab marked aria-current after the shortcut').not.toBeNull();
    expect(activeTab!.textContent?.trim()).toBe('Analytics');

    // The view itself mounted, not just the nav chrome — AnalyticsView's own
    // anchor (ANALYTICS_BASIC_SURFACE), present whenever its Overview renders.
    await waitFor(
      () => container.querySelector('#analytics-basic') !== null,
      'AnalyticsView to mount',
      { describe: () => `body = ${JSON.stringify((container.textContent ?? '').slice(0, 300))}` },
    );
  });

  it('is a real second listener, not a rename of ⌘1-4 — those still work afterwards', async () => {
    localStorage.setItem(TOKEN_KEY, 'test-token');
    stubMatchMedia();
    stubDaemon();

    const container = await renderComponent(<App />);
    await waitFor(
      () => [...container.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === '+ New task'),
      'the shell to render past the connect gate',
    );

    await pressUntil('5', () => window.location.hash === '#/analytics', 'the hash to move to #/analytics');

    // ⌘1 (Calendar) — CommandPalette.tsx's pre-existing useGlobalShortcuts,
    // untouched by this change — still has to fire afterwards. Not ⌘3/Tasks:
    // that view throws on this test's deliberately generic `{}` stub for
    // every unlisted route, which is a fetch-response-shape mismatch in the
    // TEST fixture, not a product bug — see the header comment on why
    // /analytics gets its own real shape and everything else gets `{}`.
    await pressUntil('1', () => window.location.hash === '#/calendar', 'the hash to move back to #/calendar (⌘1, unrelated to this change)');
  });
});

describe('the command palette can reach Analytics too', () => {
  it('lists "Open Analytics" with the ⌘5 hint', async () => {
    localStorage.setItem(TOKEN_KEY, 'test-token');
    stubMatchMedia();
    stubDaemon();

    const container = await renderComponent(<App />);
    await waitFor(
      () => [...container.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === '+ New task'),
      'the shell to render past the connect gate',
    );

    await pressUntil(
      'k',
      () => container.querySelector('[data-testid="palette-input"]') !== null,
      'the command palette to open',
    );

    const items = [...container.querySelectorAll('[data-testid="palette-item"]')];
    const analyticsItem = items.find((i) => (i.textContent ?? '').includes('Open Analytics'));
    expect(analyticsItem, `no "Open Analytics" command among: ${items.map((i) => i.textContent).join(' | ')}`).not.toBeUndefined();
    expect(analyticsItem!.textContent).toContain('⌘5');
  });
});
