/**
 * T4-7: clicking a template card actually fills the form — the composer's
 * half of "a new user can book any of the five without typing a prompt".
 *
 * Round 2 review: the prior evidence for this Done-when was reading the
 * code plus a daemon-side text/JSON comparison — and reading is exactly
 * what missed the cadence-comparison hole. This mounts the REAL component
 * and drives it the way a user would: click a card, then check the fields
 * the review named — name, prompt, profile, the three budget numbers, and
 * the schedule controls — plus that template 5 selects the ASAP tab.
 *
 * Pattern follows composer-asap.test.tsx: static ComposerView import (JSX/
 * Radix/lucide through the transform is too slow for a per-test dynamic
 * import under CPU oversubscription), stub fetch, capture the real
 * `POST /tasks` body as the decisive proof for fields a Radix `Select`
 * would otherwise make fragile/locale-dependent to read from the DOM
 * (the TimeField hour trigger renders a locale-formatted label).
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { renderComponent, waitForElement, waitFor } from './helpers/dom';
import ComposerView from '../src/components/ComposerView';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** One profile per template's profileSlug (resources/templates/*.json), so `applyTemplate`'s profiles.find(...) actually resolves. */
const PROFILES = [
  { id: 'p-dep-surgeon', slug: 'dep-surgeon', name: 'Dep Surgeon', color: '#7FD8C8', avatar: '✚' },
  { id: 'p-test-doctor', slug: 'test-doctor', name: 'Test Doctor', color: '#F2A7B9', avatar: '✚' },
  { id: 'p-docs-scribe', slug: 'docs-scribe', name: 'Docs Scribe', color: '#B9A7F2', avatar: '✎' },
  { id: 'p-repo-health-monitor', slug: 'repo-health-monitor', name: 'Repo Health Monitor', color: '#B9A7F2', avatar: '♥' },
  { id: 'p-changelog-writer', slug: 'changelog-writer', name: 'Changelog Writer', color: '#7FA8F2', avatar: '≡' },
];

interface Captured {
  name?: string;
  prompt?: string;
  profileId?: string;
  permissionMode?: string;
  budget?: { maxUsd?: number; maxTurns?: number; timeoutSec?: number };
  schedule?: { kind?: string; rrule?: string; runAt?: number; tz?: string };
}

/** Stubs the composer's reads (with real profiles) and captures the POST /tasks body. */
function stubAndCapture(): { posted: () => Captured | null } {
  let body: Captured | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      if (path === '/profiles') return json(PROFILES);
      if (path === '/providers') return json([]);
      if (path === '/byok') return json({ configs: [] });
      if (path === '/tasks' && init?.method === 'POST') {
        body = JSON.parse(String(init.body)) as Captured;
        return new Response(JSON.stringify({ id: 'task-1' }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return json({});
    }),
  );
  return { posted: () => body };
}

const cardByName = (container: HTMLElement, name: string): HTMLButtonElement => {
  const btn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.querySelector('span')?.textContent?.trim() === name,
  );
  expect(btn, `template card "${name}" missing`).not.toBeUndefined();
  return btn!;
};

const buttonByText = (container: HTMLElement, text: string): HTMLButtonElement => {
  const btn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent ?? '').trim() === text);
  expect(btn, `"${text}" button missing`).not.toBeUndefined();
  return btn!;
};

const tabByLabel = (container: HTMLElement, label: string): HTMLButtonElement => {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  expect(tab, `"${label}" tab missing`).not.toBeUndefined();
  return tab!;
};

/** Waits for the async GET /profiles to have actually landed in state — AgentPicker's own count proves it. */
async function waitForProfilesLoaded(container: HTMLElement): Promise<void> {
  await waitFor(
    () => (container.textContent ?? '').includes(`Browse all ${PROFILES.length} agents`),
    'profiles to finish loading',
  );
}

/**
 * Clicks a template card and waits for the SINGLE anchor field (#c-name) the
 * click's one `setForm` call is guaranteed to settle in the same commit as
 * every other field it sets — so once this resolves, prompt/budget/profile/
 * schedule are all safe to read synchronously. Empirically, `applyTemplate`'s
 * click does NOT resolve synchronously here the way helpers/dom.tsx's own
 * doc comment says a discrete DOM event normally does (verified: an
 * unguarded synchronous read after `.click()` read the PRE-click empty
 * value); this anchor wait is the fix, applied once per interaction rather
 * than duplicated at every assertion.
 */
