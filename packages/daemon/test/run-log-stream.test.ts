/**
 * The live run view's daemon half (T4-1): `run.log` over SSE, and the
 * catch-up route a tab opened mid-run seeds itself from.
 *
 * WHAT WAS ACTUALLY MISSING, AND WHY NOBODY SAW IT
 *   The broadcast itself shipped — `run-manager.ts` has emitted `run.log`
 *   since the Hermes engine landed. What shipped with it was nothing: no test
 *   named `run.log` anywhere in the repo, so two real gaps stayed invisible.
 *   (1) It fired once PER LINE, so a chatty agent wrote a frame per line to
 *   every connected client — and, because App.tsx bumps its data version on
 *   every frame, a refetch of the inbox with it. (2) The stream only carries
 *   what happens after you subscribe, and no route served the journal, so
 *   opening a running task showed a blank box that slowly filled.
 *
 * WHY THE THROTTLE NEEDED A TEST OF ITS OWN
 *   Coalescing invites exactly one bug: a run that ends three milliseconds
 *   into its window takes the buffered lines with it. The frames would still
 *   be sent when the timer eventually fired — but AFTER the terminal state,
 *   and the UI stops tailing a run the moment it sees that, so late is
 *   indistinguishable from lost. `ends inside the coalescing window` below
 *   therefore asserts ORDER, not merely presence.
 *
 * WHY THE SSE ASSERTIONS USE AN INJECTED CLIENT
 *   `GET /events` hijacks the reply and streams for ever, so `app.inject()`
 *   would hang on it (api.test.ts says so where it tests the auth path), and
 *   no daemon test opens a real socket. `buildServer` returns its
 *   `sseClients` set, so a stub client dropped into that set is written to by
 *   the REAL broadcast closure — same `data: …\n\n` framing a browser sees.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@clockwork/shared';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance, FastifyReply } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const NOW = Date.UTC(2026, 8, 10, 9, 0, 0);
/** Must match LOG_COALESCE_MS in run-manager.ts — the ~10 frames/sec budget. */
const WINDOW_MS = 100;

interface Frame {
  type: string;
  runId?: string;
  lines?: string[];
  state?: string;
  at?: number;
}

let db: DB;
let dir: string;
let app: FastifyInstance;
let token: string;
let rm: RunManager;
/** Everything the daemon has written to its one SSE client, in order. */
let wire: string[];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Parse the SSE wire back into events, asserting the framing on the way. */
function frames(): Frame[] {
  return wire.map((payload) => {
    expect(payload.startsWith('data: '), `not an SSE data frame: ${JSON.stringify(payload)}`).toBe(true);
    expect(payload.endsWith('\n\n'), 'SSE frames end with a blank line').toBe(true);
    return JSON.parse(payload.slice('data: '.length, -2)) as Frame;
  });
}

const logFrames = (): Frame[] => frames().filter((f) => f.type === 'run.log');
/** Every line delivered over SSE, in the order a reader would see it. */
const delivered = (): string[] => logFrames().flatMap((f) => f.lines ?? []);

