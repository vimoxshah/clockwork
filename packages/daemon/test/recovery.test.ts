/**
 * Crash-recovery suite (fixture inventory #2): S-30 daemon crash between
 * queued and preparing; S-31 crash while running (orphan terminate +
 * journal-report); S-81 reboot sweep ordering.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { FakeClock } from '../src/clock.js';
import { SafetyJournal } from '@clockwork/runner';

let db: DB;
let dir: string;
let repoDir: string;

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

function makeManager(): RunManager {
  return new RunManager({
    db,
    clock: new FakeClock(Date.now()),
    dataDir: path.join(dir, 'data'),
    runnerChildModule: '/nonexistent.js',
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(path.join(dir, 'journal.jsonl')),
  });
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-recover-'));
  repoDir = path.join(dir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 't']);
  writeFileSync(path.join(repoDir, '.keep'), '');
  execFileSync('git', ['-C', repoDir, 'add', '-A']);
  execFileSync('git', ['-C', repoDir, 'commit', '-qm', 'init']);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function seedRunningRow(pgid: number | null): string {
  const id = `r-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('task-x', 't', 'p', ?, ?)`).run(now, now);
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, pgid, pid, started_at)
     VALUES (?, 'task-x', '{}', 'running', ?, ?, ?, ?)`,
  ).run(id, now, pgid, pgid, now);
  return id;
}

describe('S-30: transient states re-queue idempotently', () => {
  it('preparing rows without children reset to queued on startup sweep', () => {
    db = openDatabase(path.join(dir, `s30-${Date.now()}`)).db;
    createMigrator(db, MIGRATIONS).migrate();
    const now = Date.now();
    db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('t', 't', 'p', ?, ?)`).run(now, now);
    const id = `r-${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at) VALUES (?, 't', '{}', 'preparing', ?)`).run(id, Date.now());
    const queued = `q-${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at) VALUES (?, 't', '{}', 'queued', ?)`).run(queued, Date.now());

    const res = makeManager().recoverySweep();
    const states = db.prepare('SELECT id, state FROM runs').all() as any[];
    const prep = states.find((s) => s.id === id);
    expect(prep.state).toBe('queued');
    expect(res.requeued).toBeGreaterThanOrEqual(2);
  });
});

describe('S-31: orphaned runner terminated + failed/orphaned with notification', () => {
  it('live foreign process in a running row is killed by group and row marked failed/orphaned', async () => {
    db = openDatabase(path.join(dir, `s31-${Date.now()}`)).db;
    createMigrator(db, MIGRATIONS).migrate();

    // spawn a real long-lived detached process to act as the "orphan"
    const child = spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' });
    const pgid = child.pid!;
    const runId = seedRunningRow(pgid);

    // simulate daemon death + restart: brand-new RunManager over same DB
    const notifications: string[] = [];
    const rm = new RunManager({
      db,
      clock: new FakeClock(Date.now()),
      dataDir: path.join(dir, 'data-s31'),
      runnerChildModule: '/nonexistent.js',
      notify: (kind) => notifications.push(kind),
      broadcast: () => {},
      safetyJournal: new SafetyJournal(path.join(dir, 'journal-s31.jsonl')),
    });
    const res = rm.recoverySweep();

    await new Promise((r) => setTimeout(r, 300));
    const aliveAfter = (() => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    expect(aliveAfter).toBe(false); // orphan terminated (ADR-011)
    const row = db.prepare('SELECT state, outcome_reason FROM runs WHERE id=?').get(runId) as any;
    expect(row.state).toBe('failed');
    expect(row.outcome_reason).toBe('orphaned');
    expect(res.orphanedTerminated).toBe(1);
    expect(notifications.length).toBeGreaterThan(0);
  });
});

describe('S-81: reboot sweep finds dead-identity rows', () => {
  it('running rows with dead pgids go through the orphan path without killing anything live', () => {
    db = openDatabase(path.join(dir, `s81-${Date.now()}`)).db;
    createMigrator(db, MIGRATIONS).migrate();
    const runId = seedRunningRow(999_999_999); // certainly-dead group
    const rm = makeManager();
    const res = rm.recoverySweep();
    const row = db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as any;
    expect(row.state).toBe('failed');
    void res;
  });
});
