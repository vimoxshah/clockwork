/**
 * Shared waiting helpers for the jsdom + `createRoot` UI tests.
 *
 * THE BUG THESE EXIST FOR. Every UI test in this package used to render a
 * component that fetches, `await new Promise((r) => setTimeout(r, 30))`, and
 * then assert. A fixed sleep is a bet on machine speed: it wins on an idle
 * laptop and loses on CI's loaded runner. Three CI builds in a row failed that
 * way, with failures like `expected '' to contain 'nothing carried over yet'`
 * — an EMPTY container, i.e. the component had not rendered yet. Worse, a test
 * whose assertions are all negative (`toBeNull`, `not.toContain`, `toBe('')`)
 * does not fail when it reads an empty container: it passes while measuring
 * nothing.
 *
 * The fix is two primitives, and neither of them is a duration:
 *
 *   1. `renderComponent` proves the FIRST COMMIT happened, by rendering a
 *      probe alongside the component under test. The probe's `useLayoutEffect`
 *      runs inside React's commit phase, so `commits > 0` is a fact about
 *      React, not about elapsed time. That is what makes "this component
 *      renders nothing" a real assertion instead of a race the empty container
 *      always wins.
 *   2. `waitFor` (and its `waitForElement` / `waitForText` / `waitForTextGone`
 *      wrappers) polls a CONDITION until it holds, then
 *      returns immediately. On a fast machine it costs one poll; on a loaded
 *      one it simply keeps looking. When it gives up it prints what it
 *      actually saw, so a real component regression still reads as a component
 *      regression rather than a timeout.
 *
 * The `setTimeout` inside `waitFor` is a poll interval, not a deadline: the
 * loop exits on the condition, never on the clock, unless the wait genuinely
 * fails.
 *
 * NOT covered here on purpose: a state update caused by a discrete DOM event
 * (`click`, `input`) needs no wait at all. React 18 dispatches those at
 * `DiscreteEventPriority` and flushes the sync callback queue before
 * `dispatchEvent` returns, so the re-render has already happened. Where such a
 * test does wait, it is waiting for the ASYNC consequence (a fetch, a portal),
 * not for React.
 */
import { useLayoutEffect } from 'react';
import type { ReactElement } from 'react';