async function boot(): Promise<void> {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-run-log-'));
  db = openDatabase(dir).db;
  createMigrator(db, MIGRATIONS).migrate();
  rm = new RunManager({
    db,
    clock: new FakeClock(NOW),
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js', // replaced per test by a stub
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(path.join(dir, 'journal.jsonl')),
  });
  const scheduler = new Scheduler({ db, clock: new FakeClock(NOW), enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
  app = built.app;
  token = built.token;
  await app.ready();

  // Captured, not read through the module binding: a straggler timer from a
  // previous test would otherwise push into THIS test's transcript.
  const sink: string[] = [];
  wire = sink;
  // Stands in for a browser holding GET /events open.
  const client = {
    raw: {
      write(payload: string): boolean {
        sink.push(payload);
        return true;
      },
    },
  } as unknown as FastifyReply;
  built.sseClients.add(client);
}

beforeEach(boot);

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRunningRun(): { runId: string; spec: Record<string, unknown> } {
  const runId = newId();
  const spec = {
    runId,
    taskId: 'task-tail',
    taskName: 'Tail probe',
    taskSlug: 'tail-probe',
    prompt: 'p',
    engine: 'cli',
    permissionMode: 'plan',
    budget: { maxUsd: 5, maxTurns: 50, timeoutSec: 300 },
    repoPath: null,
    worktreePath: path.join(dir, 'wt'),
    delivery: { osNotify: false },
  };
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('task-tail', 'Tail probe', 'p', ?, ?)`).run(NOW, NOW);
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, started_at, scheduled_for)
     VALUES (?, 'task-tail', ?, 'running', ?, ?, ?)`,
  ).run(runId, JSON.stringify(spec), NOW, NOW, NOW);
  return { runId, spec };
}

/**
 * A stand-in for runner-child that logs `count` lines and then reports an
 * outcome and exits at once. The immediate exit is the point: it is what puts
 * the terminal state inside the coalescing window the last lines are sitting
 * in.
 */
function useLoggingChild(count: number): void {
  const file = path.join(dir, `logging-child-${count}.mjs`);
  writeFileSync(
    file,
    `process.stdout.write(JSON.stringify({ t: 'ready', nonce: process.argv[3] }) + '\\n');\n` +
      `for (let i = 0; i < ${count}; i++) {\n` +
      `  process.stdout.write(JSON.stringify({ t: 'log', line: 'line ' + i }) + '\\n');\n` +
      `}\n` +
      `process.stdout.write(JSON.stringify({ t: 'outcome', outcome: { state: 'completed', artifacts: [], costUsd: 0.25, turns: 3, summary: 'done' } }) + '\\n');\n` +
      `process.exit(0);\n`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (rm as any)['deps'].runnerChildModule = file;
}

/** Feed the manager a child message directly — no process, no timing noise. */
async function say(runId: string, spec: Record<string, unknown>, msg: Record<string, unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (rm as any).handleChildMessage(runId, spec, JSON.stringify(msg));
}

async function waitForTerminal(runId: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as { state: string };
    if (['completed', 'failed', 'cancelled', 'budget_exceeded', 'timed_out'].includes(row.state)) return row.state;
    if (Date.now() > deadline) throw new Error(`run never went terminal — stuck in "${row.state}"`);
    await sleep(10);
  }
}

/**
 * The run row goes terminal inside finalize()'s transaction, and `report.ready`
 * is broadcast at the END of the advisory tail that follows it — so waiting on
 * the database row is NOT waiting for the last frame. Anything asserting about
 * frame order has to wait for the frame.
 */
async function waitForFrame(type: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!frames().some((f) => f.type === type)) {
    if (Date.now() > deadline) {
      throw new Error(`no ${type} frame; saw: ${frames().map((f) => f.type).join(', ')}`);
    }
    await sleep(10);
  }
}

const auth = (o: { method: string; url: string }): { method: string; url: string; headers: Record<string, string> } => ({
  ...o,
  headers: { authorization: `Bearer ${token}` },
});

// ---------------------------------------------------------------------------
// 1. The line the runner wrote reaches a subscriber
// ---------------------------------------------------------------------------

