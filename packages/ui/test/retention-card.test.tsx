/**
 * T1-10: the UI half of "retention gets a screen".
 *
 * `GET`/`PUT /retention` (`api.ts:2855-2882`, ADR-031) have been reachable
 * since `retention-audit.ts` shipped; only the screen was missing, exactly as
 * README's Known limits bullet says. `RetentionCard` (`SettingsView.tsx`) is
 * that screen: it shows what the sweep will delete next and when, and makes
 * the two numbers editable.
 *
 * This file also carries the finding that surfaced while building the screen
 * (reported, not fixed — out of this task's touch set): `PUT /retention`
 * entitlement-gates `runDays` alone, against a 30-day free-tier cap, while
 * `retention-audit.ts`'s own seeded default is 90 — so on a real free-tier
 * install (the only tier any install runs at today) the setter accepts a save
 * only when the new `runDays` is <=30. Re-saving the loaded default unchanged,
 * or shrinking to anything still above 30, both 402. The last describe block
 * below proves that concretely, and proves the card degrades honestly rather
 * than crashing or silently discarding the failure.
 *
 * jsdom + `createRoot` through `renderComponent`, the same approach
 * `quiet-hours-card.test.tsx` (T1-8's sibling screen) uses. This file mounts
 * `RetentionCard` alone, for the same reason that file mounts `QuietHoursCard`
 * alone rather than all of `SettingsView`: a Save click must not route a dozen
 * unrelated fetches. New file rather than an addition to an existing shared
 * test file, so a concurrent lane touching another Settings card does not
 * collide with this one. Does not touch any of the twelve F1–F12 feature
 * suites `claims-honesty.test.ts` counts — retention is not a workforce
 * feature.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetentionCard } from '../src/components/SettingsView';
import { renderComponent, waitFor, waitForElement, neverHappens } from './helpers/dom';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface RetentionPrefsT {
  runDays: number | null;
  maxRuns: number | null;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * React tracks a controlled input's value on the node itself, so a plain
 * `el.value = x` bypasses React's own setter and the following `input` event
 * is deduped as "nothing changed." Same helper as `quiet-hours-card.test.tsx`.
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

/**
 * Only `/retention` is ever allowed — an unrouted request throws rather than
 * resolving empty, so a silently-swallowed fetch cannot pass as a green test.
 * `onPut` defaults to echoing back whatever body was sent, matching the real
 * `PUT /retention` handler's `return retentionAudit.getPrefs()` on success.
 */
async function mount(
  initial: RetentionPrefsT,
  onPut?: (call: Call) => Response,
): Promise<{ container: HTMLDivElement; calls: Call[] }> {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      if (call.url !== '/retention') throw new Error(`unexpected request: ${call.method} ${call.url}`);
      if (call.method === 'GET') return json(initial);
      if (call.method === 'PUT') {
        if (onPut) return onPut(call);
        const body = call.body as { runDays: number; maxRuns: number };
        return json({ runDays: body.runDays, maxRuns: body.maxRuns });
      }
      throw new Error(`unexpected method: ${call.method}`);
    }),
  );
  const container = await renderComponent(<RetentionCard version={1} />);
  await waitForElement(container, '[data-testid="retention-run-days"]');
  const daysField = (): HTMLInputElement => container.querySelector('[data-testid="retention-run-days"]') as HTMLInputElement;
  await waitFor(
    () => daysField().value === String(initial.runDays ?? ''),
    'the fields to sync from GET /retention',
    { describe: () => `value = ${JSON.stringify(daysField().value)}` },
  );
  return { container, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Settings ▸ Retention — shows the current settings (the gap this closes)', () => {
  it('pre-fills both fields from GET /retention', async () => {
    const { container, calls } = await mount({ runDays: 90, maxRuns: 1000 });
    expect((container.querySelector('[data-testid="retention-run-days"]') as HTMLInputElement).value).toBe('90');
    expect((container.querySelector('[data-testid="retention-max-runs"]') as HTMLInputElement).value).toBe('1000');
    expect(calls.some((c) => c.url === '/retention' && c.method === 'GET')).toBe(true);
  });

  it('states what the sweep deletes, when, and the two things it is not — worktrees and reports', async () => {
    const { container } = await mount({ runDays: 30, maxRuns: 200 });
    const text = container.textContent ?? '';
    // Cadence — main.ts's own RETENTION_SWEEP_MS, not an invented number.
    expect(text).toContain('every 6 hours');
    // The consequence, legible before any click.
    expect(text.toLowerCase()).toContain('deleting a run deletes its report');
    // Scope — a run still in flight is never in danger, whatever the numbers say.
    expect(text.toLowerCase()).toContain('never touched');
    // The card must not imply one number governs everything (T1-10's brief):
    // worktrees are pruned on a wholly separate, per-run schedule.
    expect(text).toContain('Worktrees are cleaned up per run');
    expect(text).toContain('not by this sweep');
  });
});

