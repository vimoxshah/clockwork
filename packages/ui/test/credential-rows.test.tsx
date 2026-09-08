/**
 * The shape behind "see alignment of all buttons Save Clear".
 *
 * Every credential row in Settings › Notifications & delivery used to be a
 * .tasklist-row: flex, align-items:center, with a .grow field taking whatever
 * the buttons left. Two visible faults came out of that, both measured in
 * Chromium at 1440px by tools/probe-layout.mjs:
 *
 *   - the field's right edge moved with the BUTTON COUNT — 1213 on the Slack
 *     row (Save · Send test · Clear) against 1287 on the Telegram row;
 *   - align-items:center put SMTP's Save/Clear against the middle of a block
 *     holding two fields and two hints, so they sat level with the STARTTLS
 *     sentence instead of the relay field they act on.
 *
 * After: every field ends at 1179, every Save begins at 1297, every Clear at
 * 1353, and every button's centre is level with its own input (dCentre 0).
 *
 * Source-level, for the reason settings-layout.test.tsx gives: SettingsView
 * reaches a dozen endpoints and rendering it here tests the stubs rather than
 * the layout — it does not survive jsdom at all. jsdom has no layout engine
 * either, so the numbers above cannot be asserted anywhere but the probe. What
 * is pinned here is the structure they depend on. Revert the CSS and the
 * numbers come back; revert the markup and these fail.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const VIEW = readFileSync(path.resolve(import.meta.dirname, '../src/components/SettingsView.tsx'), 'utf8');
const CSS = readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

/** The `.cred-row` block of the stylesheet, so a rule elsewhere cannot satisfy these. */
const credRowCss = ((): string => {
  const start = CSS.indexOf('.cred-row {');
  expect(start, '.cred-row must exist in styles.css').toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf('@media (max-width: 720px)', start));
})();

describe('Settings › Notifications & delivery — credential rows', () => {
  it('is a grid with a FIXED action track, so the field cannot shrink to fit buttons', () => {
    // This is the whole fix for the ragged right edge: a fixed second column
    // means the field is `1fr` of a constant remainder whatever the row holds.
    expect(credRowCss).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+13\.5rem/);
    expect(credRowCss).toContain('display: grid');
  });

  it('places the actions on the FIELD row, not centred on the whole block', () => {
    // Named areas are what keep Save/Clear level with their own input when the
    // hint wraps to three lines or a second field sits underneath.
    expect(credRowCss).toMatch(/grid-template-areas:[\s\S]*?"field\s+actions"/);
    expect(credRowCss).toContain('align-items: start');
  });

  it('gives Save and Clear their own columns rather than right-aligning the group', () => {
    // Right-aligning lines up whatever is LAST. That is why Clear agreed across
    // rows while Save sat at 1297 on four rows and 1213 on the Slack row.
    expect(credRowCss).toMatch(/grid-template-areas:\s*"test\s+save\s+clear"/);
    expect(credRowCss).toContain('.act-save { grid-area: save; }');
    expect(credRowCss).toContain('.act-clear { grid-area: clear; }');
  });

  it('uses the row on all six credentials and leaves .tasklist-row to the Tasks list', () => {
    expect(VIEW.match(/className="cred-row"/g) ?? []).toHaveLength(6);
    // The delivery card is the region between its heading and the next one.
    const card = VIEW.slice(VIEW.indexOf('Telegram bot token'), VIEW.indexOf('Send test email to'));
    expect(card, 'no credential row may still be a tasklist-row').not.toContain('tasklist-row');
  });

  it('tags every Save and Clear so they land in a column', () => {
    expect(VIEW.match(/act-save/g) ?? []).toHaveLength(4);
    expect(VIEW.match(/act-clear/g) ?? []).toHaveLength(4);
    expect(VIEW.match(/act-test/g) ?? []).toHaveLength(3);
  });

  it('marks the two test-only rows so they do not sit in an empty Save column', () => {
    expect(VIEW.match(/cred-actions--single/g) ?? []).toHaveLength(2);
    expect(credRowCss).toContain('.cred-actions--single');
  });

  it('keeps SMTP\'s second field out of the row that carries the actions', () => {
    const smtp = VIEW.slice(VIEW.indexOf('htmlFor="smtp-url"'), VIEW.indexOf('htmlFor="smtp-test-to"'));
    // `From address` in `extra`, below the hint. Leaving it beside the relay
    // field is what centred Save/Clear on the whole block.
    expect(smtp).toContain('className="cred-extra"');
    expect(smtp.indexOf('cred-extra')).toBeLessThan(smtp.indexOf('htmlFor="smtp-from"'));
    expect(smtp).toContain('className="cred-field"');
  });

  it('stops the single-column fallback squeezing the field on a narrow window', () => {
    const narrow = CSS.slice(CSS.indexOf('@media (max-width: 720px)', CSS.indexOf('.cred-row {')));
    expect(narrow).toMatch(/grid-template-areas:\s*"label"\s*"field"\s*"hint"\s*"actions"\s*"extra"/);
  });
});
