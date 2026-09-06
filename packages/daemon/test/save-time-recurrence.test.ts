/**
 * Save-time materialization must accept every recurrence the scheduler can run.
 *
 * The bug: `validateAndMaterialize` in api.ts asked `nextOccurrenceAfter` for a
 * fire inside a SEVEN-DAY window, under a comment that claimed it was the full
 * horizon. Anything that fires less often than weekly has no occurrence in that
 * window when it is created mid-cycle, so:
 *
 *   - a monthly RRULE was refused at save with "RRULE has no future
 *     occurrences" — a user simply could not create a monthly job;
 *   - a monthly CRON was accepted with `next_fire = NULL`, and the tick query
 *     (`scheduler.ts`: `WHERE ... s.next_fire IS NOT NULL AND s.next_fire <= ?`)
 *     never looks at a NULL row again. Saved, listed, never fires.
 *
 * The fix keeps the "bounded work per call" intent that the seven was reaching
 * for — see the ladder assertions below, which pin that a per-minute rule is
 * still answered from a small window and is never expanded across two years.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer, nextFireForSave } from '../src/api.js';
import { nextOccurrenceAfter, type ScheduleLike } from '../src/recurrence.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const DAY_MS = 86_400_000;

let dir: string;
let db: DB;
let app: FastifyInstance;
let token: string;

const auth = (json: Record<string, unknown>): any => ({
  ...json,
  headers: { authorization: `Bearer ${token}` },
});

const base = {
  prompt: 'Summarize open TODOs in this repo.',
};

/** `YYYYMMDDTHHMMSSZ` — the iCal form RRULE's DTSTART wants. */
const dtstamp = (t: DateTime): string => t.toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");

/**
 * A day-of-month that is at least ~9 days out from now, and never 29/30/31 (a
 * BYMONTHDAY the short months skip would make the gap ambiguous). This is the
 * "created mid-cycle" case: the very shape the UI emits for "monthly on the Nth".
 */
function midCycleMonthDay(from: DateTime): { day: number; offsetDays: number } {
  for (let offsetDays = 10; offsetDays <= 28; offsetDays++) {
    const target = from.plus({ days: offsetDays });
    if (target.day <= 28) return { day: target.day, offsetDays };
  }
  throw new Error('unreachable: at most three days of any month are > 28');
}

const nextFireOf = (taskId: string): number | null =>
  (db.prepare('SELECT next_fire FROM schedules WHERE task_id=?').get(taskId) as { next_fire: number | null })
    .next_fire;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-save-recurrence-'));
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  const clock = new FakeClock(Date.now());
  const rm = new RunManager({
    db,
    clock,
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js', // never spawned: nothing here runs
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock, enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
  app = built.app;
  token = built.token;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /tasks — a recurrence created mid-cycle saves and gets a real next_fire', () => {
  it('accepts a MONTHLY rrule whose next fire is weeks away (the 422 that made monthly jobs impossible)', async () => {
    const now = DateTime.utc();
    const { day, offsetDays } = midCycleMonthDay(now);
    const res = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: {
          ...base,
          name: 'Monthly invoice sweep',
          schedule: { kind: 'rrule', rrule: `FREQ=MONTHLY;BYMONTHDAY=${day};BYHOUR=9;BYMINUTE=0`, tz: 'UTC' },
        },
      }),
    );

    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; nextFire: number | null };
    expect(body.nextFire).not.toBeNull();
    // The fire is the Nth of a month, so it lands within a day of the offset we
    // picked — never inside the old seven-day window, never two years out.
    const daysOut = (body.nextFire! - now.toMillis()) / DAY_MS;
    expect(daysOut).toBeGreaterThan(7);
    expect(daysOut).toBeLessThanOrEqual(offsetDays + 1);
    expect(nextFireOf(body.id)).toBe(body.nextFire); // visible to the tick query
  });

  it('accepts a FORTNIGHTLY rrule and materializes its first occurrence exactly', async () => {
    const first = DateTime.utc().plus({ days: 10 }).startOf('hour');
    const res = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: {
          ...base,
          name: 'Fortnightly dependency bump',
          schedule: {
            kind: 'rrule',
            rrule: `DTSTART:${dtstamp(first)}\nRRULE:FREQ=WEEKLY;INTERVAL=2`,
            tz: 'UTC',
          },
        },
      }),
    );

    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; nextFire: number | null };
    expect(body.nextFire).toBe(first.toMillis());
    expect(nextFireOf(body.id)).toBe(first.toMillis());
  });

  it('accepts a YEARLY rrule — the sparsest schedule the scheduler can still see', async () => {
    const anniversary = DateTime.utc().plus({ days: 200 }).startOf('hour');
    const res = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: {
          ...base,
          name: 'Annual license review',
          schedule: { kind: 'rrule', rrule: `DTSTART:${dtstamp(anniversary)}\nRRULE:FREQ=YEARLY`, tz: 'UTC' },
        },
      }),
    );

    expect(res.statusCode).toBe(201);
    expect((res.json() as { nextFire: number | null }).nextFire).toBe(anniversary.toMillis());
  });

  it('gives a MONTHLY cron a real next_fire instead of the NULL the tick loop ignores forever', async () => {
    const now = DateTime.utc();
    const { day, offsetDays } = midCycleMonthDay(now);
    const res = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: {
          ...base,
          name: 'Monthly cron report',
          schedule: { kind: 'cron', cron: `0 9 ${day} * *`, tz: 'UTC' },
        },
      }),
    );

    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; nextFire: number | null };
    // The silent half of the same bug: cron never returned 422, it just stored
    // NULL, and `WHERE s.next_fire IS NOT NULL` drops the row from every tick.
    expect(nextFireOf(body.id)).not.toBeNull();
    const daysOut = (nextFireOf(body.id)! - now.toMillis()) / DAY_MS;
    expect(daysOut).toBeGreaterThan(7);
    expect(daysOut).toBeLessThanOrEqual(offsetDays + 1);
  });

  it('still REFUSES a COUNT-exhausted rrule, and writes nothing', async () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c;
    const res = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: {
          ...base,
          name: 'Three runs, all in 2020',
          schedule: { kind: 'rrule', rrule: 'DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;COUNT=3', tz: 'UTC' },
        },
      }),
    );

    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('RRULE has no future occurrences');
    expect((db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c).toBe(before);
  });

  it('lets PATCH move an existing task onto a monthly rrule (same materializer, same bug)', async () => {
    const created = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: {
          ...base,
          name: 'Was a one-shot',
          schedule: { kind: 'once', runAt: Date.now() + 3_600_000, tz: 'UTC' },
        },
      }),
    );
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const now = DateTime.utc();
    const { day } = midCycleMonthDay(now);
    const patched = await app.inject(
      auth({
        method: 'PATCH',
        url: `/tasks/${id}`,
        payload: {
          schedule: { kind: 'rrule', rrule: `FREQ=MONTHLY;BYMONTHDAY=${day};BYHOUR=9;BYMINUTE=0`, tz: 'UTC' },
        },
      }),
    );

    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { nextFire: number | null }).nextFire).not.toBeNull();
    expect(nextFireOf(id)).not.toBeNull();
  });
});

