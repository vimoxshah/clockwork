/**
 * Natural-language scheduling (P1): the matrix from the spec — weekday,
 * weekly, monthly, timezone, DST, invalid and ambiguous input — plus the
 * architectural invariant: every emitted string is a composer shape
 * (WEEKLY/DAILY/MONTHLY/HOURLY, no INTERVAL/MINUTELY/YEARLY/COUNT).
 *
 * Fixed clock: Wednesday 2026-09-23 12:00 UTC. America/New_York is EDT
 * (UTC-4) until 2026-11-01, EST (UTC-5) after — the DST cases pin both.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNaturalSchedule, wallToUtcMs, type NlRrule, type NlOnce } from '../src/lib/natural-schedule';

const WED = Date.UTC(2026, 8, 23, 12, 0, 0);
const NY = 'America/New_York';

function rrule(text: string, nowMs = WED, tz = NY): NlRrule {
  const r = parseNaturalSchedule({ text, nowMs, tz });
  if (r.kind !== 'rrule') throw new Error(`expected rrule for "${text}", got ${r.kind}: ${(r as any).message}`);
  return r;
}

function once(text: string, nowMs = WED, tz = NY): NlOnce {
  const r = parseNaturalSchedule({ text, nowMs, tz });
  if (r.kind !== 'once') throw new Error(`expected once for "${text}", got ${r.kind}: ${(r as any).message}`);
  return r;
}

function fails(text: string, nowMs = WED, tz = NY): string {
  const r = parseNaturalSchedule({ text, nowMs, tz });
  if (r.kind !== 'error') throw new Error(`expected error for "${text}", got ${r.kind}`);
  return r.message;
}

function wallHour(runAt: number, tz: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(runAt)),
  );
}

describe('weekly', () => {
  it('every Mon 2am → WEEKLY MO 02:00, high, no warnings', () => {
    const r = rrule('every Mon 2am');
    expect(r.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=2;BYMINUTE=0');
    expect(r.confidence).toBe('high');
    expect(r.warnings).toEqual([]);
    expect(r.interpretation).toContain('Monday');
    expect(r.interpretation).toContain(NY);
  });

  it('every Friday → weekly + assumed 9am, medium', () => {
    const r = rrule('every Friday');
    expect(r.rrule).toBe('FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0');
    expect(r.confidence).toBe('medium');
    expect(r.warnings.join(' ')).toMatch(/9:00 AM/);
  });

  it('every Mon, Wed, Fri at 6pm → three days', () => {
    expect(rrule('every Mon, Wed, Fri at 6pm').rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0');
  });

  it('weekly alone names the missing piece instead of guessing', () => {
    expect(fails('weekly')).toMatch(/which/);
  });
});

describe('daily shapes', () => {
  it('weekdays at 9 → MO–FR 09:00 high', () => {
    const r = rrule('weekdays at 9');
    expect(r.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0');
    expect(r.confidence).toBe('high');
  });

  it('every weekday at 9:30', () => {
    expect(rrule('every weekday at 9:30').rrule).toContain('BYHOUR=9;BYMINUTE=30');
  });

  it('weekends → SA,SU', () => {
    expect(rrule('weekends at 10am').rrule).toContain('BYDAY=SA,SU');
  });

  it('nightly defaults to 9 PM, said out loud', () => {
    const r = rrule('nightly');
    expect(r.rrule).toBe('FREQ=DAILY;BYHOUR=21;BYMINUTE=0');
    expect(r.confidence).toBe('medium');
    expect(r.warnings.join(' ')).toMatch(/9:00 PM/);
  });

  it('daily at 7:30am', () => {
    expect(rrule('daily at 7:30am').rrule).toBe('FREQ=DAILY;BYHOUR=7;BYMINUTE=30');
  });
});

describe('monthly', () => {
  it('monthly on the 15th at 9am', () => {
    const r = rrule('monthly on the 15th at 9am');
    expect(r.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0');
    expect(r.confidence).toBe('high');
  });

  it('monthly alone asks for the date', () => {
    expect(fails('monthly')).toMatch(/which date/);
  });

  it('the 31st refuses (short months would silently skip)', () => {
    expect(fails('monthly on the 31st')).toMatch(/short months/);
  });
});

describe('interval', () => {
  it('every 15 minutes → safe HOURLY grid', () => {
    const r = rrule('every 15 minutes');
    expect(r.rrule).toBe('FREQ=HOURLY;BYMINUTE=0,15,30,45');
  });

  it('every 90 minutes names the offered steps', () => {
    expect(fails('every 90 minutes')).toMatch(/5, 10, 15 or 30/);
  });

  it('hourly is refused, not approximated', () => {
    expect(fails('hourly')).toMatch(/every 5 minutes/);
  });
});

describe('one-offs', () => {
  it('tomorrow 9am lands at 9am wall time', () => {
    const r = once('tomorrow 9am');
    expect(r.runAt).toBeGreaterThan(WED);
    expect(wallHour(r.runAt, NY)).toBe(9);
    expect(r.interpretation).toContain(NY);
  });

  it('Friday at 5pm → the upcoming Friday 17:00 wall', () => {
    const r = once('Friday at 5pm');
    expect(wallHour(r.runAt, NY)).toBe(17);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short' }).format(new Date(r.runAt));
    expect(wd).toBe('Fri');
  });

  it('bare "Friday at 5" refuses instead of guessing 5am', () => {
    expect(fails('Friday at 5')).toMatch(/AM or .* PM/);
  });

  it('two times in one schedule refuse instead of dropping one', () => {
    expect(fails('every Mon at 2am and 3pm')).toMatch(/one time/);
  });

  it('"every minute" cannot become daily', () => {
    expect(fails('every minute')).toMatch(/5 minutes/);
  });

  it('an unreadable time errors instead of defaulting with a lying warning', () => {
    expect(fails('daily at 25:00')).toMatch(/Could not read a time/);
  });

  it('a DST-gap wall time refuses with the transition named', () => {
    // 2:30 AM never exists on 2026-03-08 in New York (spring forward) —
    // clock set before the date so the past check does not fire first.
    const feb = Date.UTC(2026, 1, 1, 12, 0, 0);
    expect(fails('March 8 2026 at 2:30am', feb, NY)).toMatch(/daylight-saving/);
  });

  it('Feb 29 on a non-leap year refuses instead of booking March 1st', () => {
    expect(fails('Feb 29 2026 at 9am', WED, NY)).toMatch(/does not exist/);
  });

  it('tonight defaults to evening, said out loud', () => {
    const r = once('tonight', Date.UTC(2026, 8, 23, 12), NY);
    // Noon UTC is 8am EDT: 9 PM EDT is still ahead.
    expect(wallHour(r.runAt, NY)).toBe(21);
    expect(r.warnings.join(' ')).toMatch(/9:00 PM/);
  });

  it('"day after tomorrow" books +2, not +1', () => {
    const r = once('day after tomorrow at 9am', WED, NY);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short', day: 'numeric' }).format(new Date(r.runAt));
    expect(r.runAt).toBeGreaterThan(WED + 86400_000);
    expect(wd).toMatch(/Fri/);
    expect(wallHour(r.runAt, NY)).toBe(9);
  });

  it('"in 2 hours" anchors on now, midnight-safe', () => {
    const r = once('in 2 hours', WED, NY);
    expect(r.runAt).toBe(WED + 2 * 3600_000);
    expect(r.confidence).toBe('high');
  });

  it('a past moment refuses', () => {
    expect(fails('today at 1am')).toMatch(/past/);
  });
});

describe('refusals', () => {
  it('every other Monday needs INTERVAL', () => {
    expect(fails('every other Monday')).toMatch(/interval/i);
  });

  it('every 2 weeks cannot become daily', () => {
    expect(fails('every 2 weeks')).toMatch(/Multi-week/);
  });

  it('every March cannot become daily', () => {
    expect(fails('every March')).toMatch(/Yearly/);
  });

  it('garbage gets guidance, not a guess', () => {
    const r = parseNaturalSchedule({ text: 'blorple', nowMs: WED, tz: NY });
    expect(r.kind).toBe('error');
  });

  it('empty and bad-tz inputs', () => {
    expect(fails('')).toMatch(/when this should run/);
    expect(fails('every Mon 2am', WED, 'Mars/Olympus')).toMatch(/timezone/i);
  });
});

describe('timezones and DST', () => {
  it('wallToUtcMs respects EDT vs EST', () => {
    // 2am Sep 15 (EDT, UTC-4) and 2am Nov 2 (EST, UTC-5 — DST ended Nov 1).
    expect(wallToUtcMs({ y: 2026, mo: 6, d: 15, h: 2, mi: 0 }, NY)).toBe(Date.UTC(2026, 6, 15, 6, 0));
    expect(wallToUtcMs({ y: 2026, mo: 10, d: 2, h: 2, mi: 0 }, NY)).toBe(Date.UTC(2026, 10, 2, 7, 0));
  });

  it('parses in the task tz, not the machine tz', () => {
    const r = rrule('every Mon 2am', WED, 'Asia/Tokyo');
    expect(r.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=2;BYMINUTE=0');
    expect(r.interpretation).toContain('Asia/Tokyo');
  });

  it('Feb 29 exists on leap years', () => {
    expect(wallToUtcMs({ y: 2024, mo: 1, d: 29, h: 9, mi: 0 }, NY)).toBeGreaterThan(0);
  });

  it('trailing garbage warns instead of booking silently', () => {
    const r = rrule('every Mon 2am please');
    expect(r.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=2;BYMINUTE=0');
    expect(r.confidence).toBe('medium');
    expect(r.warnings.join(' ')).toMatch(/Ignored extra text/);
  });
});

/**
 * The MACHINE timezone must not move a parse. chrono reads its reference
 * Date through local getters, so a reference built in the wrong frame shifts
 * every result by the laptop's UTC offset: "tomorrow" became today on a US
 * morning and two days out on an Indian evening. Node honours a runtime
 * change to process.env.TZ, so each case runs under several machine zones in
 * one process — this block fails on any machine, not only on one in the
 * wrong zone. CI also runs the whole suite under LA and Kolkata.
 */
