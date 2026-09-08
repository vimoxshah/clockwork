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
import { renderComponent, waitForElement } from './helpers/dom';
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

describe('the page is one grid, not a stack with two-column islands', () => {
  it('has no `settings-grid` island left', () => {
    // The two islands began at "Usage & limits" and "CLI engines", which is why
    // a second column appeared two thirds of the way down the page.
    expect(VIEW).not.toContain('settings-grid');
    expect(CSS).not.toContain('.settings-grid');
  });

  it('wraps every section in a card of the one grid', () => {
    const cards = VIEW.match(/className="settings-card/g) ?? [];
    const titles = VIEW.match(/className="section-title/g) ?? [];
    expect(cards.length).toBeGreaterThanOrEqual(14);
    // One card per section heading — a heading outside a card is a section that
    // would not take part in the column flow.
    expect(cards.length).toBe(titles.length);
  });

  it('stops a card stretching, and backfills the holes a full-row card leaves', () => {
    // Deliberately NOT claiming this removes all whitespace: a grid row is
    // still as tall as its tallest one-span card. What it removes is the
    // half-screen — "Usage & limits" no longer shares a two-cell row with the
    // tallest section on the page.
    expect(CSS).toMatch(/\.settings-page\s*\{[^}]*align-items:\s*start/);
    expect(CSS).toMatch(/\.settings-page\s*\{[^}]*grid-auto-flow:\s*row dense/);
  });

  it('starts the columns at the FIRST section, not two thirds down', () => {
    // SET-1's first clause. Every section heading opens a card, so there is no
    // run of full-width single-column content before the grid begins — which is
    // what made the second column appear mid-page.
    // Walk the file once, in order, instead of grepping a window behind each
    // heading — a fixed lookback matches a card opened for a DIFFERENT section
    // and would pass on a page that had drifted back into islands.
    const tokens = [...VIEW.matchAll(/<section className="settings-card|<\/section>|<h3 className="section-title/g)];
    let depth = 0;
    let headings = 0;
    for (const t of tokens) {
      if (t[0].startsWith('<section')) depth++;
      else if (t[0] === '</section>') depth = Math.max(0, depth - 1);
      else {
        headings++;
        expect(depth, `the heading at ${t.index} is not inside a settings-card`).toBeGreaterThan(0);
      }
    }
    expect(headings).toBeGreaterThanOrEqual(14);
  });

  it('collapses to one column by track floor rather than a breakpoint', () => {
    expect(CSS).toMatch(/repeat\(auto-fill,\s*minmax\(min\(100%,\s*26rem\),\s*1fr\)\)/);
  });
});
