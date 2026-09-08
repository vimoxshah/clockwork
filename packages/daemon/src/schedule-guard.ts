/**
 * Refusals that must happen BEFORE rrule ever sees a rule.
 *
 * `recurrence.ts` documents two costs an RRULE can carry. One of them is not a
 * cost at all — it is an infinite loop — and neither is reachable from a check
 * that runs after `RRule.fromString`, because the damage is done inside the
 * iteration `between()` performs. So this module parses the rule text itself,
 * with a plain split, and answers from arithmetic alone. Nothing here calls
 * into rrule, and nothing here can loop: every check is O(BY parts).
 *
 *   1. UNREACHABLE BY PARTS — an infinite hang, upstream, still open in
 *      rrule 2.8.1. The iterator walks by INTERVAL units from the anchor and
 *      re-checks the BY filter at every step, so the values it can ever reach
 *      are the residues of `anchor + k*INTERVAL`. When no stated BY value is
 *      among them the skip loop never terminates. `FREQ=HOURLY;INTERVAL=2;
 *      BYHOUR=3` is the case recurrence.ts names, and it is not the only one:
 *      measured 2026-09-08 with a 12s watchdog, `DTSTART:20260908T100700Z` +
 *      `FREQ=MINUTELY;INTERVAL=15;BYMINUTE=0,15,30,45` hangs identically,
 *      because minute 07 + 15k never lands on a quarter hour. A DTSTART does
 *      not rescue either one — both were killed at 12s with and without it,
 *      while the reachable controls answered in ~11ms.
 *
 *   2. THE EPOCH-ANCHOR CLIFF — slow, not fatal. `advancedAnchorMs` refuses to
 *      move a synthesized anchor for a sub-daily rule whose counter can leave
 *      the INTERVAL grid, so the rule replays from 1970. Measured here on an
 *      M4, next-fire over the 8-day save rung for `FREQ=MINUTELY;BYDAY=MO..FR;
 *      BYHOUR=9..16`: 1872ms at INTERVAL=5, 628ms at 15, 319ms at 30. That
 *      blocks the request that saves the task and the tick that touches it.
 *      The composer avoids it by emitting a DTSTART (see `composeRrule` in the
 *      UI), which takes the same rule to 17ms/1.0ms/0.5ms with a byte-identical
 *      occurrence set. The API is reachable without the composer, so the check
 *      stays here too.
 *
 * The reachability test is stated against the ANCHOR rather than against
 * midnight, because the composer's DTSTART is what makes the difference between
 * 1.0ms and a hang. With an epoch or midnight anchor both forms collapse to
 * `value % gcd(INTERVAL, period) === 0`, which is the shape the hazard was
 * first described in.
 */

/** Whole-day BY parts — the ones `recurrence.ts:filtersWholeDays` consults. */
const WHOLE_DAY_PARTS = ['BYMONTH', 'BYWEEKNO', 'BYDAY', 'BYYEARDAY', 'BYMONTHDAY', 'BYEASTER'] as const;

export type GuardReason = 'unreachable' | 'slow_anchor' | 'count_too_large' | 'unparseable';

export type GuardVerdict =
  | { safe: true }
  | { safe: false; reason: GuardReason; detail: string };

interface ParsedRule {
  props: Map<string, string>;
  /** Anchor wall-clock hour/minute/second from DTSTART, or null when synthesized. */
  anchor: { hour: number; minute: number; second: number } | null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcd(b, a % b);
}

/** Non-negative remainder — `-7 % 15` is -7 in JS and 8 is the answer wanted. */
function mod(value: number, n: number): number {
  return ((value % n) + n) % n;
}

/**
 * Split an RRULE text into its properties plus the DTSTART anchor's wall clock.
 * Deliberately tolerant: an unrecognised token is ignored rather than rejected,
 * because this guard's job is to refuse the two shapes it can PROVE are bad,
 * not to re-implement RFC 5545 validation that `RRule.fromString` already does.
 */
function parseRule(text: string): ParsedRule {
  const props = new Map<string, string>();
  let anchor: ParsedRule['anchor'] = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const dt = /^DTSTART[^:]*:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/i.exec(line);
    if (dt) {
      anchor = { hour: Number(dt[4]), minute: Number(dt[5]), second: Number(dt[6]) };
      continue;
    }
    for (const pair of line.replace(/^RRULE:/i, '').split(';')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      props.set(pair.slice(0, eq).trim().toUpperCase(), pair.slice(eq + 1).trim());
    }
  }
  return { props, anchor };
}

/** A BY part as numbers; `null` when the part is absent or states nothing. */
function numericPart(props: Map<string, string>, name: string): number[] | null {
  const raw = props.get(name);
  if (raw == null || raw.trim() === '') return null;
  const values = raw.split(',').map((v) => Number(v.trim()));
  return values.every((v) => Number.isInteger(v)) ? values : null;
}

/**
 * Can the iterator ever reach one of `values`, stepping by INTERVAL from
 * `anchorValue` within a field of `period` units? It can iff some stated value
 * is congruent to the anchor modulo `gcd(INTERVAL, period)` — the step's orbit.
 */
function anyReachable(values: number[], anchorValue: number, interval: number, period: number): boolean {
  const step = gcd(interval, period);
  return values.some((v) => mod(v - anchorValue, step) === 0);
}

/**
 * Classify a candidate schedule. `cron` and `once` are always safe here: neither
 * goes through rrule, and croner terminates by construction.
 *
 * @param kind the schedule kind being saved or previewed
 * @param rrule the rule text, when kind is 'rrule'
 * @param maxCount the COUNT ceiling to mirror (api.ts MAX_RRULE_COUNT)
 */