describe('Settings ▸ Retention — Save reaches PUT /retention', () => {
  it('growing either number saves immediately, with no confirmation', async () => {
    const { container, calls } = await mount({ runDays: 14, maxRuns: 50 });
    type(container.querySelector('[data-testid="retention-run-days"]'), '21');
    click(container.querySelector('[data-testid="retention-save"]'));

    const put = await waitFor(() => calls.find((c) => c.method === 'PUT'), 'a PUT /retention', {
      describe: () => JSON.stringify(calls),
    });
    expect(put.url).toBe('/retention');
    expect(put.body).toEqual({ runDays: 21, maxRuns: 50 });
    expect(container.querySelector('[role="dialog"]'), 'growing is not destructive — no confirmation gate').toBeNull();
    await waitFor(() => (container.textContent ?? '').includes('Retention settings saved.'), 'the success message', {
      describe: () => container.textContent,
    });
  });

  it('disables Save until a field actually differs from what was loaded', async () => {
    // A real free-tier install seeds 90/1000 (retention-audit.ts's own
    // default) while PUT /retention gates runDays at 30 for the free tier
    // (entitlements.ts numericLimit). A no-op Save on the loaded value would
    // 402 for no reason — disabling Save on "nothing changed" is what keeps
    // the common "just looking" path from hitting that gate at all.
    const { container, calls } = await mount({ runDays: 90, maxRuns: 1000 });
    const save = container.querySelector<HTMLButtonElement>('[data-testid="retention-save"]')!;
    expect(save.disabled).toBe(true);
    click(save);
    await neverHappens(() => calls.some((c) => c.method === 'PUT'), 'a PUT with nothing changed', {
      describe: () => JSON.stringify(calls),
    });
    // Re-typing the SAME value must not enable it either.
    type(container.querySelector('[data-testid="retention-run-days"]'), '90');
    expect(save.disabled).toBe(true);
  });

  it('will not send a PUT while a field is blank or invalid', async () => {
    const { container, calls } = await mount({ runDays: 14, maxRuns: 50 });
    type(container.querySelector('[data-testid="retention-run-days"]'), '');
    const save = container.querySelector<HTMLButtonElement>('[data-testid="retention-save"]')!;
    expect(save.disabled).toBe(true);
    click(save);
    await neverHappens(() => calls.some((c) => c.method === 'PUT'), 'a PUT with a blank field', {
      describe: () => JSON.stringify(calls),
    });
  });
});

