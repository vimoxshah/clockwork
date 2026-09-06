/**
 * Reachable approvals — outbound half (FR-18 sibling): a permission request
 * must reach every configured delivery channel (OS, Telegram, webhook), not
 * just sit in the `approvals` table waiting for someone to open the app.
 *
 * This drives the REAL RunManager.handleChildMessage('permission', ...) path
 * — real DB, real approvals row, real SSE broadcast — and stubs only the two
 * actual transports: node:child_process.spawn (so we can feed a fake child's
 * stdout) and global fetch (Telegram/webhook HTTP). OS notification is
 * observed via the injected `notify` dep, exactly as main.ts wires it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { FakeClock } from '../src/clock.js';
import { SafetyJournal } from '@clockwork/runner';

// ---- fake node:child_process.spawn (mirrors credential-channel.test.ts) ----
const captured = vi.hoisted(() => ({
  calls: [] as Array<{ env: Record<string, string>; child: FakeChild }>,
}));
interface FakeChild {
  pid: number;
  stdin: { writable: boolean; writes: string[]; write: (d: string) => boolean };
  stdout: import('node:stream').PassThrough;
  stderr: import('node:stream').PassThrough;
  on: (...a: unknown[]) => unknown;
}
let nextPid = 616161;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return {
    ...actual,
    spawn: (_bin: string, _args: string[], opts: { env?: Record<string, string> }) => {
      const emitter = new EventEmitter();
      const writes: string[] = [];
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(emitter, {
        pid: nextPid++,
        stdin: { writable: true, writes, write: (d: string) => { writes.push(d); return true; } },
        stdout,
        stderr,
      }) as unknown as FakeChild;
      captured.calls.push({ env: opts.env ?? {}, child });
      return child;
    },
  };
});

let db: DB;
let dir: string;
let dataDir: string;
let rm: RunManager;
let clock: FakeClock;
let notifyMock: ReturnType<typeof vi.fn>;
let broadcastMock: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function seedTask(name: string, deliveryJson: string): { id: string } {
  const now = Date.now();
  const id = `t-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, repo_path, delivery_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, 'do the thing', null, deliveryJson, now, now);
  return { id };
}

function enqueueScratchRun(taskId: string, taskName: string): string {
  const runId = `r-${Math.random().toString(36).slice(2, 10)}`;
  const scratchPath = path.join(dir, 'scratch', runId);
  const spec = {
    runId,
    taskId,
    taskName,
    taskSlug: taskId,
    prompt: 'do the thing',
    engine: 'cli',
    model: null,
    byokId: null,
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

function sendPermission(child: FakeChild, reqId: string, tool: string, input: unknown): void {
  child.stdout.write(JSON.stringify({ t: 'permission', reqId, tool, input }) + '\n');
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-approval-notify-'));
  mkdirSync(path.join(dir, 'scratch'), { recursive: true });
  dataDir = path.join(dir, 'data');
  const opened = openDatabase(dataDir);
  db = opened.db;
  createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
  clock = new FakeClock(Date.now());
  notifyMock = vi.fn();
  broadcastMock = vi.fn();
  rm = new RunManager({
    db,
    clock,
    dataDir,
    runnerChildModule: path.resolve(import.meta.dirname, '../src/runner-child.ts'),
    childCommandPrefix: [path.resolve(import.meta.dirname, '../node_modules/.bin/tsx')],
    // Every run here is spawned via the mocked spawn() and never reaches a
    // terminal state, so it stays 'running' forever — generous cap avoids
    // starving later tests on the mutex-free slot count.
    maxParallel: 10,
    notify: notifyMock,
    broadcast: broadcastMock,
    safetyJournal: new SafetyJournal(path.join(dir, 'journal.jsonl')),
  });
});

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  captured.calls.length = 0;
  notifyMock.mockClear();
  broadcastMock.mockClear();
  vi.unstubAllGlobals();
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const DELIVERY_JSON = JSON.stringify({
  osNotify: true,
  telegram: { chatId: 'chat-777' },
  webhook: { url: 'https://example.test/hook' },
});

describe('reachable approvals: outbound notification on permission request', () => {
  it('sends exactly one notification per channel, with task/engine/tool/truncated+masked command/approval id/deadline', async () => {
    writeFileSync(
      path.join(dataDir, 'delivery-creds.json'),
      JSON.stringify({ telegramBotToken: 'bot-tok', webhookSecret: 'whsec' }),
    );

    const task = seedTask('deploy-prod', DELIVERY_JSON);
    const runId = enqueueScratchRun(task.id, 'deploy-prod');

    rm.pump();
    await waitFor(() => captured.calls.length > 0);
    const { child } = captured.calls[0]!;

    const secret = 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const longCommand = `rm -rf /tmp/x && token=${secret} && ` + 'y'.repeat(300);
    sendPermission(child, 'req-1', 'Bash', { command: longCommand });

    await waitFor(() => notifyMock.mock.calls.length > 0);
    await waitFor(() => fetchMock.mock.calls.length >= 2);

    // ---- OS channel (deps.notify) ----
    expect(notifyMock.mock.calls.length).toBe(1);
    const [kind, title, body] = notifyMock.mock.calls[0]!;
    expect(kind).toBe('approval_requested');
    expect(title).toContain('deploy-prod');
    expect(body).toContain('deploy-prod');
    expect(body).toContain('cli'); // engine
    expect(body).toContain('Bash');
    expect(body).toContain('Answer in Clockwork');
    expect(body).not.toContain(secret);
    expect(body).not.toContain('y'.repeat(300)); // truncated well before the filler tail

    // ---- Telegram channel ----
    const telegramCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('api.telegram.org'));
    expect(telegramCall).toBeTruthy();
    const tgBody = JSON.parse(String((telegramCall![1] as RequestInit).body));
    expect(tgBody.chat_id).toBe('chat-777');
    expect(tgBody.text).not.toContain(secret);
    expect(tgBody.text).toContain('token=[MASKED]');
    expect(tgBody.text).toContain('Bash');

    // ---- Webhook channel ----
    const webhookCall = fetchMock.mock.calls.find((c) => String(c[0]) === 'https://example.test/hook');
    expect(webhookCall).toBeTruthy();
    const whBody = JSON.parse(String((webhookCall![1] as RequestInit).body));
    expect(whBody.schema).toBe('clockwork.approval-request.v1');
    expect(whBody.runId).toBe(runId);
    expect(whBody.taskName).toBe('deploy-prod');
    expect(whBody.engine).toBe('cli');
    expect(whBody.tool).toBe('Bash');
    expect(typeof whBody.approvalId).toBe('string');
    expect(typeof whBody.timeoutAt).toBe('number');
    expect(whBody.commandSummary.length).toBeLessThanOrEqual(200);
    expect(whBody.commandSummary).not.toContain(secret);
    expect(whBody.commandSummary).toContain('token=[MASKED]');
    // never the full jobspec/secrets
    expect(JSON.stringify(whBody)).not.toContain('worktreePath');
    expect((webhookCall![1] as RequestInit & { headers: Record<string, string> }).headers['x-clockwork-signature']).toBeTruthy();
  });

  it('a failing transport never affects the approval row, the SSE broadcast, or the decision path', async () => {
    writeFileSync(
      path.join(dataDir, 'delivery-creds.json'),
      JSON.stringify({ telegramBotToken: 'bot-tok', webhookSecret: 'whsec' }),
    );
    fetchMock.mockImplementation(async () => {
      throw new Error('network is down');
    });

    const task = seedTask('flaky-notify-task', DELIVERY_JSON);
    const runId = enqueueScratchRun(task.id, 'flaky-notify-task');

    rm.pump();
    await waitFor(() => captured.calls.length > 0);
    const { child } = captured.calls[0]!;

    sendPermission(child, 'req-fail', 'Bash', { command: 'echo hi' });

    // Approval row + SSE broadcast happen synchronously in handleChildMessage,
    // independent of (and before) the fire-and-forget notification promise.
    await waitFor(() => {
      const row = db.prepare(`SELECT id FROM approvals WHERE run_id=?`).get(runId) as { id: string } | undefined;
      return !!row;
    }, 2_000);
    const approvalRow = db.prepare(`SELECT id FROM approvals WHERE run_id=?`).get(runId) as { id: string };
    expect(approvalRow).toBeTruthy();
    expect(broadcastMock.mock.calls.some((c) => (c[0] as { type: string }).type === 'approval.requested')).toBe(true);

    // Decision path still works while the notification is failing/retrying in the background.
    const ok = rm.respondToChild(runId, 'req-fail', true);
    expect(ok).toBe(true);
    const decisionLine = child.stdin.writes.find((w) => {
      try {
        return JSON.parse(w).t === 'decision';
      } catch {
        return false;
      }
    });
    expect(decisionLine).toBeTruthy();
    expect(JSON.parse(decisionLine!)).toMatchObject({ t: 'decision', reqId: 'req-fail', behavior: 'allow' });

    // The transport was attempted (at least once per channel) but never threw out of the run.
    await waitFor(() => fetchMock.mock.calls.length >= 1, 2_000);
  });

  it('does not send a duplicate notification for a second identical child message (same reqId)', async () => {
    writeFileSync(
      path.join(dataDir, 'delivery-creds.json'),
      JSON.stringify({ telegramBotToken: 'bot-tok', webhookSecret: 'whsec' }),
    );

    const task = seedTask('dupe-notify-task', DELIVERY_JSON);
    const runId = enqueueScratchRun(task.id, 'dupe-notify-task');

    rm.pump();
    await waitFor(() => captured.calls.length > 0);
    const { child } = captured.calls[0]!;

    sendPermission(child, 'req-dup', 'Bash', { command: 'echo one' });
    sendPermission(child, 'req-dup', 'Bash', { command: 'echo one' });

    await waitFor(() => notifyMock.mock.calls.length > 0);
    await waitFor(() => fetchMock.mock.calls.length >= 2);

    // Give any accidental second dispatch a moment to show up before asserting the ceiling.
    await new Promise((r) => setTimeout(r, 150));

    expect(notifyMock.mock.calls.length).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(2); // one telegram + one webhook, not four

    // Both approvals rows still exist (inbound/DB behavior is unchanged — only the
    // outbound notification is deduped), but only one carried a live notification.
    const rows = db.prepare(`SELECT id FROM approvals WHERE run_id=?`).all(runId) as Array<{ id: string }>;
    expect(rows.length).toBe(2);
  });
});
