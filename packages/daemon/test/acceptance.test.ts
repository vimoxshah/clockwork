/**
 * F6 accept-with-note (plan/AGENT-WORKFORCE-SPEC.md, §F6).
 *
 * Defends: not_found on an unknown run, a second decision UPDATEs the same
 * run_outcomes row instead of duplicating it, accepted_with_note writes an
 * agent_memories row (author='human', kind='note') and records its id,
 * a decision that stops being accepted_with_note clears memory_id without
 * touching the append-only memory row it once pointed to, the profile_id
 * snapshot is read from the run's frozen jobspec_json (never joined live),
 * listForTask orders newest-first and respects limit, and acceptedStreak
 * counts accepted + accepted_with_note but stops at the first rejection.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { Acceptance } from '../src/acceptance.js';
import { HandoffMemory } from '../src/handoff.js';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

function freshDb(): DB {
  const db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
  createMigrator(db, MIGRATIONS).migrate();
  return db;
}

function insertTask(db: DB, id: string, now: number): void {
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    `task-${id}`,
    'do the thing',
    now,
    now,
  );
}

function insertRun(db: DB, id: string, taskId: string, now: number, profileId: string | null = 'profile-1'): void {
  const jobspec = JSON.stringify({ taskId, profile: profileId ? { id: profileId, slug: 'p', name: 'P' } : null });
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at) VALUES (?, ?, ?, 'completed', ?)`,
  ).run(id, taskId, jobspec, now);
}

describe('Acceptance.record', () => {
  let db: DB;
  let acceptance: Acceptance;

  beforeEach(() => {
    db = freshDb();
    acceptance = new Acceptance(db, new HandoffMemory(db));
    insertTask(db, 't1', 1_000);
  });

  it("returns 'not_found' for a run that does not exist — nothing to attach an acceptance to", () => {
    const result = acceptance.record('does-not-exist', { decision: 'accepted' }, 'local', 2_000);
    expect(result).toBe('not_found');
    expect((db.prepare('SELECT COUNT(*) c FROM run_outcomes').get() as { c: number }).c).toBe(0);
  });

  it('records a plain accept with no note and no memory row', () => {
    insertRun(db, 'r1', 't1', 1_000);
    const rec = acceptance.record('r1', { decision: 'accepted' }, 'local', 2_000);
    expect(rec).not.toBe('not_found');
    if (rec === 'not_found') throw new Error('unreachable');
    expect(rec.decision).toBe('accepted');
    expect(rec.note).toBeNull();
    expect(rec.memoryId).toBeNull();
    expect(rec.taskId).toBe('t1');
    expect(rec.profileId).toBe('profile-1');
    expect(rec.decidedAt).toBe(2_000);
    expect((db.prepare('SELECT COUNT(*) c FROM agent_memories').get() as { c: number }).c).toBe(0);
  });

  it('accepted_with_note appends an agent_memories row (author=human, kind=note) and stores its id', () => {
    insertRun(db, 'r1', 't1', 1_000);
    const rec = acceptance.record('r1', { decision: 'accepted_with_note', note: 'looks good, ship it' }, 'local', 2_000);
    if (rec === 'not_found') throw new Error('unreachable');
    expect(rec.decision).toBe('accepted_with_note');
    expect(rec.note).toBe('looks good, ship it');
    expect(rec.memoryId).toBeTruthy();

    const mem = db.prepare('SELECT * FROM agent_memories WHERE id=?').get(rec.memoryId as string) as {
      task_id: string;
      run_id: string;
      author: string;
      kind: string;
      body: string;
    };
    expect(mem.task_id).toBe('t1');
    expect(mem.run_id).toBe('r1');
    expect(mem.author).toBe('human');
    expect(mem.kind).toBe('note');
    expect(mem.body).toBe('looks good, ship it');
  });

  it('throws rather than silently writing a noteless accepted_with_note (defensive, mirrors handoff.append fail-closed on an unknown taskId)', () => {
    insertRun(db, 'r1', 't1', 1_000);
    expect(() => acceptance.record('r1', { decision: 'accepted_with_note', note: '   ' }, 'local', 2_000)).toThrow();
    expect((db.prepare('SELECT COUNT(*) c FROM run_outcomes').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM agent_memories').get() as { c: number }).c).toBe(0);
  });

  it('a second decision on the same run UPDATEs the row instead of duplicating it', () => {
    insertRun(db, 'r1', 't1', 1_000);
    acceptance.record('r1', { decision: 'accepted' }, 'local', 2_000);
    const second = acceptance.record('r1', { decision: 'rejected' }, 'local', 3_000);
    if (second === 'not_found') throw new Error('unreachable');
    expect(second.decision).toBe('rejected');
    expect(second.decidedAt).toBe(3_000);
    expect((db.prepare('SELECT COUNT(*) c FROM run_outcomes').get() as { c: number }).c).toBe(1);
  });

  it('re-deciding away from accepted_with_note clears memory_id but leaves the earlier append-only memory row untouched', () => {
    insertRun(db, 'r1', 't1', 1_000);
    const first = acceptance.record('r1', { decision: 'accepted_with_note', note: 'first note' }, 'local', 2_000);
    if (first === 'not_found') throw new Error('unreachable');
    const firstMemoryId = first.memoryId as string;

    const second = acceptance.record('r1', { decision: 'accepted' }, 'local', 3_000);
    if (second === 'not_found') throw new Error('unreachable');
    expect(second.memoryId).toBeNull();

    // the earlier memory row is untouched — agent_memories is append-only (F2 invariant)
    const mem = db.prepare('SELECT body FROM agent_memories WHERE id=?').get(firstMemoryId) as { body: string };
    expect(mem.body).toBe('first note');
    expect((db.prepare('SELECT COUNT(*) c FROM agent_memories').get() as { c: number }).c).toBe(1);
  });

  it('profile_id is a snapshot read from the run\'s frozen jobspec_json, not a live join', () => {
    insertRun(db, 'r1', 't1', 1_000, 'profile-a');
    const rec = acceptance.record('r1', { decision: 'accepted' }, 'local', 2_000);
    if (rec === 'not_found') throw new Error('unreachable');
    expect(rec.profileId).toBe('profile-a');
  });

  it('profile_id is null when the jobspec carried no profile (unassigned)', () => {
    insertRun(db, 'r1', 't1', 1_000, null);
    const rec = acceptance.record('r1', { decision: 'accepted' }, 'local', 2_000);
    if (rec === 'not_found') throw new Error('unreachable');
    expect(rec.profileId).toBeNull();
  });
});

describe('Acceptance.get', () => {
  it('returns undefined when the run has no recorded outcome', () => {
    const db = freshDb();
    const acceptance = new Acceptance(db, new HandoffMemory(db));
    expect(acceptance.get('no-such-run')).toBeUndefined();
  });

  it('returns the recorded outcome', () => {
    const db = freshDb();
    const acceptance = new Acceptance(db, new HandoffMemory(db));
    insertTask(db, 't1', 1_000);
    insertRun(db, 'r1', 't1', 1_000);
    acceptance.record('r1', { decision: 'accepted' }, 'local', 2_000);
    expect(acceptance.get('r1')?.decision).toBe('accepted');
  });
});

describe('Acceptance.listForTask', () => {
  let db: DB;
  let acceptance: Acceptance;

  beforeEach(() => {
    db = freshDb();
    acceptance = new Acceptance(db, new HandoffMemory(db));
    insertTask(db, 't1', 1_000);
  });

  it('orders newest first', () => {
    insertRun(db, 'r1', 't1', 1_000);
    insertRun(db, 'r2', 't1', 1_000);
    insertRun(db, 'r3', 't1', 1_000);
    acceptance.record('r1', { decision: 'accepted' }, 'local', 1_000);
    acceptance.record('r2', { decision: 'accepted' }, 'local', 2_000);
    acceptance.record('r3', { decision: 'accepted' }, 'local', 3_000);
    const list = acceptance.listForTask('t1', 10);
    expect(list.map((o) => o.runId)).toEqual(['r3', 'r2', 'r1']);
  });

  it('respects the limit', () => {
    insertRun(db, 'r1', 't1', 1_000);
    insertRun(db, 'r2', 't1', 1_000);
    acceptance.record('r1', { decision: 'accepted' }, 'local', 1_000);
    acceptance.record('r2', { decision: 'accepted' }, 'local', 2_000);
    expect(acceptance.listForTask('t1', 1)).toHaveLength(1);
  });

  it('returns an empty array for a task with no recorded outcomes', () => {
    expect(acceptance.listForTask('t1')).toEqual([]);
  });
});

describe('Acceptance.acceptedStreak', () => {
  let db: DB;
  let acceptance: Acceptance;

  beforeEach(() => {
    db = freshDb();
    acceptance = new Acceptance(db, new HandoffMemory(db));
    insertTask(db, 't1', 1_000);
  });

  it('counts accepted and accepted_with_note as a streak', () => {
    insertRun(db, 'r1', 't1', 1_000, 'p1');
    insertRun(db, 'r2', 't1', 1_000, 'p1');
    insertRun(db, 'r3', 't1', 1_000, 'p1');
    acceptance.record('r1', { decision: 'accepted' }, 'local', 1_000);
    acceptance.record('r2', { decision: 'accepted_with_note', note: 'nice' }, 'local', 2_000);
    acceptance.record('r3', { decision: 'accepted' }, 'local', 3_000);
    expect(acceptance.acceptedStreak('p1')).toBe(3);
  });

  it('stops counting at the first rejection scanning newest-first', () => {
    insertRun(db, 'r1', 't1', 1_000, 'p1');
    insertRun(db, 'r2', 't1', 1_000, 'p1');
    insertRun(db, 'r3', 't1', 1_000, 'p1');
    acceptance.record('r1', { decision: 'rejected' }, 'local', 1_000);
    acceptance.record('r2', { decision: 'accepted' }, 'local', 2_000);
    acceptance.record('r3', { decision: 'accepted' }, 'local', 3_000);
    // newest-first: r3 (accepted), r2 (accepted), r1 (rejected) -> streak stops at r1
    expect(acceptance.acceptedStreak('p1')).toBe(2);
  });

  it('is 0 when the most recent decision was a rejection', () => {
    insertRun(db, 'r1', 't1', 1_000, 'p1');
    insertRun(db, 'r2', 't1', 1_000, 'p1');
    acceptance.record('r1', { decision: 'accepted' }, 'local', 1_000);
    acceptance.record('r2', { decision: 'rejected' }, 'local', 2_000);
    expect(acceptance.acceptedStreak('p1')).toBe(0);
  });

  it('is 0 for a profile with no recorded outcomes', () => {
    expect(acceptance.acceptedStreak('never-seen')).toBe(0);
  });
});
