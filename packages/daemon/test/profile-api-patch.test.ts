/**
 * `PATCH /profiles/:id` must not accept an edit it has no intention of making.
 *
 * Three silent drops, all the same shape — 200 OK, nothing changed:
 *
 *  1. Unknown keys. Zod strips them by default, so a client typo (`budgetUsd`
 *     instead of the nested `budget.maxUsd`) came back 200 with the field gone.
 *  2. `slug`. It is part of `ProfileCreate`, so `ProfilePatch` accepted it and
 *     the handler never applied it. It CANNOT be applied here either:
 *     `ProfileRepo.upsert` is `ON CONFLICT(slug)`, so a changed slug misses the
 *     conflict target and tries to INSERT a second row under the same id.
 *     Immutable via PATCH is the honest contract; refusing it out loud is the fix.
 *  3. `delivery`. The handler's merge object never supplied `delivery_json`, so
 *     a delivery-config edit was dropped one layer above the repo that stores it.
 *
 * `profile-repo-patch.test.ts` covers the repo layer; this is the route.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

let dir: string;
let db: DB;
let app: FastifyInstance;
let token: string;

const auth = (json: Record<string, unknown>): any => ({
  ...json,
  headers: { authorization: `Bearer ${token}` },
});

interface ProfileRowView {
  id: string;
  slug: string;
  name: string;
  budget_usd: number;
  delivery_json: string | null;
  system_prompt_extra: string | null;
}

async function makeProfile(slug: string): Promise<ProfileRowView> {
  const res = await app.inject(
    auth({
      method: 'POST',
      url: '/profiles',
      payload: { slug, name: `Profile ${slug}`, budget: { maxUsd: 3, maxTurns: 10, timeoutSec: 600 } },
    }),
  );
  expect(res.statusCode).toBe(201);
  return res.json() as ProfileRowView;
}

const readBack = (id: string): ProfileRowView =>
  db.prepare('SELECT * FROM profiles WHERE id=?').get(id) as unknown as ProfileRowView;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-profile-api-patch-'));
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  const clock = new FakeClock(Date.now());
  const rm = new RunManager({
    db,
    clock,
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js',
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

describe('PATCH /profiles/:id — a dropped field is a refusal, not a 200', () => {
  it('refuses an unknown key instead of stripping it and reporting success', async () => {
    const p = await makeProfile('typo-target');

    const res = await app.inject(
      auth({ method: 'PATCH', url: `/profiles/${p.id}`, payload: { budgetUsd: 99 } }),
    );

    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('validation');
    expect(readBack(p.id).budget_usd).toBe(3); // and the row is untouched
  });

  it('refuses a slug change instead of ignoring it', async () => {
    const p = await makeProfile('rename-target');

    const res = await app.inject(
      auth({ method: 'PATCH', url: `/profiles/${p.id}`, payload: { slug: 'renamed', name: 'Renamed' } }),
    );

    expect(res.statusCode).toBe(422);
    const row = readBack(p.id);
    expect(row.slug).toBe('rename-target');
    expect(row.name).toBe('Profile rename-target'); // the whole patch is refused, not half-applied
  });

  it('persists a delivery-config edit', async () => {
    const p = await makeProfile('delivery-target');
    expect(JSON.parse(readBack(p.id).delivery_json!)).toEqual({ osNotify: true });

    const res = await app.inject(
      auth({
        method: 'PATCH',
        url: `/profiles/${p.id}`,
        payload: { delivery: { osNotify: false, telegram: { chatId: '4242' } } },
      }),
    );

    expect(res.statusCode).toBe(200);
    const stored = JSON.parse(readBack(p.id).delivery_json!) as { osNotify: boolean; telegram: { chatId: string } };
    expect(stored.osNotify).toBe(false);
    expect(stored.telegram.chatId).toBe('4242');
  });

  it('still applies an ordinary edit, and leaves the fields it was not given alone', async () => {
    const p = await makeProfile('happy-path');

    const res = await app.inject(
      auth({
        method: 'PATCH',
        url: `/profiles/${p.id}`,
        payload: { name: 'Renamed properly', systemPromptExtra: 'be terse' },
      }),
    );

    expect(res.statusCode).toBe(200);
    const row = readBack(p.id);
    expect(row.name).toBe('Renamed properly');
    expect(row.system_prompt_extra).toBe('be terse');
    expect(row.slug).toBe('happy-path');
    expect(row.budget_usd).toBe(3);
    expect(JSON.parse(row.delivery_json!)).toEqual({ osNotify: true }); // untouched, not defaulted away
  });
});
