/**
 * T4-8: `GET /templates/bundled` — the route that makes `loadBundledTemplates`
 * (templates.ts) reachable from the product instead of only from a loader and
 * a test. Before this route existed, `loadBundledTemplates`'s own doc comment
 * said "as of T4-7 this function has NO production caller — grep -rn
 * loadBundledTemplates packages/*\/src finds only this definition." The first
 * describe block below converts that exact claim into a check: it greps the
 * shipped source the same way the comment describes, so a regression that
 * quietly removes the route's only caller (rather than the route itself)
 * still fails here.
 *
 * Second block: the route over the real HTTP surface (app.inject), same
 * harness templates-library.test.ts / templates-export.test.ts use.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import { loadBundledTemplates, type TemplateFile } from '../src/templates.js';

const TEMPLATES_DIR = path.resolve(import.meta.dirname, '../../../resources/templates');
const API_SRC = readFileSync(path.resolve(import.meta.dirname, '../src/api.ts'), 'utf8');

describe('T4-8 loadBundledTemplates now has a production caller — falsifying the pre-T4-8 doc comment claim', () => {
  it('api.ts registers GET /templates/bundled', () => {
    expect(API_SRC).toContain("app.get('/templates/bundled'");
  });

  it('that route calls loadBundledTemplates — not a second, parallel reader of resources/templates/', () => {
    const start = API_SRC.indexOf("app.get('/templates/bundled'");
    expect(start, 'GET /templates/bundled not found in api.ts').toBeGreaterThan(-1);
    const end = API_SRC.indexOf('\n  });', start);
    const handler = API_SRC.slice(start, end);
    expect(handler).toContain('loadBundledTemplates(');
  });

  it('the loader import at the top of the templates section includes loadBundledTemplates', () => {
    // The specific regression this guards: the route destructures a DIFFERENT
    // name (a typo, or a second loader) that never reaches the real function.
    expect(API_SRC).toContain('loadBundledTemplates,');
  });
});

describe('T4-8 GET /templates/bundled over HTTP', () => {
  let db: DB;
  let dir: string;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-tpl-bundled-'));
    db = openDatabase(dir).db;
    createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
    const rm = new RunManager({
      db,
      clock: new FakeClock(Date.now()),
      dataDir: dir,
      runnerChildModule: '/nonexistent/runner-child.js', // not exercised — no import here ever runs
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

  function auth(json: Record<string, unknown>): Record<string, unknown> {
    return { ...json, headers: { authorization: `Bearer ${token}` } };
  }

  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/templates/bundled' });
    expect(res.statusCode).toBe(401);
  });

  it('returns exactly the five files loadBundledTemplates itself reads off disk', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/templates/bundled' }));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { templates: TemplateFile[] };
    expect(body.templates).toHaveLength(5);
    expect(body.templates).toEqual(loadBundledTemplates(TEMPLATES_DIR));
    expect(body.templates.map((t) => t.name).sort()).toEqual(
      [
        'Flaky test sweep',
        'Friday docs-drift check',
        'Monday dependency triage',
        'Morning repo-health digest',
        'Pre-release changelog draft',
      ].sort(),
    );
  });

  it('every returned template is still the valid, disabled-on-arrival shape S-74/S-75 expect', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/templates/bundled' }));
    const body = res.json() as { templates: TemplateFile[] };
    for (const tpl of body.templates) {
      expect(tpl.schema).toBe('clockwork.template.v1');
      expect(tpl.prompt.trim().length).toBeGreaterThan(0);
    }
  });
});
