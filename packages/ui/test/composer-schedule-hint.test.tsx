/**
 * Regression: the composer's one-off schedule hint dropped the date.
 * ComposerView.tsx's "Run at" button (via ui/datetime-picker.tsx's `fmt`)
 * formats with { weekday, month, day, hour, minute } — e.g. 'Sun, Dec 20,
 * 02:00 PM' — but the "Fires …" hint directly below it only passed
 * { weekday, hour, minute }, so a booking months out read as 'Fires Sun
 * 02:00 PM', which looks like THIS coming Sunday.
 *
 * Repro (from the browser findings): pick 20 Dec 2026 → button reads
 * 'Sun, Dec 20, 02:00 PM', hint read 'Fires Sun 02:00 PM (America/New_York)'.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { renderComponent, waitFor, waitForElement } from './helpers/dom';
// Statically imported, not with `await import()` inside the test — the pattern
// version-skew.test.tsx:22-25 and screen-honesty.test.tsx:25-27 already record.
// ComposerView drags Radix Select/Switch/Dialog, react-day-picker and the
// lucide barrel through the transform, and this file has ONE test, so nothing
// warms that cache first. Under load the dynamic import alone blew the
// per-test timeout: three of four runs at 14x CPU oversubscription died on
// `Test timed out in 30000ms` with `collect 1.47s, tests 46.97s` — the cost was
// inside the test body. At module scope it lands in collection, where no
// timeout applies. Safe here: ComposerView touches no network at module scope,
// only two registerFeatureSurface() registry writes.
import ComposerView from '../src/components/ComposerView';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function stubComposerFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const path = String(url).split('?')[0];
      if (path === '/profiles') return json([]);
      if (path === '/providers') return json([]);
      return json({});
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('ComposerView one-off schedule hint carries the same date as the button', () => {
  it('names the month and day in the "Fires …" hint, matching the "Run at" button', async () => {
    stubComposerFetch();
    // Far-future date, same construction the bug report used (20 Dec, a Sunday).
    const target = new Date(2026, 11, 20, 14, 0, 0);
    const container = await renderComponent(
      <ComposerView onDone={() => {}} prefill={{ runAtLocal: target.toISOString() }} />,
    );
    // ComposerView loads /profiles and /providers before it draws the form, so
    // this waits for the two nodes the test reads rather than for 40ms.
    await waitForElement(container, '#c-when');
    await waitFor(
      () => [...container.querySelectorAll('p')].some((p) => (p.textContent ?? '').startsWith('Fires')),
      'the "Fires …" hint paragraph',
      { describe: () => `paragraphs = ${JSON.stringify([...container.querySelectorAll('p')].map((p) => p.textContent))}` },
    );

    const button = container.querySelector('#c-when');
    expect(button, '"Run at" button missing').not.toBeNull();
    const buttonText = button!.textContent ?? '';
    expect(buttonText).toContain('Dec');
    expect(buttonText).toContain('20');

    const hint = [...container.querySelectorAll('p')].find((p) => (p.textContent ?? '').startsWith('Fires'));
    expect(hint, '"Fires …" hint missing').not.toBeUndefined();
    const hintText = hint!.textContent ?? '';
    expect(hintText).toContain('Dec');
    expect(hintText).toContain('20');
  });
});
