/**
 * F9 proposed-events — the PRODUCER side (plan/AGENT-WORKFORCE-SPEC.md §F9).
 *
 * The spec says a run report MAY carry `proposedEvents[]`; it never said who
 * writes them. This module is that writer. An agent asks for a calendar
 * suggestion by emitting one fenced block in its final summary:
 *
 *     ```clockwork-events
 *     [{ "title": "Review PR 42", "durationMin": 10, "notes": "…",
 *        "suggestedAt": "2026-09-08T15:00:00Z" }]
 *     ```
 *
 * `run-manager.finalize()` runs `extractProposedEvents()` over the agent's
 * summary, puts the validated result on the report and stores the stripped
 * prose as the summary — the block is a machine channel, not something a
 * human should read in their inbox.
 *
 * ## The input is hostile until proven otherwise
 *
 * This text was written by a model that may have read a repository, a web
 * page or an issue comment, so it is untrusted input on the same footing as a
 * request body. Every defence here exists for a reason:
 *
 * - **Bounded at three levels** — the summary is not scanned past
 *   `MAX_INPUT_BYTES`, the block body is refused past `MAX_BLOCK_BYTES`, and
 *   at most `MAX_EVENTS` suggestions survive. Only the FIRST block counts;
 *   later ones are stripped from the prose and otherwise ignored, so a
 *   thousand blocks cost the same as one.
 * - **`key` is assigned here, never taken from the agent.** `key` is the
 *   React list key in the inbox AND the `<runId>-<key>@clockwork.local` UID in
 *   the downloadable .ics, where a duplicate silently overwrites a real
 *   calendar entry. Agent-chosen keys could collide by accident or on
 *   purpose; `ev-1…ev-N` cannot.
 * - **C0/C1 control characters are stripped** from title and notes. The ICS
 *   writer escapes `\` `;` `,` and `\n` (RFC 5545 §3.3.11) but not a bare
 *   `\r`, and its physical lines are joined with CRLF — so a control
 *   character reaching it is calendar-injection surface. Nothing with one
 *   ever gets that far.
 * - **Secrets are masked before the length clamp.** `maskSecrets` can GROW a
 *   string (`token:x` → `token=[MASKED]`), so masking after the clamp would
 *   push a title back over `max(200)` and lose the whole suggestion.
 * - **Nothing here throws.** The run is already finished when this is called;
 *   a malformed block must cost the suggestions, never the report.
 */
import { ProposedEvent } from '@clockwork/shared';
import { maskSecrets } from './context.js';

/** The info string an agent puts on its fenced block. */
export const PROPOSED_EVENTS_FENCE = 'clockwork-events';

/** Summaries longer than this are not scanned at all. */
const MAX_INPUT_BYTES = 256_000;
/** A block body bigger than this is refused whole — no partial parse. */
const MAX_BLOCK_BYTES = 8_000;
/** At most this many suggestions survive one run. */
const MAX_EVENTS = 20;
const MAX_TITLE = 200;
const MAX_NOTES = 2_000;
const MS_DAY = 86_400_000;
/** A `suggestedAt` outside [now − 1y, now + 2y] is treated as "no time given". */
const PAST_WINDOW_MS = 365 * MS_DAY;
const FUTURE_WINDOW_MS = 730 * MS_DAY;

/** C0 and C1 control characters, minus TAB (U+0009) and LF (U+000A). */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export interface ProposedEventsExtraction {
  /** validated, bounded, key-assigned suggestions; `[]` when the run proposed none */
  events: ProposedEvent[];
  /** the agent's prose with every recognized block removed */
  text: string;
  /** true when at least one `clockwork-events` fence was seen */
  found: boolean;
  /** how many entries the block offered that were refused */
  rejected: number;
  /**
   * Short, user-readable account of what was refused, for a report timeline
   * note. `null` when there was nothing to say — either no block, or a block
   * that parsed whole.
   */
  reason: string | null;
}

/** A fenced block located in the summary, by line index. */
interface Block {
  openLine: number;
  /** index of the closing fence line, or -1 when the block was never closed */
  closeLine: number;
  body: string;
}

/**
 * Find every `clockwork-events` block by scanning lines. Deliberately not a
 * regular expression: this runs over model-authored text of arbitrary shape,
 * and a line scan has no backtracking behaviour to reason about.
 */
function findBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i]!.trim();
    if (!isOpeningFence(trimmed)) {
      i++;
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trim().startsWith('```')) {
        close = j;
        break;
      }
    }
    const end = close === -1 ? lines.length : close;
    blocks.push({ openLine: i, closeLine: close, body: lines.slice(i + 1, end).join('\n') });
    i = close === -1 ? lines.length : close + 1;
  }
  return blocks;
}

