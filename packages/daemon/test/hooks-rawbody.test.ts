/**
 * Regression test for the webhook signature bug (goal #27 fix): the
 * `/hooks/:id` route declared `{ config: { rawBody: true } }` but no
 * raw-body capture existed, so `handleHook` HMAC'd `JSON.stringify(req.body)`
 * — a re-serialization of the parsed body — instead of the exact bytes a
 * sender (e.g. GitHub) signed. Pretty-printing, float formatting and
 * escaped-unicode all round-trip differently through
 * `JSON.stringify(JSON.parse(raw))`, so a real GitHub delivery would fail
 * signature verification even with the right secret.
 *
 * This suite proves the fix with a byte-exact test: a GitHub-style payload
 * (pretty-printed, containing a float and an escaped unicode sequence),
 * signed over its EXACT wire bytes, must be accepted; the same payload
 * signed over its re-serialized form (what the old code effectively
 * verified against) must be rejected.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
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

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const GITHUB_SECRET = 'a-long-signing-secret-for-rawbody-tests';

beforeAll(async () => {
  // Own fixture (own DB/app), not shared with api.test.ts, so we don't race
  // that suite's `delete process.env.CLOCKWORK_GITHUB_WEBHOOK_SECRET` or its
  // token-rotation test — vitest's forks pool can reuse workers across files.
  process.env.CLOCKWORK_GITHUB_WEBHOOK_SECRET = GITHUB_SECRET;

  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-hooks-rawbody-'));
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  clock = new FakeClock(Date.now());

  const rm = new RunManager({
    db,
    clock,
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js', // not exercised here
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
  delete process.env.CLOCKWORK_GITHUB_WEBHOOK_SECRET;
});

function auth(json: any): { method: string; url: string; payload?: any; headers: Record<string, string> } {
  return { ...json, headers: { ...(json.headers ?? {}), authorization: `Bearer ${token}` } };
}

// A GitHub-style delivery: pretty-printed with real newlines/indentation,
// a float (`1.50`) and an escaped unicode sequence (`é`). Each of these
// renders differently once round-tripped through
// `JSON.stringify(JSON.parse(x))`: whitespace collapses, `1.50` becomes
// `1.5`, and `é` becomes a literal, unescaped "é" — so the raw bytes and
// the re-serialized bytes are guaranteed to differ.
const RAW_GITHUB_PAYLOAD = [
  '{',
  '  "action": "opened",',
  '  "pull_request": {',
  '    "number": 42,',
  '    "size": 1.50,',
  '    "title": "Caf\\u00e9 fix"',
  '  }',
  '}',
].join('\n');

describe('webhook signatures verify over the raw wire bytes', () => {
  it('proves the raw payload and its re-serialization actually differ (else this test would pass vacuously)', () => {
    const reserialized = JSON.stringify(JSON.parse(RAW_GITHUB_PAYLOAD));
    expect(reserialized).not.toBe(RAW_GITHUB_PAYLOAD);
  });

  it('accepts a signature computed over the exact wire bytes, and rejects the same payload signed over the re-serialized JSON', async () => {
    const profileRes = await app.inject(
      auth({
        method: 'POST',
        url: '/profiles',
        payload: {
          slug: 'rawbody-fixture',
          name: 'RawBody Fixture',
          engine: 'cli',
          permissionMode: 'acceptEdits',
          budget: { maxUsd: 1, maxTurns: 5, timeoutSec: 60 },
          skills: [],
          mcpAllow: [],
          contextRoots: [],
        },
      }),
    );
    expect(profileRes.statusCode).toBe(201);
    const profileId = (profileRes.json() as { id: string }).id;

    const taskRes = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: {
          name: 'Raw-body hook task',
          prompt: 'Summarize the event.',
          profileId,
          schedule: { kind: 'queue', tz: 'UTC' },
        },
      }),
    );
    expect(taskRes.statusCode).toBe(201);
    const taskId = (taskRes.json() as { id: string }).id;

    const trgRes = await app.inject(
      auth({
        method: 'POST',
        url: '/triggers',
        payload: { name: 'github-rawbody', source: 'github', taskId },
      }),
    );
    expect(trgRes.statusCode).toBe(201);
    const triggerId = (trgRes.json() as { id: string }).id;
    expect(triggerId).toBeTruthy();

    const reserialized = JSON.stringify(JSON.parse(RAW_GITHUB_PAYLOAD));
    const sigOverRaw = 'sha256=' + createHmac('sha256', GITHUB_SECRET).update(RAW_GITHUB_PAYLOAD, 'utf8').digest('hex');
    const sigOverReserialized = 'sha256=' + createHmac('sha256', GITHUB_SECRET).update(reserialized, 'utf8').digest('hex');
    expect(sigOverRaw).not.toBe(sigOverReserialized);

    // Positive path: signed over the exact bytes GitHub would have sent.
    const good = await app.inject({
      method: 'POST',
      url: `/hooks/${triggerId}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sigOverRaw },
      payload: RAW_GITHUB_PAYLOAD,
    });
    expect(good.statusCode).toBe(202);
    const goodBody = good.json() as { ok: boolean; fired: boolean; runId: string };
    expect(goodBody.fired).toBe(true);
    expect(goodBody.runId).toBeTruthy();

    const eventsAfterGood = await app.inject(auth({ method: 'GET', url: '/trigger-events?limit=10' }));
    expect(eventsAfterGood.statusCode).toBe(200);
    const goodEvent = (eventsAfterGood.json() as Array<{ run_id: string | null; matched: boolean }>).find(
      (e) => e.run_id === goodBody.runId,
    );
    expect(goodEvent).toBeTruthy();
    expect(goodEvent!.matched).toBe(true);

    // Negative control: the identical payload, but signed over the
    // re-serialized JSON instead of the raw bytes. This is exactly what the
    // pre-fix handler computed its HMAC over
    // (`JSON.stringify(req.body ?? {})`), so this proves the fix rather than
    // passing vacuously — it must now be rejected.
    const bad = await app.inject({
      method: 'POST',
      url: `/hooks/${triggerId}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sigOverReserialized },
      payload: RAW_GITHUB_PAYLOAD,
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe('bad signature');
  });
});