export function guardSchedule(
  kind: 'once' | 'rrule' | 'cron',
  rrule: string | null | undefined,
  maxCount: number,
): GuardVerdict {
  if (kind !== 'rrule') return { safe: true };
  const text = (rrule ?? '').trim();
  if (!text) return { safe: false, reason: 'unparseable', detail: 'the recurrence rule is empty' };

  const { props, anchor } = parseRule(text);
  const freq = (props.get('FREQ') ?? '').toUpperCase();
  if (!freq) return { safe: false, reason: 'unparseable', detail: 'the recurrence rule states no FREQ' };

  const countRaw = props.get('COUNT');
  if (countRaw != null && Number(countRaw) > maxCount) {
    return {
      safe: false,
      reason: 'count_too_large',
      detail: `COUNT is ${countRaw}, above the ${maxCount} limit. Expanding it would block the scheduler — drop COUNT and use UNTIL, or lower it.`,
    };
  }

  const intervalRaw = props.get('INTERVAL');
  const interval = intervalRaw == null ? 1 : Number(intervalRaw);
  if (!Number.isInteger(interval) || interval <= 0) {
    // A degenerate INTERVAL yields no occurrences or walks backwards; that is
    // the untouched path's problem, and it terminates. Not this guard's refusal.
    return { safe: true };
  }

  // --- 1. unreachable BY parts: the hang -------------------------------------
  const byHour = numericPart(props, 'BYHOUR');
  const byMinute = numericPart(props, 'BYMINUTE');
  const bySecond = numericPart(props, 'BYSECOND');
  const anchorHour = anchor?.hour ?? 0;
  const anchorMinute = anchor?.minute ?? 0;
  const anchorSecond = anchor?.second ?? 0;

  const unreachable = (part: string, values: number[], anchorValue: number, period: number): GuardVerdict => ({
    safe: false,
    reason: 'unreachable',
    detail:
      `${part}=${values.join(',')} is unreachable from FREQ=${freq};INTERVAL=${interval} starting at `
      + `${String(anchorHour).padStart(2, '0')}:${String(anchorMinute).padStart(2, '0')}. Stepping by ${interval} `
      + `only ever reaches values ${gcd(interval, period)} apart, so the expansion would never terminate. `
      + `Pick an interval that divides ${period}, or a start time on the same grid.`,
  });

  if (freq === 'HOURLY' && byHour && !anyReachable(byHour, anchorHour, interval, 24)) {
    return unreachable('BYHOUR', byHour, anchorHour, 24);
  }
  if (freq === 'MINUTELY' && byMinute && !anyReachable(byMinute, anchorMinute, interval, 60)) {
    return unreachable('BYMINUTE', byMinute, anchorMinute, 60);
  }
  if (freq === 'SECONDLY' && bySecond && !anyReachable(bySecond, anchorSecond, interval, 60)) {
    return unreachable('BYSECOND', bySecond, anchorSecond, 60);
  }

  // --- 2. a sub-daily counter fighting a whole-day filter: the second hang ---
  // Below HOURLY, `DateTime.addMinutes` normalizes its carry through
  // `addHours(hourDiv, false, byhour)`, whose skip loop re-adds hours for every
  // hour BYHOUR rejects, while a whole-day BY part makes the same counter jump a
  // whole day at a time. When the anchor's own day is one the day filter rejects,
  // the two never resynchronise. Measured out of process with an 8s watchdog on
  // 2026-09-08: `FREQ=MINUTELY;INTERVAL={5,15,30};BYDAY=MO;BYHOUR=9..16` hung at
  // every interval, and `BYDAY=MO,TU,WE,TH,FR` hung too once anchored on a
  // Saturday while answering in 15ms anchored on a Tuesday. A DTSTART does not
  // fix it — it only moves which start days are fatal — so this refusal is
  // anchor-independent, unlike the cliff below. `FREQ=HOURLY` with the same BY
  // parts answers in 12-23ms in every one of those cases, which is what the
  // composer emits instead.
  const filtersWholeDays = WHOLE_DAY_PARTS.some((p) => (props.get(p) ?? '').trim() !== '');
  const statesCoarser = freq === 'MINUTELY' ? byHour != null : byHour != null || byMinute != null;
  if ((freq === 'MINUTELY' || freq === 'SECONDLY') && filtersWholeDays && statesCoarser) {
    return {
      safe: false,
      reason: 'unreachable',
      detail:
        `FREQ=${freq} cannot be combined with a whole-day filter and an hour filter: the minute counter `
        + 'jumps a whole day while the hour skip loop steps by hours, and on a start day the filter rejects '
        + 'they never meet, so the expansion does not terminate. Express the same schedule as FREQ=HOURLY '
        + 'with BYMINUTE — every 15 minutes is BYMINUTE=0,15,30,45.',
    };
  }

  // --- 3. the epoch-anchor cliff: slow, only when the anchor is synthesized ---
  // Mirrors `advancedAnchorMs`: with no DTSTART the anchor is ours to move, and
  // it is NOT moved for a sub-daily rule whose counter can leave the grid.
  if (anchor === null && (freq === 'MINUTELY' || freq === 'SECONDLY')) {
    const skipStaysOnGrid = 60 % interval === 0 && !filtersWholeDays;
    if ((statesCoarser && !skipStaysOnGrid) || countRaw != null) {
      return {
        safe: false,
        reason: 'slow_anchor',
        detail:
          `FREQ=${freq} with ${countRaw != null ? 'COUNT' : 'a coarser BY part'} and no DTSTART replays from 1970 on `
          + 'every expansion, which blocks the save request and the scheduler tick. Add a DTSTART on the rule\'s own '
          + 'grid — midnight of the start day works for any interval that divides 60.',
      };
    }
  }

  return { safe: true };
}