describe('run.log reaches an SSE subscriber', () => {
  it('carries a line the runner emitted, through the real broadcast closure', async () => {
    const { runId, spec } = seedRunningRun();
    useLoggingChild(3);
    await rm.spawnChild(runId, spec as never, NOW);
    await waitForTerminal(runId);
    // The close/finalize flush is synchronous, so by now every line is out.

    const logs = logFrames();
    expect(logs.length, 'no run.log frame reached the subscriber at all').toBeGreaterThan(0);
    expect(logs.every((f) => f.runId === runId), 'every frame names its run').toBe(true);
    expect(delivered()).toContain('line 0');
  }, 20_000);

  it('never mixes two runs into one frame', async () => {
    const a = seedRunningRun();
    const b = { runId: newId(), spec: null as unknown as Record<string, unknown> };
    db.prepare(
      `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, started_at, scheduled_for)
       VALUES (?, 'task-tail', ?, 'running', ?, ?, ?)`,
    ).run(b.runId, JSON.stringify({ ...a.spec, runId: b.runId }), NOW, NOW, NOW);
    b.spec = { ...a.spec, runId: b.runId };

    await say(a.runId, a.spec, { t: 'log', line: 'from A' });
    await say(b.runId, b.spec, { t: 'log', line: 'from B' });
    await sleep(WINDOW_MS * 3);

    const byRun = new Map(logFrames().map((f) => [f.runId, f.lines]));
    expect(byRun.get(a.runId)).toEqual(['from A']);
    expect(byRun.get(b.runId)).toEqual(['from B']);
  });
});

// ---------------------------------------------------------------------------
// 2. The throttle
// ---------------------------------------------------------------------------

