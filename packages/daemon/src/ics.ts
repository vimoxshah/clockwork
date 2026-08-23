/**
 * ICS human-calendar subscription (Phase 5): fetch + parse a user-supplied
 * ICS feed URL into lightweight events for calendar overlay.
 *
 * Architecture decision (documented in docs/calendar-integration.md):
 * ICS read-only subscription is the strongest production-ready H1 path —
 * no OAuth surface, works with Google Calendar "secret address", Apple
 * Calendar published calendars, Fastmail, Nextcloud, and most providers.
 * Read-only by design: Clockwork NEVER writes to a human calendar.
 *
 * Parser scope: VEVENT with DTSTART/DTEND (date or date-time), RRULE via
 * the same recurrence engine used for schedules where feasible; otherwise
 * non-recurring expansion only (documented limitation). VALARM ignored.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

export interface IcsEvent {
  uid: string;
  summary: string;
  startMs: number;
  endMs: number | null;
  allDay: boolean;
  location: string | null;
}

interface RawProps {
  [key: string]: Array<{ value: string; params: Record<string, string> }>;
}

/** Unfold continuation lines (RFC 5545 §3.1) and split into property records. */
function unfold(ics: string): string[] {
  const lines = ics.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.length > 0);
}

function parseProp(line: string): { name: string; value: string; params: Record<string, string> } | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = (parts[0] ?? '').toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, value, params };
}

/** Parse iCalendar DTSTART/DTEND value. Returns epoch ms. */
function parseIcsDate(value: string, params: Record<string, string>): number | null {
  // DATE value: YYYYMMDD
  let m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    if (params.TZID) return zonedToMs(m[1]!, m[2]!, m[3]!, '0000', params.TZID) ?? utcToMs(m[1]!, m[2]!, m[3]!);
    return utcToMs(m[1]!, m[2]!, m[3]!) ?? null; // floating/all-day → UTC midnight
  }
  // DATE-TIME: YYYYMMDDTHHMMSS(Z?)
  m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m as unknown as [string, string, string, string, string, string, string, string];
  void s;
  if (z === 'Z') return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0);
  if (params.TZID) return zonedToMs(y, mo, d, `${h}${mi}`, params.TZID) ?? Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  // floating time — interpret in server-local zone
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime();
}

function utcToMs(y: string, mo: string, d: string): number | null {
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  return Number.isFinite(ms) ? ms : null;
}

let zonedCache: { Intl: typeof Intl } | null = null;
void zonedCache;

/** Convert wall-clock time in an IANA zone to epoch ms (via offset probing). */
function zonedToMs(y: string, mo: string, d: string, hhmm: string, tz: string): number | null {
  try {
    const guessUtc = Date.UTC(+y, +mo - 1, +d, +hhmm.slice(0, 2), +hhmm.slice(2, 4));
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const parts = dtf.formatToParts(new Date(guessUtc));
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    return guessUtc - (asUtc - guessUtc);
  } catch {
    return null;
  }
}

export function parseIcs(icsText: string, limit = 2000): IcsEvent[] {
  const lines = unfold(icsText);
  const events: IcsEvent[] = [];
  let cur: RawProps = {};
  let inEvent = false;
  const push = (): void => {
    if (!inEvent || !cur.UID || !cur.DTSTART) return;
    const startParams = cur.DTSTART[0]!.params;
    const startMs = parseIcsDate(cur.DTSTART[0]!.value, startParams);
    if (startMs == null) return;
    let endMs: number | null = null;
    if (cur.DTEND) endMs = parseIcsDate(cur.DTEND[0]!.value, cur.DTEND[0]!.params);
    const allDay = (startParams.VALUE ?? '').toUpperCase() === 'DATE';
    // Skip recurring expansion: emit the base occurrence only (documented limitation).
    if (cur.RRULE && !events.some((e) => e.uid === `${curUid}-r`)) {
      events.push({
        uid: `${curUid}-r`,
        summary: `(recurring) ${cur.SUMMARY?.[0]?.value ?? 'Busy'}`,
        startMs,
        endMs,
        allDay,
        location: cur.LOCATION?.[0]?.value ?? null,
      });
      return;
    }
    events.push({
      uid: curUid,
      summary: cur.SUMMARY?.[0]?.value ?? 'Busy',
      startMs,
      endMs,
      allDay,
      location: cur.LOCATION?.[0]?.value ?? null,
    });
  };
  let curUid = '';
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      cur = {};
      curUid = '';
      continue;
    }
    if (line === 'END:VEVENT') {
      push();
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    const prop = parseProp(line);
    if (!prop) continue;
    if (prop.name === 'UID') curUid = prop.value;
    (cur[prop.name] ??= []).push({ value: prop.value, params: prop.params });
    if (events.length >= limit) break;
  }
  events.sort((a, b) => a.startMs - b.startMs);
  return events.slice(0, limit);
}

export interface IcsSourceResult {
  ok: boolean;
  error?: string;
  events?: IcsEvent[];
  fetchedAt: number;
}

/** Fetch a subscribed ICS URL over HTTPS with size + timeout bounds. */
export async function fetchIcs(url: string, timeoutMs = 15_000): Promise<IcsSourceResult> {
  const at = Date.now();
  if (!/^https:\/\//i.test(url)) return { ok: false, error: 'only https ICS URLs are accepted', fetchedAt: at };
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/calendar' },
    });
    if (!res.ok) return { ok: false, error: `feed returned ${res.status}`, fetchedAt: at };
    const text = await res.text();
    if (text.length > 5_000_000) return { ok: false, error: 'feed exceeds 5MB', fetchedAt: at };
    if (!text.includes('BEGIN:VCALENDAR')) return { ok: false, error: 'not an ICS calendar', fetchedAt: at };
    return { ok: true, events: parseIcs(text), fetchedAt: at };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 120), fetchedAt: at };
  }
}

export function loadIcsSources(dataDir: string): Array<{ id: string; url: string; label: string }> {
  try {
    return JSON.parse(readFileSync(`${dataDir}/ics-sources.json`, 'utf8'));
  } catch {
    return [];
  }
}

export function saveIcsSources(dataDir: string, sources: Array<{ id: string; url: string; label: string }>): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${dataDir}/ics-sources.json`, JSON.stringify(sources, null, 2), { mode: 0o600 });
}
