/**
 * F9 proposed-events — the read path finally has something to read.
 *
 * `proposed-events.test.ts` proves `proposedEventsFor()` and `toIcs()` against
 * hand-built report fixtures. Nothing proved that a real run could ever put a
 * proposal into `runs.report_json` in the first place — and until
 * `run-manager.finalize()` learned the ```clockwork-events convention, nothing
 * could: the field was declared, queried, rendered and downloadable, and no
 * code on any path ever wrote it.
 *
 * These tests close that loop end to end: an agent summary goes into
 * `finalize()`, and the events come back out of `proposedEventsFor()` and into
 * a downloadable .ics — the exact two functions the daemon's routes call.
 *
 * The refusal half matters more than the happy half. The block is model-authored
 * text, so a malformed or hostile one must cost the suggestions and nothing
 * else: the run still reaches its terminal state, the report still commits, and
 * the user is told what was dropped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId, type RunReport } from '@clockwork/shared';
import { SafetyJournal, PROPOSED_EVENTS_FENCE } from '@clockwork/runner';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager, type RunManagerDeps } from '../src/run-manager.js';
import { FakeClock } from '../src/clock.js';
import { proposedEventsFor, toIcs } from '../src/proposed-events.js';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const NOW = Date.UTC(2026, 8, 6, 9, 0, 0);

let db: DB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-proposed-producer-'));
  db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON');
  createMigrator(db, MIGRATIONS).migrate();
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('task-x', 'Queue triage', 'p', ?, ?)`).run(NOW, NOW);
});

afterEach(() => {
  if ((db as unknown as { open: boolean }).open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeManager(over: Partial<RunManagerDeps> = {}): RunManager {
  return new RunManager({
    db,
    clock: new FakeClock(NOW),
    dataDir: path.join(dir, 'data'),
    runnerChildModule: '/nonexistent.js',
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(path.join(dir, 'journal.jsonl')),
    ...over,
  });
}

/** A `running` row, the state every finalize path starts from. */
function seedRunningRun(): string {
  const runId = newId();
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, started_at, scheduled_for)
     VALUES (?, 'task-x', ?, 'running', ?, ?, ?)`,
  ).run(runId, JSON.stringify({ runId, taskId: 'task-x', taskName: 'Queue triage' }), NOW, NOW, NOW);
  return runId;
}

function reportOf(runId: string): RunReport & { proposedEvents?: unknown } {
  const row = db.prepare('SELECT report_json, state FROM runs WHERE id=?').get(runId) as { report_json: string; state: string };
  return JSON.parse(row.report_json) as RunReport;
}

function stateOf(runId: string): string {
  return (db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as { state: string }).state;
}

function block(body: string): string {
  return ['```' + PROPOSED_EVENTS_FENCE, body, '```'].join('\n');
}

const AGENT_SUMMARY = [
  'Triaged the queue. Two items need a human.',
  '',
  block(
    JSON.stringify([
      { title: 'Review PR 42', durationMin: 10, notes: 'CI is red on main', suggestedAt: '2026-09-08T15:00:00.000Z' },
      { title: 'Pair on the flaky sentinel test' },
    ]),
  ),
].join('\n');

const OK = { artifacts: [], costUsd: 0.1, turns: 3 };

describe('finalize() is the producer the F9 read path was missing', () => {
  it('turns an agent summary block into events the daemon route returns', async () => {
    const runId = seedRunningRun();
    await makeManager().finalize(runId, { state: 'completed', summary: AGENT_SUMMARY, ...OK });

    // Exactly what GET /workforce/runs/:runId/proposed-events serves.
    expect(proposedEventsFor(db, runId)).toEqual([
      {
        key: 'ev-1',
        title: 'Review PR 42',
        notes: 'CI is red on main',
        durationMin: 10,
        suggestedAt: Date.UTC(2026, 8, 8, 15, 0, 0),
      },
      { key: 'ev-2', title: 'Pair on the flaky sentinel test', notes: null, durationMin: 15, suggestedAt: null },
    ]);
  });

  it('produces a real downloadable calendar from that same run', async () => {
    const runId = seedRunningRun();
    await makeManager().finalize(runId, { state: 'completed', summary: AGENT_SUMMARY, ...OK });

    // Exactly what GET /workforce/runs/:runId/proposed-events.ics serves.
    const ics = toIcs(proposedEventsFor(db, runId), { runId, calName: 'Queue triage' });
    expect(ics).toContain('SUMMARY:Review PR 42');
    expect(ics).toContain(`UID:${runId}-ev-1@clockwork.local`);
    expect(ics).toContain('DTSTART:20260908T150000Z');
    expect(ics).toContain('DTEND:20260908T151000Z');
    expect([...ics.matchAll(/BEGIN:VEVENT/g)]).toHaveLength(2);
  });

  it('keeps the block out of the summary a human reads', async () => {
    const runId = seedRunningRun();
    await makeManager().finalize(runId, { state: 'completed', summary: AGENT_SUMMARY, ...OK });

    const report = reportOf(runId);
    expect(report.summary).toBe('Triaged the queue. Two items need a human.');
    expect(report.summary).not.toContain(PROPOSED_EVENTS_FENCE);
    expect(report.summary).not.toContain('durationMin');
  });

  it('leaves proposedEvents absent when the run proposed nothing', async () => {
    const runId = seedRunningRun();
    await makeManager().finalize(runId, { state: 'completed', summary: 'Nothing to report.', ...OK });

    const raw = (db.prepare('SELECT report_json FROM runs WHERE id=?').get(runId) as { report_json: string }).report_json;
    expect(JSON.parse(raw)).not.toHaveProperty('proposedEvents');
    expect(reportOf(runId).summary).toBe('Nothing to report.');
    expect(reportOf(runId).timeline).toEqual([]);
    expect(proposedEventsFor(db, runId)).toEqual([]);
  });

  it('still masks a credential in ordinary summary prose', async () => {
    // maskSecrets moved from the raw summary to the stripped prose; it must
    // still run. The block is parsed first precisely so masking can never
    // corrupt its JSON.
    const runId = seedRunningRun();
    const secret = `sk-ant-${'b'.repeat(40)}`;
    await makeManager().finalize(runId, { state: 'completed', summary: `Used ${secret} to log in.`, ...OK });
    expect(reportOf(runId).summary).toBe('Used [ANTHROPIC-KEY-MASKED] to log in.');
  });
});

describe('a bad block costs the suggestions, never the run', () => {
  const bad: Array<[name: string, summary: string, reason: string]> = [
    ['invalid JSON', `Done.\n${block('{ nope')}`, 'not valid JSON'],
    ['a JSON object instead of an array', `Done.\n${block('{"title":"T"}')}`, 'not a JSON array'],
    ['an 8 KB+ block', `Done.\n${block(JSON.stringify([{ title: 'T', notes: 'n'.repeat(9_000) }]))}`, 'larger than 8000 bytes'],
    ['entries with no usable title', `Done.\n${block('[{"notes":"x"},null,7]')}`, 'had an unusable shape'],
    ['an unterminated block', `Done.\n\`\`\`${PROPOSED_EVENTS_FENCE}\n[{"title":"T"}]`, 'never closed'],
  ];

  for (const [name, summary, reason] of bad) {
    it(`finalizes normally and discloses the drop for ${name}`, async () => {
      const runId = seedRunningRun();
      await expect(makeManager().finalize(runId, { state: 'completed', summary, ...OK })).resolves.toBeUndefined();

      expect(stateOf(runId)).toBe('completed'); // the run is untouched by the parse
      const report = reportOf(runId);
      expect(report).not.toHaveProperty('proposedEvents');
      expect(proposedEventsFor(db, runId)).toEqual([]);

      // Not swallowed: the user is told the agent tried and what was dropped.
      expect(report.timeline).toHaveLength(1);
      expect(report.timeline[0]?.kind).toBe('note');
      expect(report.timeline[0]?.text).toContain('Proposed calendar events');
      expect(report.timeline[0]?.text).toContain(reason);
    });
  }

  it('finalizes a failed run with a hostile block without changing its outcome', async () => {
    const runId = seedRunningRun();
    const hostile = [
      'Crashed.',
      block(JSON.stringify(Array.from({ length: 200 }, () => ({ key: 'collide', title: 'x' })))),
      block('[{"title":"second block"}]'),
    ].join('\n');

    await makeManager().finalize(runId, { state: 'failed', failureReason: 'runner_crashed', summary: hostile, ...OK });

    expect(stateOf(runId)).toBe('failed');
    expect(reportOf(runId).failureReason).toBe('runner_crashed');
    const events = proposedEventsFor(db, runId);
    expect(events).toHaveLength(20); // count cap held
    expect(new Set(events.map((e) => e.key)).size).toBe(20); // no UID collision reached the calendar
    expect(reportOf(runId).summary).toBe('Crashed.');
  });
});
