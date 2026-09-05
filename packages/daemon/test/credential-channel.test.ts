/**
 * ADR-035: the BYOK credential must travel to runner-child over stdin, never
 * through the spawned child's env — macOS exposes a process's exec-time env
 * to any other same-user process via sysctl KERN_PROCARGS2 (the Seatbelt
 * profile has to allow sysctl-read for Node to run at all, so it cannot close
 * that door). A `delete process.env.*` scrub inside the child is not a
 * boundary against a sibling process reading the ORIGINAL env this process
 * was exec'd with.
 *
 * This test drives the REAL RunManager.spawnChild() code path — real DB, real
 * ByokStore credential resolution, real env construction — and intercepts only
 * node:child_process's `spawn` (kept real is spawnSync, used elsewhere by
 * RunManager for identity-verified kills, unrelated to this path) so we can
 * observe, without needing a live provider or a real subprocess, (a) the exact
 * env object RunManager hands to spawn(), and (b) the exact bytes written to
 * the child's stdin. A real runner-child (as full-loop.test.ts drives) cannot
 * prove env absence from outside the process without shelling out to
 * KERN_PROCARGS2 itself, which is what this finding is ABOUT — spying on the
 * daemon's own spawn call is the deterministic way to assert the production
 * code path never puts the secret where the finding says it leaked from.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { FakeClock } from '../src/clock.js';
import { ByokStore } from '../src/byok.js';
import { SafetyJournal } from '@clockwork/runner';

// ---- fake node:child_process.spawn ----------------------------------------
const captured = vi.hoisted(() => ({
  calls: [] as Array<{ env: Record<string, string>; child: FakeChild }>,
}));
interface FakeChild {
  pid: number;
  stdin: { writable: boolean; writes: string[]; write: (d: string) => boolean };
  stdout: unknown;
  stderr: unknown;
  on: (...a: unknown[]) => unknown;
}
let nextPid = 424242;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return {
    ...actual,
    spawn: (_bin: string, _args: string[], opts: { env?: Record<string, string> }) => {
      const emitter = new EventEmitter();
      const writes: string[] = [];
      const child = Object.assign(emitter, {
        pid: nextPid++,
        stdin: { writable: true, writes, write: (d: string) => { writes.push(d); return true; } },
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      }) as unknown as FakeChild;
      captured.calls.push({ env: opts.env ?? {}, child });
      return child;
    },
  };
});

let db: DB;
let dir: string;
let rm: RunManager;
let clock: FakeClock;

function seedTask(name: string): { id: string } {
  const now = Date.now();
  const id = `t-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, 'do the thing', null, now, now);
  return { id };
}

function enqueueScratchRun(taskId: string, byokId: string | null): string {
  const runId = `r-${Math.random().toString(36).slice(2, 10)}`;
  const scratchPath = path.join(dir, 'scratch', runId);
  const spec = {
    runId,
    taskId,
    taskName: taskId,
    taskSlug: taskId,
    prompt: 'do the thing',
    engine: 'cli',
    model: null,
    byokId,
    permissionMode: 'acceptEdits',
    budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 60 },
    repoPath: null,
    baseBranch: null,
    worktreePath: scratchPath,
    branch: `clockwork/${taskId}/x`,
    scratchPath,
    profile: null,
    contextFiles: [],
    occurrenceAt: Date.now(),
    scheduledFor: Date.now(),
    createdAt: Date.now(),
  };
  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, task_id, occurrence_at, jobspec_json, state, state_changed_at, scheduled_for) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(runId, taskId, now, JSON.stringify(spec), now, now);
  return runId;
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor timeout'));
      }
    }, 20);
  });
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-credchannel-'));
  mkdirSync(path.join(dir, 'scratch'), { recursive: true });
  const opened = openDatabase(path.join(dir, 'data'));
  db = opened.db;
  createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
  clock = new FakeClock(Date.now());
  rm = new RunManager({
    db,
    clock,
    dataDir: path.join(dir, 'data'),
    runnerChildModule: path.resolve(import.meta.dirname, '../src/runner-child.ts'),
    childCommandPrefix: [path.resolve(import.meta.dirname, '../node_modules/.bin/tsx')],
    // Every run in this suite is spawned via the mocked spawn() and never
    // reaches a terminal state (no 'outcome' message is ever sent), so each
    // `it()`'s run stays 'running' in the DB forever. A low maxParallel would
    // starve later tests on the mutex-free slot count; this suite only ever
    // has a handful of runs total, so a generous cap avoids that entirely.
    maxParallel: 10,
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(path.join(dir, 'journal.jsonl')),
  });
});

afterEach(() => {
  captured.calls.length = 0;
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('BYOK credential delivery: stdin, never env (ADR-035)', () => {
  it('a BYOK run gets no CW_BYOK_KEY/CW_BYOK_BASE_URL in its spawned env, and the credential arrives as a stdin line', async () => {
    process.env.CW_TEST_BYOK_SECRET = 'sk-test-shhh-do-not-log';
    const store = new ByokStore({ db: db as unknown as { prepare: (s: string) => any; transaction?: (fn: () => void) => unknown } });
    const cfg = store.create({
      kind: 'openai',
      auth: 'env',
      envVar: 'CW_TEST_BYOK_SECRET',
      defaultModel: 'gpt-5-mini',
    });

    const task = seedTask('byok-task');
    enqueueScratchRun(task.id, cfg.id);

    rm.pump();
    await waitFor(() => captured.calls.length > 0);
    const { env, child } = captured.calls[0]!;

    expect(Object.keys(env)).not.toContain('CW_BYOK_KEY');
    expect(Object.keys(env)).not.toContain('CW_BYOK_BASE_URL');

    const credentialLines = child.stdin.writes
      .map((w) => { try { return JSON.parse(w); } catch { return null; } })
      .filter((m): m is { t: string; byokKey?: string; byokBaseUrl?: string } => !!m && m.t === 'credential');
    expect(credentialLines.length).toBe(1);
    expect(credentialLines[0]!.byokKey).toBe('sk-test-shhh-do-not-log');
    expect(credentialLines[0]!.byokBaseUrl).toBe('https://api.openai.com/v1');

    delete process.env.CW_TEST_BYOK_SECRET;
  });

  it('a non-BYOK run never gets a credential message on its stdin', async () => {
    const task = seedTask('plain-task');
    enqueueScratchRun(task.id, null);

    rm.pump();
    await waitFor(() => captured.calls.length > 0);
    const { env, child } = captured.calls[0]!;

    expect(Object.keys(env)).not.toContain('CW_BYOK_KEY');
    expect(Object.keys(env)).not.toContain('CW_BYOK_BASE_URL');
    const credentialLines = child.stdin.writes
      .map((w) => { try { return JSON.parse(w); } catch { return null; } })
      .filter((m): m is { t: string } => !!m && m.t === 'credential');
    expect(credentialLines.length).toBe(0);
  });

  it('a BYOK run whose credential cannot be resolved (env var unset) still gets an explicit empty credential message, not silence', async () => {
    // No process.env var set for this config's env_var — resolution fails.
    const store = new ByokStore({ db: db as unknown as { prepare: (s: string) => any; transaction?: (fn: () => void) => unknown } });
    const cfg = store.create({
      kind: 'openai',
      auth: 'env',
      envVar: 'CW_TEST_BYOK_SECRET_MISSING',
      defaultModel: 'gpt-5-mini',
    });

    const task = seedTask('byok-missing-cred-task');
    enqueueScratchRun(task.id, cfg.id);

    rm.pump();
    await waitFor(() => captured.calls.length > 0);
    const { env, child } = captured.calls[0]!;

    expect(Object.keys(env)).not.toContain('CW_BYOK_KEY');
    expect(Object.keys(env)).not.toContain('CW_BYOK_BASE_URL');
    const credentialLines = child.stdin.writes
      .map((w) => { try { return JSON.parse(w); } catch { return null; } })
      .filter((m): m is { t: string; byokKey?: string } => !!m && m.t === 'credential');
    expect(credentialLines.length).toBe(1);
    expect(credentialLines[0]!.byokKey).toBe('');
  });
});
