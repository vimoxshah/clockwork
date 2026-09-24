/**
 * NL schedule field (P1): typing maps through the parser into builder state.
 *
 * Two things this holds: the draft→form mapping is TOTAL (every parser draft
 * field lands in a builder field — an interval that forgot its window would
 * preview one rule and save another), and a failed parse touches nothing
 * (the last good builder state stands, error + hint shown instead).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import NlScheduleField, { applyLiveText, draftToForm } from '../src/components/NlScheduleField';
import { parseNaturalSchedule } from '../src/lib/natural-schedule';
import { renderComponent, waitForElement, waitForText } from './helpers/dom';

afterEach(() => {
  vi.unstubAllGlobals();
});

function type(input: Element | null, value: string): void {
  expect(input, 'field missing from the DOM').not.toBeNull();
  const el = input as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('draftToForm is total', () => {
  it('maps weekly draft into builder fields', () => {
    const r = parseNaturalSchedule({ text: 'every Mon 2am', nowMs: Date.UTC(2026, 8, 23, 12), tz: 'America/New_York' });
    expect(r.kind).toBe('rrule');
    if (r.kind !== 'rrule') throw new Error('unreachable');
    expect(draftToForm(r)).toMatchObject({ kind: 'rrule', rruleFreq: 'WEEKLY', rruleByDay: ['MO'], rruleTime: '2:00' });
  });

  it('maps interval draft with its window, not defaults', () => {
    const r = parseNaturalSchedule({ text: 'every 15 minutes on weekdays 9 to 17', nowMs: Date.UTC(2026, 8, 23, 12), tz: 'UTC' });
    expect(r.kind).toBe('rrule');
    if (r.kind !== 'rrule') throw new Error('unreachable');
    expect(draftToForm(r)).toMatchObject({
      kind: 'rrule',
      rruleFreq: 'INTERVAL',
      intervalEvery: 15,
      intervalDays: ['MO', 'TU', 'WE', 'TH', 'FR'],
      intervalFromHour: '9',
      intervalToHour: '17',
    });
  });

  it('maps monthly dom and one-off times', () => {
    const m = parseNaturalSchedule({ text: 'monthly on the 15th at 9am', nowMs: Date.UTC(2026, 8, 23, 12), tz: 'UTC' });
    if (m.kind !== 'rrule') throw new Error('unreachable');
    expect(draftToForm(m)).toMatchObject({ rruleFreq: 'MONTHLY', monthlyDay: '15', rruleTime: '9:00' });
    const o = parseNaturalSchedule({ text: 'tomorrow 9am', nowMs: Date.UTC(2026, 8, 23, 12), tz: 'UTC' });
    if (o.kind !== 'once') throw new Error('unreachable');
    const applied = draftToForm(o);
    expect(applied).toMatchObject({ kind: 'once' });
    if (applied?.kind === 'once') expect(applied.runAt.getTime()).toBeGreaterThan(Date.UTC(2026, 8, 23, 12));
  });

  it('errors map to null (builder untouched)', () => {
    expect(draftToForm({ kind: 'error', message: 'x', hint: 'y' })).toBeNull();
  });
});

describe('field behavior', () => {
  function stubPreview(): void {
    vi.stubGlobal(
      'fetch',
      (async (url: unknown) => {
        if (String(url).includes('/schedule/preview')) {
          return new Response(JSON.stringify({ runs: [1, 2, 3, 4, 5], tz: 'America/New_York', count: 5 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected request: ${String(url)}`);
      }) as any,
    );
  }

  it('previews a candidate and applies only on click', async () => {
    stubPreview();
    const applied: unknown[] = [];
    const container = await renderComponent(<NlScheduleField tz="America/New_York" onApply={(a) => applied.push(a)} />);
    await waitForElement(container, '[data-testid="nl-schedule-input"]');
    type(container.querySelector('[data-testid="nl-schedule-input"]'), 'every Mon 2am');
    await waitForText(container, 'Every Monday at 2:00 AM');
    // Typing alone applies nothing — the builder is untouched until Apply.
    expect(applied).toEqual([]);
    (container.querySelector('[data-testid="nl-schedule-apply"]') as HTMLButtonElement).click();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ kind: 'rrule', rruleFreq: 'WEEKLY', rruleByDay: ['MO'] });
  });

  it('a failed parse shows guidance and applies nothing', async () => {
    stubPreview();
    const applied: unknown[] = [];
    const container = await renderComponent(<NlScheduleField tz="America/New_York" onApply={(a) => applied.push(a)} />);
    await waitForElement(container, '[data-testid="nl-schedule-input"]');
    type(container.querySelector('[data-testid="nl-schedule-input"]'), 'every other Monday');
    await waitForElement(container, '[data-testid="nl-schedule-error"]');
    expect(applied).toEqual([]);
    expect(container.querySelector('[data-testid="nl-schedule-apply"]')).toBeNull();
  });

  it('applyLiveText books the argument text, never a stale candidate', () => {
    // The same-tick race (click before React disables Apply) cannot be
    // staged through dispatch — React drops clicks on disabled buttons even
    // synthetic ones (probed). So the decision itself is unit-proven here:
    // the handler passes live text, and live text wins.
    const applied: unknown[] = [];
    expect(applyLiveText('every Tue 3am', 'America/New_York', (a) => applied.push(a))).toBe(true);
    expect(applied[0]).toMatchObject({ kind: 'rrule', rruleFreq: 'WEEKLY', rruleByDay: ['TU'], rruleTime: '3:00' });
    // Garbage-attached text still books (with a loud warning), while true
    // garbage books nothing — the line is silent-vs-loud, not book-vs-refuse.
    expect(applyLiveText('every Mon 2amx', 'America/New_York', (a) => applied.push(a))).toBe(true);
    expect(applied).toHaveLength(2);
    expect(applyLiveText('blorple', 'America/New_York', (a) => applied.push(a))).toBe(false);
    expect(applied).toHaveLength(2);
  });
});
