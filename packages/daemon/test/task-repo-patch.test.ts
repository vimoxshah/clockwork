/**
 * TaskRepo.patch — confirmatory coverage, not a bug fix.
 *
 * The profile-patch bug (ProfileRepo.upsert only ever wrote name/color)
 * raised the question of whether tasks have the same silent-discard pattern.
 * They do not: TaskRepo.patch (repo.ts) builds its UPDATE dynamically from a
 * `[key, column, cast]` map plus explicit handling for budget/context/
 * delivery/schedule, driven directly off `input[k] !== undefined` — there is
 * no ON CONFLICT-style hardcoded column list to go stale. This test locks
 * that in across every field TaskPatch (schemas.ts) accepts, so a future
 * change can't reintroduce the profile bug's shape here without a red test.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { TaskRepo } from '../src/repo.js';
import { newId } from '@clockwork/shared';
import type { TaskCreate, TaskPatch } from '@clockwork/shared';

function freshDb(): { db: DB; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-task-patch-db-'));
  const db = openDatabase(dir).db;
  createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
  return { db, dir };
}

const BASE_CREATE: TaskCreate = {
  name: 'Original task',
  prompt: 'do the thing',
  permissionMode: 'acceptEdits',
  budget: { maxUsd: 2.0, maxTurns: 50, timeoutSec: 3600 },
  schedule: { kind: 'once', tz: 'UTC', runAt: Date.now() + 3_600_000 },
  overlapPolicy: 'skip',
  missedPolicy: 'run-late',
  missedWindowSec: 21_600,
  retryOnTransient: false,
  context: { files: [] },
  delivery: { osNotify: true },
};

describe('TaskRepo.patch — persists every TaskPatch field (confirmatory)', () => {
  let db: DB;
  let dir: string;
  let repo: TaskRepo;
  let taskId: string;
  let otherId: string;

  beforeEach(() => {
    ({ db, dir } = freshDb());
    repo = new TaskRepo(db);
    const upstream = repo.create(BASE_CREATE, null, BASE_CREATE.schedule.runAt ?? null);
    taskId = upstream.id;
    // Give the chain-target a real row to point chainAfter at.
    const other = repo.create({ ...BASE_CREATE, name: 'upstream' }, null, null);
    otherId = other.id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists scalar, budget, context, delivery and schedule fields from one patch', () => {
    const patch: TaskPatch = {
      name: 'Patched task',
      prompt: 'do the other thing',
      repoPath: '/repo/x',
      baseBranch: 'develop',
      model: 'gpt-5',
      engine: 'api',
      permissionMode: 'plan',
      budget: { maxUsd: 7.5, maxTurns: 10, timeoutSec: 120 },
      overlapPolicy: 'queue',
      missedPolicy: 'skip',
      missedWindowSec: 900,
      retryOnTransient: true,
      chainAfter: otherId,
      chainOn: 'any_terminal',
      context: { files: [{ path: '/repo/x/README.md', mode: 'live-ref' }] },
      delivery: { osNotify: false },
      enabled: false,
      schedule: { kind: 'once', tz: 'America/New_York', runAt: Date.now() + 7_200_000 },
    };
    const result = repo.patch(taskId, patch, undefined, patch.schedule!.runAt ?? null);
    expect(result).not.toBe('not_found');
    expect(result).not.toBe('version_conflict');
    const after = result as Exclude<typeof result, 'not_found' | 'version_conflict'>;

    expect(after.name).toBe('Patched task');
    expect(after.prompt).toBe('do the other thing');
    expect(after.repo_path).toBe('/repo/x');
    expect(after.base_branch).toBe('develop');
    expect(after.model).toBe('gpt-5');
    expect(after.budget_usd).toBe(7.5);
    expect(after.max_turns).toBe(10);
    expect(after.timeout_sec).toBe(120);
    expect(after.overlap_policy).toBe('queue');
    expect(after.missed_policy).toBe('skip');
    expect(after.missed_window_sec).toBe(900);
    expect(after.retry_on_transient).toBe(1);
    expect(after.chain_after).toBe(otherId);
    expect(after.chain_on).toBe('any_terminal');
    expect(JSON.parse(after.context_json)).toEqual({ files: [{ path: '/repo/x/README.md', mode: 'live-ref' }] });
    expect(JSON.parse(after.delivery_json)).toEqual({ osNotify: false });
    expect(after.enabled).toBe(0);
    expect(after.version).toBe(2);

    const sched = repo.scheduleFor(taskId)!;
    expect(sched.tz).toBe('America/New_York');
    expect(sched.run_at).toBe(patch.schedule!.runAt);
  });
});
