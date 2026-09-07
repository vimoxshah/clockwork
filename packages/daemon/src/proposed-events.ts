/**
 * F9 proposed-events (plan/AGENT-WORKFORCE-SPEC.md §F9).
 *
 * A run report may carry `proposedEvents[]`: calendar events the agent
 * suggests ("review PR 42, 10 min"). This module renders them on demand as a
 * downloadable RFC 5545 .ics file. **Clockwork NEVER writes to the user's
 * real calendar** — this module has no write path at all: no ICS source is
 * added, no calendar is contacted, and every statement it runs is a SELECT
 * against `runs.report_json`.
 *
 * Owns no table (spec §1.1): this is a derived view over `runs.report_json`,
 * not a second source of truth. Reports are read with bare `JSON.parse` and
 * never re-validated end-to-end, so `report.proposedEvents` may be
 * `undefined`, absent, or shaped wrong (a report predating the field, or hand
 * -edited data) — each proposed event is validated individually with
 * `ProposedEvent.safeParse`, and a malformed entry is dropped rather than
 * failing the whole request.
 */
import { ProposedEvent } from '@clockwork/shared';
import type { DB } from './db.js';

const MS_HOUR = 3_600_000;

/** [] when the run has no report, no proposals, or a report predating the field */
export function proposedEventsFor(db: DB, runId: string): ProposedEvent[] {
  const row = db.prepare('SELECT report_json FROM runs WHERE id = ?').get(runId) as
    | { report_json: string | null }
    | undefined;
  if (!row || !row.report_json) return [];
  let report: unknown;
  try {
    report = JSON.parse(row.report_json);
  } catch {
    return []; // corrupt report_json — treat like "no report" rather than throwing
  }
  const raw = (report as { proposedEvents?: unknown } | null)?.proposedEvents;
  if (!Array.isArray(raw)) return [];
  const events: ProposedEvent[] = [];
  for (const candidate of raw) {
    const parsed = ProposedEvent.safeParse(candidate);
    if (parsed.success) events.push(parsed.data);
    // else: drop the bad entry — one malformed suggestion must not sink the rest
  }
  return events;
}

/** Escape SUMMARY/DESCRIPTION text per RFC 5545 §3.3.11 (order matters: backslash first). */
function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** Format epoch ms as a UTC iCalendar DATE-TIME value: YYYYMMDDTHHMMSSZ. */
function formatIcsUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Fold a content line at 75 octets (RFC 5545 §3.1). Continuation lines are
 * introduced by CRLF + a single leading SPACE, which itself counts toward
 * the 75-octet budget of that physical line, so continuations carry 74
 * content octets. Splits are byte-safe: a boundary landing inside a
 * multi-byte UTF-8 codepoint is backed off to the codepoint's start so a
 * folded/unfolded round trip never corrupts multibyte text.
 */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return parts.join('\r\n ');
}

/**
 * Next whole hour strictly after `ms`. Defined as `floor(ms / hour) * hour +
 * hour` so a `ms` that lands exactly on the hour still advances to the next
 * one rather than returning itself.
 */
function nextWholeHour(ms: number): number {
  return Math.floor(ms / MS_HOUR) * MS_HOUR + MS_HOUR;
}

/**
 * RFC 5545 VCALENDAR text; CRLF line endings, folded at 75 octets.
 *
 * `opts.runId`, present, makes `UID` `<runId>-<event.key>@clockwork.local` —
 * stable across re-generation of the same run's .ics, so re-importing it
 * updates the user's calendar entry rather than duplicating it. Absent (e.g.
 * a caller with no run context), `UID` falls back to `<event.key>@clockwork.local`.
 */
export function toIcs(
  events: ProposedEvent[],
  opts: { calName?: string; defaultAtMs?: number; runId?: string } = {},
): string {
  const now = Date.now();
  const dtstamp = formatIcsUtc(now);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Clockwork//Proposed Events//EN',
    'CALSCALE:GREGORIAN',
  ];
  if (opts.calName) lines.push(fold(`X-WR-CALNAME:${escapeText(opts.calName)}`));
  for (const ev of events) {
    const startMs = ev.suggestedAt ?? opts.defaultAtMs ?? nextWholeHour(now);
    const endMs = startMs + ev.durationMin * 60_000;
    const uid = opts.runId ? `${opts.runId}-${ev.key}@clockwork.local` : `${ev.key}@clockwork.local`;
    lines.push('BEGIN:VEVENT');
    lines.push(fold(`UID:${uid}`));
    lines.push(fold(`DTSTAMP:${dtstamp}`));
    lines.push(fold(`DTSTART:${formatIcsUtc(startMs)}`));
    lines.push(fold(`DTEND:${formatIcsUtc(endMs)}`));
    lines.push(fold(`SUMMARY:${escapeText(ev.title)}`));
    if (ev.notes) lines.push(fold(`DESCRIPTION:${escapeText(ev.notes)}`));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map((l) => l).join('\r\n') + '\r\n';
}

/** e.g. clockwork-<runId>.ics */
export function icsFilenameFor(runId: string): string {
  return `clockwork-${runId}.ics`;
}
