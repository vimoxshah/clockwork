/**
 * F2 shift-handoff (plan/AGENT-WORKFORCE-SPEC.md).
 * Tests HandoffMemory, renderHandoffPrompt and handoffFromReport against a
 * real migrated in-memory DB (§2.6 loader convention).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { HandoffMemory, renderHandoffPrompt, handoffFromReport } from '../src/handoff.js';
import { AgentMemoryWrite } from '@clockwork/shared';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

function freshDb(): DB {
  const db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
  createMigrator(db, MIGRATIONS).migrate();
  return db;
}

function insertTask(db: DB, id: string, now: number): void {
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, `task-${id}`, 'do the thing', now, now);
}

describe('HandoffMemory.append', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it('writes a memory row the caller can read back', () => {
    insertTask(db, 't1', 1_000);
    const handoff = new HandoffMemory(db);
    const mem = handoff.append(
      { taskId: 't1', runId: 'r1', author: 'agent', kind: 'handoff', tried: 'ran the migration', blocked: null, nextCheck: 'check disk usage', body: null },
      2_000,
    );
    expect(mem.taskId).toBe('t1');
    expect(mem.runId).toBe('r1');
    expect(mem.tried).toBe('ran the migration');
    expect(mem.nextCheck).toBe('check disk usage');
    expect(mem.createdAt).toBe(2_000);
    expect(mem.id).toBeTruthy();
  });

  it('never updates: a second append adds a row and leaves the first row unchanged (append-only)', () => {
    insertTask(db, 't1', 1_000);
    const handoff = new HandoffMemory(db);
    const first = handoff.append({ taskId: 't1', tried: 'first attempt' }, 1_000);
    const second = handoff.append({ taskId: 't1', tried: 'second attempt' }, 2_000);
    expect(first.id).not.toBe(second.id);
    const all = handoff.latest('t1', 10);
    expect(all).toHaveLength(2);
    expect(all.find((m) => m.id === first.id)?.tried).toBe('first attempt');
    expect(all.find((m) => m.id === second.id)?.tried).toBe('second attempt');
  });

  it('refuses (throws on the FK) rather than writing an orphaned row for an unknown task', () => {
    const handoff = new HandoffMemory(db);
    expect(() => handoff.append({ taskId: 'does-not-exist', tried: 'x' }, 1_000)).toThrow();
    const orphans = db.prepare('SELECT COUNT(*) c FROM agent_memories').get() as { c: number };
    expect(orphans.c).toBe(0);
  });
});

describe('HandoffMemory.latest', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', 500);
  });

  it('returns newest first', () => {
    const handoff = new HandoffMemory(db);
    handoff.append({ taskId: 't1', tried: 'oldest' }, 1_000);
    handoff.append({ taskId: 't1', tried: 'middle' }, 2_000);
    handoff.append({ taskId: 't1', tried: 'newest' }, 3_000);
    const rows = handoff.latest('t1');
    expect(rows.map((r) => r.tried)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('defaults to 5 rows and honors a smaller explicit limit', () => {
    const handoff = new HandoffMemory(db);
    for (let i = 0; i < 8; i++) handoff.append({ taskId: 't1', tried: `attempt-${i}` }, 1_000 + i);
    expect(handoff.latest('t1')).toHaveLength(5);
    expect(handoff.latest('t1', 2)).toHaveLength(2);
    expect(handoff.latest('t1', 2).map((r) => r.tried)).toEqual(['attempt-7', 'attempt-6']);
  });

  it('returns [] for a task with no memory', () => {
    insertTask(db, 't2', 500);
    const handoff = new HandoffMemory(db);
    expect(handoff.latest('t2')).toEqual([]);
  });
});

describe('HandoffMemory.renderBlock', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', 500);
  });

  it("renders '' when there is no memory", () => {
    const handoff = new HandoffMemory(db);
    expect(handoff.renderBlock('t1')).toBe('');
  });

  it('renders an agent handoff row with labeled Tried/Blocked/Next check lines', () => {
    const handoff = new HandoffMemory(db);
    handoff.append({ taskId: 't1', author: 'agent', kind: 'handoff', tried: 'migrated schema', blocked: 'disk full', nextCheck: 'free up /var' }, 1_000);
    const block = handoff.renderBlock('t1');
    expect(block).toContain('Tried: migrated schema');
    expect(block).toContain('Blocked: disk full');
    expect(block).toContain('Next check: free up /var');
  });

  it('renders a human note distinctly from an agent handoff row', () => {
    const handoff = new HandoffMemory(db);
    handoff.append({ taskId: 't1', author: 'human', kind: 'note', body: 'nice work, double-check the retry logic next time' }, 1_000);
    const block = handoff.renderBlock('t1');
    expect(block).toBe('Note from your reviewer: nice work, double-check the retry logic next time');
  });

  it('renders newest-first across mixed agent and human rows', () => {
    const handoff = new HandoffMemory(db);
    handoff.append({ taskId: 't1', author: 'agent', kind: 'handoff', tried: 'first' }, 1_000);
    handoff.append({ taskId: 't1', author: 'human', kind: 'note', body: 'second' }, 2_000);
    const block = handoff.renderBlock('t1');
    expect(block.indexOf('second')).toBeLessThan(block.indexOf('first'));
  });

  it('truncates at budgetChars with the templates.ts truncation marker', () => {
    const handoff = new HandoffMemory(db);
    handoff.append({ taskId: 't1', author: 'agent', kind: 'handoff', tried: 'x'.repeat(500) }, 1_000);
    const block = handoff.renderBlock('t1', 50);
    expect(block.length).toBeLessThan(600);
    expect(block.endsWith('… [truncated to fit context budget]')).toBe(true);
  });
});

describe('renderHandoffPrompt', () => {
  it('returns the template untouched when it has no {{handoff placeholder', () => {
    const tpl = 'do the thing, no placeholders here';
    expect(renderHandoffPrompt(tpl, 'some memory block')).toBe(tpl);
  });

  it('replaces {{handoff.previous}} with the given block', () => {
    const tpl = 'Context from last time:\n{{handoff.previous}}\nNow continue.';
    expect(renderHandoffPrompt(tpl, 'previous run tried X')).toBe(
      'Context from last time:\nprevious run tried X\nNow continue.',
    );
  });

  it('replaces {{handoff.previous}} with an empty string when there is no memory', () => {
    const tpl = 'Context:\n{{handoff.previous}}\nGo.';
    expect(renderHandoffPrompt(tpl, '')).toBe('Context:\n\nGo.');
  });
});

describe('handoffFromReport', () => {
  it('returns null for a null report (no run yet, or report predates the field)', () => {
    expect(handoffFromReport(null)).toBeNull();
  });

  it('returns null for unparseable JSON', () => {
    expect(handoffFromReport('{not json')).toBeNull();
  });

  it('returns null for valid JSON that is not an object (e.g. an array or a scalar)', () => {
    expect(handoffFromReport('[1,2,3]')).toBeNull();
    expect(handoffFromReport('"just a string"')).toBeNull();
  });

  it('falls back to the whole summary as tried, and null blocked, for a completed run', () => {
    const result = handoffFromReport(JSON.stringify({ state: 'completed', summary: 'Migrated the schema cleanly.' }));
    expect(result).toMatchObject({ author: 'agent', kind: 'handoff', tried: 'Migrated the schema cleanly.', blocked: null, nextCheck: null });
  });

  it('sets blocked from state + failureReason for a non-completed terminal run', () => {
    const result = handoffFromReport(
      JSON.stringify({ state: 'failed', summary: 'Tried to run migration.', failureReason: 'disk full' }),
    );
    expect(result?.blocked).toBe('failed: disk full');
    expect(result?.tried).toBe('Tried to run migration.');
  });

  it('still produces a memory for a cancelled run (not only completed)', () => {
    const result = handoffFromReport(JSON.stringify({ state: 'cancelled', summary: 'stopped mid-way' }));
    expect(result).not.toBeNull();
    expect(result?.blocked).toBe('cancelled');
  });

  it('extracts labeled Tried/Blocked/Next check sections from the summary when present', () => {
    const summary = ['Tried: rebuilt the index', 'Blocked: lock timeout', 'Next check: retry after 5m'].join('\n');
    const result = handoffFromReport(JSON.stringify({ state: 'failed', summary, failureReason: 'lock_timeout' }));
    expect(result).toMatchObject({
      tried: 'rebuilt the index',
      blocked: 'lock timeout',
      nextCheck: 'retry after 5m',
    });
  });

  it('caps every field at 4_000 chars so the result always satisfies AgentMemoryWrite', () => {
    const bigSummary = 'y'.repeat(10_000);
    const result = handoffFromReport(JSON.stringify({ state: 'completed', summary: bigSummary }));
    expect(result?.tried?.length).toBe(4_000);
    const parsed = AgentMemoryWrite.safeParse({ taskId: 't1', ...result });
    expect(parsed.success).toBe(true);
  });
});
