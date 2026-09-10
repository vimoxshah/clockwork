/**
 * T1-9 — a run that slept through its window.
 *
 * THE DEFECT THIS FILE PINS
 *   `run-manager.finalize()` wrote `sleptThroughKeepAwake: false` as a
 *   LITERAL, on every run, for the whole life of the field. The schema
 *   defaulted it to `false` too. So the one failure the README warns about
 *   hardest — the Mac slept and your job did not run — was the one case the
 *   report actively denied, and every stored report says "did not sleep"
 *   about a window nobody watched.
 *
 * WHY THE OBVIOUS DETECTOR DOES NOT WORK
 *   "wall elapsed vs the process's own monotonic elapsed" finds nothing on
 *   macOS. Measured 2026-09-10 on Node 24.13.1 / libuv 1.51.0, seconds since
 *   boot at one instant:
 *     process.hrtime.bigint() 92469.7 == CLOCK_MONOTONIC_RAW 92469.7
 *     CLOCK_UPTIME_RAW        92406.9   <- the only clock that stops
 *   Darwin's CLOCK_MONOTONIC_RAW keeps running through sleep (it behaves like
 *   Linux's CLOCK_BOOTTIME), the 62.8s difference IS the sleep `pmset -g log`
 *   records at 06:38:10 -> 06:39:15 that boot, and Node exposes no
 *   sleep-excluding clock. The signal that survives is timer starvation: a
 *   frozen process runs nothing, so a tick due 15s out arrives on wake.
 *
 * WHAT THE TESTS BELOW ASSERT
 *   1. A window that spans a sleep reports the frozen time, in ms.
 *   2. A window that was merely SLOW reports none — this is the assertion
 *      that stops the feature crying wolf, and it matters more than (1).
 *   3. A wall clock that jumped is not a sleep; real time did not pass.
 *   4. Off macOS the answer is "unknown", never "no".
 *   5. The report carries all three states apart, end to end through
 *      finalize() and into report_json.
 *
 * `pmset -g log | grep -E ' (Sleep|Wake) '` corroborates any of this after
 * the fact on a real Mac. It is not wired in: it takes seconds, its format is
 * not a contract, and finalize() is not the place to spawn a process.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId, RunReport } from '@clockwork/shared';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager, type RunManagerDeps } from '../src/run-manager.js';
import { FakeClock } from '../src/clock.js';
import { KeepAwake, SLEEP_GAP_MS, SLEEP_SAMPLE_MS } from '../src/keep-awake.js';
import { SafetyJournal } from '@clockwork/runner';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const NOW = Date.UTC(2026, 8, 10, 2, 0, 0);
const RUN_MANAGER_SRC = readFileSync(path.resolve(import.meta.dirname, '../src/run-manager.ts'), 'utf8');

/**
 * The two clocks the detector reads, advanced together or apart.
 *
 * `pass()` is real time going by — both move, which is what a sleep looks
 * like on Darwin. `stepWallOnly()` is the wall clock being CORRECTED, by NTP
 * or by hand: the number changes and no time passed.
 */
