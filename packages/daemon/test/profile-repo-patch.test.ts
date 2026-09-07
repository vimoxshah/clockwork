/**
 * ProfileRepo.upsert — full-field persistence (bug: verified against a live
 * daemon — `PATCH /profiles/:id` returned 200 but only `name` and `color`
 * were ever written; every other field the caller sent (permission mode,
 * engine, model, budget, max turns, timeout, skills, MCP allow-list, context
 * roots, system prompt extra, delivery, avatar) was silently discarded).
 *
 * Root cause: `ProfileRepo.upsert()`'s `INSERT ... ON CONFLICT(slug) DO
 * UPDATE SET` clause only listed `name=excluded.name, color=excluded.color`.
 * `api.ts`'s PATCH handler already builds a fully-merged row (existing +
 * overrides) and passes it to `upsert()`, but since the profile row already
 * exists, every upsert from a PATCH hits the ON CONFLICT branch — so only
 * those two columns ever reached the database, no matter what the INSERT
 * values said.
 *
 * Fix: widen the ON CONFLICT SET clause to cover every user-editable column.
 * `id`, `builtin` and `created_at` are deliberately left out of the SET
 * clause (immutable identity / creation-time facts), matching the intent
 * `seedBuiltinProfiles()` (profiles.ts) already relies on when it re-upserts
 * an unchanged row just to sync category/featured.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { ProfileRepo, type ProfileRow } from '../src/repo.js';
import { newId } from '@clockwork/shared';

function freshDb(): { db: DB; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-profile-patch-db-'));
  const db = openDatabase(dir).db;
  createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
  return { db, dir };
}

const INITIAL: Omit<ProfileRow, 'id'> = {
  slug: 'patch-target',
  name: 'Original Name',
  color: '#111111',
  avatar: '◦',
  engine: 'cli',
  model: 'claude-sonnet-4',
  permission_mode: 'acceptEdits',
  budget_usd: 2.0,
  max_turns: 50,
  timeout_sec: 3600,
  skills_json: JSON.stringify([{ name: 'docs-writer', version: '1.0.0' }]),
  mcp_allow_json: JSON.stringify(['fs']),
  context_roots_json: JSON.stringify(['/repo']),
  system_prompt_extra: 'original extra',
  delivery_json: JSON.stringify({ osNotify: true }),
  builtin: 0,
};

describe('ProfileRepo.upsert — patch persists every field (regression)', () => {
  let db: DB;
  let dir: string;
  let repo: ProfileRepo;
  let id: string;

  beforeEach(() => {
    ({ db, dir } = freshDb());
    repo = new ProfileRepo(db);
    id = newId();
    repo.upsert({ id, ...INITIAL });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists every patchable column, not just name and color', () => {
    const existing = repo.get(id)!;
    expect(existing).toBeDefined();

    // Mirrors api.ts's PATCH handler: merge existing row with every field changed.
    const patched: ProfileRow = {
      ...existing,
      name: 'Patched Name',
      color: '#2a2a2a',
      avatar: '✦',
      engine: 'api',
      model: 'gpt-5',
      permission_mode: 'plan',
      budget_usd: 9.5,
      max_turns: 12,
      timeout_sec: 900,
      skills_json: JSON.stringify([{ name: 'dependency-triage', version: '2.0.0' }]),
      mcp_allow_json: JSON.stringify(['fs', 'github']),
      context_roots_json: JSON.stringify(['/repo', '/other']),
      system_prompt_extra: 'patched extra',
      delivery_json: JSON.stringify({ osNotify: false, telegram: true }),
    };
    repo.upsert(patched);

    const after = repo.get(id)!;
    expect(after.name).toBe('Patched Name');
    expect(after.color).toBe('#2a2a2a');
    expect(after.avatar).toBe('✦');
    expect(after.engine).toBe('api');
    expect(after.model).toBe('gpt-5');
    expect(after.permission_mode).toBe('plan');
    expect(after.budget_usd).toBe(9.5);
    expect(after.max_turns).toBe(12);
    expect(after.timeout_sec).toBe(900);
    expect(after.skills_json).toBe(JSON.stringify([{ name: 'dependency-triage', version: '2.0.0' }]));
    expect(after.mcp_allow_json).toBe(JSON.stringify(['fs', 'github']));
    expect(after.context_roots_json).toBe(JSON.stringify(['/repo', '/other']));
    expect(after.system_prompt_extra).toBe('patched extra');
    expect(after.delivery_json).toBe(JSON.stringify({ osNotify: false, telegram: true }));

    // Immutable identity/creation facts must survive untouched.
    expect(after.id).toBe(id);
    expect(after.slug).toBe('patch-target');
    expect(after.builtin).toBe(0);
    expect(after.created_at).toBe(existing.created_at);
  });

  it('never flips builtin via a patch-driven upsert', () => {
    const existing = repo.get(id)!;
    repo.upsert({ ...existing, name: 'still not builtin' });
    expect(repo.get(id)!.builtin).toBe(0);
  });

  it('round-trips a null-able field back to null', () => {
    const existing = repo.get(id)!;
    repo.upsert({ ...existing, model: null, system_prompt_extra: null });
    const after = repo.get(id)!;
    expect(after.model).toBeNull();
    expect(after.system_prompt_extra).toBeNull();
  });
});