async function clickTemplateCard(container: HTMLElement, name: string): Promise<void> {
  cardByName(container, name).click();
  await waitFor(() => container.querySelector<HTMLInputElement>('#c-name')!.value === name, `#c-name to read "${name}" after clicking its template card`, {
    describe: () => `#c-name.value = ${JSON.stringify(container.querySelector<HTMLInputElement>('#c-name')?.value)}`,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('T4-7 composer templates — clicking a card fills the form, not just data', () => {
  it('all five template cards are present and each click sets a DIFFERENT, correct task name', async () => {
    stubAndCapture();
    const container = await renderComponent(<ComposerView onDone={() => {}} />);
    await waitForElement(container, '#c-prompt');

    const names = [
      'Monday dependency triage',
      'Flaky test sweep',
      'Friday docs-drift check',
      'Morning repo-health digest',
      'Pre-release changelog draft',
    ];
    for (const name of names) {
      await clickTemplateCard(container, name);
    }
  });

  it('Monday dependency triage: name/prompt/budget/profile/permission populate, Recurring/Weekly/Mon selects, and Book it posts the matching rrule', async () => {
    const { posted } = stubAndCapture();
    const container = await renderComponent(<ComposerView onDone={() => {}} />);
    await waitForElement(container, '#c-prompt');
    await waitForProfilesLoaded(container);

    await clickTemplateCard(container, 'Monday dependency triage');

    // The visible promise: fields populate before Book it is ever pressed.
    expect(container.querySelector<HTMLInputElement>('#c-name')!.value).toBe('Monday dependency triage');
    expect(container.querySelector<HTMLTextAreaElement>('#c-prompt')!.value).toContain('Run the dependency-triage procedure');
    expect(container.querySelector<HTMLInputElement>('#c-usd')!.value).toBe('2');
    expect(container.querySelector<HTMLInputElement>('#c-turns')!.value).toBe('50');
    expect(container.querySelector<HTMLInputElement>('#c-timeout')!.value).toBe('3600');

    // Profile: AgentPicker's own "currently selected" chip, not a fragile
    // dig into its collapsed "browse all" radiogroup.
    const selectedAgent = container.querySelector('[data-testid="selected-agent"]');
    expect(selectedAgent, 'no profile shows as selected').not.toBeNull();
    expect(selectedAgent!.textContent).toContain('Dep Surgeon');

    // Schedule controls: visibly Recurring / Weekly / Mon, not just data.
    expect(tabByLabel(container, 'acceptEdits').getAttribute('aria-selected')).toBe('true');
    expect(tabByLabel(container, 'Recurring').getAttribute('aria-selected')).toBe('true');
    expect(tabByLabel(container, 'Weekly').getAttribute('aria-selected')).toBe('true');
    // Weekday toggles are plain-text buttons with no child elements; the
    // template cards ALSO carry aria-pressed (for their own "last applied"
    // highlight, see ComposerView.tsx) and would otherwise collide here
    // since the just-clicked card is now aria-pressed="true" too.
    const pressedDays = [...container.querySelectorAll<HTMLButtonElement>('[aria-pressed="true"]')]
      .filter((b) => b.children.length === 0)
      .map((b) => b.textContent?.trim());
    expect(pressedDays).toEqual(['Mon']);

    // And it survives to the real booking payload — the cadence a Radix
    // Select's locale-formatted label would be fragile to read directly.
    buttonByText(container, 'Book it').click();
    await waitFor(() => posted() !== null, 'the POST /tasks body');
    const body = posted()!;
    expect(body.name).toBe('Monday dependency triage');
    expect(body.profileId).toBe('p-dep-surgeon');
    expect(body.permissionMode).toBe('acceptEdits');
    expect(body.budget).toEqual({ maxUsd: 2, maxTurns: 50, timeoutSec: 3600 });
    expect(body.schedule?.kind).toBe('rrule');
    expect(body.schedule?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0');
  });

  it('Pre-release changelog draft: selects the ASAP tab (not Recurring/One-off), plan mode, and books a near-future once — never the unfireable queue kind', async () => {
    const { posted } = stubAndCapture();
    const container = await renderComponent(<ComposerView onDone={() => {}} />);
    await waitForElement(container, '#c-prompt');
    await waitForProfilesLoaded(container);

    await clickTemplateCard(container, 'Pre-release changelog draft');

    expect(container.querySelector<HTMLInputElement>('#c-usd')!.value).toBe('1.5');
    expect(container.querySelector<HTMLInputElement>('#c-turns')!.value).toBe('30');
    expect(container.querySelector<HTMLInputElement>('#c-timeout')!.value).toBe('1800');
    const selectedAgent = container.querySelector('[data-testid="selected-agent"]');
    expect(selectedAgent?.textContent).toContain('Changelog Writer');

    // The exact thing the review asked to see: template 5 lands on the ASAP
    // tab, not on Recurring (its composer-side kind before this template
    // existed) and not on One-off.
    expect(tabByLabel(container, 'plan (dry-run)').getAttribute('aria-selected')).toBe('true');
    expect(tabByLabel(container, 'ASAP').getAttribute('aria-selected')).toBe('true');
    expect(tabByLabel(container, 'Recurring').getAttribute('aria-selected')).toBe('false');
    expect(tabByLabel(container, 'One-off').getAttribute('aria-selected')).toBe('false');

    const before = Date.now();
    buttonByText(container, 'Book it').click();
    await waitFor(() => posted() !== null, 'the POST /tasks body');
    const body = posted()!;
    expect(body.profileId).toBe('p-changelog-writer');
    expect(body.permissionMode).toBe('plan');
    expect(body.budget).toEqual({ maxUsd: 1.5, maxTurns: 30, timeoutSec: 1800 });
    // composer-asap.test.tsx's own invariant: ASAP must book a future `once`,
    // never `queue` (the daemon's unfireable review-gate kind) — restated
    // here because it is exactly what "Run on demand" must cash out to.
    expect(body.schedule?.kind).toBe('once');
    expect(body.schedule?.kind).not.toBe('queue');
    expect(body.schedule!.runAt!).toBeGreaterThan(before);
    expect(body.schedule!.runAt!).toBeLessThan(before + 60_000);
  });
});
