/**
 * Natural-language scheduling (P1): "every Mon 2am" → a real RRULE.
 *
 * Architecture, read before touching: the UI is a pure wire client and the
 * daemon cannot import this file, so this parser may ONLY emit shapes the
 * composer's own emitter already produces (schedule-rule.ts compose* +
 * checked-in emittable-schedules.json). A new RRULE *shape* here would reach
 * the daemon unvetted. The guard (guardSchedule) still validates at save —
 * this module's job is to never ask it to refuse.
 *
 * Two deliberate refusals, both louder than a guess:
 *  - "every other X" needs INTERVAL, which no composer shape carries.
 *  - day-of-month 29–31 would silently skip short months under BYMONTHDAY.
 *
 * chrono parses the time-of-day/date; recurrence intent (every/each/daily/
 * weekdays/…) is a small keyword layer because chrono answers datetimes,
 * never recurrences. All wall-clock math happens in the TASK timezone, never
 * the machine's: chrono runs against a reference Date built from the tz wall
 * clock, so "2am" means 2am where the job fires.
 */
import { parse as chronoParse } from 'chrono-node';
import {
  composeDailyRule,
  composeWeeklyRule,
  composeMonthlyRule,
  composeIntervalRule,
  type Weekday,
  INTERVAL_MINUTES,
} from './schedule-rule';

export type NlConfidence = 'high' | 'medium';

export interface NlOnce {
  kind: 'once';
  runAt: number;
  interpretation: string;
  confidence: NlConfidence;
  warnings: string[];
}

export interface NlRrule {
  kind: 'rrule';
  rrule: string;
  interpretation: string;
  confidence: NlConfidence;
  warnings: string[];
  draft: {
    freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'INTERVAL';
    days: Weekday[];
    dom: number | null;
    hour: number;
    minute: number;
    /** INTERVAL only: step + window actually emitted. */
    every?: (typeof INTERVAL_MINUTES)[number];
    fromHour?: number;
    toHour?: number;
  };
}

export interface NlError {
  kind: 'error';
  message: string;
  hint: string;
}

export type NlResult = NlOnce | NlRrule | NlError;

const DAY_RES: Array<{ re: RegExp; js: number; code: Weekday }> = [
  { re: /\bmon(day)?s?\b/, js: 1, code: 'MO' },
  { re: /\btue(sday)?s?\b/, js: 2, code: 'TU' },
  { re: /\bwed(nesday)?s?\b/, js: 3, code: 'WE' },
  { re: /\bthu(rsday)?s?\b/, js: 4, code: 'TH' },
  { re: /\bfri(day)?s?\b/, js: 5, code: 'FR' },
  { re: /\bsat(urday)?s?\b/, js: 6, code: 'SA' },
  { re: /\bsun(day)?s?\b/, js: 0, code: 'SU' },
];

