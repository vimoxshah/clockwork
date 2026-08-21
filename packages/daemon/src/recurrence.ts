/**
 * Recurrence expansion + next-fire materialization (arch §4, FR-4).
 * DST rules (normative, S-20/S-21): nonexistent local time fires at the
 * post-transition instant; ambiguous local time fires on the FIRST occurrence
 * (earlier UTC instant). All storage is UTC epoch ms; zones are IANA strings.
 */
import { DateTime } from 'luxon';
import * as cronerNs from 'croner';

// rrule 2.8 ships CJS; Node ESM sees it as default-only. Resolve both shapes.
import * as rruleNs from 'rrule';
const RRule: typeof import('rrule').RRule =
  (rruleNs as any).RRule ?? (rruleNs as any).default?.RRule;
const Cron: typeof cronerNs.Cron =
  (cronerNs as any).Cron ?? (cronerNs as any).default?.Cron;

export interface ScheduleLike {
  kind: 'once' | 'rrule' | 'cron';
  rrule?: string | null;
  cron?: string | null;
  runAt?: number | null;
  tz: string;
}

/** Convert a naive wall-clock component set in `tz` to UTC ms with DST rules. */
export function wallTimeToUtcMs(wall: DateTime, tz: string): number {
  const local = wall.setZone(tz, { keepLocalTime: true });
  // Round-trip detection: does this wall time exist unambiguously?
  const back = local.setZone('utc').setZone(tz);
  if (!local.isValid) {
    // Truly invalid → push forward minute-by-minute until valid (bounded).
    let probe = local.plus({ minutes: 1 });
    for (let i = 0; i < 180 && !probe.isValid; i++) probe = probe.plus({ minutes: 1 });
    return probe.toMillis();
  }
  if (back.hour !== local.hour || back.minute !== local.minute || back.day !== local.day) {
    // Nonexistent local time (spring-forward gap): Luxon shifted it backward;
    // normative rule = POST-transition instant. Shift forward until wall matches.
    let probe = local.plus({ minutes: 1 });
    for (let i = 0; i < 180; i++) {
      const pback = probe.setZone('utc').setZone(tz);
      if (pback.hour === probe.hour && pback.minute === probe.minute && pback.day === probe.day) {
        return probe.toMillis();
      }
      probe = probe.plus({ minutes: 1 });
    }
    return local.toMillis();
  }
  // Ambiguous (fall-back repeat): Luxon's default earlier-offset pick == S-21 first occurrence.
  return local.toMillis();
}

/**
 * Enumerate occurrences in (fromMsExclusive, toMsInclusive] in UTC epoch ms.
 * Bounded work per call — the tick loop must stay O(due), never O(history).
 */
export function occurrencesBetween(s: ScheduleLike, fromMsExcl: number, toMsIncl: number, limit = 500): number[] {
  if (s.kind === 'once') {
    return s.runAt != null && s.runAt > fromMsExcl && s.runAt <= toMsIncl ? [s.runAt] : [];
  }

  if (s.kind === 'rrule') {
    // Work in wall-time space anchored to UTC to iterate, then map through tz.
    const fromWall = DateTime.fromMillis(fromMsExcl, { zone: 'utc' });
    const toWall = DateTime.fromMillis(toMsIncl, { zone: 'utc' });
    let ruleText = s.rrule ?? '';
    // Without an explicit DTSTART the lib anchors at construction-time "now",
    // which breaks historical/fake-clock expansion. Anchor at epoch instead:
    // the between() window is the real boundary.
    if (!/DTSTART/i.test(ruleText)) {
      ruleText = `DTSTART:19700101T000000Z\n${ruleText}`;
    }
    const rule = RRule.fromString(ruleText);
    const between = rule.between(
      new Date(Date.UTC(fromWall.year, fromWall.month - 1, fromWall.day, fromWall.hour, fromWall.minute)),
      new Date(Date.UTC(toWall.year, toWall.month - 1, toWall.day, toWall.hour, toWall.minute)),
      true,
    );
    const out: number[] = [];
    for (const d of between.slice(-limit)) {
      const wall = DateTime.fromJSDate(d, { zone: 'utc' });
      out.push(wallTimeToUtcMs(wall, s.tz));
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }

  // cron — croner supports IANA tz natively
  const job = new Cron(s.cron ?? '', { name: 'cw-expand', timezone: s.tz, paused: true });
  try {
    const out: number[] = [];
    let cur = new Date(fromMsExcl);
    for (let i = 0; i < Math.min(limit, 200); i++) {
      const nextAny = (job as any).nextRun(cur) ?? (job as any)._nextRun?.(cur);
      if (!nextAny) break;
      const next = nextAny as Date;
      if (next.getTime() > toMsIncl) break;
      out.push(next.getTime());
      cur = next;
    }
    return out.sort((a, b) => a - b);
  } finally {
    job.stop();
  }
}

/** First occurrence strictly AFTER afterMs (for next_fire materialization). */
export function nextOccurrenceAfter(s: ScheduleLike, afterMs: number, horizonDays = 366 * 2): number | null {
  const horizon = afterMs + horizonDays * 86_400_000;
  const found = occurrencesBetween(s, afterMs, horizon, 1);
  return found.length > 0 ? found[0]! : null; // COUNT-exhausted RRULE → null → auto-disable (S-24)
}
