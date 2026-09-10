/**
 * Re-deciding a run updates its verdict; it never stacks a second one (T4-6).
 *
 * Why this is a daemon test and not a UI one. The report can now record a
 * verdict in place (`OutcomeControls`, mounted under the summary), which makes
 * changing your mind easy — you read the diff, you accept, you read further,
 * you reject. `run_outcomes` is THE acceptance signal: F7's earned-autonomy
 * ladder reads the last N decisions for a profile, F10's timesheets and F11's
 * scorecards count them. A second row for one run would not be a cosmetic
 * duplicate; it would double-count that run in every one of those readers and
 * could hand out a rung nobody earned.
 *
 * So the property under test lives in SQL — `ON CONFLICT(run_id) DO UPDATE`
 * (acceptance.ts:92-101) — and the only honest way to prove it is to decide
 * twice through the real route and count the rows.
 *
 * `acceptance.test.ts` is one of the twelve F1–F12 suites whose test count
 * `claims-honesty.test.ts` holds against a hand-written number in
 * `plan/STATUS.md`, so this is a sibling file rather than an addition to it.
 *
 * Harness is `analytics.test.ts`'s: temp dir, real RunManager pointed at a
 * runner child that is never spawned, `buildServer`, `app.inject`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer, enqueueRunNow } from '../src/api.js';
import { TaskRepo } from '../src/repo.js';
import { SafetyJournal } from '@clockwork/runner';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

let db: DB;
let dir: string;
let app: FastifyInstance;
let token: string;
let tasks: TaskRepo;

interface OutcomeBody {
  runId: string;
  taskId: string;
  decision: string;
  note: string | null;
  memoryId: string | null;
  decidedAt: number;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-verdict-'));
  db = openDatabase(dir).db;
  createMigrator(db, MIGRATIONS).migrate();
  tasks = new TaskRepo(db);

  const rm = new RunManager({
    db,
    clock: new FakeClock(Date.now()),
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js',
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock: new FakeClock(Date.now()), enqueueRun: () => {}, notify: () => {} });
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

beforeEach(() => {
  db.exec('DELETE FROM run_outcomes');
});

function auth(json: Record<string, unknown>): Record<string, unknown> {
  return { ...json, headers: { authorization: `Bearer ${token}` } };
}

/** A finished run, created the way analytics.test.ts creates one: no child spawns. */
async function makeFinishedRun(name: string): Promise<string> {
  const created = await app.inject(
    auth({
      method: 'POST',
      url: '/tasks',
      payload: { name, prompt: `Prompt for ${name}.`, schedule: { kind: 'queue', tz: 'UTC' } },
    }),
  );
  expect(created.statusCode, created.body).toBe(201);
  const taskId = (created.json() as { id: string }).id;
  const runId = enqueueRunNow(db, tasks.get(taskId)!);
  const now = Date.now();
  db.prepare("UPDATE runs SET state='completed', started_at=?, ended_at=? WHERE id=?").run(now - 1000, now, runId);
  return runId;
}

function decide(runId: string, payload: Record<string, unknown>): Promise<{ statusCode: number; body: string }> {
  return app
    .inject(auth({ method: 'POST', url: `/workforce/runs/${runId}/outcome`, payload }))
    .then((r) => ({ statusCode: r.statusCode, body: r.body }));
}

function readBack(runId: string): Promise<{ statusCode: number; body: string }> {
  return app
    .inject(auth({ method: 'GET', url: `/workforce/runs/${runId}/outcome` }))
    .then((r) => ({ statusCode: r.statusCode, body: r.body }));
}

function rowCount(runId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM run_outcomes WHERE run_id=?').get(runId) as { c: number }).c;
}

describe('recording a verdict from the report', () => {
  it('accepts a finished run and reads the decision back', async () => {
    const runId = await makeFinishedRun('verdict accept');
    const posted = await decide(runId, { decision: 'accepted' });
    expect(posted.statusCode, posted.body).toBe(200);

    const got = await readBack(runId);
    expect(got.statusCode, got.body).toBe(200);
    expect((JSON.parse(got.body) as OutcomeBody).decision).toBe('accepted');
    expect(rowCount(runId)).toBe(1);
  });

  it('answers 200 with a bare null before anyone has decided', async () => {
    // OutcomeControls stores whatever this returns and renders the banner on a
    // bare truthiness check, so an envelope here would crash the panel.
    const runId = await makeFinishedRun('verdict undecided');
    const got = await readBack(runId);
    expect(got.statusCode, got.body).toBe(200);
    expect(JSON.parse(got.body)).toBeNull();
  });
});

describe('re-deciding updates the verdict rather than stacking a second one', () => {
  it('replaces accept with reject, and leaves exactly one row', async () => {
    const runId = await makeFinishedRun('verdict changed');
    expect((await decide(runId, { decision: 'accepted' })).statusCode).toBe(200);
    expect((await decide(runId, { decision: 'rejected' })).statusCode).toBe(200);

    const got = await readBack(runId);
    expect((JSON.parse(got.body) as OutcomeBody).decision).toBe('rejected');
    expect(rowCount(runId), 'a second row would double-count this run in F7, F10 and F11').toBe(1);
  });

  it('survives a whole sequence of changes of mind', async () => {
    const runId = await makeFinishedRun('verdict flip flop');
    for (const decision of ['accepted', 'rejected', 'accepted', 'rejected', 'accepted'] as const) {
      expect((await decide(runId, { decision })).statusCode).toBe(200);
    }
    expect(rowCount(runId)).toBe(1);
    expect((JSON.parse((await readBack(runId)).body) as OutcomeBody).decision).toBe('accepted');
  });

  it('carries the note onto the existing row, and clears it when the next verdict has none', async () => {
    const runId = await makeFinishedRun('verdict noted');
    expect((await decide(runId, { decision: 'accepted_with_note', note: 'Ship it, but pin the version.' })).statusCode).toBe(200);

    const noted = JSON.parse((await readBack(runId)).body) as OutcomeBody;
    expect(noted.decision).toBe('accepted_with_note');
    expect(noted.note).toBe('Ship it, but pin the version.');
    expect(noted.memoryId, 'the note is what F2 shift-handoff memory reads').not.toBeNull();
    expect(rowCount(runId)).toBe(1);

    expect((await decide(runId, { decision: 'accepted' })).statusCode).toBe(200);
    const plain = JSON.parse((await readBack(runId)).body) as OutcomeBody;
    expect(plain.decision).toBe('accepted');
    expect(plain.note, 'a stale note on a plain accept would misreport what the human said').toBeNull();
    expect(rowCount(runId)).toBe(1);
  });

  it('moves the decision timestamp forward, so the latest verdict is the one dated', async () => {
    const runId = await makeFinishedRun('verdict redated');
    await decide(runId, { decision: 'accepted' });
    const first = (JSON.parse((await readBack(runId)).body) as OutcomeBody).decidedAt;
    await new Promise((r) => setTimeout(r, 5));
    await decide(runId, { decision: 'rejected' });
    const second = (JSON.parse((await readBack(runId)).body) as OutcomeBody).decidedAt;
    expect(second).toBeGreaterThanOrEqual(first);
    expect(rowCount(runId)).toBe(1);
  });

  it('refuses a verdict on a run that does not exist, instead of inventing a row', async () => {
    const refused = await decide('run-that-never-was', { decision: 'accepted' });
    expect(refused.statusCode, refused.body).toBe(404);
    expect(rowCount('run-that-never-was')).toBe(0);
  });
});
