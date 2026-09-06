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

async function render(node: JSX.Element): Promise<HTMLDivElement> {
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  createRoot(container).render(node);
  await new Promise((r) => setTimeout(r, 40));
  return container;
}

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
    const { default: ComposerView } = await import('../src/components/ComposerView');
    // Far-future date, same construction the bug report used (20 Dec, a Sunday).
    const target = new Date(2026, 11, 20, 14, 0, 0);
    const container = await render(
      <ComposerView onDone={() => {}} prefill={{ runAtLocal: target.toISOString() }} />,
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