describe('machine timezone never moves a parse', () => {
  const MACHINE_TZS = ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati'];
  const savedTz = process.env.TZ;
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  function wallDate(runAt: number, tz: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(runAt));
  }

  // 18:00 UTC is 23:30 IST, late on Wed Sep 23; 13:00 UTC is 6:00 AM PDT.
  const LATE_IST = Date.UTC(2026, 8, 23, 18, 0);
  const EARLY_LA = Date.UTC(2026, 8, 23, 13, 0);
  // 07:00 UTC is 3:00 AM EDT — a wall hour inside the 1–5 AM/PM refusal.
  const THREE_AM_NY = Date.UTC(2026, 8, 23, 7, 0);

  for (const machine of MACHINE_TZS) {
    describe(`machine TZ=${machine}`, () => {
      beforeEach(() => {
        process.env.TZ = machine;
      });

      it('"tomorrow 9am" late at night in Kolkata is the next wall day', () => {
        const r = once('tomorrow 9am', LATE_IST, 'Asia/Kolkata');
        expect(wallDate(r.runAt, 'Asia/Kolkata')).toBe('Thu, Sep 24');
        expect(wallHour(r.runAt, 'Asia/Kolkata')).toBe(9);
      });

      it('"tomorrow 9am" early morning in LA is tomorrow, not today', () => {
        const r = once('tomorrow 9am', EARLY_LA, 'America/Los_Angeles');
        expect(wallDate(r.runAt, 'America/Los_Angeles')).toBe('Thu, Sep 24');
        expect(wallHour(r.runAt, 'America/Los_Angeles')).toBe(9);
      });

      it('"next week" is seven wall days out, time assumed out loud', () => {
        const ist = once('next week', LATE_IST, 'Asia/Kolkata');
        expect(wallDate(ist.runAt, 'Asia/Kolkata')).toBe('Wed, Sep 30');
        expect(wallHour(ist.runAt, 'Asia/Kolkata')).toBe(9);
        expect(ist.warnings.join(' ')).toMatch(/Assumed 9:00 AM/);
        const la = once('next week', EARLY_LA, 'America/Los_Angeles');
        expect(wallDate(la.runAt, 'America/Los_Angeles')).toBe('Wed, Sep 30');
      });

      it('"Friday at 5pm" is the coming Friday at 17:00 in the task zone', () => {
        const r = once('Friday at 5pm', LATE_IST, 'Asia/Kolkata');
        expect(wallDate(r.runAt, 'Asia/Kolkata')).toBe('Fri, Sep 25');
        expect(wallHour(r.runAt, 'Asia/Kolkata')).toBe(17);
      });

      it('"every 15 minutes" books the grid, even at 3 AM task time', () => {
        expect(rrule('every 15 minutes').rrule).toBe('FREQ=HOURLY;BYMINUTE=0,15,30,45');
        expect(rrule('every 15 minutes', THREE_AM_NY, NY).rrule).toBe('FREQ=HOURLY;BYMINUTE=0,15,30,45');
      });

      it('"in 2 hours" is now + 2h, even at 3 AM task time', () => {
        expect(once('in 2 hours', THREE_AM_NY, NY).runAt).toBe(THREE_AM_NY + 2 * 3600_000);
      });

      it('"every Mon 2am" is Monday 02:00 in the task zone', () => {
        expect(rrule('every Mon 2am', LATE_IST, 'Asia/Kolkata').rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=2;BYMINUTE=0');
      });
    });
  }
});