function clockPair(startWall: number): {
  wall: () => number;
  mono: () => number;
  pass: (ms: number) => void;
  stepWallOnly: (ms: number) => void;
} {
  let wall = startWall;
  let mono = 1_000_000; // arbitrary origin, as performance.now() has
  return {
    wall: () => wall,
    mono: () => mono,
    pass: (ms) => {
      wall += ms;
      mono += ms;
    },
    stepWallOnly: (ms) => {
      wall += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. The observer
// ---------------------------------------------------------------------------

describe('the sleep observer tells a frozen Mac from a slow one', () => {
  it('reports the frozen time when the lid closes mid-run', () => {
    const c = clockPair(NOW);
    const ka = new KeepAwake({ platform: 'darwin', monoNow: c.mono });

    ka.observe('run_1', c.wall()); // seeded when the run starts
    for (let i = 0; i < 4; i++) {
      c.pass(SLEEP_SAMPLE_MS);
      ka.observe('run_1', c.wall());
    }
    expect(ka.sleepDuring('run_1'), 'a healthy minute must read as zero, not as "unknown"').toBe(0);

    c.pass(42 * 60_000); // the lid closes; no tick fires until the Mac wakes
    ka.observe('run_1', c.wall());

    // A floor, not a guess: up to one sample interval of that gap was
    // scheduled, so the sleep was 42m and we claim 41m45s of it.
    expect(ka.sleepDuring('run_1')).toBe(42 * 60_000 - SLEEP_SAMPLE_MS);
    expect(ka.sleepDuring('run_1')!).toBeLessThanOrEqual(42 * 60_000);
    expect(ka.sleepDuring('run_1')!).toBeGreaterThan(42 * 60_000 - SLEEP_SAMPLE_MS - 1);
  });

  it('reports NO sleep for a run that was merely slow — four hours of ticks that all arrived', () => {
    // The whole point of sampling per tick instead of measuring the window:
    // this run took four hours and the Mac never stopped once. Total elapsed
    // time cannot tell the two apart; a missed tick can.
    const c = clockPair(NOW);
    const ka = new KeepAwake({ platform: 'darwin', monoNow: c.mono });
    ka.observe('run_2', c.wall());

    // Jitter a loaded Mac really produces: a GC pause, a synchronous sqlite
    // transaction, and at the top end a saturated, swapping machine.
    const jitterMs = [0, 12, 140, 900, 3_000, 250, 14_000, 60, 7_500];
    for (let i = 0; i < 960; i++) {
      c.pass(SLEEP_SAMPLE_MS + jitterMs[i % jitterMs.length]!);
      ka.observe('run_2', c.wall());
    }

    expect(c.wall() - NOW, 'the fixture must actually span hours').toBeGreaterThan(4 * 3_600_000);
    expect(ka.sleepDuring('run_2'), 'a slow run must not be reported as a sleep').toBe(0);
  });

  it('holds the line exactly at the threshold', () => {
    // One tick short of the bar is jitter; the bar itself is a sleep. The
    // number reported is the overshoot, never the whole gap.
    const below = clockPair(NOW);
    const kaBelow = new KeepAwake({ platform: 'darwin', monoNow: below.mono });
    kaBelow.observe('r', below.wall());
    below.pass(SLEEP_GAP_MS - 1);
    kaBelow.observe('r', below.wall());
    expect(kaBelow.sleepDuring('r')).toBe(0);

    const at = clockPair(NOW);
    const kaAt = new KeepAwake({ platform: 'darwin', monoNow: at.mono });
    kaAt.observe('r', at.wall());
    at.pass(SLEEP_GAP_MS);
    kaAt.observe('r', at.wall());
    expect(kaAt.sleepDuring('r')).toBe(SLEEP_GAP_MS - SLEEP_SAMPLE_MS);
  });

  it('catches the shortest sleep that already kills a run on the heartbeat gap', () => {
    // A sleep past HEARTBEAT_GAP_MS makes the watchdog kill the run as
    // `runner_crashed` the moment the Mac wakes. If the detector's bar sat
    // above that, those reports would say "crashed" and "did not sleep" side
    // by side — the T1-9 defect, rebuilt one band higher.
    const heartbeatGap = Number(/const HEARTBEAT_GAP_MS = ([\d_]+)/.exec(RUN_MANAGER_SRC)![1]!.replace(/_/g, ''));
    expect(
      SLEEP_GAP_MS,
      `a ${heartbeatGap}ms sleep is fatal to a run, so the detector must not need more than that to see one`,
    ).toBeLessThanOrEqual(heartbeatGap);

    const c = clockPair(NOW);
    const ka = new KeepAwake({ platform: 'darwin', monoNow: c.mono });
    ka.observe('r', c.wall());
    c.pass(heartbeatGap + 1_000); // the worst phase: asleep the instant after a tick
    ka.observe('r', c.wall());
    expect(ka.sleepDuring('r')!).toBeGreaterThan(0);
  });

  it('adds up a window that was interrupted more than once', () => {
    const c = clockPair(NOW);
    const ka = new KeepAwake({ platform: 'darwin', monoNow: c.mono });
    ka.observe('r', c.wall());
    for (const sleep of [10 * 60_000, 25 * 60_000]) {
      c.pass(SLEEP_SAMPLE_MS);
      ka.observe('r', c.wall());
      c.pass(sleep);
      ka.observe('r', c.wall());
    }
    expect(ka.sleepDuring('r')).toBe(35 * 60_000 - 2 * SLEEP_SAMPLE_MS);
  });

  it('reports no sleep when only the wall clock moved', () => {
    // NTP stepping the clock an hour forward, or a user fixing the date.
    // Nothing was frozen and no time passed, so nothing is owed to the user.
    const c = clockPair(NOW);
    const ka = new KeepAwake({ platform: 'darwin', monoNow: c.mono });
    ka.observe('r', c.wall());
    c.pass(SLEEP_SAMPLE_MS);
    c.stepWallOnly(60 * 60_000);
    ka.observe('r', c.wall());
    expect(ka.sleepDuring('r'), 'a clock correction is not a sleep').toBe(0);
  });

  it('survives a wall clock that moved BACKWARDS without inventing negative sleep', () => {
    const c = clockPair(NOW);
    const ka = new KeepAwake({ platform: 'darwin', monoNow: c.mono });
    ka.observe('r', c.wall());
    c.pass(SLEEP_SAMPLE_MS);
    c.stepWallOnly(-3_600_000);
    ka.observe('r', c.wall());
    expect(ka.sleepDuring('r')).toBe(0);

    // and it resynchronises rather than staying poisoned
    c.pass(30 * 60_000);
    ka.observe('r', c.wall());
    expect(ka.sleepDuring('r')).toBe(30 * 60_000 - SLEEP_SAMPLE_MS);
  });

  it('answers "unknown" and not "no" off macOS', () => {
    // There is no keep-awake window off macOS to sleep through, and Linux's
    // CLOCK_MONOTONIC excludes suspend, which would make the wall-vs-monotonic
    // guard zero out every real suspend. Claiming `false` here would be the
    // same lie in a new place.
    const c = clockPair(NOW);
    const ka = new KeepAwake({ platform: 'linux', monoNow: c.mono });
    ka.observe('r', c.wall());
    c.pass(2 * 3_600_000);
    ka.observe('r', c.wall());
    expect(ka.sleepDuring('r')).toBeNull();
  });

  it('answers "unknown" for a window it never watched', () => {
    // A run recovered after a daemon restart: the window happened, this
    // process was not there for it.
    const ka = new KeepAwake({ platform: 'darwin', monoNow: () => 0 });
    expect(ka.sleepDuring('run_from_a_previous_daemon')).toBeNull();
  });

  it('forgets a window when its assertion is released', () => {
    const c = clockPair(NOW);
    const ka = new KeepAwake({ platform: 'darwin', monoNow: c.mono });
    ka.observe('r', c.wall());
    c.pass(30 * 60_000);
    ka.observe('r', c.wall());
    expect(ka.sleepDuring('r')).toBeGreaterThan(0);
    ka.release('r');
    expect(ka.sleepDuring('r'), 'a released window must read as unknown, not as zero').toBeNull();
  });

  it('keeps two concurrent runs apart', () => {
    // A daemon-wide "last sample" would charge the overnight sleep to the
    // first run of the morning. Windows are per key for that reason.
    const c = clockPair(NOW);
    const ka = new KeepAwake({ platform: 'darwin', monoNow: c.mono });
    ka.observe('early', c.wall());
    c.pass(8 * 3_600_000); // the Mac sleeps all night with `early` open
    ka.observe('early', c.wall());
    ka.observe('later', c.wall()); // a fresh run starts after the wake
    c.pass(SLEEP_SAMPLE_MS);
    ka.observe('later', c.wall());

    expect(ka.sleepDuring('early')!).toBeGreaterThan(7 * 3_600_000);
    expect(ka.sleepDuring('later'), 'the new run inherited the old one’s gap').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. The wiring — an observer nothing calls measures nothing
// ---------------------------------------------------------------------------

describe('the run manager samples the window it armed', () => {
  it('no longer writes a hardcoded sleptThroughKeepAwake: false', () => {
    expect(RUN_MANAGER_SRC, 'the literal is back; the report is lying again').not.toMatch(
      /sleptThroughKeepAwake:\s*false/,
    );
    expect(RUN_MANAGER_SRC).toMatch(/keepAwake\?\.sleepDuring\?\.\(/);
  });

  it('seeds the window beside the watchdog, with nothing awaited in between', () => {
    // THE BUG THIS PINS. The seed first went at the top of startRun, next to
    // arm(). Between there and the first watchdog tick sit prompt rendering,
    // `preflightRepo` and an awaited `createWorktree` — so on a large repo the
    // first sampled gap was `setup + 15s`, and 45s of `git worktree add`
    // reported as a 45-second sleep on every single run. Exactly the wolf-cry
    // the feature must not make.
    const spawn = RUN_MANAGER_SRC.slice(
      RUN_MANAGER_SRC.indexOf('async spawnChild('),
      RUN_MANAGER_SRC.indexOf('watchdog.unref?.()'),
    );
    const seedAt = spawn.indexOf('keepAwake?.observe?.(');
    const watchdogAt = spawn.indexOf('const watchdog = setInterval(');
    expect(seedAt, 'spawnChild never seeds the window, so the first tick has nothing to compare against').toBeGreaterThan(-1);
    expect(seedAt, 'the seed moved after the watchdog it is supposed to precede').toBeLessThan(watchdogAt);
    expect(
      spawn.slice(seedAt, watchdogAt),
      'something awaits between the seed and the watchdog; that delay lands in the first sampled gap',
    ).not.toMatch(/\bawait\b/);

    // A fresh clock read, not spawnChild's `now` parameter — that is the
    // timestamp startRun took BEFORE preflight, which is the same bug wearing
    // a different line number.
    expect(spawn.slice(seedAt, seedAt + 80), 'the seed reuses the stale startRun timestamp').toContain(
      'this.deps.clock.now()',
    );

    // And it must not be gated on arm(): arm() declines on battery, and a
    // laptop on battery is the machine most likely to sleep.
    const startRun = RUN_MANAGER_SRC.slice(
      RUN_MANAGER_SRC.indexOf('async startRun('),
      RUN_MANAGER_SRC.indexOf('async spawnChild('),
    );
    expect(startRun, 'the seed must not sit inside an if (armed) branch').not.toMatch(
      /if\s*\([^)]*arm\([^)]*\)[^{]*\{[^}]*observe/s,
    );
  });

  it('samples from the watchdog BEFORE the heartbeat check', () => {
    // A sleep longer than HEARTBEAT_GAP_MS makes that very tick kill the run.
    // Sampling after the check would lose the gap that caused the kill, and
    // the resulting `runner_crashed` report could not say why.
    const start = RUN_MANAGER_SRC.indexOf('const watchdog = setInterval(');
    expect(start, 'the run watchdog moved; this tripwire no longer reads it').toBeGreaterThan(-1);
    const body = RUN_MANAGER_SRC.slice(start, RUN_MANAGER_SRC.indexOf('watchdog.unref?.()'));
    const observedAt = body.indexOf('keepAwake?.observe?.(');
    // The COMPARISON, not the constant's name: the name also appears in the
    // comment explaining this ordering, and matching that would compare an
    // index against prose.
    const heartbeatAt = body.indexOf('if (r.heartbeat_at');
    expect(observedAt, 'the watchdog never samples, so only the seed is ever taken').toBeGreaterThan(-1);
    expect(heartbeatAt, 'the heartbeat check moved; this tripwire no longer reads it').toBeGreaterThan(-1);
    expect(observedAt).toBeLessThan(heartbeatAt);
    expect(body, 'the heartbeat check no longer uses the gap constant the threshold is pinned to').toContain(
      'HEARTBEAT_GAP_MS',
    );
    // The threshold maths is stated in terms of this cadence, so the two must
    // not drift apart. Numeric separators are stripped so `15_000` in the
    // source compares against the constant's value.
    expect(body.replace(/(\d)_(?=\d)/g, '$1'), `the watchdog no longer ticks every ${SLEEP_SAMPLE_MS}ms`).toContain(
      `}, ${SLEEP_SAMPLE_MS})`,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The schema — "not checked" must not be spellable as "did not happen"
// ---------------------------------------------------------------------------

describe('the report schema keeps "not checked" apart from "did not happen"', () => {
  const legacy = {
    runId: 'r', taskId: 't', taskName: 'n', profile: null, engine: 'cli', cliVersion: null,
    state: 'completed', failureReason: null, summary: 's', branch: null, baseSha: null,
    transcriptPath: null, startedAt: null, endedAt: null,
  };

  it('invents no answer for a report that carries none', () => {
    const parsed = RunReport.parse(legacy);
    expect(parsed.sleptDuringRunMs).toBeUndefined();
    expect(
      parsed.sleptThroughKeepAwake,
      'the schema default was the defect: it made "nobody looked" parse as "it did not happen"',
    ).toBeUndefined();
    expect(parsed.sleptThroughKeepAwake).not.toBe(false);
  });

  it('still accepts the hardcoded false every stored report already carries', () => {
    // Reports written before T1-9 must not crash the inbox. They stay
    // readable — and `sleptDuringRunMs` stays absent on them, which is how a
    // reader knows that `false` was never measured.
    const shipped = RunReport.parse({ ...legacy, sleptThroughKeepAwake: false });
    expect(shipped.sleptThroughKeepAwake).toBe(false);
    expect(shipped.sleptDuringRunMs).toBeUndefined();
  });

  it('carries a measured window', () => {
    const measured = RunReport.parse({ ...legacy, sleptDuringRunMs: 2_505_000, sleptThroughKeepAwake: true });
    expect(measured.sleptDuringRunMs).toBe(2_505_000);
    expect(measured.sleptThroughKeepAwake).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. End to end: finalize() -> report_json
// ---------------------------------------------------------------------------

let db: DB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-sleep-detection-'));
  db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON');
  createMigrator(db, MIGRATIONS).migrate();
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

function seedRunningRun(): string {
  const runId = newId();
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('task-s', 'Nightly digest', 'p', ?, ?)`).run(NOW, NOW);
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, started_at, scheduled_for)
     VALUES (?, 'task-s', ?, 'running', ?, ?, ?)`,
  ).run(runId, JSON.stringify({ runId, taskId: 'task-s', taskName: 'Nightly digest' }), NOW, NOW, NOW);
  return runId;
}

const DONE = { state: 'completed' as const, artifacts: [], costUsd: 0, turns: 0 };

function storedReport(runId: string): Record<string, unknown> {
  const row = db.prepare('SELECT report_json FROM runs WHERE id=?').get(runId) as { report_json: string };
  return JSON.parse(row.report_json) as Record<string, unknown>;
}

describe('the run report says what the observer found', () => {
  it('carries the sleep and its duration into report_json', async () => {
    const c = clockPair(NOW);
    const keepAwake = new KeepAwake({ platform: 'darwin', monoNow: c.mono });
    const runId = seedRunningRun();

    keepAwake.observe(runId, c.wall());
    c.pass(SLEEP_SAMPLE_MS);
    keepAwake.observe(runId, c.wall());
    c.pass(42 * 60_000); // the Mac sleeps for 42 minutes mid-window
    keepAwake.observe(runId, c.wall());

    await makeManager({ keepAwake }).finalize(runId, DONE);

    const report = storedReport(runId);
    expect(report.sleptThroughKeepAwake).toBe(true);
    expect(report.sleptDuringRunMs).toBe(42 * 60_000 - SLEEP_SAMPLE_MS);
    // Round to whole minutes the way the inbox does: 41m45s reads as 42m.
    expect(Math.round((report.sleptDuringRunMs as number) / 60_000)).toBe(42);
  });

  it('records a watched, sleepless window as 0 — a claim it has earned', async () => {
    const c = clockPair(NOW);
    const keepAwake = new KeepAwake({ platform: 'darwin', monoNow: c.mono });
    const runId = seedRunningRun();
    keepAwake.observe(runId, c.wall());
    for (let i = 0; i < 200; i++) {
      c.pass(SLEEP_SAMPLE_MS + 400);
      keepAwake.observe(runId, c.wall());
    }

    await makeManager({ keepAwake }).finalize(runId, DONE);

    const report = storedReport(runId);
    expect(report.sleptDuringRunMs).toBe(0);
    expect(report.sleptThroughKeepAwake).toBe(false);
  });

  it('leaves BOTH fields out of report_json when nobody could know', async () => {
    // Off macOS. The keys must be absent from the stored JSON, not present
    // and false: `JSON.stringify` drops `undefined`, and that absence is the
    // whole representation of "we did not check".
    const c = clockPair(NOW);
    const keepAwake = new KeepAwake({ platform: 'linux', monoNow: c.mono });
    const runId = seedRunningRun();
    keepAwake.observe(runId, c.wall());
    c.pass(3 * 3_600_000);
    keepAwake.observe(runId, c.wall());

    await makeManager({ keepAwake }).finalize(runId, DONE);

    const report = storedReport(runId);
    expect(report, 'off macOS the report must make no claim at all').not.toHaveProperty('sleptDuringRunMs');
    expect(report).not.toHaveProperty('sleptThroughKeepAwake');
    expect(report.sleptThroughKeepAwake).not.toBe(false);
  });

  it('leaves both fields out when the daemon never watched the run at all', async () => {
    // No keepAwake dep: recovery paths and every existing test construct the
    // manager this way. Silence, not a denial.
    const runId = seedRunningRun();
    await makeManager().finalize(runId, DONE);

    const report = storedReport(runId);
    expect(report).not.toHaveProperty('sleptDuringRunMs');
    expect(report).not.toHaveProperty('sleptThroughKeepAwake');
  });

  it('still reports the sleep on the run the sleep KILLED', async () => {
    // The heartbeat watchdog fires on wake and finalizes this run as
    // `runner_crashed`. Before T1-9 that report said "crashed" and "did not
    // sleep" at once, and the user had no way to learn which was true.
    const c = clockPair(NOW);
    const keepAwake = new KeepAwake({ platform: 'darwin', monoNow: c.mono });
    const runId = seedRunningRun();
    keepAwake.observe(runId, c.wall());
    c.pass(20 * 60_000);
    keepAwake.observe(runId, c.wall());

    await makeManager({ keepAwake }).finalize(runId, {
      state: 'failed',
      failureReason: 'runner_crashed',
      artifacts: [],
      costUsd: 0,
      turns: 0,
    });

    const report = storedReport(runId);
    expect(report.failureReason).toBe('runner_crashed');
    expect(report.sleptDuringRunMs).toBe(20 * 60_000 - SLEEP_SAMPLE_MS);
  });
});