describe('Settings ▸ Retention — a shrink is confirmed before it is applied', () => {
  it('shortening the day window opens a confirmation naming the new numbers, and nothing is sent until confirmed', async () => {
    const { container, calls } = await mount({ runDays: 60, maxRuns: 500 });
    type(container.querySelector('[data-testid="retention-run-days"]'), '20');
    click(container.querySelector('[data-testid="retention-save"]'));

    await waitForElement(container, '[role="dialog"]');
    const dialogText = container.querySelector('[role="dialog"]')!.textContent ?? '';
    // The consequence, legible before the click: the ACTUAL new numbers, not a
    // generic warning.
    expect(dialogText).toContain('20');
    expect(dialogText).toContain('500');
    expect(dialogText.toLowerCase()).toContain('cannot be undone');

    await neverHappens(() => calls.some((c) => c.method === 'PUT'), 'a PUT before the dialog is confirmed', {
      describe: () => JSON.stringify(calls),
    });

    click(buttonByText(container, 'Shorten and save'));
    const put = await waitFor(() => calls.find((c) => c.method === 'PUT'), 'a PUT /retention', {
      describe: () => JSON.stringify(calls),
    });
    expect(put.body).toEqual({ runDays: 20, maxRuns: 500 });
    await waitFor(() => container.querySelector('[role="dialog"]') === null, 'the dialog to close on success', {
      describe: () => container.innerHTML,
    });
  });

  it('shrinking only the per-task cap also asks first, even with the day window unchanged', async () => {
    const { container, calls } = await mount({ runDays: 60, maxRuns: 500 });
    type(container.querySelector('[data-testid="retention-max-runs"]'), '100');
    click(container.querySelector('[data-testid="retention-save"]'));
    await waitForElement(container, '[role="dialog"]');
    await neverHappens(() => calls.some((c) => c.method === 'PUT'), 'a PUT before the dialog is confirmed', {
      describe: () => JSON.stringify(calls),
    });
  });

  it('Cancel sends nothing and closes the dialog', async () => {
    const { container, calls } = await mount({ runDays: 60, maxRuns: 500 });
    type(container.querySelector('[data-testid="retention-run-days"]'), '20');
    click(container.querySelector('[data-testid="retention-save"]'));
    await waitForElement(container, '[role="dialog"]');
    click(buttonByText(container, 'Cancel'));
    await waitFor(() => container.querySelector('[role="dialog"]') === null, 'the dialog to close', {
      describe: () => container.innerHTML,
    });
    await neverHappens(() => calls.some((c) => c.method === 'PUT'), 'a PUT after Cancel', {
      describe: () => JSON.stringify(calls),
    });
  });

  it('a shrink the daemon 402s keeps the dialog open with the daemon’s own message (the entitlement finding, proven live)', async () => {
    // Mirrors the real PUT /retention handler: 402 whenever the new runDays
    // exceeds entitlements.limitFor('retention') (30 on free tier), same
    // shape the daemon actually sends (api.ts:2864-2871).
    const { container, calls } = await mount({ runDays: 90, maxRuns: 1000 }, (call) => {
      const body = call.body as { runDays: number };
      if (body.runDays > 30) {
        return json(
          { error: 'The free plan keeps history up to 30 days. Clockwork Pro extends retention.', feature: 'retention', requiresPlan: 'pro' },
          402,
        );
      }
      return json({ runDays: body.runDays, maxRuns: 1000 });
    });
    // A shrink (90 -> 45) that is still above the free-tier cap: destructive
    // enough to ask, and still refused by the daemon underneath the ask.
    type(container.querySelector('[data-testid="retention-run-days"]'), '45');
    click(container.querySelector('[data-testid="retention-save"]'));
    await waitForElement(container, '[role="dialog"]');
    click(buttonByText(container, 'Shorten and save'));

    await waitFor(() => calls.some((c) => c.method === 'PUT'), 'the PUT attempt', { describe: () => JSON.stringify(calls) });
    // Stays open — same contract TasksView's and SentinelsSection's delete
    // confirmations rely on: a failure is shown INSIDE the dialog, not
    // swallowed behind one that already closed.
    await waitFor(
      () => (container.querySelector('[role="dialog"]')?.textContent ?? '').includes('free plan keeps history up to 30 days'),
      'the daemon’s own 402 message, verbatim, inside the still-open dialog',
      { describe: () => container.querySelector('[role="dialog"]')?.textContent },
    );
    expect(container.querySelector('[role="dialog"]'), 'the dialog must not have closed on failure').not.toBeNull();
  });
});
