/**
 * Where the two optional delivery sections live in the composer's grid.
 *
 * Reported as "one side is having empty space and right side is having data":
 * Telegram approvals and Slack-and-email sat at the bottom of the narrow side
 * column, each carrying a paragraph of explanation, so the grid row grew to
 * their height and left 437px of white space beside "Budget & limits" —
 * measured at 1440px in Chromium by tools/shoot-composer.mjs, which prints 0
 * after this change.
 *
 * jsdom has no layout engine, so this file cannot measure that gap. What it
 * CAN pin is the structural fact the measurement depends on: those two
 * sections are children of a full-width row, not of the side column. If
 * someone moves them back, the pixels come back with them.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { renderComponent, waitForElement } from './helpers/dom';
// Statically imported for the reason composer-schedule-hint.test.tsx records:
// ComposerView pulls Radix, react-day-picker and the lucide barrel through the
// transform, and a dynamic import here blows the per-test timeout.
import ComposerView from '../src/components/ComposerView';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const path = String(url).split('?')[0];
      if (path === '/profiles') return json([]);
      if (path === '/providers') return json([]);
      if (path === '/byok') return json({ configs: [] });
      return json({});
    }),
  );
}

/** The grid child that contains this heading, i.e. the column it sits in. */
function columnFor(root: HTMLElement, heading: string): HTMLElement {
  const grid = root.querySelector<HTMLElement>('#c-prompt')?.closest('.grid');
  expect(grid, 'composer grid not found').not.toBeNull();
  const h = [...root.querySelectorAll('h3')].find((n) => (n.textContent ?? '').trim() === heading);
  expect(h, `section "${heading}" missing`).not.toBeUndefined();
  const col = [...grid!.children].find((c) => c.contains(h!));
  expect(col, `"${heading}" is not inside the composer grid`).not.toBeUndefined();
  return col as HTMLElement;
}

describe('composer grid — the optional delivery sections', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sits in a full-width row, not in the side column', async () => {
    stub();
    const container = await renderComponent(<ComposerView onDone={() => {}} />);
    await waitForElement(container, '#c-prompt');

    const telegram = columnFor(container, 'Telegram approvals (optional)');
    const slack = columnFor(container, 'Slack and email (optional)');
    expect(telegram, 'both optional sections share one row').toBe(slack);
    expect(telegram.className).toContain('lg:col-span-5');

    // And they are NOT in the column that made the row tall. Agent profile is
    // the anchor, not Schedule: Schedule moved to a full-width row of its own
    // once its frequency tabs turned out to have 250px to share.
    const profile = columnFor(container, 'Agent profile');
    expect(profile.className).toContain('lg:col-span-2');
    expect(profile).not.toBe(telegram);
  });

  it('gives Schedule the full width rather than the 2/5 side column', async () => {
    // Measured, not guessed: inside the side column the four frequency tabs had
    // 250px between them and needed 251px, so "Monthly" wrapped to a second row.
    stub();
    const container = await renderComponent(<ComposerView onDone={() => {}} />);
    await waitForElement(container, '#c-prompt');
    const schedule = columnFor(container, 'Schedule');
    expect(schedule.className).toContain('lg:col-span-5');
    expect(schedule, 'its own row, not the one the delivery sections share')
      .not.toBe(columnFor(container, 'Telegram approvals (optional)'));
  });

  it('lets each column end at its own content instead of stretching', async () => {
    // Without items-start a grid child stretches to the row height, which is
    // why comparing the two columns' bottoms measured nothing before: they
    // agreed while one was half empty.
    stub();
    const container = await renderComponent(<ComposerView onDone={() => {}} />);
    await waitForElement(container, '#c-prompt');
    const grid = container.querySelector<HTMLElement>('#c-prompt')!.closest('.grid')!;
    expect(grid.className).toContain('items-start');
  });
});
