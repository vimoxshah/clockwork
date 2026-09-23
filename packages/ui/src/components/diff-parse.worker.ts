/**
 * Diff parse worker: classifies >5000-line diffs off the main thread so
 * scrolling stays at 60fps while a 10k-line report parses.
 */
import type { DiffLine } from './UnifiedDiff';

self.onmessage = (e: MessageEvent<string>): void => {
  const out: DiffLine[] = [];
  for (const raw of String(e.data).split('\n')) {
    if (raw.startsWith('@@')) out.push({ kind: 'hunk', text: raw });
    else if (raw.startsWith('+') && !raw.startsWith('+++')) out.push({ kind: 'add', text: raw });
    else if (raw.startsWith('-') && !raw.startsWith('---')) out.push({ kind: 'del', text: raw });
    else out.push({ kind: 'ctx', text: raw });
  }
  (self as unknown as { postMessage: (m: DiffLine[]) => void }).postMessage(out);
};
