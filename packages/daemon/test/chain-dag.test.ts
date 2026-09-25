/**
 * Chaining v2 DAG (P3): edge validation, union parents/children, {{runs.*}}
 * binding, all-parents firing gates, legacy column behavior intact, and the
 * pipeline view-model route.
 *
 * Firing runs through the REAL RunManager.fireChainedTasks (repo-less tasks,
 * so no worktree/preflight involved) — queued rows, materialized prompts and
 * chain_* events are all asserted, not simulated.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import {
  validateEdge,
  normalizeChainOn,
  chainParents,
  chainChildren,
  renderChainPrompt,
  upstreamRefs,
} from '../src/templates.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

function freshDb(): { db: DB; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-dag-'));
  const db = openDatabase(dir).db;
  createMigrator(db, MIGRATIONS).migrate();
  return { db, dir };
}

function addTask(db: DB, id: string, opts: { prompt?: string; chainAfter?: string | null; chainOn?: string | null; enabled?: number } = {}): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, chain_after, chain_on, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, id, opts.prompt ?? 'p', opts.chainAfter ?? null, opts.chainOn ?? null, opts.enabled ?? 1, now, now);
}

function addEdge(db: DB, parent: string, child: string, on = 'completed'): void {
  db.prepare('INSERT INTO chain_edges (parent_task_id, child_task_id, on_state, created_at) VALUES (?,?,?,?)').run(
    parent,
    child,
    on,
    Date.now(),
  );
}

function addRun(
  db: DB,
  id: string,
  taskId: string,
  state: string,
  report: Record<string, unknown> | null = null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, ended_at, report_json) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, taskId, JSON.stringify({ taskId }), state, now, now, state === 'completed' || state === 'failed' ? now : null, report ? JSON.stringify(report) : null);
}

describe('validateEdge', () => {
  it('rejects self, duplicates, bad on, missing tasks', () => {
    const { db, dir } = freshDb();
    try {
      addTask(db, 'a');
      addTask(db, 'b');
      expect(validateEdge(db, 'a', 'a', 'completed')).toMatch(/itself/);
      expect(validateEdge(db, 'a', 'b', 'sometimes')).toMatch(/on must be/);
      expect(validateEdge(db, 'ghost', 'b', 'completed')).toMatch(/not found/);
      expect(validateEdge(db, 'a', 'ghost', 'completed')).toMatch(/not found/);
      expect(validateEdge(db, 'a', 'b', 'completed')).toBeNull();
      addEdge(db, 'a', 'b');
      expect(validateEdge(db, 'a', 'b', 'completed')).toMatch(/already exists/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects cycles through the union graph, allows diamonds', () => {
    const { db, dir } = freshDb();
    try {
      for (const id of ['a', 'b', 'c', 'd']) addTask(db, id);
      addEdge(db, 'a', 'b');
      addEdge(db, 'b', 'c');
      // c→a would close a→b→c→a.
      expect(validateEdge(db, 'c', 'a', 'completed')).toMatch(/cycle/);
      // Fan-out and fan-in are acyclic: a→c joins a→b→c as a diamond.
      expect(validateEdge(db, 'a', 'c', 'completed')).toBeNull();
      expect(validateEdge(db, 'b', 'd', 'completed')).toBeNull();
      // The column participates in the union: d -column→ c, so d→a would
      // close a→b→c→d→a through mixed links.
      db.prepare('UPDATE tasks SET chain_after=? WHERE id=?').run('c', 'd');
      expect(validateEdge(db, 'd', 'a', 'completed')).toMatch(/cycle/);
      expect(validateEdge(db, 'a', 'd', 'completed')).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sees legacy column links as existing dependencies', () => {
    const { db, dir } = freshDb();
    try {
      addTask(db, 'a');
      addTask(db, 'b', { chainAfter: 'a' });
      expect(validateEdge(db, 'a', 'b', 'completed')).toMatch(/already exists/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores soft-deleted tasks in the union graph', () => {
    const { db, dir } = freshDb();
    try {
      addTask(db, 'a');
      addTask(db, 'b');
      addTask(db, 'c');
      addEdge(db, 'a', 'b');
      addEdge(db, 'b', 'c');
      db.prepare('UPDATE tasks SET deleted_at=? WHERE id=?').run(Date.now(), 'b');
      expect(chainParents(db, 'c')).toEqual([]);
      expect(chainChildren(db, 'a')).toEqual([]);
      // b deleted: a→c directly is fine (b no longer bridges a cycle).
      expect(validateEdge(db, 'a', 'c', 'completed')).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('union parents/children + on normalization', () => {
  it('reads both mechanisms, dedupes, normalizes legacy success', () => {
    const { db, dir } = freshDb();
    try {
      addTask(db, 'a');
      addTask(db, 'b', { chainAfter: 'a', chainOn: 'success' });
      addTask(db, 'c');
      addEdge(db, 'a', 'c', 'any_terminal');
      expect(chainParents(db, 'b')).toEqual([{ parentId: 'a', on: 'completed', via: 'column' }]);
      expect(chainParents(db, 'c')).toEqual([{ parentId: 'a', on: 'any_terminal', via: 'edge' }]);
      expect(chainChildren(db, 'a')).toHaveLength(2);
      expect(normalizeChainOn('success')).toBe('completed');
      expect(normalizeChainOn('any_terminal')).toBe('any_terminal');
      expect(normalizeChainOn(undefined)).toBe('completed');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderChainPrompt {{runs.*}}', () => {
  const rep = (summary: string, artifacts: string[] = []) => ({ report_json: JSON.stringify({ summary, artifacts }) });

  it('binds each parent id explicitly with truncation', () => {
    const byTask = new Map([
      ['scan', rep('3 findings', ['a.md'])],
      ['deps', rep('clean', [])],
    ]);
    const out = renderChainPrompt('S: {{runs.scan.report}}\nD: {{runs.deps.report}} / {{runs.deps.artifacts}}', undefined, 12_000, byTask);
    expect(out).toContain('3 findings');
    expect(out).toContain('Artifacts: a.md');
    expect(out).toContain('clean');
  });

  it('names unknown ids and run-less parents instead of blanking', () => {
    const byTask = new Map([['scan', undefined]]);
    const out = renderChainPrompt('{{runs.ghost.report}} {{runs.scan.report}}', undefined, 12_000, byTask);
    expect(out).toContain('unknown upstream task ghost');
    expect(out).toContain('has no runs yet');
  });

  it('column-created cycles through edges are refused', async () => {
    const { validateChain } = await import('../src/templates.js');
    const { db, dir } = freshDb();
    try {
      addTask(db, 'a');
      addTask(db, 'b');
      addTask(db, 'c');
      addEdge(db, 'a', 'b');
      addEdge(db, 'b', 'c');
      // PATCH a.chain_after=c would close a→b→c→a through mixed links: the
      // old column-only walk stopped at c (no column parent) and passed it.
      expect(validateChain(db, 'a', 'c')).toMatch(/cycle/);
      // Same-direction column link is a duplicate relationship, not a cycle —
      // but the single-successor rule still governs the column itself.
      addTask(db, 'z');
      expect(validateChain(db, 'z', 'a')).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves legacy {{previous.*}} behavior identical', () => {
    const out = renderChainPrompt('Was: {{previous.report}}', { report_json: JSON.stringify({ summary: 'hi', artifacts: [] }) });
    expect(out).toBe('Was: hi');
  });

  it('caps total {{runs.*}} context across fan-in', async () => {
    const { renderChainPrompt } = await import('../src/templates.js');
    const byTask = new Map(
      Array.from({ length: 10 }, (_, i) => [`p${i}`, { report_json: JSON.stringify({ summary: 'x'.repeat(10000), artifacts: [] }) }]),
    );
    const prompt = Array.from({ length: 10 }, (_, i) => `{{runs.p${i}.report}}`).join('\n');
    const out = renderChainPrompt(prompt, undefined, 12_000, byTask);
    expect(out.length).toBeLessThan(30_000);
    expect(out).toContain('context budget exhausted');
  });

  it('upstreamRefs extracts ids', () => {
    expect(upstreamRefs('{{runs.scan.report}} and {{runs.deps.artifacts}} and {{previous.report}}').sort()).toEqual(['deps', 'scan']);
    expect(upstreamRefs('no placeholders')).toEqual([]);
  });
});

describe('firing through the real RunManager', () => {
  let db: DB;
  let dir: string;
  let rm: RunManager;

  beforeAll(() => {
    const f = freshDb();
    db = f.db;
    dir = f.dir;
    rm = new RunManager({
      db,
      clock: new FakeClock(Date.now()),
      dataDir: dir,
      runnerChildModule: '/nonexistent/runner-child.js',
      notify: () => {},
      broadcast: () => {},
      safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
    });
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const fire = (taskId: string, runId: string, state: string): Promise<void> =>
    (rm as any).fireChainedTasks(runId, { taskId } as any, state, Date.now());

  const queuedFor = (taskId: string): any[] =>
    db.prepare(`SELECT * FROM runs WHERE task_id=? AND state='queued'`).all(taskId) as any[];

  const events = (runId: string, kind: string): any[] =>
    db.prepare(`SELECT * FROM events WHERE run_id=? AND kind=?`).all(runId, kind) as any[];

  it('fan-out: one parent fires two edge children with their own gates', async () => {
    addTask(db, 'fa', { prompt: 'scan' });
    addTask(db, 'fb1', { prompt: 'fix {{runs.fa.report}}' });
    addTask(db, 'fb2', { prompt: 'always {{previous.report}}' });
    addEdge(db, 'fa', 'fb1');
    addEdge(db, 'fa', 'fb2', 'any_terminal');
    addRun(db, 'run-fa', 'fa', 'completed', { summary: 'FOUND IT', artifacts: [] });
    await fire('fa', 'run-fa', 'completed');
    const q1 = queuedFor('fb1');
    expect(q1).toHaveLength(1);
    expect(JSON.parse(q1[0].jobspec_json).prompt).toContain('FOUND IT');
    expect(queuedFor('fb2')).toHaveLength(1);
  });

  it('fan-in waits for all parents, then fires once with both reports', async () => {
    addTask(db, 'ga');
    addTask(db, 'gb');
    addTask(db, 'gc', { prompt: 'A:{{runs.ga.report}} B:{{runs.gb.report}}' });
    addEdge(db, 'ga', 'gc');
    addEdge(db, 'gb', 'gc');
    addRun(db, 'run-ga', 'ga', 'completed', { summary: 'A-DONE', artifacts: [] });
    await fire('ga', 'run-ga', 'completed');
    expect(queuedFor('gc')).toHaveLength(0);
    expect(events('run-ga', 'chain_waiting')).toHaveLength(1);
    addRun(db, 'run-gb', 'gb', 'completed', { summary: 'B-DONE', artifacts: [] });
    await fire('gb', 'run-gb', 'completed');
    const q = queuedFor('gc');
    expect(q).toHaveLength(1);
    const prompt = JSON.parse(q[0].jobspec_json).prompt as string;
    expect(prompt).toContain('A-DONE');
    expect(prompt).toContain('B-DONE');
  });

  it('failed gate records chain_skipped and fires nothing', async () => {
    addTask(db, 'ha');
    addTask(db, 'hb', { prompt: 'x' });
    addEdge(db, 'ha', 'hb'); // completed-only
    addRun(db, 'run-ha', 'ha', 'failed', { summary: 'broke', artifacts: [] });
    await fire('ha', 'run-ha', 'failed');
    expect(queuedFor('hb')).toHaveLength(0);
    expect(events('run-ha', 'chain_skipped')).toHaveLength(1);
  });

  it('legacy column behavior is unchanged (fires on this upstream alone)', async () => {
    addTask(db, 'la');
    addTask(db, 'lb', { prompt: 'was {{previous.report}}', chainAfter: 'la' });
    addRun(db, 'run-la', 'la', 'completed', { summary: 'LEGACY', artifacts: [] });
    await fire('la', 'run-la', 'completed');
    const q = queuedFor('lb');
    expect(q).toHaveLength(1);
    expect(JSON.parse(q[0].jobspec_json).prompt).toContain('LEGACY');
  });

  it('unknown {{runs.*}} reference refuses instead of rendering into instructions', async () => {
    addTask(db, 'ua');
    addTask(db, 'ub', { prompt: 'use {{runs.ghost.report}}' });
    addEdge(db, 'ua', 'ub');
    addRun(db, 'run-ua', 'ua', 'completed', { summary: 's', artifacts: [] });
    await fire('ua', 'run-ua', 'completed');
    expect(queuedFor('ub')).toHaveLength(0);
    const ev = events('run-ua', 'chain_skipped');
    expect(ev.length).toBe(1);
    expect(JSON.stringify(ev[0])).toContain('ghost');
  });

  it('does not double-fire a child that already has an active run', async () => {
    addTask(db, 'da');
    addTask(db, 'db_', { prompt: 'x {{runs.da.report}}' });
    addEdge(db, 'da', 'db_');
    addRun(db, 'run-da1', 'da', 'completed', { summary: 'one', artifacts: [] });
    await fire('da', 'run-da1', 'completed');
    expect(queuedFor('db_')).toHaveLength(1);
    addRun(db, 'run-da2', 'da', 'completed', { summary: 'two', artifacts: [] });
    await fire('da', 'run-da2', 'completed');
    expect(queuedFor('db_')).toHaveLength(1); // still one — no duplicate
  });

  it('concurrent parent completions enqueue exactly one child run (atomic check-then-act)', async () => {
    addTask(db, 'ca1');
    addTask(db, 'ca2');
    addTask(db, 'cb', { prompt: 'x {{runs.ca1.report}} {{runs.ca2.report}}' });
    addEdge(db, 'ca1', 'cb');
    addEdge(db, 'ca2', 'cb');
    addRun(db, 'run-ca1', 'ca1', 'completed', { summary: 'one', artifacts: [] });
    addRun(db, 'run-ca2', 'ca2', 'completed', { summary: 'two', artifacts: [] });
    // Interleaved at every await the runtime allows: the per-successor path
    // past the module import is synchronous, so these serialize.
    await Promise.all([fire('ca1', 'run-ca1', 'completed'), fire('ca2', 'run-ca2', 'completed')]);
    expect(queuedFor('cb')).toHaveLength(1);
  });

  it("legacy 'success' chain_on fires on completed (normalization)", async () => {
    addTask(db, 'sa');
    addTask(db, 'sb', { prompt: 'x', chainAfter: 'sa', chainOn: 'success' });
    addRun(db, 'run-sa', 'sa', 'completed', { summary: 's', artifacts: [] });
    await fire('sa', 'run-sa', 'completed');
    expect(queuedFor('sb')).toHaveLength(1);
  });
});

describe('GET /tasks/:id/pipeline', () => {
  let db: DB;
  let dir: string;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    const f = freshDb();
    db = f.db;
    dir = f.dir;
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
    addTask(db, 'pa');
    addTask(db, 'pb', { prompt: 'fix {{runs.pa.report}}' });
    addTask(db, 'pc', { prompt: 'test' });
    addEdge(db, 'pa', 'pb');
    addEdge(db, 'pb', 'pc');
    addRun(db, 'run-pa', 'pa', 'completed', { summary: 's', artifacts: [] });
  });
  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const auth = (o: any) => ({ ...o, headers: { authorization: `Bearer ${token}` } });

  it('rejects unauthenticated reads', async () => {
    expect((await app.inject({ method: 'GET', url: '/tasks/pb/pipeline' })).statusCode).toBe(401);
  });

  it('returns the graph with derived states', async () => {
    const r = await app.inject(auth({ method: 'GET', url: '/tasks/pb/pipeline' }));
    expect(r.statusCode).toBe(200);
    const body = r.json() as any;
    expect(body.focus).toBe('pb');
    const byId = Object.fromEntries(body.nodes.map((n: any) => [n.taskId, n]));
    expect(byId.pa.derived).toBe('succeeded');
    expect(byId.pb.derived).toBe('blocked'); // no run, parent settled... see note
    expect(byId.pc.parents).toEqual([{ parentId: 'pb', on: 'completed', via: 'edge' }]);
    expect(byId.pb.latestRun).toBeNull();
  });

  it('404s unknown tasks, validates parents CRUD', async () => {
    expect((await app.inject(auth({ method: 'GET', url: '/tasks/nope/pipeline' }))).statusCode).toBe(404);
    const bad = await app.inject(auth({ method: 'POST', url: '/tasks/pc/parents', payload: { parentId: 'pc', on: 'completed' } }));
    expect(bad.statusCode).toBe(409);
    const dup = await app.inject(auth({ method: 'POST', url: '/tasks/pc/parents', payload: { parentId: 'pb', on: 'completed' } }));
    expect(dup.statusCode).toBe(409);
    const add = await app.inject(auth({ method: 'POST', url: '/tasks/pc/parents', payload: { parentId: 'pa', on: 'any_terminal' } }));
    expect(add.statusCode).toBe(201);
    const del = await app.inject(auth({ method: 'DELETE', url: '/tasks/pc/parents/pa' }));
    expect(del.statusCode).toBe(200);
    expect((await app.inject(auth({ method: 'DELETE', url: '/tasks/pc/parents/pa' }))).statusCode).toBe(404);
  });
});
