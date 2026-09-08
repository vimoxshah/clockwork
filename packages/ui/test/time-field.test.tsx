/**
 * TimeField, after "wherever we are asking time we should give user to select
 * it and use same component".
 *
 * There were three different answers to "what time?" before this: a native
 * `<input type="time">` on the composer's recurring tab, two more in Office
 * hours, and a pair of bare number inputs for the interval window. A native
 * time input in WKWebView — the engine the desktop window actually runs — is
 * an OS widget that ignores the theme, which is the same fault already fixed
 * once in the date picker.
 *
 * The two things worth pinning are not the styling. A control on a 5-minute
 * grid that cannot render a stored :37 moves the user's saved time the moment
 * they open the form, and a control that spells 24:00 as "12 AM" makes the end
 * of the day indistinguishable from the start of it.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { renderComponent, waitForElement } from './helpers/dom';
import { openOptions, pickOption } from './helpers/radix';
import { TimeField, minuteOptions, timeStringToMinutes, minutesToTimeString, END_OF_DAY } from '../src/components/ui/time-field';

afterEach(() => {
  document.body.innerHTML = '';
});

function hourLabel(h: number): string {
  return new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
}

describe('TimeField', () => {
  it('is not a native control — that is the whole report', async () => {
    const c = await renderComponent(<TimeField testIdPrefix="t" value={9 * 60} onChange={() => {}} />);
    await waitForElement(c, '[data-testid="t-hour"]');
    expect(c.querySelectorAll('select'), 'a native select is an OS popup in WKWebView').toHaveLength(0);
    expect(c.querySelectorAll('input[type="time"]'), 'so is a native time input').toHaveLength(0);
    // And it did not satisfy that by rendering nothing.
    expect(c.querySelector('[data-testid="t-minute"]')).not.toBeNull();
  });

  it('shows a stored off-grid minute and hands it back unchanged', async () => {
    // 09:37 is not on the 5-minute grid. A pure grid would display 09:35 and
    // then write 09:35 back the next time anything touched the field.
    const seen: number[] = [];
    const c = await renderComponent(
      <TimeField testIdPrefix="t" value={9 * 60 + 37} onChange={(m) => seen.push(m)} />,
    );
    const minute = await waitForElement(c, '[data-testid="t-minute"]');
    expect(minute.textContent?.trim(), 'the stored minute, not the nearest grid line').toBe('37');
    expect(seen, 'rendering must not change the value').toEqual([]);

    await pickOption(c.querySelector('[data-testid="t-hour"]'), hourLabel(11));
    expect(seen, 'changing the hour keeps the off-grid minute').toEqual([11 * 60 + 37]);
  });

  it('keeps the minute list short by offering the grid plus whatever is stored', () => {
    expect(minuteOptions(5, 0)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(minuteOptions(5, 37)).toContain(37);
    expect(minuteOptions(5, 37), 'the stored value is added, not substituted').toContain(35);
    expect(minuteOptions(5, 37)).toHaveLength(13);
  });

  it('offers 24:00 only where an end of day is meaningful', async () => {
    const plain = await renderComponent(<TimeField testIdPrefix="p" value={0} onChange={() => {}} />);
    expect((await openOptions(plain.querySelector('[data-testid="p-hour"]'))).map((o) => o.textContent?.trim()))
      .not.toContain('24:00');
    document.body.innerHTML = '';

    const seen: number[] = [];
    const end = await renderComponent(
      <TimeField testIdPrefix="e" allowEndOfDay value={17 * 60} onChange={(m) => seen.push(m)} />,
    );
    await pickOption(end.querySelector('[data-testid="e-hour"]'), '24:00');
    expect(seen, '24:00 is 1440, never 0').toEqual([END_OF_DAY]);
  });

  it('renders 1440 as 24:00 rather than as the "12 AM" it collides with', async () => {
    const c = await renderComponent(
      <TimeField testIdPrefix="e" allowEndOfDay value={END_OF_DAY} onChange={() => {}} />,
    );
    const hour = await waitForElement(c, '[data-testid="e-hour"]');
    expect(hour.textContent?.trim()).toBe('24:00');
    expect(hour.textContent?.trim(), 'the whole point is that it differs from midnight')
      .not.toBe(hourLabel(0));
  });

  it('drops the minute control where the grain is whole hours', async () => {
    const c = await renderComponent(<TimeField testIdPrefix="h" hourOnly value={9 * 60} onChange={() => {}} />);
    await waitForElement(c, '[data-testid="h-hour"]');
    expect(c.querySelector('[data-testid="h-minute"]'), 'an hour window has no minutes to pick').toBeNull();
  });

  it('converts to and from the "HH:MM" the recurrence form stores', () => {
    expect(timeStringToMinutes('09:30')).toBe(570);
    expect(timeStringToMinutes('00:00')).toBe(0);
    expect(timeStringToMinutes('')).toBeNull();
    expect(timeStringToMinutes('99:99')).toBeNull();
    expect(minutesToTimeString(570)).toBe('09:30');
    // The one lossy direction, named so nobody routes an end-of-day through it.
    expect(minutesToTimeString(END_OF_DAY), '"HH:MM" cannot spell 24:00').toBe('00:00');
  });
});
