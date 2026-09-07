/**
 * Agent Workforce API contract tests (plan/AGENT-WORKFORCE-SPEC.md §2.6).
 *
 * The integrator owns this file: the twelve feature agents were forbidden from
 * touching `api.ts`, so nothing until the wiring pass could prove their routes
 * were reachable at all. Per §2.6 the minimum per route is one authenticated
 * happy case and one unauthenticated 401 — routes are OPEN BY DEFAULT in this
 * daemon, so the 401 is the only thing that proves the `/workforce/` auth
 * prefix actually landed. On top of that this file asserts the refusal paths
 * §2.2 names: 422 for a zod failure, 422 for a semantic failure, 404 for an
 * unknown id and 409 `already_resolved` for a second verdict.
 *
 * Harness is `api.test.ts`'s: temp dir, real RunManager pointed at a
 * nonexistent runner child (no run ever starts), buildServer, app.inject.
 * Runs are created with the exported `enqueueRunNow` rather than
 * POST /tasks/:id/run-now so no child spawn is attempted.
 *
 * This file does NOT re-test module behaviour — each feature's own suite does
 * that. It tests the wire: status codes, headers and the auth prefix.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer, enqueueRunNow } from '../src/api.js';
import { TaskRepo } from '../src/repo.js';
import { newId } from '@clockwork/shared';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

let db: DB;
let dir: string;
let app: FastifyInstance;
let token: string;
let tasks: TaskRepo;
/** module-scoped so a test can reach the finalize-hook wiring buildServer attaches to it */
let rm: RunManager;

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const tmpDirs: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-wfapi-'));
  db = openDatabase(dir).db;
  createMigrator(db, MIGRATIONS).migrate();
  tasks = new TaskRepo(db);

  rm = new RunManager({
    db,
    clock: new FakeClock(Date.now()),
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js', // not exercised in contract tests
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
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function auth(json: Record<string, unknown>): Record<string, unknown> {
  return { ...json, headers: { authorization: `Bearer ${token}` } };
}

/** A queued task with no schedule, created through the real route. */
async function makeTask(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject(
    auth({
      method: 'POST',
      url: '/tasks',
      payload: {
        name,
        prompt: `Prompt for ${name}.`,
        schedule: { kind: 'queue', tz: 'UTC' },
        ...extra,
      },
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

async function makeProfile(slug: string): Promise<string> {
  const res = await app.inject(
    auth({
      method: 'POST',
      url: '/profiles',
      payload: {
        slug,
        name: slug,
        engine: 'cli',
        permissionMode: 'acceptEdits',
        budget: { maxUsd: 1, maxTurns: 5, timeoutSec: 60 },
        skills: [],
        mcpAllow: [],
        contextRoots: [],
      },
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/** A `runs` row without pumping the manager — no child is ever spawned. */
function makeRun(taskId: string): string {
  return enqueueRunNow(db, tasks.get(taskId)!);
}

function setReport(runId: string, report: unknown): void {
  db.prepare("UPDATE runs SET state='completed', ended_at=?, report_json=? WHERE id=?").run(
    Date.now(),
    JSON.stringify(report),
    runId,
  );
}

function tmpRepo(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'cw-wfrepo-'));
  tmpDirs.push(d);
  return d;
}

function writeJobs(repoDir: string, contents: string): void {
  mkdirSync(path.join(repoDir, '.clockwork'), { recursive: true });
  writeFileSync(path.join(repoDir, '.clockwork', 'jobs.json'), contents, 'utf8');
}

// ---------------------------------------------------------------------------
// The auth prefix — the one snippet all twelve features share. Routes are open
// by default in this daemon, so without `/^\/workforce\//` every route below
// would ship anonymous. One 401 per route family, asserted first.
// ---------------------------------------------------------------------------
describe('auth prefix: every /workforce/ route family refuses an anonymous caller', () => {
  const ANONYMOUS: Array<[string, string, unknown?]> = [
    ['GET', '/workforce/plan-execute'],
    ['POST', '/workforce/plan-execute', { taskId: 'x' }],
    ['GET', '/workforce/handoff/whatever'],
    ['POST', '/workforce/handoff/whatever', { body: 'x' }],
    ['GET', '/workforce/office-hours'],
    ['POST', '/workforce/office-hours', { dow: 1, startMin: 0, endMin: 60, tz: 'UTC' }],
    ['PUT', '/workforce/office-hours/enabled', { enabled: true }],
    ['GET', '/workforce/sentinels'],
    ['POST', '/workforce/sentinels', {}],
    ['GET', '/workforce/repo-jobs'],
    ['POST', '/workforce/repo-jobs/discover', { repoPath: '/tmp' }],
    ['GET', '/workforce/runs/x/outcome'],
    ['POST', '/workforce/runs/x/outcome', { decision: 'accepted' }],
    ['GET', '/workforce/tasks/x/outcomes'],
    ['GET', '/workforce/autonomy/offers'],
    ['GET', '/workforce/autonomy/profiles/x'],
    ['GET', '/workforce/remediations'],
    ['POST', '/workforce/remediations/x/apply', {}],
    ['GET', '/workforce/runs/x/proposed-events'],
    ['GET', '/workforce/runs/x/proposed-events.ics'],
    ['GET', '/workforce/timesheets'],
    ['PUT', '/workforce/prefs/hourly-rate', { humanHourlyRateUsd: 1 }],
    ['GET', '/workforce/performance'],
    ['GET', '/workforce/performance/x'],
    ['GET', '/workforce/runs/x/proof-of-work'],
  ];

  for (const [method, url, payload] of ANONYMOUS) {
    it(`${method} ${url} is 401 without a bearer token`, async () => {
      const res = await app.inject({ method: method as 'GET', url, payload });
      expect(res.statusCode, res.body).toBe(401);
    });
  }

  // S-review (auth bypass, critical): every entry above tests the CANONICAL
  // spelling. The router percent-decodes before it matches, so one encoded
  // character used to skip the hook and still reach a mutating workforce
  // handler — repo-job import and remediation apply among them.
  it('refuses the percent-encoded spelling of a workforce route too', async () => {
    const encodedPrefix = await app.inject({ method: 'GET', url: '/%77orkforce/repo-jobs' });
    expect(encodedPrefix.statusCode, encodedPrefix.body).toBe(401);

    const encodedTail = await app.inject({
      method: 'POST',
      url: '/workforce/repo-job%73/discover',
      payload: { repoPath: '/tmp' },
    });
    expect(encodedTail.statusCode, encodedTail.body).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// F8's auto-booker — the wiring, not the module. The other two auto-bookers
// (F1 at api.ts and F4's bookWorker) evaluate the policy engine before they
// enqueue; this one did not, so every automatically booked diagnostic ran
// outside the engine allowlist, the BYOK restriction and the budget ceiling.
// ---------------------------------------------------------------------------
describe('F8 diagnostic booking obeys the policy engine', () => {
  it('refuses to book a diagnostic that breaks policy, and enqueues nothing', async () => {
    const taskId = await makeTask('F8 policy gate'); // default budget 2.0
    const booker = (rm as unknown as { deps: { selfHealing: { deps: { bookRun(t: string, p: string): string | null } } } }).deps
      .selfHealing.deps;
    const runsBefore = db.prepare('SELECT COUNT(*) c FROM runs').get();

    try {
      const put = await app.inject(auth({ method: 'PUT', url: '/policies', payload: { maxCostPerRunUsd: 1 } }));
      expect(put.statusCode, put.body).toBe(200);

      expect(booker.bookRun(taskId, 'diagnostic prompt')).toBeNull();
      expect(db.prepare('SELECT COUNT(*) c FROM runs').get()).toEqual(runsBefore);
    } finally {
      await app.inject(auth({ method: 'PUT', url: '/policies', payload: { maxCostPerRunUsd: null } }));
    }

    // with no policy in the way it still books, so the gate is the only change
    const runId = booker.bookRun(taskId, 'diagnostic prompt');
    expect(runId).not.toBeNull();
    db.prepare('DELETE FROM runs WHERE id=?').run(runId);
  });
});

// ---------------------------------------------------------------------------
// F1 plan-then-execute
// ---------------------------------------------------------------------------
describe('F1 /workforce/plan-execute', () => {
  let taskId: string;
  let pairId: string;

  it('creates a pair from a real task (201) and lists it', async () => {
    taskId = await makeTask('F1 source');
    const res = await app.inject(auth({ method: 'POST', url: '/workforce/plan-execute', payload: { taskId, planHour: 9, tz: 'UTC' } }));
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { id: string; planTaskId: string; executeTaskId: string; status: string };
    expect(body.status).toBe('awaiting_plan');
    expect(body.planTaskId).not.toBe(body.executeTaskId);
    pairId = body.id;

    const list = await app.inject(auth({ method: 'GET', url: '/workforce/plan-execute' }));
    expect(list.statusCode).toBe(200);
    expect((list.json() as { pairs: Array<{ id: string }> }).pairs.map((p) => p.id)).toContain(pairId);
  });

  it('refuses a body zod rejects with 422 validation', async () => {
    const res = await app.inject(auth({ method: 'POST', url: '/workforce/plan-execute', payload: { planHour: 9 } }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('validation');
  });

  it('refuses an unknown task with 422 and a sentence, not a 500', async () => {
    const res = await app.inject(auth({ method: 'POST', url: '/workforce/plan-execute', payload: { taskId: 'nope' } }));
    expect(res.statusCode).toBe(422);
    expect(typeof (res.json() as { error: string }).error).toBe('string');
  });

  it('404s an unknown pair id', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/workforce/plan-execute/nope' }));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('404s resolve for an unknown pair, and 422s a decision outside the enum', async () => {
    const missing = await app.inject(auth({ method: 'POST', url: '/workforce/plan-execute/nope/resolve', payload: { decision: 'approved' } }));
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject(auth({ method: 'POST', url: `/workforce/plan-execute/${pairId}/resolve`, payload: { decision: 'maybe' } }));
    expect(bad.statusCode).toBe(422);
  });

  it('409s a pair whose plan has not reached the gate — no plan, no verdict to give', async () => {
    const res = await app.inject(auth({ method: 'POST', url: `/workforce/plan-execute/${pairId}/resolve`, payload: { decision: 'approved' } }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already_resolved' });
  });

  it('resolves a pair standing at the gate, then 409s the second verdict', async () => {
    const gated = await app.inject(auth({ method: 'POST', url: '/workforce/plan-execute', payload: { taskId } }));
    expect(gated.statusCode).toBe(201);
    const id = (gated.json() as { id: string }).id;
    // Stand the pair at the gate the way run-manager's finalize hook does.
    db.prepare("UPDATE plan_execute_pairs SET status='awaiting_approval', updated_at=? WHERE id=?").run(Date.now(), id);

    const first = await app.inject(auth({ method: 'POST', url: `/workforce/plan-execute/${id}/resolve`, payload: { decision: 'rejected' } }));
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as { status: string }).status).toBe('rejected');

    const second = await app.inject(auth({ method: 'POST', url: `/workforce/plan-execute/${id}/resolve`, payload: { decision: 'approved' } }));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'already_resolved' });
  });
});

// ---------------------------------------------------------------------------
// F1's gate, asked on the ORDINARY task routes (ADR-039).
//
// `enabled=0` keeps the scheduler and the chain away from an execute half, but
// three routes reach a task row directly and never looked at the pair:
// POST /tasks/:id/run-now, the webhook fire path, and PATCH /tasks/:id
// {enabled:true} — which re-arms the chain, because run-manager.ts:683 fires
// successors `WHERE chain_after = ? AND enabled = 1` and the execute half does
// carry `chain_after` (plan-execute.ts:180). docs/agent-workforce.md says "the
// execute half never runs without your explicit approval of that specific
// plan"; without these refusals that sentence is false on all three.
// ---------------------------------------------------------------------------
describe('F1 approval gate holds on the ordinary task routes (ADR-039)', () => {
  /** A fresh pair, straight from the real route. Its execute half is the target. */
  async function makePair(name: string): Promise<{ pairId: string; planTaskId: string; executeTaskId: string }> {
    const sourceId = await makeTask(name);
    const res = await app.inject(
      auth({ method: 'POST', url: '/workforce/plan-execute', payload: { taskId: sourceId, planHour: 9, tz: 'UTC' } }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { id: string; planTaskId: string; executeTaskId: string };
    return { pairId: body.id, planTaskId: body.planTaskId, executeTaskId: body.executeTaskId };
  }

  it('409s run-now for an execute half whose plan nobody approved, and enqueues nothing', async () => {
    const { pairId, executeTaskId } = await makePair('F1 gate run-now');
    const before = db.prepare('SELECT COUNT(*) c FROM runs').get();

    const res = await app.inject(auth({ method: 'POST', url: `/tasks/${executeTaskId}/run-now` }));
    expect(res.statusCode, res.body).toBe(409);
    const body = res.json() as { error: string; code: string; pairId: string; pairStatus: string };
    expect(body.code).toBe('plan_not_approved');
    expect(body.pairId).toBe(pairId);
    expect(body.pairStatus).toBe('awaiting_plan');
    expect(body.error, 'the refusal has to be a sentence the UI can show').toMatch(/plan/i);
    // The whole point: no run row exists to be pumped.
    expect(db.prepare('SELECT COUNT(*) c FROM runs').get()).toEqual(before);
  });

  it('409s PATCH {enabled:true} for an execute half, leaving enabled=0 and the version unburned', async () => {
    const { pairId, executeTaskId } = await makePair('F1 gate patch');
    const before = db.prepare('SELECT enabled, version FROM tasks WHERE id=?').get(executeTaskId) as {
      enabled: number;
      version: number;
    };
    expect(before.enabled).toBe(0);

    const res = await app.inject(auth({ method: 'PATCH', url: `/tasks/${executeTaskId}`, payload: { enabled: true } }));
    expect(res.statusCode, res.body).toBe(409);
    const body = res.json() as { error: string; code: string; pairId: string };
    expect(body.code).toBe('execute_half_stays_disabled');
    expect(body.pairId).toBe(pairId);

    const after = db.prepare('SELECT enabled, version FROM tasks WHERE id=?').get(executeTaskId) as {
      enabled: number;
      version: number;
    };
    expect(after.enabled, 'the chain must stay un-armed (run-manager.ts:683)').toBe(0);
    expect(after.version).toBe(before.version);
  });

  // Re-enabling stays refused AFTER the verdict too: resolve('approved') books
  // the execute run itself (ADR-039), so an enabled execute half would only
  // ever mean "the next plan run fires it again, with a plan nobody read".
  it('409s PATCH {enabled:true} for an execute half whose pair is already resolved', async () => {
    const { pairId, executeTaskId } = await makePair('F1 gate patch resolved');
    db.prepare("UPDATE plan_execute_pairs SET status='executed', updated_at=? WHERE id=?").run(Date.now(), pairId);

    const res = await app.inject(auth({ method: 'PATCH', url: `/tasks/${executeTaskId}`, payload: { enabled: true } }));
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { code: string }).code).toBe('execute_half_stays_disabled');
    expect((db.prepare('SELECT enabled FROM tasks WHERE id=?').get(executeTaskId) as { enabled: number }).enabled).toBe(0);
  });

  it('409s the webhook fire path for an execute half, and books no run', async () => {
    const { executeTaskId } = await makePair('F1 gate webhook');
    const trg = await app.inject(
      auth({ method: 'POST', url: '/triggers', payload: { name: 'f1-gate-trigger', taskId: executeTaskId } }),
    );
    expect(trg.statusCode, trg.body).toBe(201);
    const triggerId = (trg.json() as { id: string }).id;
    const before = db.prepare('SELECT COUNT(*) c FROM runs').get();

    const fired = await app.inject({ method: 'POST', url: `/hooks/${triggerId}`, payload: { any: 'payload' } });
    expect(fired.statusCode, fired.body).toBe(409);
    expect((fired.json() as { code: string }).code).toBe('plan_not_approved');
    expect(db.prepare('SELECT COUNT(*) c FROM runs').get()).toEqual(before);
  });

  // Blast radius. The gate reads one table that only F1 writes, so a task that
  // is not an execute half is untouched — including the PLAN half, which is
  // exactly what a human runs to GET a plan.
  it('leaves ordinary tasks and the plan half alone: PATCH {enabled:true} still 200s', async () => {
    const ordinary = await makeTask('F1 gate blast radius');
    const off = await app.inject(auth({ method: 'PATCH', url: `/tasks/${ordinary}`, payload: { enabled: false } }));
    expect(off.statusCode, off.body).toBe(200);
    const on = await app.inject(auth({ method: 'PATCH', url: `/tasks/${ordinary}`, payload: { enabled: true } }));
    expect(on.statusCode, on.body).toBe(200);
    expect((db.prepare('SELECT enabled FROM tasks WHERE id=?').get(ordinary) as { enabled: number }).enabled).toBe(1);

    const { planTaskId } = await makePair('F1 gate plan half');
    const planPatch = await app.inject(auth({ method: 'PATCH', url: `/tasks/${planTaskId}`, payload: { enabled: true } }));
    expect(planPatch.statusCode, planPatch.body).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// F2 shift-handoff
// ---------------------------------------------------------------------------
describe('F2 /workforce/handoff/:taskId', () => {
  let taskId: string;

  it('appends a memory (201) and reads it back newest-first', async () => {
    taskId = await makeTask('F2 memory');
    const empty = await app.inject(auth({ method: 'GET', url: `/workforce/handoff/${taskId}` }));
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as { memories: unknown[] }).memories).toEqual([]);

    const res = await app.inject(
      auth({ method: 'POST', url: `/workforce/handoff/${taskId}`, payload: { tried: 'ran the suite', blocked: 'flaky test' } }),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { taskId: string }).taskId).toBe(taskId);

    const list = await app.inject(auth({ method: 'GET', url: `/workforce/handoff/${taskId}?limit=1` }));
    expect(list.statusCode).toBe(200);
    expect((list.json() as { memories: Array<{ tried: string }> }).memories).toHaveLength(1);
  });

  it('refuses an unknown task with 422 rather than letting the FK throw a 500', async () => {
    const res = await app.inject(auth({ method: 'POST', url: '/workforce/handoff/nope', payload: { body: 'x' } }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('unknown task');
  });

  it('refuses an author outside the enum with 422 validation', async () => {
    const res = await app.inject(auth({ method: 'POST', url: `/workforce/handoff/${taskId}`, payload: { author: 'martian' } }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// F3 office-hours
// ---------------------------------------------------------------------------
describe('F3 /workforce/office-hours', () => {
  let windowId: string;

  it('creates a window (201), lists it, and toggles the feature flag', async () => {
    const res = await app.inject(
      auth({ method: 'POST', url: '/workforce/office-hours', payload: { dow: 1, startMin: 540, endMin: 1020, tz: 'America/New_York' } }),
    );
    expect(res.statusCode, res.body).toBe(201);
    windowId = (res.json() as { id: string }).id;

    const list = await app.inject(auth({ method: 'GET', url: '/workforce/office-hours' }));
    expect(list.statusCode).toBe(200);
    const body = list.json() as { enabled: boolean; windows: Array<{ id: string }> };
    expect(body.windows.map((w) => w.id)).toContain(windowId);

    const on = await app.inject(auth({ method: 'PUT', url: '/workforce/office-hours/enabled', payload: { enabled: true } }));
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ enabled: true });
    const off = await app.inject(auth({ method: 'PUT', url: '/workforce/office-hours/enabled', payload: { enabled: false } }));
    expect(off.json()).toEqual({ enabled: false });
  });

  it('422s a window that ends before it starts', async () => {
    const res = await app.inject(auth({ method: 'POST', url: '/workforce/office-hours', payload: { dow: 1, startMin: 600, endMin: 60, tz: 'UTC' } }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('validation');
  });

  it('422s a time zone luxon cannot resolve — a window that would never open', async () => {
    const res = await app.inject(auth({ method: 'POST', url: '/workforce/office-hours', payload: { dow: 1, startMin: 0, endMin: 60, tz: 'Mars/Olympus' } }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/Unknown IANA time zone/);
  });

  it('422s a non-boolean enabled flag', async () => {
    const res = await app.inject(auth({ method: 'PUT', url: '/workforce/office-hours/enabled', payload: { enabled: 'yes' } }));
    expect(res.statusCode).toBe(422);
  });

  it('deletes a window (204) and 404s the second delete', async () => {
    const first = await app.inject(auth({ method: 'DELETE', url: `/workforce/office-hours/${windowId}` }));
    expect(first.statusCode).toBe(204);
    const second = await app.inject(auth({ method: 'DELETE', url: `/workforce/office-hours/${windowId}` }));
    expect(second.statusCode).toBe(404);
    expect(second.json()).toEqual({ error: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// F4 sentinel-worker
// ---------------------------------------------------------------------------
describe('F4 /workforce/sentinels', () => {
  let sentinelId: string;

  it('creates a sentinel bound to a real trigger (201) and lists it', async () => {
    const sentinelTaskId = await makeTask('F4 sentinel watcher');
    const workerTaskId = await makeTask('F4 worker');
    const trg = await app.inject(auth({ method: 'POST', url: '/triggers', payload: { name: 'f4-trigger', taskId: workerTaskId } }));
    expect(trg.statusCode, trg.body).toBe(201);
    const triggerId = (trg.json() as { id: string }).id;

    const res = await app.inject(
      auth({
        method: 'POST',
        url: '/workforce/sentinels',
        payload: { name: 'disk pressure', sentinelTaskId, triggerId, tripExpr: 'DISK FULL', cooldownSec: 60 },
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    sentinelId = (res.json() as { id: string }).id;

    const list = await app.inject(auth({ method: 'GET', url: '/workforce/sentinels' }));
    expect(list.statusCode).toBe(200);
    expect((list.json() as { sentinels: Array<{ id: string }> }).sentinels.map((s) => s.id)).toContain(sentinelId);
  });

  it('422s a body zod rejects', async () => {
    const res = await app.inject(auth({ method: 'POST', url: '/workforce/sentinels', payload: { name: '' } }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('validation');
  });

  it('422s an unknown trigger with a sentence a human can act on', async () => {
    const sentinelTaskId = await makeTask('F4 orphan watcher');
    const res = await app.inject(
      auth({
        method: 'POST',
        url: '/workforce/sentinels',
        payload: { name: 'orphan', sentinelTaskId, triggerId: 'nope', tripExpr: 'x' },
      }),
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('trigger not found');
  });

  it('lists trips for a real sentinel and 404s an unknown one', async () => {
    const ok = await app.inject(auth({ method: 'GET', url: `/workforce/sentinels/${sentinelId}/trips` }));
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { trips: unknown[] }).trips).toEqual([]);
    const missing = await app.inject(auth({ method: 'GET', url: '/workforce/sentinels/nope/trips' }));
    expect(missing.statusCode).toBe(404);
  });

  it('deletes a sentinel (204) and 404s the second delete', async () => {
    const first = await app.inject(auth({ method: 'DELETE', url: `/workforce/sentinels/${sentinelId}` }));
    expect(first.statusCode).toBe(204);
    const second = await app.inject(auth({ method: 'DELETE', url: `/workforce/sentinels/${sentinelId}` }));
    expect(second.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// F5 repo-shipped-jobs
// ---------------------------------------------------------------------------
describe('F5 /workforce/repo-jobs', () => {
  let offerId: string;

  it('discovers offers from a repo (200) and lists them', async () => {
    const repo = tmpRepo();
    writeJobs(
      repo,
      JSON.stringify({
        schema: 'clockwork.jobs.v1',
        jobs: [{ key: 'nightly', name: 'Nightly digest', prompt: 'Summarize open TODOs.' }],
      }),
    );
    const res = await app.inject(auth({ method: 'POST', url: '/workforce/repo-jobs/discover', payload: { repoPath: repo } }));
    expect(res.statusCode, res.body).toBe(200);
    const offers = (res.json() as { offers: Array<{ id: string; status: string }> }).offers;
    expect(offers).toHaveLength(1);
    expect(offers[0]!.status).toBe('offered');
    offerId = offers[0]!.id;

    const list = await app.inject(auth({ method: 'GET', url: '/workforce/repo-jobs?status=offered' }));
    expect(list.statusCode).toBe(200);
    expect((list.json() as { offers: Array<{ id: string }> }).offers.map((o) => o.id)).toContain(offerId);
  });

  it('422s a discover with no repoPath', async () => {
    const res = await app.inject(auth({ method: 'POST', url: '/workforce/repo-jobs/discover', payload: {} }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('validation');
  });

  it('422s a jobs file the parser refuses, instead of importing garbage', async () => {
    const repo = tmpRepo();
    writeJobs(repo, JSON.stringify({ schema: 'not.clockwork.jobs', jobs: [] }));
    const res = await app.inject(auth({ method: 'POST', url: '/workforce/repo-jobs/discover', payload: { repoPath: repo } }));
    expect(res.statusCode, res.body).toBe(422);
    expect(typeof (res.json() as { error: string }).error).toBe('string');
  });

  it('422s an unknown ?status filter rather than silently returning everything', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/workforce/repo-jobs?status=bogus' }));
    expect(res.statusCode).toBe(422);
  });

  it('imports an offer (201) and 404s import/dismiss for an unknown offer', async () => {
    const res = await app.inject(auth({ method: 'POST', url: `/workforce/repo-jobs/${offerId}/import`, payload: {} }));
    expect(res.statusCode, res.body).toBe(201);
    const taskId = (res.json() as { taskId: string }).taskId;
    expect(tasks.get(taskId)).toBeDefined();

    const missingImport = await app.inject(auth({ method: 'POST', url: '/workforce/repo-jobs/nope/import', payload: {} }));
    expect(missingImport.statusCode).toBe(404);
    const missingDismiss = await app.inject(auth({ method: 'POST', url: '/workforce/repo-jobs/nope/dismiss', payload: {} }));
    expect(missingDismiss.statusCode).toBe(404);
  });

  it('dismisses an offer', async () => {
    const repo = tmpRepo();
    writeJobs(
      repo,
      JSON.stringify({ schema: 'clockwork.jobs.v1', jobs: [{ key: 'weekly', name: 'Weekly', prompt: 'Weekly sweep.' }] }),
    );
    const disc = await app.inject(auth({ method: 'POST', url: '/workforce/repo-jobs/discover', payload: { repoPath: repo } }));
    const id = (disc.json() as { offers: Array<{ id: string }> }).offers[0]!.id;
    const res = await app.inject(auth({ method: 'POST', url: `/workforce/repo-jobs/${id}/dismiss`, payload: {} }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dismissed: true });
  });
});

// ---------------------------------------------------------------------------
// F6 accept-with-note
// ---------------------------------------------------------------------------
describe('F6 /workforce/runs/:runId/outcome', () => {
  let taskId: string;
  let runId: string;

  it('records a verdict, reads it back, and lists it for the task', async () => {
    taskId = await makeTask('F6 reviewed task');
    runId = makeRun(taskId);

    // "Nobody has decided yet" is the normal state of a fresh run, not an
    // error: the run exists, so the answer is an ordinary 200 carrying JSON
    // `null`. (It used to 404, which put a red line in the browser console
    // every time the inbox opened an undecided run and taught people to
    // ignore the console.)
    const before = await app.inject(auth({ method: 'GET', url: `/workforce/runs/${runId}/outcome` }));
    expect(before.statusCode, before.body).toBe(200);
    expect(before.headers['content-type']).toMatch(/application\/json/);
    expect(before.json()).toBeNull();

    const res = await app.inject(
      auth({ method: 'POST', url: `/workforce/runs/${runId}/outcome`, payload: { decision: 'accepted_with_note', note: 'ship it, but rename the flag' } }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { decision: string; memoryId: string | null };
    expect(body.decision).toBe('accepted_with_note');
    expect(body.memoryId).not.toBeNull(); // the note became a handoff memory

    const after = await app.inject(auth({ method: 'GET', url: `/workforce/runs/${runId}/outcome` }));
    expect(after.statusCode).toBe(200);
    const list = await app.inject(auth({ method: 'GET', url: `/workforce/tasks/${taskId}/outcomes` }));
    expect(list.statusCode).toBe(200);
    expect((list.json() as { outcomes: unknown[] }).outcomes).toHaveLength(1);
  });

  it('422s accepted_with_note carrying no note — the note IS the feature', async () => {
    const res = await app.inject(auth({ method: 'POST', url: `/workforce/runs/${runId}/outcome`, payload: { decision: 'accepted_with_note' } }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('validation');
  });

  it('404s a verdict on a run that does not exist', async () => {
    const res = await app.inject(auth({ method: 'POST', url: '/workforce/runs/nope/outcome', payload: { decision: 'accepted' } }));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('keeps "no such run" distinguishable from "no decision yet": 404 vs 200 null', async () => {
    const unknown = await app.inject(auth({ method: 'GET', url: '/workforce/runs/nope/outcome' }));
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not_found' });

    const undecided = await app.inject(auth({ method: 'GET', url: `/workforce/runs/${makeRun(await makeTask('F6 undecided run'))}/outcome` }));
    expect(undecided.statusCode, undecided.body).toBe(200);
    // A real JSON `null` body, not an empty one: the client parses this, it
    // does not fall into a "response had no body" catch path.
    expect(undecided.body).toBe('null');
    expect(undecided.json()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F7 earned-autonomy — including the gate that earns it the 'enforced' status
// ---------------------------------------------------------------------------
describe('F7 /workforce/autonomy', () => {
  let profileId: string;

  it('enrolls a profile at a rung and reports its state', async () => {
    profileId = await makeProfile('f7-enrolled');
    const res = await app.inject(auth({ method: 'POST', url: `/workforce/autonomy/profiles/${profileId}/enroll`, payload: { rung: 'plan' } }));
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { rung: string }).rung).toBe('plan');

    const state = await app.inject(auth({ method: 'GET', url: `/workforce/autonomy/profiles/${profileId}` }));
    expect(state.statusCode).toBe(200);
    expect((state.json() as { rung: string; streak: number }).rung).toBe('plan');
  });

  it('404s enroll and state for a profile that does not exist', async () => {
    const enroll = await app.inject(auth({ method: 'POST', url: '/workforce/autonomy/profiles/nope/enroll', payload: { rung: 'plan' } }));
    expect(enroll.statusCode).toBe(404);
    const state = await app.inject(auth({ method: 'GET', url: '/workforce/autonomy/profiles/nope' }));
    expect(state.statusCode).toBe(404);
  });

  it('422s a rung outside the ladder', async () => {
    const res = await app.inject(auth({ method: 'POST', url: `/workforce/autonomy/profiles/${profileId}/enroll`, payload: { rung: 'god-mode' } }));
    expect(res.statusCode).toBe(422);
  });

  it('lists offers and 422s an unknown ?status', async () => {
    const ok = await app.inject(auth({ method: 'GET', url: '/workforce/autonomy/offers' }));
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { offers: unknown[] }).offers).toEqual([]);
    const bad = await app.inject(auth({ method: 'GET', url: '/workforce/autonomy/offers?status=promoted' }));
    expect(bad.statusCode).toBe(422);
  });

  it('404s a respond for an unknown offer and 422s a decision outside the enum', async () => {
    const missing = await app.inject(auth({ method: 'POST', url: '/workforce/autonomy/offers/nope/respond', payload: { decision: 'accepted' } }));
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject(auth({ method: 'POST', url: '/workforce/autonomy/offers/nope/respond', payload: { decision: 'sure' } }));
    expect(bad.statusCode).toBe(422);
  });

  it('409s a second verdict on the same offer', async () => {
    const offerId = newId();
    db.prepare(
      `INSERT INTO autonomy_offers (id, profile_id, from_rung, to_rung, streak, status, offered_at, decided_at)
       VALUES (?, ?, 'plan', 'acceptEdits', 3, 'offered', ?, NULL)`,
    ).run(offerId, profileId, Date.now());

    const first = await app.inject(auth({ method: 'POST', url: `/workforce/autonomy/offers/${offerId}/respond`, payload: { decision: 'declined' } }));
    expect(first.statusCode, first.body).toBe(200);
    const second = await app.inject(auth({ method: 'POST', url: `/workforce/autonomy/offers/${offerId}/respond`, payload: { decision: 'accepted' } }));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'already_resolved' });
  });

  // S-review (high): the PATCH gate used to run AFTER `tasks.patch` had already
  // committed, so the 403 reported an escalation it had just persisted. F7 is
  // declared `enforced` and spec §F7 calls the gate fail-closed; a refusal that
  // leaves the new permission mode in the row is neither. The row assertions
  // below — not the status code — are what that regression would break.
  it('403s PATCH /tasks/:id BEFORE the escalation is written, leaving the row untouched', async () => {
    const gated = await makeProfile('f7-patch-gate');
    await app.inject(auth({ method: 'POST', url: `/workforce/autonomy/profiles/${gated}/enroll`, payload: { rung: 'plan' } }));

    const created = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: {
          name: 'F7 patch target',
          prompt: 'Do the thing.',
          profileId: gated,
          permissionMode: 'plan',
          schedule: { kind: 'queue', tz: 'UTC' },
        },
      }),
    );
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    const before = db.prepare('SELECT permission_mode, version FROM tasks WHERE id=?').get(id) as {
      permission_mode: string;
      version: number;
    };

    const refused = await app.inject(auth({ method: 'PATCH', url: `/tasks/${id}`, payload: { permissionMode: 'acceptEdits' } }));
    expect(refused.statusCode, refused.body).toBe(403);
    expect((refused.json() as { violation: string }).violation).toMatch(/autonomy_rung_exceeded/);

    const after = db.prepare('SELECT permission_mode, version FROM tasks WHERE id=?').get(id) as {
      permission_mode: string;
      version: number;
    };
    expect(after.permission_mode).toBe('plan'); // the escalation never landed
    expect(after.version).toBe(before.version); // and no version was burned

    // The same PATCH within the earned rung is still accepted.
    const allowed = await app.inject(auth({ method: 'PATCH', url: `/tasks/${id}`, payload: { name: 'F7 patch target renamed' } }));
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  // This is the evidence behind features.ts saying `earned_autonomy: 'enforced'`:
  // the refusal happens on a route that is NOT under /workforce/.
  it('403s POST /tasks when the task asks for more autonomy than its profile earned', async () => {
    const gated = await makeProfile('f7-plan-only');
    await app.inject(auth({ method: 'POST', url: `/workforce/autonomy/profiles/${gated}/enroll`, payload: { rung: 'plan' } }));

    const refused = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: {
          name: 'F7 over-reach',
          prompt: 'Do the thing.',
          profileId: gated,
          permissionMode: 'acceptEdits',
          schedule: { kind: 'queue', tz: 'UTC' },
        },
      }),
    );
    expect(refused.statusCode, refused.body).toBe(403);
    expect((refused.json() as { violation: string }).violation).toMatch(/autonomy_rung_exceeded/);

    // The same task at the rung it actually holds is accepted.
    const allowed = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: {
          name: 'F7 within rung',
          prompt: 'Do the thing.',
          profileId: gated,
          permissionMode: 'plan',
          schedule: { kind: 'queue', tz: 'UTC' },
        },
      }),
    );
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

  // S-review (NIT from the re-review): the gate above judges the PROSPECTIVE
  // row, which is right for a create and a trap for an edit. A GRANDFATHERED
  // task — one stored `acceptEdits` before its profile was enrolled at rung
  // 'plan' — fails the gate on its own stored values, so EVERY patch of it was
  // refused, including `{enabled:false}`: the one edit that makes it safe. A
  // fail-closed gate nobody can comply with is not fail-closed, it is stuck.
  it('lets a grandfathered task be patched when the patch does not raise autonomy', async () => {
    const gated = await makeProfile('f7-grandfathered');
    const id = await makeTask('F7 grandfathered', { permissionMode: 'acceptEdits' });
    // Enrol AFTER the task exists — POST /tasks would have refused it, which is
    // exactly why this row can only be reached by having pre-dated the rung.
    await app.inject(auth({ method: 'POST', url: `/workforce/autonomy/profiles/${gated}/enroll`, payload: { rung: 'plan' } }));
    db.prepare('UPDATE tasks SET profile_id=? WHERE id=?').run(gated, id);

    // Turning it OFF lowers nothing and raises nothing: it must land.
    const off = await app.inject(auth({ method: 'PATCH', url: `/tasks/${id}`, payload: { enabled: false } }));
    expect(off.statusCode, off.body).toBe(200);
    expect((db.prepare('SELECT enabled FROM tasks WHERE id=?').get(id) as { enabled: number }).enabled).toBe(0);

    // Lowering the mode toward the rung must land too ('default' is
    // 'acceptEdits' plus a human prompt per action, so it is strictly less).
    const lower = await app.inject(auth({ method: 'PATCH', url: `/tasks/${id}`, payload: { permissionMode: 'default' } }));
    expect(lower.statusCode, lower.body).toBe(200);
    expect((db.prepare('SELECT permission_mode FROM tasks WHERE id=?').get(id) as { permission_mode: string }).permission_mode).toBe('default');
  });

  it('still 403s a grandfathered task whose patch RAISES autonomy, and writes nothing', async () => {
    const gated = await makeProfile('f7-grandfathered-raise');
    const id = await makeTask('F7 grandfathered raise', { permissionMode: 'default' });
    await app.inject(auth({ method: 'POST', url: `/workforce/autonomy/profiles/${gated}/enroll`, payload: { rung: 'plan' } }));
    db.prepare('UPDATE tasks SET profile_id=? WHERE id=?').run(gated, id);
    const before = db.prepare('SELECT permission_mode, version FROM tasks WHERE id=?').get(id) as {
      permission_mode: string;
      version: number;
    };

    const refused = await app.inject(auth({ method: 'PATCH', url: `/tasks/${id}`, payload: { permissionMode: 'acceptEdits' } }));
    expect(refused.statusCode, refused.body).toBe(403);
    expect((refused.json() as { violation: string }).violation).toMatch(/autonomy_rung_exceeded/);

    const after = db.prepare('SELECT permission_mode, version FROM tasks WHERE id=?').get(id) as {
      permission_mode: string;
      version: number;
    };
    expect(after.permission_mode).toBe(before.permission_mode);
    expect(after.version).toBe(before.version);
  });
});

// ---------------------------------------------------------------------------
// F8 self-healing
// ---------------------------------------------------------------------------
describe('F8 /workforce/remediations', () => {
  let taskId: string;

  function makeProposal(): string {
    const id = newId();
    db.prepare(
      `INSERT INTO remediation_proposals (id, task_id, run_id, approval_id, target, current_value, proposed_value, rationale, status, created_at, decided_at)
       VALUES (?, ?, NULL, NULL, 'prompt', 'old prompt', 'new prompt', 'the old one was ambiguous', 'proposed', ?, NULL)`,
    ).run(id, taskId, Date.now());
    return id;
  }

  it('lists proposals and fetches one by id', async () => {
    taskId = await makeTask('F8 flaky task');
    const id = makeProposal();

    const list = await app.inject(auth({ method: 'GET', url: '/workforce/remediations?status=proposed' }));
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { proposals: Array<{ id: string }> }).proposals.map((p) => p.id)).toContain(id);

    const one = await app.inject(auth({ method: 'GET', url: `/workforce/remediations/${id}` }));
    expect(one.statusCode).toBe(200);
    expect((one.json() as { target: string }).target).toBe('prompt');
  });

  it('422s an unknown ?status and a non-positive ?limit', async () => {
    const status = await app.inject(auth({ method: 'GET', url: '/workforce/remediations?status=maybe' }));
    expect(status.statusCode).toBe(422);
    const limit = await app.inject(auth({ method: 'GET', url: '/workforce/remediations?limit=0' }));
    expect(limit.statusCode).toBe(422);
  });

  it('404s an unknown proposal on get, apply and reject', async () => {
    expect((await app.inject(auth({ method: 'GET', url: '/workforce/remediations/nope' }))).statusCode).toBe(404);
    expect((await app.inject(auth({ method: 'POST', url: '/workforce/remediations/nope/apply', payload: {} }))).statusCode).toBe(404);
    expect((await app.inject(auth({ method: 'POST', url: '/workforce/remediations/nope/reject', payload: {} }))).statusCode).toBe(404);
  });

  it('applies a proposal, writes the new prompt, then 409s the second apply', async () => {
    const id = makeProposal();
    const first = await app.inject(auth({ method: 'POST', url: `/workforce/remediations/${id}/apply`, payload: {} }));
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as { status: string }).status).toBe('applied');
    expect(tasks.get(taskId)!.prompt).toBe('new prompt');

    const second = await app.inject(auth({ method: 'POST', url: `/workforce/remediations/${id}/apply`, payload: {} }));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'already_resolved' });
  });

  it('rejects a proposal without touching the task, then 409s the second reject', async () => {
    const promptBefore = tasks.get(taskId)!.prompt;
    const id = makeProposal();
    const first = await app.inject(auth({ method: 'POST', url: `/workforce/remediations/${id}/reject`, payload: {} }));
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as { status: string }).status).toBe('rejected');
    expect(tasks.get(taskId)!.prompt).toBe(promptBefore);

    const second = await app.inject(auth({ method: 'POST', url: `/workforce/remediations/${id}/reject`, payload: {} }));
    expect(second.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// F9 proposed-events
// ---------------------------------------------------------------------------
describe('F9 /workforce/runs/:runId/proposed-events', () => {
  let runId: string;

  it('returns the run report’s proposals as JSON', async () => {
    const taskId = await makeTask('F9 suggester');
    runId = makeRun(taskId);
    setReport(runId, { summary: 'done', proposedEvents: [{ key: 'k1', title: 'Review PR 42', durationMin: 30 }] });

    const res = await app.inject(auth({ method: 'GET', url: `/workforce/runs/${runId}/proposed-events` }));
    expect(res.statusCode, res.body).toBe(200);
    const events = (res.json() as { events: Array<{ key: string; title: string }> }).events;
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe('Review PR 42');
  });

  it('serves the same proposals as a downloadable .ics, never writing a calendar', async () => {
    const res = await app.inject(auth({ method: 'GET', url: `/workforce/runs/${runId}/proposed-events.ics` }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/calendar/);
    expect(String(res.headers['content-disposition'])).toMatch(/attachment; filename=/);
    expect(res.body).toContain('BEGIN:VCALENDAR');
    expect(res.body).toContain('Review PR 42');
  });

  it('404s both routes for a run that does not exist', async () => {
    expect((await app.inject(auth({ method: 'GET', url: '/workforce/runs/nope/proposed-events' }))).statusCode).toBe(404);
    expect((await app.inject(auth({ method: 'GET', url: '/workforce/runs/nope/proposed-events.ics' }))).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// F10 timesheets
// ---------------------------------------------------------------------------
describe('F10 /workforce/timesheets', () => {
  it('returns a timesheet for the default window', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/workforce/timesheets' }));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { fromMs: number; toMs: number; rows: unknown[] };
    expect(body.toMs).toBeGreaterThan(body.fromMs);
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it('422s a window that ends before it starts', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/workforce/timesheets?from=2000&to=1000' }));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('to must be after from');
  });

  it('sets and clears the human hourly rate, and 422s a body without the key', async () => {
    const set = await app.inject(auth({ method: 'PUT', url: '/workforce/prefs/hourly-rate', payload: { humanHourlyRateUsd: 120 } }));
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual({ humanHourlyRateUsd: 120 });

    const sheet = await app.inject(auth({ method: 'GET', url: '/workforce/timesheets' }));
    expect((sheet.json() as { humanHourlyRateUsd: number | null }).humanHourlyRateUsd).toBe(120);

    const cleared = await app.inject(auth({ method: 'PUT', url: '/workforce/prefs/hourly-rate', payload: { humanHourlyRateUsd: null } }));
    expect(cleared.json()).toEqual({ humanHourlyRateUsd: null });

    // A bare PUT must NOT silently clear the rate — the key is required.
    const bare = await app.inject(auth({ method: 'PUT', url: '/workforce/prefs/hourly-rate', payload: {} }));
    expect(bare.statusCode).toBe(422);
    const negative = await app.inject(auth({ method: 'PUT', url: '/workforce/prefs/hourly-rate', payload: { humanHourlyRateUsd: -5 } }));
    expect(negative.statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// F11 performance-reviews
// ---------------------------------------------------------------------------
describe('F11 /workforce/performance', () => {
  let profileId: string;

  it('returns a scorecard list and a per-profile card', async () => {
    profileId = await makeProfile('f11-reviewed');
    const taskId = await makeTask('F11 measured task', { profileId });
    setReport(makeRun(taskId), { summary: 'done' });

    const list = await app.inject(auth({ method: 'GET', url: '/workforce/performance' }));
    expect(list.statusCode, list.body).toBe(200);
    expect(Array.isArray((list.json() as { cards: unknown[] }).cards)).toBe(true);

    const card = await app.inject(auth({ method: 'GET', url: `/workforce/performance/${profileId}` }));
    expect(card.statusCode, card.body).toBe(200);
    expect((card.json() as { profileId: string }).profileId).toBe(profileId);
  });

  it('renders a review prompt a human can paste', async () => {
    const res = await app.inject(auth({ method: 'GET', url: `/workforce/performance/${profileId}/review-prompt` }));
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { prompt: string }).prompt.length).toBeGreaterThan(0);
  });

  it('404s an id that names no profile and produced no runs', async () => {
    expect((await app.inject(auth({ method: 'GET', url: '/workforce/performance/nope' }))).statusCode).toBe(404);
    expect((await app.inject(auth({ method: 'GET', url: '/workforce/performance/nope/review-prompt' }))).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// F12 proof-of-work export
// ---------------------------------------------------------------------------
describe('F12 /workforce/runs/:runId/proof-of-work', () => {
  let runId: string;

  it('exports an HTML attachment for a real run', async () => {
    const taskId = await makeTask('F12 exported task');
    runId = makeRun(taskId);
    setReport(runId, { summary: 'shipped the thing', taskName: 'F12 exported task' });

    const res = await app.inject(auth({ method: 'GET', url: `/workforce/runs/${runId}/proof-of-work` }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(String(res.headers['content-disposition'])).toMatch(/attachment; filename=/);
    expect(res.body).toContain('shipped the thing');
  });

  it('honours the redactPaths query flag', async () => {
    const res = await app.inject(auth({ method: 'GET', url: `/workforce/runs/${runId}/proof-of-work?redactPaths=1&includeTranscript=0` }));
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('404s a run that does not exist', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/workforce/runs/nope/proof-of-work' }));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});
