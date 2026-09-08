/**
 * POST /schedule/preview (SCH-3) and the end-to-end life of the rule the whole
 * change exists for (SCH-6).
 *
 * The endpoint is reachable per keystroke, which is exactly why the guard runs
 * before the expander rather than after it: an unreachable rule expanded here
 * would take the daemon's request thread with it while the user was still
 * typing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer, MAX_RRULE_COUNT, PREVIEW_RUN_COUNT } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

let dir: string;
let db: DB;
let app: FastifyInstance;
let token: string;
let realHome: string | undefined;
let clock: FakeClock;
let scheduler: Scheduler;
/** Task ids the scheduler actually booked. This is what "fireable" means. */
let booked: string[];

const auth = (json: Record<string, unknown>): any => ({
  ...json,
  headers: { authorization: `Bearer ${token}` },
});

const preview = (body: Record<string, unknown>): Promise<any> =>
  app.inject(auth({ method: 'POST', url: '/schedule/preview', payload: body }));

/** "Every 15 minutes, weekdays, 9 to 5" as the composer now emits it. */
const EVERY_15_WEEKDAYS = 'FREQ=HOURLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10,11,12,13,14,15,16;BYMINUTE=0,15,30,45';

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-preview-'));
  realHome = process.env.HOME;
  process.env.HOME = dir;
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  clock = new FakeClock(Date.now());
  booked = [];
  const rm = new RunManager({
    db, clock, dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js',
    notify: () => {}, broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  scheduler = new Scheduler({
    db,
    clock,
    // The scheduler's only way of starting work. Recording it is how this file
    // asserts a rule FIRES rather than asserting a copy of the tick's SELECT.
    enqueueRun: (spec: { taskId: string }) => { booked.push(spec.taskId); },
    notify: () => {},
  });
  const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
  app = built.app;
  token = built.token;
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /schedule/preview answers a rule without saving it', () => {
  it('returns five ascending future runs', async () => {
    const res = await preview({ kind: 'rrule', rrule: EVERY_15_WEEKDAYS, tz: 'America/New_York' });
    expect(res.statusCode, res.body).toBe(200);
    const runs = res.json().runs as number[];
    expect(runs.length).toBe(PREVIEW_RUN_COUNT);
    expect(runs.every((t) => t > Date.now())).toBe(true);
    expect([...runs].sort((a, b) => a - b)).toEqual(runs);
  });

  it('creates nothing — no task and no schedule row', async () => {
    await preview({ kind: 'rrule', rrule: EVERY_15_WEEKDAYS, tz: 'UTC' });
    expect((db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM schedules').get() as { c: number }).c).toBe(0);
  });

  it('reaches back for a monthly rule instead of answering empty', async () => {
    // A monthly rule has nothing in the 8-day rung; the ladder is what stops
    // preview reporting "never runs" for a perfectly good schedule.
    const res = await preview({ kind: 'rrule', rrule: 'FREQ=MONTHLY;BYMONTHDAY=28;BYHOUR=9;BYMINUTE=0', tz: 'UTC' });
    expect(res.statusCode).toBe(200);
    expect((res.json().runs as number[]).length).toBe(PREVIEW_RUN_COUNT);
  });

  it('previews a cron rule too', async () => {
    const res = await preview({ kind: 'cron', cron: '*/15 9-16 * * 1-5', tz: 'America/New_York' });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().runs as number[]).length).toBe(PREVIEW_RUN_COUNT);
  });
});

describe('the guard runs before the expander, not after it', () => {
  it('refuses an unreachable HOURLY rule with its reason, fast', async () => {
    // This rule does not terminate inside rrule. Answering at all is the proof.
    const t0 = Date.now();
    const res = await preview({ kind: 'rrule', rrule: 'FREQ=HOURLY;INTERVAL=2;BYHOUR=3', tz: 'UTC' });
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe('unreachable');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('refuses the FREQ=MINUTELY spelling of an interval rule', async () => {
    const res = await preview({
      kind: 'rrule',
      rrule: 'FREQ=MINUTELY;INTERVAL=15;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10;BYMINUTE=0,15,30,45',
      tz: 'UTC',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe('unreachable');
    expect(res.json().error).toMatch(/FREQ=HOURLY/);
  });

  it('refuses a DTSTART-less sub-daily rule that would replay from 1970', async () => {
    const res = await preview({ kind: 'rrule', rrule: 'FREQ=MINUTELY;INTERVAL=7;BYHOUR=5', tz: 'UTC' });
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe('slow_anchor');
  });

  it('mirrors save\'s COUNT ceiling, so preview is not the weaker door', async () => {
    const res = await preview({ kind: 'rrule', rrule: `FREQ=DAILY;COUNT=${MAX_RRULE_COUNT + 1};BYHOUR=9`, tz: 'UTC' });
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe('count_too_large');
  });

  it('rejects a kind it does not understand', async () => {
    const res = await preview({ kind: 'nonsense', tz: 'UTC' });
    expect(res.statusCode).toBe(422);
  });
});

describe('the rule this change exists for, end to end', () => {
  it('saves, and the real scheduler tick books a run for it', async () => {
    const t0 = Date.now();
    const res = await app.inject(auth({
      method: 'POST',
      url: '/tasks',
      payload: {
        name: 'Every 15 minutes, weekdays',
        prompt: 'check the queue',
        schedule: { kind: 'rrule', rrule: EVERY_15_WEEKDAYS, tz: 'America/New_York' },
      },
    }));
    const elapsed = Date.now() - t0;
    expect(res.statusCode, res.body).toBe(201);
    const taskId = res.json().id as string;

    const row = db.prepare('SELECT enabled, next_fire FROM schedules WHERE task_id = ?').get(taskId) as
      { enabled: number; next_fire: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
    expect(row!.next_fire).toBeGreaterThan(clock.now());

    // Not a copy of the tick's SELECT — the tick itself. Nothing here would
    // survive `scheduler.ts` changing its due-selection, which a duplicated
    // predicate silently would.
    await scheduler.tick();
    expect(booked, 'nothing is due yet').toEqual([]);

    clock.setTo(row!.next_fire + 1);
    await scheduler.tick();
    expect(booked, 'the rule fires once its next_fire arrives').toContain(taskId);

    // The schedule must also roll forward, or it fires once and stops.
    const after = db.prepare('SELECT next_fire FROM schedules WHERE task_id = ?').get(taskId) as { next_fire: number };
    expect(after.next_fire).toBeGreaterThan(row!.next_fire);

    // The FREQ=MINUTELY spelling of this rule costs 319-1872ms when it answers
    // at all, and hangs outright on a start day its BYDAY rejects. 500ms is a
    // ceiling the measured 12-23ms clears by an order of magnitude.
    expect(elapsed).toBeLessThan(500);
  });

  it('refuses to save a rule that would hang the scheduler', async () => {
    const res = await app.inject(auth({
      method: 'POST',
      url: '/tasks',
      payload: {
        name: 'unreachable',
        prompt: 'x',
        schedule: { kind: 'rrule', rrule: 'FREQ=HOURLY;INTERVAL=2;BYHOUR=3', tz: 'UTC' },
      },
    }));
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/unreachable/);
    expect((db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c).toBe(0);
  });
});
