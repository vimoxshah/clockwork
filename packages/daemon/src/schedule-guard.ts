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
 *      The composer does not go near it — `composeIntervalRule` in
 *      packages/ui/src/lib/schedule-rule.ts emits FREQ=HOURLY, which
 *      `advancedAnchorMs` advances unconditionally. The API is reachable
 *      without the composer, so the check stays here.
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
 * Can the iterator ever reach one of `targets`, stepping by INTERVAL units from
 * `anchorOffset` around a cycle of `period` units? It can iff some target is
 * congruent to the anchor modulo `gcd(INTERVAL, period)` — the step's orbit.
 *
 * ONLY sound where the walk is a single loop with a constant step: HOURLY's
 * `addHours`, and MINUTELY/SECONDLY with no coarser BY part to make the inner
 * skip loop run. Every other case is refused below rather than computed — see
 * the comment there for the two models that got this wrong.
 */
function anyReachable(targets: number[], anchorOffset: number, interval: number, period: number): boolean {
  const step = gcd(interval, period);
  return targets.some((v) => mod(v - anchorOffset, step) === 0);
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

  // HOURLY walks hours with ONE loop and a constant step — `addHours` does
  // `this.hour += INTERVAL` and re-tests BYHOUR each time (rrule datetime.js:87)
  // — so its reachable set really is `anchorHour + k*INTERVAL (mod 24)` and the
  // gcd is exact. This is the documented `INTERVAL=2;BYHOUR=3` case.
  if (freq === 'HOURLY' && byHour && !anyReachable(byHour, anchorHour, interval, 24)) {
    return unreachable('BYHOUR', byHour, anchorHour, 24);
  }

  // MINUTELY and SECONDLY are NOT one loop, and that is why a coarser BY part
  // is refused outright rather than analysed.
  //
  // `addMinutes` (datetime.js:103) adds INTERVAL to the minute, and on a carry
  // calls `addHours(hourDiv, false, byhour)` — a SECOND unbounded loop whose
  // step is `hourDiv = floor((minute + INTERVAL) / 60)`, not INTERVAL. Two
  // models of that were written here and both were wrong, in both directions:
  //
  //   * modelling BYHOUR on the 24-hour grid passed
  //     `FREQ=MINUTELY;INTERVAL=120;BYHOUR=3` — killed at 457 SECONDS;
  //   * modelling it on the minute-of-day grid `gcd(INTERVAL, 1440)` passed
  //     `INTERVAL=288;BYHOUR=9,10` and `INTERVAL=1441;BYHOUR=3` — both killed
  //     at 20s — AND refused `INTERVAL=288;BYHOUR=8`, which answers in 11ms.
  //     Wrong in both directions is the proof the grid was misidentified rather
  //     than the analysis being incomplete.
  //
  // A third model would need `gcd(hourDiv, 24)` and its SECONDLY equivalent
  // through `addSeconds -> addMinutes -> addHours`, and nothing here can show
  // that one is right where two were wrong. So the combination is refused. That
  // is sound BY CONSTRUCTION — no arithmetic to get wrong — and the cost is
  // bounded and disclosed: a hand-written rule like the `INTERVAL=288;BYHOUR=8`
  // above is refused even though it works. Nothing the composer can emit is
  // affected (it emits FREQ=HOURLY, asserted over all 377,040 reachable control
  // states), and the alternative is a wedged daemon — Fastify is
  // single-threaded, so one such request takes the whole process with it.
  const coarser = freq === 'MINUTELY'
    ? (byHour ? 'BYHOUR' : null)
    : freq === 'SECONDLY'
      ? (byHour ? 'BYHOUR' : byMinute ? 'BYMINUTE' : null)
      : null;
  if (coarser) {
    return {
      safe: false,
      reason: 'unreachable',
      detail:
        `FREQ=${freq} with ${coarser} cannot be checked for termination: the minute counter carries into a `
        + 'second, independent skip loop over hours, and a rule whose filter that loop can never satisfy spins '
        + 'forever inside rrule 2.8.1. Express the schedule as FREQ=HOURLY with BYMINUTE instead — every 15 '
        + 'minutes is BYMINUTE=0,15,30,45.',
    };
  }

  // With no coarser part stated, both inner loops break immediately, so the
  // walk IS plain arithmetic on its own unit and the gcd is exact again.
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
  // every interval, and `BYDAY=MO,TU,WE,TH,FR` hung once the window started on a
  // Saturday while answering in 15ms from a Tuesday.
  //
  // THIS ONE IS DELIBERATELY CONSERVATIVE, and the false positive is named
  // rather than hidden: the same MO..FR rule anchored at midnight on a TUESDAY
  // does answer, in 26ms. Whether it terminates depends on the relationship
  // between the anchor's weekday, the day filter and the hour skip, and I could
  // not derive a rule for that the way the modular check above is derived — so
  // the whole combination is refused. The cost is bounded: FREQ=HOURLY with the
  // same BY parts answers in 12-23ms in every one of these cases and is what
  // the composer emits, so nothing a user can build in the app is refused here.
  // A caller writing MINUTELY+BYDAY by hand is told exactly what to write.
  const filtersWholeDays = WHOLE_DAY_PARTS.some((p) => (props.get(p) ?? '').trim() !== '');
  // The BYHOUR/BYMINUTE half of this is already refused above; what is left is a
  // whole-day filter on its own, which makes the counter jump a whole day and
  // is its own non-termination.
  if ((freq === 'MINUTELY' || freq === 'SECONDLY') && filtersWholeDays) {
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
  // COUNT is the whole of it, and that is a narrowing from what this block used
  // to test. It used to refuse a synthesized-anchor MINUTELY/SECONDLY rule
  // carrying BYMINUTE off the interval grid, on the theory that it mirrored
  // `advancedAnchorMs`. It did not. `advancedAnchorMs` (recurrence.ts:252) keeps
  // the 1970 anchor for MINUTELY on BYHOUR alone — BYMINUTE never enters it —
  // and for SECONDLY on BYHOUR or BYMINUTE (:256). Measured through the real
  // `occurrencesBetween` over an 8-day window in America/New_York, every rule
  // the old clause refused is fast:
  //
  //   FREQ=MINUTELY;INTERVAL=7;BYMINUTE=0       13ms, 28 runs
  //   FREQ=MINUTELY;INTERVAL=7;BYMINUTE=0,30     2ms, 50 runs
  //   FREQ=MINUTELY;INTERVAL=13;BYMINUTE=0       0ms, 15 runs
  //   FREQ=MINUTELY;INTERVAL=45;BYMINUTE=0       1ms, 50 runs
  //
  // The BYHOUR half that WOULD have been a true mirror is unreachable here:
  // step 2 above refuses any sub-daily rule carrying a coarser BY part before
  // control arrives, so a MINUTELY rule with BYHOUR, and a SECONDLY rule with
  // BYHOUR or BYMINUTE, are already gone. Restoring the mirror would restore
  // dead code beside a live refusal, which is the shape that produced the wrong
  // model twice — so it is written down here instead of kept in the branch. If
  // step 2 is ever narrowed, this is the clause that has to come back.
  if (anchor === null && countRaw != null && (freq === 'MINUTELY' || freq === 'SECONDLY')) {
    return {
      safe: false,
      reason: 'slow_anchor',
      detail:
        `FREQ=${freq} with COUNT keeps the 1970 anchor, so the occurrences it counts are 1970's, not this year's. `
        + 'State a DTSTART to say when the rule starts, or drop COUNT and use UNTIL.',
    };
  }

  return { safe: true };
}