export interface WaitOptions {
  /**
   * How long to keep polling before failing. Generous on purpose — a slow
   * answer is not a wrong answer, and this only ever costs real time when the
   * test is about to fail anyway. Kept below the package's 30s `testTimeout`
   * (vitest.config.ts) so THIS message is what the CI log shows, rather than
   * vitest's contentless one.
   */
  timeoutMs?: number;
  /** How often to re-check. Short, because the loop exits on the condition. */
  intervalMs?: number;
  /** Extra context printed on timeout — normally the DOM the wait could see. */
  describe?: () => string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 5;
const MAX_REPORTED_CHARS = 500;

/**
 * The deadline must NOT be measured with the clock a test may have frozen.
 * `screen-honesty.test.tsx` calls `vi.useFakeTimers({ toFake: ['Date'] })` and
 * pins a system time, which makes `Date.now()` constant — a wait measured with
 * it can never time out, so a failed wait would spin until vitest's generic 5s
 * message instead of printing what it saw. `performance.now()` is monotonic and
 * is not part of `toFake: ['Date']`; the `Date.now` fallback is captured at
 * module load, before any test can replace the global `Date`.
 */
const realDateNow = Date.now.bind(Date);
const monotonicNow: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now.bind(performance)
    : realDateNow;

function truncate(text: string): string {
  return text.length > MAX_REPORTED_CHARS ? `${text.slice(0, MAX_REPORTED_CHARS)}… (${text.length} chars)` : text;
}

/**
 * What a failed wait reports. An empty container is called out by name,
 * because that is the exact state the fixed sleeps used to assert against.
 */
function describeContainer(container: HTMLElement): string {
  const text = container.textContent ?? '';
  if (text === '') {
    return container.innerHTML === ''
      ? 'the container is EMPTY — nothing rendered into it at all'
      : `no text; html = ${truncate(container.innerHTML)}`;
  }
  return `textContent = ${JSON.stringify(truncate(text))}`;
}

/**
 * Polls `check` until it returns something truthy, and returns that value.
 * A throwing `check` counts as "not ready yet" and its error is reported if
 * the wait runs out — that keeps `container.querySelector(…)!.textContent`
 * style probes usable without a null guard at every call site.
 */
export async function waitFor<T>(
  check: () => T | false | null | undefined,
  what: string,
  opts: WaitOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startedAt = monotonicNow();
  let lastThrow: unknown;
  for (;;) {
    try {
      const value = check();
      if (value) return value;
      lastThrow = undefined;
    } catch (e) {
      lastThrow = e;
    }
    const elapsed = Math.round(monotonicNow() - startedAt);
    if (elapsed >= timeoutMs) {
      const saw = opts.describe ? opts.describe() : '(no context supplied)';
      throw new Error(
        `timed out after ${elapsed}ms waiting for ${what}\n` +
          `  what it actually saw: ${saw}` +
          (lastThrow === undefined ? '' : `\n  the check kept throwing: ${String(lastThrow)}`),
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * The one shape polling cannot express: proving that something does NOT happen.
 * Watches for a bounded window and fails the INSTANT `didHappen` becomes true,
 * which is strictly better than sleeping and hoping — a sleep only notices the
 * forbidden event if it is still visible when the sleep ends, and says nothing
 * about what it saw.
 *
 * Use only where the absence is the point (a control that must send nothing).
 * Everywhere else, wait for the positive consequence instead.
 */
export async function neverHappens(
  didHappen: () => boolean,
  what: string,
  opts: { forMs?: number; intervalMs?: number; describe?: () => string } = {},
): Promise<void> {
  const forMs = opts.forMs ?? 150;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startedAt = monotonicNow();
  for (;;) {
    if (didHappen()) {
      const saw = opts.describe ? opts.describe() : '(no context supplied)';
      throw new Error(
        `${what} happened after ${Math.round(monotonicNow() - startedAt)}ms, and it must not\n` +
          `  what it actually saw: ${saw}`,
      );
    }
    if (monotonicNow() - startedAt >= forMs) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Waits until `selector` matches inside `container`, and returns the element. */
export function waitForElement<E extends Element = Element>(
  container: HTMLElement,
  selector: string,
  opts: WaitOptions = {},
): Promise<E> {
  return waitFor<E>(
    () => container.querySelector<E>(selector) ?? undefined,
    `an element matching ${JSON.stringify(selector)}`,
    { describe: () => describeContainer(container), ...opts },
  );
}

/** Waits until `container` reads `needle` somewhere, and returns its full text. */
export function waitForText(container: HTMLElement, needle: string, opts: WaitOptions = {}): Promise<string> {
  return waitFor<string>(
    () => {
      const text = container.textContent ?? '';
      return text.includes(needle) ? text : undefined;
    },
    `the text ${JSON.stringify(needle)}`,
    { describe: () => describeContainer(container), ...opts },
  );
}

/**
 * Waits until `needle` is no longer anywhere in `container`. For a
 * DISAPPEARANCE — the state change a test is about — never for "it was never
 * there", which is true before the component renders and is exactly the vacuous
 * pass being removed.
 */
export function waitForTextGone(container: HTMLElement, needle: string, opts: WaitOptions = {}): Promise<true> {
  return waitFor<true>(
    () => ((container.textContent ?? '').includes(needle) ? undefined : true),
    `the text ${JSON.stringify(needle)} to disappear`,
    { describe: () => describeContainer(container), ...opts },
  );
}

/**
 * Renders `null` and reports every commit it takes part in. `useLayoutEffect`
 * runs inside the commit phase, so by the time `onCommit` fires the sibling
 * component's DOM is already in the container.
 */
function CommitProbe({ onCommit }: { onCommit: () => void }): null {
  useLayoutEffect(() => {
    onCommit();
  });
  return null;
}

/**
 * Mounts `node` into a fresh container attached to `document.body` (React 18
 * delegates events from the root container, so it has to be in the document)
 * and returns only once React has committed.
 *
 * The probe contributes no DOM and no text, so `container.textContent`,
 * `querySelectorAll('button')` and friends see exactly what they saw before.
 * What it buys is the guarantee the fixed sleeps never had: when this resolves,
 * "the component rendered nothing" and "the component has not rendered yet"
 * are distinguishable.
 */
export async function renderComponent(node: ReactElement, opts: WaitOptions = {}): Promise<HTMLDivElement> {
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  let commits = 0;
  createRoot(container).render(
    <>
      {node}
      <CommitProbe
        onCommit={() => {
          commits += 1;
        }}
      />
    </>,
  );
  await waitFor(() => commits > 0, 'React to commit the rendered tree', {
    describe: () => `React never committed; container html = ${JSON.stringify(truncate(container.innerHTML))}`,
    ...opts,
  });
  return container;
}
