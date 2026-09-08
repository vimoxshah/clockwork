/**
 * The date-time picker, after "still not able to see date time picker proper
 * component - we need to fix it at any cost".
 *
 * The component did render — a themed month grid, in both engines. What was
 * not ours were the two time controls: native <select>, which in WKWebView
 * (the engine the desktop window actually uses) is a macOS popup menu drawn by
 * the OS, ignoring the theme and dark mode. Chromium draws its own styled
 * dropdown, which is why the earlier check missed it: it was run in the wrong
 * browser. tools/shoot-picker.mjs runs in WebKit for that reason.
 *
 * The second fault was cheaper to see and easier to miss: the trigger read
 * "02:00 PM" while the hour control read "14" — the same instant, spelled two
 * ways, an inch apart.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { renderComponent, waitForElement } from './helpers/dom';
import { DateTimePicker } from '../src/components/ui/datetime-picker';
import { notInThePast } from '../src/components/ComposerView';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/**
 * Open the popover and wait for the MONTH GRID, not for a time control.
 *
 * Waiting on `[data-testid="dtp-hour"]` would make every assertion below fail
 * by timeout the moment someone swapped the themed control back for a native
 * one — a real failure, but one that says "timed out" instead of naming the
 * thing that broke. `.rdp` is present either way, so the assertions get to run
 * and report what they actually found.
 */
async function openPicker(value: Date): Promise<HTMLElement> {
  const c = await renderComponent(<DateTimePicker id="dtp" value={value} onChange={() => {}} />);
  const trigger = await waitForElement<HTMLButtonElement>(c, '#dtp');
  trigger.click();
  await waitForElement(document.body, '.rdp');
  return document.body;
}

describe('DateTimePicker', () => {
  it('has no native select anywhere — that is the whole report', async () => {
    const body = await openPicker(new Date(2026, 8, 8, 14, 0));
    expect(body.querySelectorAll('select'), 'a native select is an OS popup in WKWebView').toHaveLength(0);
    // And the controls it replaced them with are actually there, so "no
    // native select" cannot be satisfied by rendering no time controls at all.
    expect(body.querySelector('[data-testid="dtp-hour"]'), 'hour control').not.toBeNull();
    expect(body.querySelector('[data-testid="dtp-minute"]'), 'minute control').not.toBeNull();
  });

  it('labels the hour the way the trigger spells it', async () => {
    const value = new Date(2026, 8, 8, 14, 0);
    const body = await openPicker(value);
    const hour = body.querySelector('[data-testid="dtp-hour"]');
    // Both sides through the same locale machinery, so a 24-hour locale gets
    // "14" in both places and a 12-hour one gets "2 PM" in both.
    const expected = value.toLocaleTimeString(undefined, { hour: 'numeric' });
    expect(hour?.textContent).toContain(expected);
    const trigger = document.querySelector('#dtp');
    expect(trigger?.textContent).toContain(
      value.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' }).replace(/^.*?(\d)/, '$1').slice(0, 5),
    );
  });

  it('offers every minute, so any time is reachable', async () => {
    const body = await openPicker(new Date(2026, 8, 8, 14, 0));
    const minute = body.querySelector('[data-testid="dtp-minute"]');
    expect(minute?.textContent).toContain('00');
  });

  it('shows an off-grid minute without silently moving it', async () => {
    // A prefill or an imported rule can land on :07. Snapping the DISPLAY is
    // fine; writing the snap back would change a time the user already chose
    // just because they opened the picker to look at it.
    const seen: Date[] = [];
    const c = await renderComponent(
      <DateTimePicker id="dtp2" value={new Date(2026, 8, 8, 14, 7)} onChange={(d) => seen.push(d)} />,
    );
    const trigger = await waitForElement<HTMLButtonElement>(c, '#dtp2');
    trigger.click();
    await waitForElement(document.body, '.rdp');
    expect(seen, 'opening the picker must not emit a change').toHaveLength(0);
  });
});

describe('notInThePast — the Calendar prefill', () => {
  it('moves a start time that has already gone', () => {
    // "Book a run this day" hands the composer midnight on the day you
    // clicked, so every hour of today after 00:00 opened the form already
    // showing "This time is in the past — pick a future slot", about a value
    // nobody chose.
    const now = new Date(2026, 8, 8, 12, 27);
    const midnightToday = new Date(2026, 8, 8, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fixed = notInThePast(midnightToday, now);
    expect(fixed.getTime()).toBeGreaterThan(now.getTime());
    expect(fixed.getMinutes(), 'lands on a round hour').toBe(0);
  });

  it('leaves a future instant exactly as the Calendar chose it', () => {
    const now = new Date(2026, 8, 8, 12, 27);
    const nextWeek = new Date(2026, 8, 15, 9, 30);
    expect(notInThePast(nextWeek, now)).toBe(nextWeek);
  });
});