describe('log lines are coalesced, not sampled', () => {
  it('holds a burst for one window and sends it as a single frame', async () => {
    const { runId, spec } = seedRunningRun();
    const lines = Array.from({ length: 40 }, (_, i) => `burst ${i}`);
    for (const line of lines) await say(runId, spec, { t: 'log', line });

    expect(logFrames(), 'the window had not closed yet — nothing should have gone out').toHaveLength(0);
    await sleep(WINDOW_MS * 3);

    expect(logFrames(), '40 lines must not become 40 frames').toHaveLength(1);
    expect(delivered(), 'coalescing batches lines; it never drops them').toEqual(lines);
  });

  it('stays inside ~10 frames/sec while a run keeps talking', async () => {
    const { runId, spec } = seedRunningRun();
    const started = Date.now();
    const lines: string[] = [];
    // ~350ms of continuous chatter: unthrottled this is 35 frames.
    for (let i = 0; i < 35; i++) {
      const line = `chatter ${i}`;
      lines.push(line);
      await say(runId, spec, { t: 'log', line });
      await sleep(10);
    }
    await sleep(WINDOW_MS * 3);
    const elapsed = Date.now() - started;

    const budget = Math.ceil(elapsed / WINDOW_MS) + 1; // +1 for the trailing flush
    expect(logFrames().length, `${logFrames().length} frames in ${elapsed}ms exceeds ~10/sec`).toBeLessThanOrEqual(budget);
    expect(logFrames().length, 'a frame per line is the bug this replaces').toBeLessThan(lines.length);
    expect(delivered(), 'throttling must not cost a single line').toEqual(lines);
  }, 20_000);

  it('caps a broadcast line at 500 chars and the journal line at 2000', async () => {
    const { runId, spec } = seedRunningRun();
    await say(runId, spec, { t: 'log', line: 'x'.repeat(4000) });
    await sleep(WINDOW_MS * 3);

    expect(delivered()[0], 'the wire cap is 500').toHaveLength(500);
    const res = await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events` }));
    expect(res.json().lines[0].text, 'the journal keeps the longer record').toHaveLength(2000);
  });
});

// ---------------------------------------------------------------------------
// 3. The tail of a run must survive the end of the run
// ---------------------------------------------------------------------------

describe('a run that ends inside the coalescing window', () => {
  it('delivers its last lines BEFORE the terminal state, not after it', async () => {
    // The child logs 30 lines and exits in the same breath, so the outcome
    // arrives a few microseconds into a 100ms window. Without the flush in
    // finalize() those 30 lines go out on the timer — after the UI has already
    // been told the run is over and stopped tailing it.
    const { runId, spec } = seedRunningRun();
    useLoggingChild(30);
    await rm.spawnChild(runId, spec as never, NOW);
    expect(await waitForTerminal(runId)).toBe('completed');
    await waitForFrame('report.ready');

    const expected = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    expect(delivered(), 'the tail of the run was swallowed by the throttle').toEqual(expected);

    const all = frames();
    const lastLog = all.map((f) => f.type).lastIndexOf('run.log');
    const finalizing = all.findIndex((f) => f.type === 'run.state_changed' && f.state === 'finalizing');
    const reportReady = all.findIndex((f) => f.type === 'report.ready');
    expect(finalizing, 'the run should have gone through finalizing').toBeGreaterThan(-1);
    expect(lastLog, 'output that lands after the terminal frame is output the UI has stopped reading').toBeLessThan(
      finalizing,
    );
    expect(lastLog).toBeLessThan(reportReady);
  }, 20_000);

  it('flushes late lines even on a second finalize() for an already-terminal run', async () => {
    // finalize() returns early for a run that is already terminal. The flush
    // sits ABOVE that early return, because lines can arrive between the two
    // calls (the child close handler is the second caller in practice).
    const { runId, spec } = seedRunningRun();
    await rm.finalize(runId, { state: 'completed', artifacts: [], costUsd: 0, turns: 1 });
    wire.length = 0;

    await say(runId, spec, { t: 'log', line: 'a straggler' });
    expect(logFrames(), 'still inside the window').toHaveLength(0);
    await rm.finalize(runId, { state: 'failed', artifacts: [], costUsd: 0, turns: 1 });

    expect(delivered(), 'the second finalize is a no-op for the run but must still flush').toEqual(['a straggler']);
  });
});

// ---------------------------------------------------------------------------
// 4. GET /runs/:id/events — the catch-up
// ---------------------------------------------------------------------------

describe('GET /runs/:id/events', () => {
  function writeJournal(runId: string, texts: string[], kind = 'log'): void {
    const d = path.join(dir, 'runs', runId);
    mkdirSync(d, { recursive: true });
    appendFileSync(
      path.join(d, 'stream.jsonl'),
      texts.map((text, i) => JSON.stringify({ t: NOW + i, kind, text }) + '\n').join(''),
    );
  }

  it('returns what a run has already written, so a tab opened mid-run is not blank', async () => {
    const { runId } = seedRunningRun();
    writeJournal(runId, ['first thing', 'second thing']);

    const res = await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events` }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lines.map((l: { text: string }) => l.text)).toEqual(['first thing', 'second thing']);
    expect(body.lines[0].at, 'each line keeps the time the daemon recorded it').toBe(NOW);
    expect(body.from, 'nothing was skipped, so the window starts where it was asked to').toBe(0);
    expect(body.nextSince).toBeGreaterThan(0);
    expect(body.complete).toBe(true);
  });

  it('advances `since`: the next call returns only what arrived after it', async () => {
    const { runId } = seedRunningRun();
    writeJournal(runId, ['one', 'two']);
    const first = (await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events` }))).json();

    // …the run keeps working while the tab is open…
    writeJournal(runId, ['three']);
    const second = (
      await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events?since=${first.nextSince}` }))
    ).json();

    expect(second.lines.map((l: { text: string }) => l.text), 'the caller must not be re-sent lines it has').toEqual([
      'three',
    ]);
    expect(second.since).toBe(first.nextSince);
    expect(second.nextSince, '`since` has to move or the caller loops for ever').toBeGreaterThan(first.nextSince);

    // …and once caught up, asking again returns nothing rather than repeating.
    const third = (
      await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events?since=${second.nextSince}` }))
    ).json();
    expect(third.lines).toEqual([]);
    expect(third.nextSince).toBe(second.nextSince);
  });

  it('never returns a partial line while the daemon is mid-write', async () => {
    const { runId } = seedRunningRun();
    writeJournal(runId, ['complete line']);
    appendFileSync(path.join(dir, 'runs', runId, 'stream.jsonl'), '{"t":1,"kind":"log","text":"torn');

    const body = (await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events` }))).json();
    expect(body.lines.map((l: { text: string }) => l.text)).toEqual(['complete line']);
    expect(body.complete, 'there are bytes past nextSince, so the caller is not caught up').toBe(false);
    // The torn line completes; the next call reads it whole rather than losing it.
    appendFileSync(path.join(dir, 'runs', runId, 'stream.jsonl'), ' write"}\n');
    const next = (await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events?since=${body.nextSince}` }))).json();
    expect(next.lines.map((l: { text: string }) => l.text)).toEqual(['torn write']);
  });

  it('seeds from the END of a journal too big to read whole, and says it did', async () => {
    // The failure this pins: seeding a 40MB run with its FIRST 200 lines is a
    // plausible-looking wrong answer — the user watches output from an hour ago.
    const { runId } = seedRunningRun();
    const filler = 'y'.repeat(1000);
    writeJournal(runId, ['THE-VERY-FIRST-LINE', ...Array.from({ length: 400 }, () => filler), 'THE-VERY-LAST-LINE']);

    const body = (await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events` }))).json();
    const texts = body.lines.map((l: { text: string }) => l.text);
    expect(texts, 'the newest line is the one that matters').toContain('THE-VERY-LAST-LINE');
    expect(texts, 'the head of a huge journal is not what a live tail wants').not.toContain('THE-VERY-FIRST-LINE');
    expect(body.from, 'the response must admit its lines do not start at `since`').toBeGreaterThan(0);
    expect(body.complete).toBe(true);
  });

  it('honours `limit`, and reports how many it trimmed', async () => {
    const { runId } = seedRunningRun();
    writeJournal(runId, Array.from({ length: 250 }, (_, i) => `line ${i}`));

    const dflt = (await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events` }))).json();
    expect(dflt.lines).toHaveLength(200);
    expect(dflt.lines[199].text, 'the trim keeps the NEWEST lines').toBe('line 249');
    expect(dflt.skipped, 'silent trimming is the dishonest version of this').toBe(50);

    const small = (await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events?limit=5` }))).json();
    expect(small.lines).toHaveLength(5);
    expect(small.lines[4].text).toBe('line 249');
  });

  it('masks credentials the way the transcript route does', async () => {
    const { runId } = seedRunningRun();
    const token = `ghp_${'a'.repeat(36)}`;
    writeJournal(runId, [`pushing with ${token}`]);

    const body = (await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events` }))).json();
    expect(body.lines[0].text).not.toContain(token);
    expect(body.lines[0].text).toContain('[GITHUB-TOKEN-MASKED]');
  });

  it('is empty, not an error, for a run that has not said anything yet', async () => {
    const { runId } = seedRunningRun();
    const res = await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events` }));
    expect(res.statusCode, 'a quiet run is not a missing run').toBe(200);
    expect(res.json()).toMatchObject({ lines: [], nextSince: 0, complete: true });
  });

  it('404s an unknown run, and never lets an id reach the filesystem first', async () => {
    expect((await app.inject(auth({ method: 'GET', url: '/runs/run_nope/events' }))).statusCode).toBe(404);
    const traversal = await app.inject(auth({ method: 'GET', url: '/runs/..%2F..%2Fetc/events' }));
    expect(traversal.statusCode, 'the runs table is the allowlist').toBe(404);
  });

  it('requires the bearer token', async () => {
    const { runId } = seedRunningRun();
    expect((await app.inject({ method: 'GET', url: `/runs/${runId}/events` })).statusCode).toBe(401);
  });

  it('serves the same lines the live stream sent, for a run tailing right now', async () => {
    // The two halves have to agree: what the stream pushed is what a reload
    // reads back.
    const { runId, spec } = seedRunningRun();
    await say(runId, spec, { t: 'log', line: 'hello from the agent' });
    await sleep(WINDOW_MS * 3);

    expect(delivered()).toEqual(['hello from the agent']);
    const body = (await app.inject(auth({ method: 'GET', url: `/runs/${runId}/events` }))).json();
    expect(body.lines.map((l: { text: string }) => l.text)).toEqual(['hello from the agent']);
  });
});