describe('nextFireForSave — bounded work per call, and never narrower than the scheduler', () => {
  /** Records the horizon of each attempt and delegates to the real expander. */
  const spy = (): { horizons: number[]; resolve: typeof nextOccurrenceAfter } => {
    const horizons: number[] = [];
    return {
      horizons,
      resolve: (s, afterMs, horizonDays) => {
        horizons.push(horizonDays!);
        return nextOccurrenceAfter(s, afterMs, horizonDays);
      },
    };
  };

  const at = DateTime.utc(2026, 3, 7, 12).toMillis();

  it('answers a per-minute rule from the smallest window — it never scans two years', () => {
    const dense: ScheduleLike = {
      kind: 'rrule',
      rrule: `DTSTART:${dtstamp(DateTime.fromMillis(at, { zone: 'utc' }).minus({ days: 1 }))}\nRRULE:FREQ=MINUTELY`,
      tz: 'UTC',
    };
    const s = spy();

    const next = nextFireForSave(dense, at, s.resolve);

    expect(next).toBe(at + 60_000);
    expect(s.horizons).toEqual([8]); // one attempt, one small window
  });

  it('escalates only as far as a sparse rule needs', () => {
    const monthly: ScheduleLike = { kind: 'rrule', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0', tz: 'UTC' };
    const s = spy();

    const next = nextFireForSave(monthly, at, s.resolve);

    expect(next).toBe(DateTime.utc(2026, 4, 1, 9).toMillis());
    expect(s.horizons).toEqual([8, 70]); // stops at the rung that answered
  });

  it('walks the whole ladder before refusing, and the last rung is the scheduler’s own horizon', () => {
    const exhausted: ScheduleLike = { kind: 'rrule', rrule: 'DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;COUNT=3', tz: 'UTC' };
    const s = spy();

    expect(nextFireForSave(exhausted, at, s.resolve)).toBeNull();
    expect(s.horizons).toEqual([8, 70, 732]); // 366 * 2 — nextOccurrenceAfter's default
  });

  it('agrees with the scheduler on every schedule: what saves is exactly what will fire', () => {
    const cases: ScheduleLike[] = [
      { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0', tz: 'UTC' },
      { kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=30', tz: 'Europe/Berlin' },
      { kind: 'rrule', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0', tz: 'UTC' },
      { kind: 'rrule', rrule: 'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0', tz: 'UTC' }, // 59-day Jan->Mar gap
      { kind: 'rrule', rrule: 'FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0', tz: 'UTC' },
      { kind: 'rrule', rrule: 'DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;COUNT=3', tz: 'UTC' },
      { kind: 'cron', cron: '0 9 1 * *', tz: 'UTC' },
      { kind: 'cron', cron: '*/5 * * * *', tz: 'UTC' },
    ];

    for (const s of cases) {
      // Feb 1st: the worst anchor for BYMONTHDAY=31 and a mid-cycle anchor for
      // everything else.
      const anchor = DateTime.utc(2026, 2, 1, 12).toMillis();
      expect(nextFireForSave(s, anchor), JSON.stringify(s)).toBe(nextOccurrenceAfter(s, anchor));
    }
  });
});
