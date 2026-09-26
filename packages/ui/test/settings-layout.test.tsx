/**
 * The Settings layout complaints, pinned structurally (SET-1).
 *
 * Three things were reported: a two-column region that began two thirds of the
 * way down the page, an Office-hours row where "To" sat far from "From" among
 * inputs of three different widths, and a dead half-screen under the limits
 * banner.
 *
 * All three came from the same shape — a single-column stack with two
 * `1fr 1fr` islands cut into it, and a six-control form in a three-column grid.
 * jsdom has no layout engine, so what is asserted here is the STRUCTURE those
 * defects needed to exist. See tools/shoot-settings.mjs for the pixel check.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderComponent, waitForElement, waitForText } from './helpers/dom';
import { OfficeHoursCard } from '../src/components/OfficeHoursCard';

// Source-level, like stale-page-notice.test.tsx: SettingsView reaches a dozen
// endpoints and rendering the whole of it here would test the stubs rather than
// the layout. What matters is that the page has ONE grid and no islands, and
// that is a fact about the file.
//
// These greps cannot see layout, and they are not claimed to. The pixels were
// checked in Chromium at 1440px and 430px against the real stylesheet; the
// script that does it is checked in at tools/shoot-settings.mjs so the check is
// repeatable rather than a claim in a comment.
const VIEW = readFileSync(path.resolve(import.meta.dirname, '../src/components/SettingsView.tsx'), 'utf8');
const CSS = readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

const json = (b: unknown): Response =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function stub(): void {
  vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
    const p = String(u).split('?')[0];
    if (p === '/workforce/office-hours') return json({ enabled: false, windows: [] });
    if (p === '/profiles') return json([]);
    return json({});
  }));
}

describe('the office-hours controls are one row of sized fields', () => {
  it('puts From and To side by side in identical wrappers', async () => {
    stub();
    const c = await renderComponent(<OfficeHoursCard version={1} />);
    const form = await waitForElement(c, '.office-hours-form');

    const start = form.querySelector('#oh-start')!;
    const end = form.querySelector('#oh-end')!;
    // `.oh-time`, not `closest('div')`: the field is now a TimeField, whose own
    // flex wrapper is the nearest div. The claim is about the CELL either way.
    const startCell = start.closest('.oh-time')!;
    const endCell = end.closest('.oh-time')!;

    // Same wrapper class == same width rule; adjacent == "To" cannot drift away.
    expect(startCell.className).toBe('oh-time');
    expect(endCell.className).toBe('oh-time');
    expect(startCell.nextElementSibling).toBe(endCell);
  });

  it('drops the three-column grid that stranded them', async () => {
    stub();
    const c = await renderComponent(<OfficeHoursCard version={1} />);
    await waitForElement(c, '.office-hours-form');
    // `.row3` is 1fr 1fr 1fr, so six controls wrapped to two rows of thirds and
    // a 7rem time input sat in a cell a third of the card wide.
    expect(c.querySelector('.row3')).toBeNull();
  });

  it('keeps the hint out of the control row, so the inputs share a baseline', async () => {
    stub();
    const c = await renderComponent(<OfficeHoursCard version={1} />);
    const form = await waitForElement(c, '.office-hours-form');
    expect(form.querySelector('p.hint')).toBeNull();
    // Still present, just below the row — and it must describe the control that
    // is actually there: the field offers 24:00 now, so the old "00:00 means
    // midnight at the end" reading of it would be a lie in the UI.
    expect(c.textContent).toContain('24:00');
    expect(c.textContent, 'the old 00:00 pun is gone from the control and the hint')
      .not.toContain('00:00 in');
  });

  it('sizes every field by what it holds', async () => {
    stub();
    const c = await renderComponent(<OfficeHoursCard version={1} />);
    const form = await waitForElement(c, '.office-hours-form');
    expect(form.querySelector('.oh-days')).not.toBeNull();
    expect(form.querySelectorAll('.oh-time')).toHaveLength(2);
    expect(form.querySelectorAll('.oh-text')).toHaveLength(2);
    expect(form.querySelector('.oh-action')).not.toBeNull();
  });
});

describe('settings tabs: one group visible, sidebar navigation', () => {
  it('declares every group once, in a fixed order', () => {
    // New settings join a group; they must not become an eighth tab by
    // accident or an untabbed section. The count below is the contract.
    const groups = [...VIEW.matchAll(/\{ key: '(\w+)', label: '([^']+)' \}/g)].map((m) => m[1]);
    expect(groups).toEqual(['general', 'providers', 'notifications', 'integrations', 'scheduling', 'governance', 'workers']);
  });

  it('renders every section inside exactly one group gate', () => {
    // Each <section> opens under `{group === '<key>' && (` — a section outside
    // any gate would render on every tab, and one under two gates would
    // render twice. Count gates per section via the heading each block holds.
    const gates = [...VIEW.matchAll(/\{group === '(\w+)' && \(\n\s+<section/g)].map((m) => m[1]);
    expect(gates).toHaveLength(20);
    const valid = new Set(['general', 'providers', 'notifications', 'integrations', 'scheduling', 'governance', 'workers']);
    for (const g of gates) expect(valid.has(g), `unknown group gate: ${g}`).toBe(true);
    // Scheduling owns three sections; workers owns one.
    expect(gates.filter((g) => g === 'scheduling')).toHaveLength(3);
    expect(gates.filter((g) => g === 'workers')).toHaveLength(1);
  });

  it('keeps every anchor id the deep links use', () => {
    // Capability-matrix "Show me" links and GROUP_FOR_ANCHOR resolve these;
    // renaming one orphans a link with no failing assertion elsewhere.
    for (const a of ['byok-providers', 'cli-engines', 'event-triggers', 'github', 'office-hours', 'quiet-hours', 'retention', 'earned-autonomy', 'workers', 'check-for-updates']) {
      expect(VIEW, `anchor ${a} missing`).toContain(`id="${a}"`);
      expect(VIEW, `anchor ${a} has no group mapping`).toContain(`'${a}'`);
    }
  });

  it('the nav names every group and marks tabs accessibly', () => {
    expect(VIEW).toContain('role="tablist"');
    expect(VIEW).toContain('role="tab"');
    expect(VIEW).toContain('aria-selected={group === g.key}');
    expect(VIEW).toContain('data-testid={`settings-nav-${g.key}`}');
    expect(VIEW).toContain('role="tabpanel"');
  });

  it('the group grid keeps the card flow, and stacks on narrow windows', () => {
    expect(CSS).toMatch(/\.settings-group\s*\{[^}]*grid-auto-flow:\s*row dense/);
    expect(CSS).toMatch(/\.settings-nav\s*\{[^}]*flex-direction:\s*column/);
    expect(CSS).toContain('@media (max-width: 720px)');
  });
});

describe('settings tab switching', () => {
  const json = (b: unknown): Response =>
    new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

  async function mountSettings(): Promise<HTMLDivElement> {
    const { default: SettingsView } = await import('../src/components/SettingsView');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: unknown) => {
        const p = String(u).split('?')[0];
        // Shapes the cards actually read: lists stay lists, objects stay
        // objects. A bare {} everywhere renders some cards into a crash
        // (WorkersCard maps tasks), which would test the stub, not the tabs.
        if (p === '/tasks' || p === '/profiles' || p === '/triggers' || p === '/calendars/ics') return json([]);
        if (p === '/workers') return json({ workers: [] });
        if (p === '/capabilities') return json({ tier: 'free', features: [], entitlement: { tier: 'free', state: 'none' } });
        if (p === '/workforce/office-hours') return json({ enabled: false, windows: [] });
        return json({});
      }),
    );
    const container = await renderComponent(<SettingsView version={1} />);
    await waitForElement(container, '[data-testid="settings-nav-general"]');
    return container;
  }

  it('shows General first and switches groups on nav clicks', async () => {
    const container = await mountSettings();
    expect(container.querySelector('[data-testid="settings-group-general"]')).not.toBeNull();
    expect(container.textContent).toContain('Appearance');
    expect(container.querySelector('[data-testid="settings-group-workers"]')).toBeNull();
    (container.querySelector('[data-testid="settings-nav-workers"]') as HTMLButtonElement).click();
    await waitForElement(container, '[data-testid="settings-group-workers"]');
    expect(container.textContent).toContain('Workers');
    expect(container.querySelector('[data-testid="settings-group-general"]')).toBeNull();
    const active = container.querySelector('[data-testid="settings-nav-workers"]') as HTMLButtonElement;
    expect(active.getAttribute('aria-selected')).toBe('true');
  });

  it('an anchor request activates its group', async () => {
    const container = await mountSettings();
    expect(container.querySelector('[data-testid="settings-group-integrations"]')).toBeNull();
    // The capability-matrix "Show me" path: revealFeatureSurface invokes the
    // activator SettingsView registered on mount. scrollIntoView is a no-op
    // in jsdom by design; the group switch is what this proves.
    const { revealFeatureSurface } = await import('../src/components/featureSurfaces');
    (Element.prototype as any).scrollIntoView = () => {};
    revealFeatureSurface({ key: 'github_pr', tab: 'settings', where: 'Settings › GitHub', anchorId: 'github' });
    await waitForElement(container, '[data-testid="settings-group-integrations"]');
    await waitForText(container, 'GitHub');
  });

  it('arrow keys walk the tabs with a roving tabindex', async () => {
    const container = await mountSettings();
    const general = container.querySelector('[data-testid="settings-nav-general"]') as HTMLButtonElement;
    general.focus();
    expect(general.tabIndex).toBe(0);
    expect((container.querySelector('[data-testid="settings-nav-workers"]') as HTMLButtonElement).tabIndex).toBe(-1);
    general.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await waitForElement(container, '[data-testid="settings-group-workers"]');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('settings-nav-workers');
    (document.activeElement as HTMLButtonElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await waitForElement(container, '[data-testid="settings-group-general"]');
  });
});