describe('hour and day steps never become a daily job', () => {
  it('"every 2 hours" refuses with guidance instead of booking daily or once', () => {
    const r = parseNaturalSchedule({ text: 'every 2 hours', nowMs: WED, tz: NY });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('unreachable');
    expect(r.message).toMatch(/hour/i);
    expect(r.hint).toMatch(/every 30 minutes/);
  });

  it('"every hour" and "every 3 hrs" refuse the same way', () => {
    expect(fails('every hour')).toMatch(/hour/i);
    expect(fails('every 3 hrs')).toMatch(/hour/i);
  });

  it('"every 2 days" refuses instead of becoming daily', () => {
    expect(fails('every 2 days')).toMatch(/Multi-day/);
  });
});

describe('residue warnings name only text the parser never read', () => {
  it('"on weekdays" is not ignored text — the rule used it', () => {
    const r = rrule('every 5 minutes on weekdays 9 to 17');
    expect(r.rrule).toBe('FREQ=HOURLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10,11,12,13,14,15,16;BYMINUTE=0,5,10,15,20,25,30,35,40,45,50,55');
    expect(r.warnings).toEqual([]);
    expect(r.confidence).toBe('high');
  });

  it('"every 15 minutes on weekends" keeps quiet too', () => {
    expect(rrule('every 15 minutes on weekends').warnings).toEqual([]);
  });

  it('real leftovers still warn', () => {
    expect(rrule('every 5 minutes on weekdays please').warnings.join(' ')).toMatch(/Ignored extra text.*please/);
  });
});

describe('shape guarantee: only composer shapes leave this module', () => {
  const inputs = [
    'every Mon 2am',
    'every Friday',
    'weekdays at 9',
    'every weekday at 9:30',
    'weekends at 10am',
    'nightly',
    'daily at 7:30am',
    'every Mon, Wed, Fri at 6pm',
    'monthly on the 15th at 9am',
    'every 15 minutes',
    'every 5 minutes on weekdays 9 to 17',
  ];
  for (const text of inputs) {
    it(`"${text}" emits a guarded shape`, () => {
      const r = rrule(text);
      expect(r.rrule).toMatch(/^FREQ=(WEEKLY|DAILY|MONTHLY|HOURLY);/);
      expect(r.rrule).not.toMatch(/MINUTELY|YEARLY|COUNT|INTERVAL/);
    });
  }
});
