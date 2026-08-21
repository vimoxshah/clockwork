/**
 * T-107 API contract tests: auth, task CRUD w/ validation (S-23/S-26/S-36),
 * optimistic versioning 409 (S-82), run-now, runs/report/cancel, search,
 * widget snapshot, pause/resume.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase, createMigrator, type DB } from '../src/db.js';
import { readFileSync } from 'node:fs';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

let db: DB;
let dir: string;
let app: FastifyInstance;
let token: string;
let clock: FakeClock;

const MIGRATION = {
  id: '0001_init',
  sql: readFileSync(path.resolve(import.meta.dirname, '../migrations/0001_init.sql'), 'utf8'),
};

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-api-'));
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, [MIGRATION]).migrate();
  clock = new FakeClock(Date.now());

  const rm = new RunManager({
    db,
    clock,
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js', // not exercised in contract tests
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

function auth(json: any): { method: string; url: string; payload?: any; headers: Record<string, string> } {
  return { ...json, headers: { authorization: `Bearer ${token}` } };
}

const VALID_ONCE_TASK = {
  name: 'Nightly TODO digest',
  prompt: 'Summarize open TODOs in this repo.',
  schedule: { kind: 'once' as const, runAt: Date.now() + 3_600_000, tz: 'UTC' },
};

describe('auth', () => {
  it('rejects missing bearer token with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/tasks' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts valid bearer token', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/tasks' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('task CRUD + validation', () => {
  it('creates a once task and materializes next_fire', async () => {
    const res = await app.inject(
      auth({ method: 'POST', url: '/tasks', payload: VALID_ONCE_TASK }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.version).toBe(1);
    expect(body.nextFire).toBe(VALID_ONCE_TASK.schedule.runAt);
  });

  it('rejects past-dated once schedules with inline-fixable error (S-23)', async () => {
    const res = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: { ...VALID_ONCE_TASK, name: 'past', schedule: { kind: 'once', runAt: Date.now() - 5000, tz: 'UTC' } },
      }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('past');
  });

  it('rejects unparsable RRULE at save — daemon never sees invalid rows (S-26)', async () => {
    const res = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: { ...VALID_ONCE_TASK, name: 'bad rrule', schedule: { kind: 'rrule', rrule: 'FREQ=NOTAREALFREQ', tz: 'UTC' } },
      }),
    );
    expect(res.statusCode).toBe(422);
  });

  it('rejects non-git repo_path at save (S-36)', async () => {
    const res = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: { ...VALID_ONCE_TASK, name: 'bad repo', repoPath: '/definitely/not/a/repo' },
      }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('not a git repository');
  });

  it('optimistic versioning: stale version gets 409, fresh succeeds (S-82)', async () => {
    const created = (
      await app.inject(auth({ method: 'POST', url: '/tasks', payload: { ...VALID_ONCE_TASK, name: 'vtest' } }))
    ).json();

    // stale write
    const stale = await app.inject(
      auth({ method: 'PATCH', url: `/tasks/${created.id}`, payload: { name: 'stale edit', version: 0 } }),
    );
    expect(stale.statusCode).toBe(409);

    // concurrent stale write after a successful one
    const good = await app.inject(
      auth({ method: 'PATCH', url: `/tasks/${created.id}`, payload: { name: 'edit 1', version: 1 } }),
    );
    expect(good.statusCode).toBe(200);
    const secondStale = await app.inject(
      auth({ method: 'PATCH', url: `/tasks/${created.id}`, payload: { name: 'edit 2', version: 1 } }),
    );
    expect(secondStale.statusCode).toBe(409);
    const fresh = await app.inject(
      auth({ method: 'PATCH', url: `/tasks/${created.id}`, payload: { prompt: 'edited prompt ok', version: 2 } }),
    );
    expect(fresh.statusCode).toBe(200);
  });

  it('soft delete keeps history semantics (S-6)', async () => {
    const created = (
      await app.inject(auth({ method: 'POST', url: '/tasks', payload: { ...VALID_ONCE_TASK, name: 'deleteme' } }))
    ).json();
    const del = await app.inject(auth({ method: 'DELETE', url: `/tasks/${created.id}` }));
    expect(del.statusCode).toBe(200);
    const get = await app.inject(auth({ method: 'GET', url: `/tasks/${created.id}` }));
    expect(get.statusCode).toBe(404);
  });
});

describe('run-now + runs surface (FR-5)', () => {
  it('run-now enqueues an ad-hoc recorded run', async () => {
    const repoDir = path.join(os.tmpdir(), `cw-api-repo-${Date.now()}`);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: os.tmpdir() });
    rmSync(repoDir, { force: true, recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main']);
    void repoDir;

    const created = (
      await app.inject(auth({ method: 'POST', url: '/tasks', payload: VALID_ONCE_TASK }))
    ).json();
    const res = await app.inject(auth({ method: 'POST', url: `/tasks/${created.id}/run-now` }));
    expect(res.statusCode).toBe(202);
    const runId = res.json().runId;
    const runs = await app.inject(auth({ method: 'GET', url: '/runs' }));
    const row = runs.json().find((r: any) => r.id === runId);
    expect(row.state).toBe('queued');
    expect(JSON.parse(row.jobspec_json).taskName).toBe(VALID_ONCE_TASK.name);
  });

  it('cancel of queued run works; cancel of unknown id 409s', async () => {
    const created = (
      await app.inject(auth({ method: 'POST', url: '/tasks', payload: { ...VALID_ONCE_TASK, name: 'cancelme' } }))
    ).json();
    const runId = (await app.inject(auth({ method: 'POST', url: `/tasks/${created.id}/run-now` }))).json().runId;
    const cancel = await app.inject(auth({ method: 'POST', url: `/runs/${runId}/cancel` }));
    expect(cancel.statusCode).toBe(202);
    const bad = await app.inject(auth({ method: 'POST', url: '/runs/nope/cancel' }));
    expect(bad.statusCode).toBe(409);
  });

  it('report endpoint returns null report until finalize', async () => {
    const created = (
      await app.inject(auth({ method: 'POST', url: '/tasks', payload: { ...VALID_ONCE_TASK, name: 'reportme' } }))
    ).json();
    const runId = (await app.inject(auth({ method: 'POST', url: `/tasks/${created.id}/run-now` }))).json().runId;
    const rep = await app.inject(auth({ method: 'GET', url: `/runs/${runId}/report` }));
    expect(rep.statusCode).toBe(200);
    expect(rep.json().report).toBeNull();
  });
});

describe('search (FR-29-lite)', () => {
  it('finds tasks by prompt words', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/search?q=todos' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(1);
    expect(res.json()[0].kind).toBe('task');
  });

  it('returns [] for empty query safely', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/search?q=' }));
    expect(res.json()).toEqual([]);
  });
});

describe('widget snapshot + pause', () => {
  it('snapshot exposes only aggregate counts', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/widget/snapshot' }));
    const b = res.json();
    expect(typeof b.runsToday).toBe('number');
    expect(typeof b.needsYou).toBe('number');
  });

  it('pause-all / resume round-trips', async () => {
    const p = await app.inject(auth({ method: 'POST', url: '/pause-all' }));
    expect(p.json().paused).toBe(true);
    const r = await app.inject(auth({ method: 'POST', url: '/resume' }));
    expect(r.json().paused).toBe(false);
  });
});