const ORDER: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function dayName(code: Weekday): string {
  return { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' }[code];
}

function fmtTime(hour: number, minute: number): string {
  const ap = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, '0')} ${ap}`;
}

function assertTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in tz. Exported for drag/drop, same frame. */
export function wallInTz(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; jsDay: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  return {
    y: get('year'),
    mo: get('month') - 1,
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    jsDay: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd),
  };
}

/** Absolute instant for a tz wall-clock reading (iterated offset, DST-safe). */
export function wallToUtcMs(wall: { y: number; mo: number; d: number; h: number; mi: number }, tz: string): number {
  let guess = Date.UTC(wall.y, wall.mo, wall.d, wall.h, wall.mi);
  for (let i = 0; i < 3; i++) {
    const w = wallInTz(guess, tz);
    const asUtc = Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
    const want = Date.UTC(wall.y, wall.mo, wall.d, wall.h, wall.mi);
    guess += want - asUtc;
    if (want === asUtc) break;
  }
  return guess;
}

function err(message: string, hint: string): NlError {
  return { kind: 'error', message, hint };
}

export interface NlInput {
  text: string;
  nowMs: number;
  tz: string;
}

/**
 * Parse scheduling intent. Never throws on weird input — unparseable text is
 * an NlError with a hint, and ambiguous-but-material gaps (which day? which
 * date?) are errors, not guesses. Filled defaults (9:00 AM, and 9 PM for
 * "nightly") are always named in warnings and lower confidence to medium.
 */
export function parseNaturalSchedule(input: NlInput): NlResult {
  const raw = input.text.trim();
  if (!raw) return err('Type when this should run — for example "every Mon 2am".', 'Try "weekdays at 9" or "tomorrow 9am".');
  // Client-side only, but chrono over unbounded input is still wasted work —
  // and a schedule sentence is never an essay.
  if (raw.length > 200) return err('That is too long to be a schedule.', 'Keep it under 200 characters — for example "every Mon 2am".');
  if (!assertTz(input.tz)) return err(`Unknown timezone "${input.tz}".`, 'Pick the schedule timezone in the composer first.');
  const t = raw.toLowerCase();

  // Interval shapes the composer cannot emit are refused, not approximated:
  // INTERVAL is exactly the knob guardSchedule watches.
  if (/\bevery other\b|\bevery second\b|\bbiweekly\b|\bfortnight/i.test(t)) {
    return err('“Every other …” needs an interval the scheduler does not offer.', 'Book it weekly and skip alternate weeks, or pick a plain weekly day.');
  }
  if (/\bhourly\b/.test(t)) {
    return err('“Hourly” is not offered — the smallest step is every 5 minutes.', 'Try "every 15 minutes".');
  }
  // Sub-minute steps have no composer shape — refuse before the bare-every
  // rule below daily-ifies them.
  if (/\bevery\s+(minute|second|moments?)\b/.test(t)) {
    return err('The smallest step offered is every 5 minutes.', 'Try "every 5 minutes".');
  }
  // Multi-week/month intervals need INTERVAL, which no composer shape
  // carries — refusing here keeps "every 2 weeks" from silently becoming
  // daily via the bare-every rule below.
  if (/\bevery\s+\d+\s*(weeks?|months?|years?)\b/.test(t)) {
    return err('Multi-week intervals are not offered.', 'Book it weekly and skip weeks by hand, or file separate weekly tasks.');
  }
  // Bare month names ("every March") match the every-word below but mean a
  // yearly shape the composer cannot emit — refuse, do not daily-ify. An
  // explicit year ("March 8 2026") is a once date, not a recurrence, and is
  // left for the date path below.
  if (
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/.test(t) &&
    !/\b(19|20)\d{2}\b/.test(t)
  ) {
    return err('Yearly recurrences like “every March” are not offered.', 'Book twelve monthly one-offs, or a monthly rule you pause off-season.');
  }
  // Feb 29 on a non-leap year: chrono declines the date outright, which would
  // surface as a generic "no date found". Name the real problem instead —
  // but only when a year is stated; bare "Feb 29" resolves to the next leap
  // year downstream, which is correct.
  const yearInText = t.match(/\b((?:19|20)\d{2})\b/);
  if (/\bfeb\w*\s+29\b/.test(t) && yearInText) {
    const y = Number(yearInText[1]);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    if (!leap) return err(`February 29th does not exist in ${y}.`, 'Pick Feb 28, or a leap year.');
  }

  // Reference date in TASK-tz wall space so "2am" parses where the job fires.
  // Built AND read in UTC space (Date.UTC + getUTC*): the machine timezone
  // must not move the boundary. The frame is self-consistent — wall date
  // encoded as UTC, day arithmetic inside it, wallToUtcMs converting out —
  // so a UTC+14 laptop and a UTC-8 one parse identically. Parsed up front so
  // every branch below (including the interval branch's residue check) sees it.
  //
  // Two strips before chrono runs: the leading every/each (recurrence intent
  // is ours, not chrono's) and hour windows ("9 to 17" parses as two times
  // and would trip the two-times refusal). Residue is measured against this
  // same stripped text, or the indices never align.
  const nowWall = wallInTz(input.nowMs, input.tz);
  const ref = new Date(Date.UTC(nowWall.y, nowWall.mo, nowWall.d, nowWall.h, nowWall.mi, 0));
  const chronoText = t
    .replace(/^\s*(every|each)\s+/, '')
    .replace(/\b\d{1,2}(?::00)?\s*(?:to|-)\s*\d{1,2}(?::00)?\b/g, ' ');
  const found = chronoParse(chronoText, ref, { forwardDate: true });
  // Time can live in a LATER result ("mon, wed, fri AT 6pm" parses as three),
  // but two certain times ("2am and 3pm") is two schedules, not one: taking
  // the first would silently drop the second.
  const certainTimes = found.filter((r) => r.start.isCertain('hour'));
  if (certainTimes.length > 1) {
    return err('Two different times in one schedule — one schedule holds one time.', 'Book "2am" and "3pm" as two tasks, or pick one.');
  }
  const timeHit = certainTimes[0] ?? null;
  const first = found[0]?.start ?? null;
  const timeCertain = timeHit !== null;

  // A bare 1–5 with no meridiem ("Friday at 5") is genuinely ambiguous — 5 AM
  // reads as morning, 5 PM as evening, and the cost of guessing wrong is a
  // week of 5 AM wake-ups. 6–11 default to AM (standup hours; a PM reading
  // there is absurd), 12+ and 24-hour times are unambiguous. This is loud,
  // never silent: the error names both options.
  if (timeHit) {
    const h = timeHit.start.get('hour')!;
    const hasMeridiem = /a\.?m\.?|p\.?m\.?|morning|afternoon|evening|night|noon|midnight|o'?clock/i.test(timeHit.text);
    if (h >= 1 && h <= 5 && !hasMeridiem) {
      return err(
        `“${timeHit.text.trim()}” — ${h} AM or ${h} PM?`,
        `Retype with a meridiem ("Friday at 5pm") — the schedule runs in ${input.tz}.`,
      );
    }
  }
  // Time-like text chrono could not read ("at 25:00") must error here: every
  // branch below would otherwise default the time and print "named no time"
  // about a time the user DID name — a lying warning.
  if (!timeHit && (/\b\d{1,2}:\d{2}\b/.test(t) || /\b\d{1,2}\s*(am|pm|a\.m\.|p\.m\.)\b/.test(t) || /\bat\s+\d/i.test(t))) {
    return err('Could not read a time in that text.', 'Try a plain time like "9am" or "14:30".');
  }

  const everyMin = t.match(/\bevery\s+(\d+)\s*(min|mins|minute|minutes)\b/);
  if (everyMin) {
    const n = Number(everyMin[1]);
    if (!(INTERVAL_MINUTES as readonly number[]).includes(n)) {
      return err(`Every ${n} minutes is not offered (5, 10, 15 or 30).`, 'Pick one of the offered steps — others cannot be proven safe to expand.');
    }
    const days = daysFromText(t);
    if (days.length === 0) {
      // "on weekdays" names no day but means five of them — same keyword
      // expansion as the daily path, or the window floats over the weekend.
      if (/\bweekdays?\b/.test(t)) days.push('MO', 'TU', 'WE', 'TH', 'FR');
      else if (/\bweekends?\b/.test(t)) days.push('SA', 'SU');
    }
    const windows = windowFromText(t);
    if (windows && 'err' in windows) return windows.err;
    const every = n as (typeof INTERVAL_MINUTES)[number];
    const fromHour = windows && 'from' in windows ? windows.from : 0;
    const toHour = windows && 'to' in windows ? windows.to : 24;
    const residue = residueWarnings(chronoText, found);
    return {
      kind: 'rrule',
      rrule: composeIntervalRule({ every, days, fromHour, toHour }),
      interpretation: `Every ${n} minutes${days.length && days.length < 7 ? ` on ${days.map(dayName).join(', ')}` : ''}${fromHour !== 0 || toHour !== 24 ? `, ${fromHour}:00–${toHour}:00` : ''} (${input.tz})`,
      confidence: residue.length ? 'medium' : 'high',
      warnings: residue,
      draft: { freq: 'INTERVAL', days, dom: null, hour: 0, minute: 0, every, fromHour, toHour },
    };
  }

  // Reference date in TASK-tz wall space so "2am" parses where the job fires.
  const wantsMonthly = /\bmonthly\b/.test(t);
  const wantsWeekly = /\bweekly\b/.test(t);
  const wantsDaily = /\bdaily\b|\bnightly\b|\bweekdays?\b|\bweekends?\b|\bevery\s+(day|night|morning|evening)\b/.test(t) || /\bevery\b/.test(t);
  const namedDays = daysFromText(t);

  if (wantsMonthly) {
    // chrono does not parse bare ordinals ("on the 15th" yields only the
    // time), so the day-of-month comes from our own ordinal match.
    const domMatch = t.match(/(?:\bon the\s+|\bmonthly\s+)(\d{1,2})(?:st|nd|rd|th)?\b/);
    const dom = domMatch ? Number(domMatch[1]) : null;
    if (dom === null) {
      return err('“Monthly” needs a day — which date?', 'Try "monthly on the 15th at 9am".');
    }
    if (dom < 1 || dom > 28) {
      return err(`The ${dom}th would silently skip short months under a monthly rule.`, 'Pick a day 1–28, or book the edge months as one-offs.');
    }
    const { hour, minute, warnings: timeWarnings } = timeOr(timeHit?.start ?? null, timeCertain, 9, 0);
    const warnings = [...timeWarnings, ...residueWarnings(chronoText, found)];
    return {
      kind: 'rrule',
      rrule: composeMonthlyRule(dom, hour, minute),
      interpretation: `Monthly on the ${dom}${ordinal(dom)} at ${fmtTime(hour, minute)} (${input.tz})`,
      confidence: warnings.length ? 'medium' : 'high',
      warnings,
      draft: { freq: 'MONTHLY', days: [], dom, hour, minute },
    };
  }

  // A bare singular day ("Friday at 5pm") is a one-off — next Friday — not a
  // weekly rule. Recurrence needs a marker: every/each, a plural ("Fridays"),
  // or a list ("Mon, Wed, Fri").
  const hasEvery = /\bevery\b|\beach\b/.test(t);
  const hasPluralDay = /\b(mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/.test(t);
  if (wantsWeekly || (namedDays.length > 0 && (namedDays.length > 1 || hasEvery || hasPluralDay))) {
    if (namedDays.length === 0) {
      return err('“Weekly” needs days — which ones?', 'Try "every Mon and Thu at 2am".');
    }
    const { hour, minute, warnings: timeWarnings } = timeOr(timeHit?.start ?? null, timeCertain, 9, 0);
    const warnings = [...timeWarnings, ...residueWarnings(chronoText, found)];
    const days = [...namedDays].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    return {
      kind: 'rrule',
      rrule: composeWeeklyRule(days, hour, minute),
      interpretation: `Every ${days.map(dayName).join(', ')} at ${fmtTime(hour, minute)} (${input.tz})`,
      confidence: warnings.length ? 'medium' : 'high',
      warnings,
      draft: { freq: 'WEEKLY', days, dom: null, hour, minute },
    };
  }

  if (wantsDaily) {
    let days: Weekday[] = [];
    let scopeNote = '';
    if (/\bweekends?\b/.test(t) && !/\bweekdays?\b/.test(t)) {
      days = ['SA', 'SU'];
      scopeNote = 'weekends';
    } else if (/\bweekdays?\b/.test(t) && !/\bweekends?\b/.test(t)) {
      days = ['MO', 'TU', 'WE', 'TH', 'FR'];
      scopeNote = 'weekdays';
    }
    const nightly = /\bnightly\b|\bevery\s+(night|evening)\b/.test(t);
    const defH = nightly ? 21 : 9;
    const { hour, minute, warnings: timeWarnings } = timeOr(timeHit?.start ?? null, timeCertain, defH, 0);
    const warnings = [...timeWarnings, ...residueWarnings(chronoText, found)];
    const label = scopeNote === 'weekdays' ? 'Weekdays' : scopeNote === 'weekends' ? 'Weekends' : nightly && !timeCertain ? 'Nightly' : 'Every day';
    return {
      kind: 'rrule',
      rrule: days.length ? composeWeeklyRule(days, hour, minute) : composeDailyRule(hour, minute),
      interpretation: `${label} at ${fmtTime(hour, minute)} (${input.tz})`,
      confidence: warnings.length ? 'medium' : 'high',
      warnings,
      draft: { freq: 'DAILY', days, dom: null, hour, minute },
    };
  }

  // One-off: needs a real future datetime, never a bare word. The DATE is
  // resolved here in wall space — chrono's absolute resolution runs on
  // machine-local getters, so a laptop far from the task zone would move the
  // day. Only chrono-CERTAIN explicit dates are taken as-is; everything else
  // is keyword/weekday arithmetic on the tz wall clock.
  if (!first) {
    return err(`Could not find a date or time in “${raw}”.`, 'Try "tomorrow 9am", "Friday at 5pm", or "every Mon 2am".');
  }
  const onceDate = resolveOnceDate(t, found, nowWall, input.tz);
  if ('err' in onceDate) return onceDate.err;
  // Relative durations ("in 2 hours") anchor on NOW, not the UTC parse frame
  // (the frame ref is wall-encoded, so chrono's "+2h" lands in the wrong
  // place). Parsed here directly: exact, tz-independent, midnight-safe.
  const durMatch = t.match(/^\s*in\s+(\d+)\s*(minutes?|hours?|days?|weeks?)\b/);
  if (durMatch) {
    const n = Number(durMatch[1]);
    const unit = durMatch[2]!.startsWith('min') ? 60_000 : durMatch[2]!.startsWith('hour') ? 3600_000 : durMatch[2]!.startsWith('day') ? 86400_000 : 7 * 86400_000;
    const runAt = input.nowMs + n * unit;
    const when = new Intl.DateTimeFormat('en-US', {
      timeZone: input.tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(runAt));
    const durResidue = residueWarnings(chronoText, found);
    return { kind: 'once', runAt, interpretation: `Once on ${when} (${input.tz})`, confidence: durResidue.length ? 'medium' : 'high', warnings: durResidue };
  }
  const isTonight = /\btonight\b/.test(t);
  const wall = {
    y: onceDate.y,
    mo: onceDate.mo,
    d: onceDate.d,
    h: timeCertain ? timeHit!.start.get('hour')! : isTonight ? 21 : 9,
    mi: timeCertain ? (timeHit!.start.get('minute') ?? 0) : 0,
  };
  const warnings: string[] = [];
  if (!timeCertain) warnings.push(`Assumed ${fmtTime(wall.h, wall.mi)} — the text named no time.`);
  // Feb 29 on a non-leap year normalizes silently inside Date math — refuse
  // with the actual problem instead of booking March 1st.
  if (/\bfeb\w*\s+29\b/.test(t) && !(wall.mo === 1 && wall.d === 29)) {
    return err(`February 29th does not exist in ${wall.y}.`, 'Pick Feb 28, or a leap year.');
  }
  const runAt = wallToUtcMs(wall, input.tz);
  if (runAt <= input.nowMs) {
    return err('That moment is already past.', 'Try "tomorrow" with a time, or a future date.');
  }
  // DST honesty: a wall time that never existed (spring gap) comes back as a
  // different wall time — refuse. One that exists twice (fall-back) keeps the
  // first occurrence and says so.
  const back = wallInTz(runAt, input.tz);
  if (back.h !== wall.h || back.mi !== wall.mi) {
    return err(
      `${fmtTime(wall.h, wall.mi)} does not exist on that date in ${input.tz} (daylight-saving transition).`,
      'Pick a time outside the 2:00–3:00 AM transition window.',
    );
  }
  const earlier = wallInTz(runAt - 3600_000, input.tz);
  if (earlier.h === wall.h && earlier.mi === wall.mi) {
    warnings.push('That wall time occurs twice (clocks fall back) — the first occurrence is used.');
  }
  warnings.push(...residueWarnings(chronoText, found));
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: input.tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(runAt));
  return {
    kind: 'once',
    runAt,
    interpretation: `Once on ${when} (${input.tz})`,
    confidence: warnings.length ? 'medium' : 'high',
    warnings,
  };
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
}

/** Named days in the text, in JS-weekday order, deduped. */
function daysFromText(t: string): Weekday[] {
  const out: Weekday[] = [];
  for (const d of DAY_RES) {
    if (d.re.test(t) && !out.includes(d.code)) out.push(d.code);
  }
  return out;
}

/** "9 to 5" / "9-17" windows for interval rules; null when unmentioned. */
function windowFromText(t: string): { from: number; to: number } | { ok: false; err: NlError } | null {
  const m = t.match(/\b(\d{1,2})(?::00)?\s*(?:to|-)\s*(\d{1,2})(?::00)?\b/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from < 0 || from > 23 || to < 1 || to > 24 || to <= from) {
    return { ok: false, err: err('That hour window does not parse as a day window.', 'Try "9 to 17" with the end after the start.') };
  }
  return { from, to };
}

/** chrono time when certain, else the named default (always warned). */
function timeOr(
  first: { get(c: string): number | null } | null,
  certain: boolean,
  defH: number,
  defM: number,
): { hour: number; minute: number; warnings: string[] } {
  if (first && certain) return { hour: first.get('hour')!, minute: first.get('minute') ?? 0, warnings: [] };
  return { hour: defH, minute: defM, warnings: [`Assumed ${fmtTime(defH, defM)} — the text named no time.`] };
}

/** Wall date + n days, DST-safe via a noon-anchored UTC round-trip. */
function addWallDays(wall: { y: number; mo: number; d: number }, n: number, tz: string): { y: number; mo: number; d: number } {
  const w = wallInTz(wallToUtcMs({ ...wall, h: 12, mi: 0 }, tz) + n * 86400_000, tz);
  return { y: w.y, mo: w.mo, d: w.d };
}

/**
 * Resolve the once-path DATE in wall space. Explicit chrono-certain dates
 * win; otherwise keyword/weekday arithmetic on the tz wall clock. Never the
 * machine timezone, never a silent rollover.
 */
function resolveOnceDate(
  t: string,
  found: Array<{ start: { isCertain(c: string): boolean; get(c: string): number | null } }>,
  nowWall: { y: number; mo: number; d: number; jsDay: number },
  tz: string,
): { y: number; mo: number; d: number } | { err: NlError } {
  const first = found[0]?.start ?? null;
  // "day after tomorrow" contains "tomorrow" — check the longer phrase first
  // otherwise chrono's certain tomorrow wins and books a day early.
  if (/\bday after tomorrow\b/.test(t)) return addWallDays(nowWall, 2, tz);
  if (first && first.isCertain('day') && first.isCertain('month')) {
    return { y: first.get('year') ?? nowWall.y, mo: first.get('month')! - 1, d: first.get('day')! };
  }
  if (/\btomorrow\b/.test(t)) return addWallDays(nowWall, 1, tz);
  if (/\btonight\b/.test(t) || /\btoday\b/.test(t)) return { y: nowWall.y, mo: nowWall.mo, d: nowWall.d };
  for (const d of DAY_RES) {
    if (d.re.test(t)) {
      // Nearest upcoming that weekday. "Today, if still ahead" is decided
      // downstream: the past check refuses with guidance when the default or
      // named time already passed.
      return addWallDays(nowWall, (d.js - nowWall.jsDay + 7) % 7, tz);
    }
  }
  if (first && (first.isCertain('hour') || first.isCertain('minute'))) {
    return { y: nowWall.y, mo: nowWall.mo, d: nowWall.d };
  }
  return { err: err('Could not find a date in that text.', 'Try "tomorrow 9am" or "Friday at 5pm".') };
}

/**
 * Alphabetic residue past the last chrono match ("2amx", "please") — booked
 * text the parser never looked at. A warning, not an error: politeness
 * ("please") must not refuse, but a typo ("2amx") must not book silently.
 */
function residueWarnings(t: string, found: Array<{ index: number; text: string }>): string[] {
  if (found.length === 0) return [];
  const end = Math.max(...found.map((r) => r.index + r.text.length));
  const rest = t.slice(end).trim();
  // Any trailing letter counts — even one ("2amx" is a typo, not 2am).
  // Punctuation alone ("mon 2am,") is not words and stays silent.
  if (/[a-zA-Z]/.test(rest)) return [`Ignored extra text after the schedule: "${rest.slice(0, 40)}".`];
  return [];
}