/** ```clockwork-events — any fence length ≥ 3, label case-insensitive, nothing else on the line. */
function isOpeningFence(trimmedLine: string): boolean {
  const m = /^`{3,}\s*([A-Za-z0-9_-]+)\s*$/.exec(trimmedLine);
  return m !== null && m[1]!.toLowerCase() === PROPOSED_EVENTS_FENCE;
}

/** Strip controls, mask credentials, clamp, trim. `null` when nothing usable is left. */
function cleanText(value: unknown, max: number, singleLine: boolean): string | null {
  if (typeof value !== 'string') return null;
  let out = value.replace(CONTROL_CHARS, '');
  if (singleLine) out = out.replace(/\n/g, ' ');
  out = maskSecrets(out).slice(0, max).trim();
  return out.length > 0 ? out : null;
}

/** A finite minute count, or `undefined` to let the schema default apply. */
function cleanDuration(value: unknown): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1_440, Math.max(1, Math.round(n)));
}

/**
 * Epoch ms from a number or an ISO-8601 string, `null` when absent, unparseable
 * or implausible. `null` is not a failure — it means "the user picks a time",
 * and the .ics writer falls back to the next whole hour. A seconds-based
 * timestamp lands in 1970 and is refused by the window check, which is the
 * intended outcome: guessing the unit would book the wrong year.
 */
function cleanSuggestedAt(value: unknown, nowMs: number): number | null {
  let ms: number;
  if (typeof value === 'number') ms = value;
  else if (typeof value === 'string') ms = Date.parse(value);
  else return null;
  if (!Number.isFinite(ms)) return null;
  ms = Math.round(ms);
  if (ms < nowMs - PAST_WINDOW_MS || ms > nowMs + FUTURE_WINDOW_MS) return null;
  return ms;
}

/**
 * One candidate → one `ProposedEvent`, or `null`.
 *
 * `title` is load-bearing, so a missing or non-string one refuses the whole
 * entry. Every other field degrades: an unusable `notes` becomes `null`, an
 * unusable `durationMin` takes the schema's 15-minute default, an unusable
 * `suggestedAt` becomes "user picks a time".
 */
function normalize(candidate: unknown, key: string, nowMs: number): ProposedEvent | null {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const raw = candidate as Record<string, unknown>;
  const title = cleanText(raw.title, MAX_TITLE, true);
  if (title === null) return null;
  const parsed = ProposedEvent.safeParse({
    key,
    title,
    notes: cleanText(raw.notes, MAX_NOTES, false),
    durationMin: cleanDuration(raw.durationMin),
    suggestedAt: cleanSuggestedAt(raw.suggestedAt, nowMs),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Pull the agent's calendar suggestions out of its final summary.
 *
 * Returns the suggestions AND the prose with every recognized block removed.
 * Never throws, and never returns anything a `ProposedEvent.parse` would
 * reject: on any doubt it returns fewer events, not looser ones.
 *
 * @param summary the agent-authored summary, exactly as the runner reported it
 * @param nowMs   reference time for the `suggestedAt` plausibility window
 */
export function extractProposedEvents(summary: string, nowMs: number = Date.now()): ProposedEventsExtraction {
  const text = typeof summary === 'string' ? summary : '';
  const none: ProposedEventsExtraction = { events: [], text, found: false, rejected: 0, reason: null };
  try {
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
      // Do not scan; say so only if the agent plausibly tried, so an ordinary
      // huge summary stays quiet.
      return text.includes(PROPOSED_EVENTS_FENCE)
        ? { ...none, found: true, reason: 'the summary was too large to scan for suggestions' }
        : none;
    }

    const lines = text.split('\n');
    const blocks = findBlocks(lines);
    if (blocks.length === 0) return none;

    // Every recognized block leaves the prose, including the ones that do not
    // contribute events — an unterminated block is the exception, since
    // removing it would swallow whatever prose followed the stray fence.
    const drop = new Set<number>();
    for (const b of blocks) {
      if (b.closeLine === -1) continue;
      for (let i = b.openLine; i <= b.closeLine; i++) drop.add(i);
    }
    const stripped = lines
      .filter((_, i) => !drop.has(i))
      .join('\n')
      .trim();

    const notes: string[] = [];
    if (blocks.length > 1) notes.push(`only the first ${PROPOSED_EVENTS_FENCE} block was read`);

    const first = blocks[0]!;
    if (first.closeLine === -1) {
      return { events: [], text: stripped, found: true, rejected: 0, reason: joinReasons([...notes, 'the block was never closed']) };
    }
    if (Buffer.byteLength(first.body, 'utf8') > MAX_BLOCK_BYTES) {
      return {
        events: [],
        text: stripped,
        found: true,
        rejected: 0,
        reason: joinReasons([...notes, `the block was larger than ${MAX_BLOCK_BYTES} bytes`]),
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(first.body);
    } catch {
      return { events: [], text: stripped, found: true, rejected: 0, reason: joinReasons([...notes, 'the block was not valid JSON']) };
    }
    if (!Array.isArray(payload)) {
      return { events: [], text: stripped, found: true, rejected: 0, reason: joinReasons([...notes, 'the block was not a JSON array']) };
    }

    const events: ProposedEvent[] = [];
    let rejected = 0;
    for (const candidate of payload) {
      if (events.length >= MAX_EVENTS) break;
      const ev = normalize(candidate, `ev-${events.length + 1}`, nowMs);
      if (ev) events.push(ev);
      else rejected++;
    }
    if (payload.length > MAX_EVENTS) notes.push(`only the first ${MAX_EVENTS} suggestions were kept`);
    if (rejected > 0) notes.push(`${rejected} suggestion${rejected === 1 ? '' : 's'} had an unusable shape and ${rejected === 1 ? 'was' : 'were'} dropped`);

    return { events, text: stripped, found: true, rejected, reason: joinReasons(notes) };
  } catch {
    // Unreachable by design; kept because this runs inside finalize() and a
    // surprise here must cost the suggestions, not the run's report.
    return none;
  }
}

function joinReasons(parts: string[]): string | null {
  return parts.length > 0 ? parts.join('; ') : null;
}
