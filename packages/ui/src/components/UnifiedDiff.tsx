/**
 * UnifiedDiff — virtualized 10k-line diff for ReportDetail (Round 4C).
 *
 * Why this exists: ReportDetail rendered the whole transcript in one
 * `<pre>`. At 10k lines that is 10k DOM nodes, one layout, dropped
 * frames on scroll. This renders only the viewport window plus
 * OVERSCAN rows above/below, with variable row height via an
 * estimated 22px slot plus per-row measurement.
 *
 * No dependency: no react-window in package.json, and adding one for
 * a single list is the wrong trade. ~120 lines of windowing instead.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type DiffKind = 'add' | 'del' | 'ctx' | 'hunk';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** Variable-height tuning: measured average wrapped row in the report pane. */
export const EST_ROW_PX = 22;
/** Rows rendered above/below the viewport so fast scroll never shows blank. */
export const OVERSCAN = 10;
/** Above this many lines parsing moves off the main thread. */
export const WORKER_CUTOFF = 5000;

/** Sync parse: classify a unified diff / transcript dump into rows. */
export function parseUnifiedDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const raw of text.split('\n')) {
    if (raw.startsWith('@@')) out.push({ kind: 'hunk', text: raw });
    else if (raw.startsWith('+') && !raw.startsWith('+++')) out.push({ kind: 'add', text: raw });
    else if (raw.startsWith('-') && !raw.startsWith('---')) out.push({ kind: 'del', text: raw });
    else out.push({ kind: 'ctx', text: raw });
  }
  return out;
}

/**
 * Async parse: Worker above WORKER_CUTOFF lines, sync below, sync fallback
 * when Workers are unavailable (jsdom, SSR, CSP without worker-src).
 */
export function parseDiffAsync(text: string): Promise<DiffLine[]> {
  if (text.split('\n').length < WORKER_CUTOFF) return Promise.resolve(parseUnifiedDiff(text));
  try {
    const w = new Worker(new URL('./diff-parse.worker', import.meta.url), { type: 'module' });
    return new Promise((resolve) => {
      const to = setTimeout(() => {
        w.terminate();
        resolve(parseUnifiedDiff(text));
      }, 3000);
      w.onmessage = (e: MessageEvent<DiffLine[]>): void => {
        clearTimeout(to);
        w.terminate();
        resolve(e.data);
      };
      w.onerror = (): void => {
        clearTimeout(to);
        w.terminate();
        resolve(parseUnifiedDiff(text));
      };
      w.postMessage(text);
    });
  } catch {
    return Promise.resolve(parseUnifiedDiff(text));
  }
}

const Row = memo(function Row({
  line,
  index,
  active,
  onMeasure,
}: {
  line: DiffLine;
  index: number;
  active: boolean;
  onMeasure: (index: number, height: number) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight || EST_ROW_PX;
    if (h !== EST_ROW_PX) onMeasure(index, h);
  }, [index, line.text, onMeasure]);
  const cls =
    line.kind === 'add' ? 'ud-add' : line.kind === 'del' ? 'ud-del' : line.kind === 'hunk' ? 'ud-hunk' : 'ud-ctx';
  return (
    <div
      ref={ref}
      id={`ud-row-${index}`}
      role="option"
      aria-selected={active}
      data-testid={`ud-row-${line.kind}`}
      className={`ud-row ${cls}${active ? ' ud-active' : ''}`}
    >
      <span className="ud-gutter mono" aria-hidden="true">
        {index + 1}
      </span>
      <code className="mono">{line.text || ' '}</code>
    </div>
  );
});

export default function UnifiedDiff({
  lines,
  height = 480,
}: {
  lines: DiffLine[];
  height?: number;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [active, setActive] = useState(0);
  const heights = useRef<Map<number, number>>(new Map());

  const onMeasure = useCallback((index: number, h: number): void => {
    if (heights.current.get(index) !== h) heights.current.set(index, h);
  }, []);

  // Prefix offsets from measured heights, EST_ROW_PX elsewhere.
  const offsets = useMemo(() => {
    const off = new Array<number>(lines.length + 1);
    off[0] = 0;
    for (let i = 0; i < lines.length; i++) {
      off[i + 1] = off[i]! + (heights.current.get(i) ?? EST_ROW_PX);
    }
    return off;
  }, [lines, scrollTop]);

  const total = offsets[lines.length] ?? lines.length * EST_ROW_PX;

  // Binary search: first row whose bottom edge passes scrollTop.
  const startIndex = useMemo(() => {
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((offsets[mid + 1] ?? 0) < scrollTop) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - OVERSCAN);
  }, [offsets, scrollTop, lines.length]);

  const endIndex = useMemo(() => {
    const visible = Math.ceil(height / EST_ROW_PX) + OVERSCAN * 2;
    return Math.min(lines.length, startIndex + visible);
  }, [startIndex, height, lines.length]);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    // rAF-throttle: coalesce scroll events into one state write per frame.
    requestAnimationFrame(() => setScrollTop(top));
  }, []);

  // Keyboard-only triage inside the diff: j/k/arrows move, PgUp/PgDn jump.
  const onKey = useCallback(
    (e: React.KeyboardEvent): void => {
      const el = scrollRef.current;
      let next: number | null = null;
      if (e.key === 'j' || e.key === 'ArrowDown') next = Math.min(lines.length - 1, active + 1);
      else if (e.key === 'k' || e.key === 'ArrowUp') next = Math.max(0, active - 1);
      else if (e.key === 'PageDown') next = Math.min(lines.length - 1, active + Math.ceil(height / EST_ROW_PX));
      else if (e.key === 'PageUp') next = Math.max(0, active - Math.ceil(height / EST_ROW_PX));
      if (next === null) return;
      e.preventDefault();
      setActive(next);
      if (el) el.scrollTop = Math.max(0, (offsets[next] ?? next * EST_ROW_PX) - height / 2);
    },
    [active, height, lines.length, offsets],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, (offsets[active] ?? active * EST_ROW_PX) - height / 2);
  }, [active]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      onKeyDown={onKey}
      tabIndex={0}
      role="listbox"
      aria-label={`Diff, ${lines.length} lines`}
      aria-activedescendant={`ud-row-${active}`}
      data-testid="unified-diff"
      className="ud-scroll mono"
      style={{ height, overflowY: 'auto', position: 'relative' }}
    >
      <div style={{ height: total, position: 'relative' }}>
        {lines.slice(startIndex, endIndex).map((line, i) => {
          const index = startIndex + i;
          const top = offsets[index] ?? index * EST_ROW_PX;
          return (
            <div key={index} style={{ position: 'absolute', top, left: 0, right: 0 }}>
              <Row line={line} index={index} active={index === active} onMeasure={onMeasure} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
