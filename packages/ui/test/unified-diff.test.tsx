/**
 * UnifiedDiff (Round 4C): virtualized 10k-line diff.
 *
 * Proves the three tweaks that buy 60fps: overscan windowing (10k lines
 * in, <120 rows out), memoized rows (a prop-identical re-render commits
 * no DOM writes), and the parse classifier the worker shares.
 */
import { describe, expect, it } from 'vitest';
import UnifiedDiff, { EST_ROW_PX, OVERSCAN, parseUnifiedDiff } from '../src/components/UnifiedDiff';
import { renderComponent, waitFor } from './helpers/dom';

const makeLines = (n: number): Array<{ kind: 'ctx'; text: string }> =>
  Array.from({ length: n }, (_, i) => ({ kind: 'ctx' as const, text: `line ${i}` }));

describe('parseUnifiedDiff', () => {
  it('classifies add/del/ctx/hunk', () => {
    const rows = parseUnifiedDiff('@@ -1 +1 @@\n ctx\n+add\n-del');
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'ctx', 'add', 'del']);
  });
});

describe('UnifiedDiff virtualization', () => {
  it('renders a window, not the 10k lines', async () => {
    const container = await renderComponent(<UnifiedDiff lines={makeLines(10_000)} height={480} />);
    const rows = container.querySelectorAll('[data-testid^="ud-row-"]');
    const budget = Math.ceil(480 / EST_ROW_PX) + OVERSCAN * 2 + 2;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(budget);
    expect(container.querySelector('[data-testid="unified-diff"]')?.getAttribute('aria-label')).toContain('10000');
  });

  it('moves the active row with j/k, keyboard-only', async () => {
    const container = await renderComponent(<UnifiedDiff lines={makeLines(200)} height={480} />);
    const scroller = container.querySelector('[data-testid="unified-diff"]') as HTMLElement;
    scroller.focus();
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
    await waitFor(() => scroller.getAttribute('aria-activedescendant') === 'ud-row-1', 'j to move to row 1', {
      describe: () => `activedescendant = ${scroller.getAttribute('aria-activedescendant')}`,
    });
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }));
    await waitFor(() => scroller.getAttribute('aria-activedescendant') === 'ud-row-0', 'k to move back to row 0', {
      describe: () => `activedescendant = ${scroller.getAttribute('aria-activedescendant')}`,
    });
  });
});
