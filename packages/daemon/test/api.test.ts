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
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer, requiresAuth } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

let db: DB;
let dir: string;
let app: FastifyInstance;
let token: string;
let clock: FakeClock;

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-api-'));
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
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

describe('SSE auth (S-audit)', () => {
  // /events used to accept ?token= because EventSource cannot set headers.
  // A bearer token in a URL reaches proxy logs, history and Referer headers.
  // The client now streams via fetch with a real Authorization header, so the
  // query-param path must stay closed — this is the regression guard.
  //
  // Only the rejection path is asserted here: the success path hijacks the
  // reply and streams indefinitely, which would hang inject(). It is covered
  // live in packages/ui/e2e/verify-sse.ts.
  it('rejects a VALID token supplied as a query parameter', async () => {
    const res = await app.inject({ method: 'GET', url: `/events?token=${encodeURIComponent(token)}` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects /events with no credentials at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(401);
  });
});

describe('token rotation', () => {
  it('replaces the credential: the old token stops working, the new one works', async () => {
    const before = token;

    const rot = await app.inject(auth({ method: 'POST', url: '/auth/rotate' }));
    expect(rot.statusCode).toBe(200);
    const next = (rot.json() as { token: string }).token;

    expect(next).not.toBe(before);
    expect(next.length).toBeGreaterThanOrEqual(32);

    // the OLD credential must now be rejected — this is the whole point
    const withOld = await app.inject({
      method: 'GET',
      url: '/profiles',
      headers: { authorization: `Bearer ${before}` },
    });
    expect(withOld.statusCode).toBe(401);

    // the NEW credential must work
    const withNew = await app.inject({
      method: 'GET',
      url: '/profiles',
      headers: { authorization: `Bearer ${next}` },
    });
    expect(withNew.statusCode).toBe(200);

    token = next; // keep the rest of the suite authenticated
  });

  it('refuses to rotate for an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/rotate' });
    expect(res.statusCode).toBe(401);
  });
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

  // S-review (auth bypass, critical): the hook used to test the RAW undecoded
  // URL while find-my-way percent-DECODES the path before matching a route, so
  // a single encoded character in the prefix skipped the hook and still reached
  // the handler. `GET /%74asks` answered 200 with no credential at all.
  it('rejects a percent-encoded spelling of a protected route, which the router still matches', async () => {
    const first = await app.inject({ method: 'GET', url: '/%74asks' });
    expect(first.statusCode, first.body).toBe(401);
    const middle = await app.inject({ method: 'GET', url: '/ta%73ks' });
    expect(middle.statusCode, middle.body).toBe(401);
  });

  it('still routes the encoded spelling for an authenticated caller', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/%74asks' }));
    expect(res.statusCode, res.body).toBe(200);
  });

  it('rejects unauthenticated access to calendar ICS sources (data route)', async () => {
    const res = await app.inject({ method: 'GET', url: '/calendars/ics' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthenticated template preview/import (control-plane routes)', async () => {
    const preview = await app.inject({
      method: 'POST',
      url: '/templates/preview',
      payload: { schema: 'clockwork.template.v1', name: 'x', prompt: 'y' },
    });
    expect(preview.statusCode).toBe(401);
    const imp = await app.inject({ method: 'POST', url: '/templates/import', payload: {} });
    expect(imp.statusCode).toBe(401);
  });

  it('github-source hook fails closed when no verification secret is configured', async () => {
    delete process.env.CLOCKWORK_GITHUB_WEBHOOK_SECRET;
    await app.inject(
      auth({
        method: 'POST',
        url: '/profiles',
        payload: { slug: 'hook-fixture', name: 'Hook Fixture', engine: 'cli', permissionMode: 'acceptEdits', budget: { maxUsd: 1, maxTurns: 5, timeoutSec: 60 }, skills: [], mcpAllow: [], contextRoots: [] },
      }),
    );
    const profilesRes = await app.inject(auth({ method: 'GET', url: '/profiles' }));
    const fixtureProfile = (profilesRes.json() as Array<{ id: string }>).find((p) => p.id) ?? { id: 'missing' };

    const taskRes = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: { ...VALID_ONCE_TASK, name: 'Hook task', profileId: fixtureProfile.id, schedule: { kind: 'queue', tz: 'UTC' } },
      }),
    );
    expect(taskRes.statusCode).toBe(201);
    const taskId = (taskRes.json() as { id: string }).id;

    const trgRes = await app.inject(
      auth({
        method: 'POST',
        url: '/triggers',
        payload: { name: 'gh-bypass-regression', source: 'github', taskId },
      }),
    );
    expect(trgRes.statusCode).toBe(201);
    const triggerId = (trgRes.json() as { id: string }).id;
    expect(triggerId).toBeTruthy();

    // The actual regression: with NO secret configured, a request carrying any
    // self-asserted GitHub signature header must NOT fire the task.
    const bypass = await app.inject({
      method: 'POST',
      url: `/hooks/${triggerId}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) },
      payload: { action: 'opened', pull_request: { number: 1 } },
    });
    expect([401, 503]).toContain(bypass.statusCode);
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

  // S-review: run-now now asks F1's approval gate before it enqueues (api.ts,
  // ADR-039). This is the blast-radius half of that change — the gate reads a
  // table only F1 writes, so an ordinary task must still run and still patch,
  // and the refusal must LIFT once a human has approved that specific plan.
  it('F1 approval gate leaves an ordinary task alone, and lifts for an approved pair', async () => {
    const ordinary = (
      await app.inject(auth({ method: 'POST', url: '/tasks', payload: { ...VALID_ONCE_TASK, name: 'f1 gate ordinary' } }))
    ).json();

    const ran = await app.inject(auth({ method: 'POST', url: `/tasks/${ordinary.id}/run-now` }));
    expect(ran.statusCode, ran.body).toBe(202);
    await app.inject(auth({ method: 'POST', url: `/runs/${ran.json().runId}/cancel` }));

    const patched = await app.inject(auth({ method: 'PATCH', url: `/tasks/${ordinary.id}`, payload: { enabled: true } }));
    expect(patched.statusCode, patched.body).toBe(200);

    const pair = await app.inject(
      auth({ method: 'POST', url: '/workforce/plan-execute', payload: { taskId: ordinary.id, planHour: 9, tz: 'UTC' } }),
    );
    expect(pair.statusCode, pair.body).toBe(201);
    const { id: pairId, executeTaskId } = pair.json();
    // The verdict a human gives at the gate, without going through resolve()
    // (which books the run itself): what is under test is the ROUTE.
    db.prepare("UPDATE plan_execute_pairs SET status='approved', decided_at=?, updated_at=? WHERE id=?").run(
      Date.now(),
      Date.now(),
      pairId,
    );
    const approvedRun = await app.inject(auth({ method: 'POST', url: `/tasks/${executeTaskId}/run-now` }));
    expect(approvedRun.statusCode, approvedRun.body).toBe(202);
    await app.inject(auth({ method: 'POST', url: `/runs/${approvedRun.json().runId}/cancel` }));
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

// ---------------------------------------------------------------------------
// S-review: both PATCH gates used to run AFTER `tasks.patch` committed, so a
// 403 reported a change it had already persisted. The policy gate is the
// pre-existing one; it moved with F7's autonomy gate because they share the
// shape and the same argument applies to both.
// ---------------------------------------------------------------------------
describe('PATCH /tasks/:id policy gate runs before the write', () => {
  it('403s a budget that breaks policy without persisting it', async () => {
    const created = await app.inject(auth({ method: 'POST', url: '/tasks', payload: { ...VALID_ONCE_TASK, name: 'policy patch target' } }));
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    const before = db.prepare('SELECT budget_usd, version FROM tasks WHERE id=?').get(id) as { budget_usd: number; version: number };

    try {
      const put = await app.inject(auth({ method: 'PUT', url: '/policies', payload: { maxCostPerRunUsd: 1 } }));
      expect(put.statusCode, put.body).toBe(200);

      const refused = await app.inject(
        auth({ method: 'PATCH', url: `/tasks/${id}`, payload: { budget: { maxUsd: 5, maxTurns: 50, timeoutSec: 3600 } } }),
      );
      expect(refused.statusCode, refused.body).toBe(403);

      const after = db.prepare('SELECT budget_usd, version FROM tasks WHERE id=?').get(id) as { budget_usd: number; version: number };
      expect(after.budget_usd).toBe(before.budget_usd); // the over-budget edit never landed
      expect(after.version).toBe(before.version);
    } finally {
      await app.inject(auth({ method: 'PUT', url: '/policies', payload: { maxCostPerRunUsd: null } }));
    }
  });

  it('keeps 404 and 409 ahead of the gates, as before', async () => {
    const missing = await app.inject(auth({ method: 'PATCH', url: '/tasks/nope', payload: { name: 'x' } }));
    expect(missing.statusCode).toBe(404);

    const created = await app.inject(auth({ method: 'POST', url: '/tasks', payload: { ...VALID_ONCE_TASK, name: 'version order target' } }));
    const id = (created.json() as { id: string }).id;
    try {
      await app.inject(auth({ method: 'PUT', url: '/policies', payload: { maxCostPerRunUsd: 1 } }));
      const stale = await app.inject(
        auth({ method: 'PATCH', url: `/tasks/${id}`, payload: { version: 99, budget: { maxUsd: 5, maxTurns: 50, timeoutSec: 3600 } } }),
      );
      expect(stale.statusCode, stale.body).toBe(409); // version conflict still wins over the 403
    } finally {
      await app.inject(auth({ method: 'PUT', url: '/policies', payload: { maxCostPerRunUsd: null } }));
    }
  });
});

// ---------------------------------------------------------------------------
// S-review (auth bypass): the hook's decision is now a pure function, so the
// fail-CLOSED branch is reachable from a test. Fastify answers a malformed
// percent-escape with 400 FST_ERR_BAD_URL *before* onRequest hooks run, so
// `app.inject` can never exercise it.
// ---------------------------------------------------------------------------
describe('requiresAuth — decides on the same path the router matches', () => {
  it('protects the canonical and the percent-encoded spelling alike', () => {
    expect(requiresAuth('/tasks')).toBe(true);
    expect(requiresAuth('/%74asks')).toBe(true);
    expect(requiresAuth('/ta%73ks')).toBe(true);
    expect(requiresAuth('/workforce/repo-jobs/discover')).toBe(true);
    expect(requiresAuth('/%77orkforce/repo-jobs/discover')).toBe(true);
    expect(requiresAuth('/workforce%2fremediations/x/apply')).toBe(true);
  });

  it('protects the absolute-form request target, which the router also resolves to /tasks', () => {
    // RFC 7230 §5.3.2. Verified against a real socket: `GET http://host/tasks
    // HTTP/1.1` reaches the /tasks handler while `req.raw.url` is the whole
    // absolute URL, so a prefix test on that string sees no match.
    expect(requiresAuth('http://127.0.0.1:4747/tasks')).toBe(true);
    expect(requiresAuth('http://127.0.0.1:4747/workforce/repo-jobs')).toBe(true);
    expect(requiresAuth('http://127.0.0.1:4747/%74asks')).toBe(true);
    expect(requiresAuth('http://127.0.0.1:4747/health')).toBe(false);
    expect(requiresAuth('*')).toBe(true); // not origin-form, not a URL: fail closed
  });

  it('fails CLOSED on a malformed percent-escape instead of letting it through', () => {
    expect(requiresAuth('/%ZZtasks')).toBe(true);
    expect(requiresAuth('/%E0%A4%A')).toBe(true);
    expect(requiresAuth('/%')).toBe(true);
  });

  it('leaves health and the static UI open, as before', () => {
    expect(requiresAuth('/health')).toBe(false);
    expect(requiresAuth('/')).toBe(false);
    expect(requiresAuth('/assets/index-abc123.js')).toBe(false);
  });

  it('decides on the path only, never on the query string', () => {
    expect(requiresAuth('/tasks?since=1')).toBe(true);
    expect(requiresAuth('/health?next=/tasks')).toBe(false);
    expect(requiresAuth('/health?next=%2Ftasks')).toBe(false);
  });
});
