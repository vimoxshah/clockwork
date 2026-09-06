/**
 * Reachable approvals — inbound half (ADR-036): an inline-keyboard tap in
 * Telegram must resolve the SAME approval row, through the SAME
 * RunManager.respondToApproval the local API route uses — CAS, forwarding to
 * a live child, offset persistence across restarts, and the trust boundary
 * (chat id match, plus an allow-list in group chats).
 *
 * The Telegram Bot API is a real local HTTP stub (node:http), not a mocked
 * fetch — TelegramApprovalsPoller talks to it over the real `fetch` global,
 * exactly as it would talk to api.telegram.org in production (apiBase is the
 * only thing overridden for tests).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@clockwork/shared';
import { SafetyJournal } from '@clockwork/runner';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { FakeClock } from '../src/clock.js';
import { TelegramApprovalsPoller } from '../src/telegram-approvals.js';

// ---------- a REAL local HTTP stub standing in for api.telegram.org ----------
interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

class TelegramStub {
  server: http.Server;
  port = 0;
  requests: RecordedRequest[] = [];
  private pendingUpdates: Array<{ update_id: number; callback_query?: unknown }> = [];
  private conflict = false;
  private readonly holdMs: number;
  private readonly holdTimers = new Set<NodeJS.Timeout>();
  private waitingRes: http.ServerResponse | null = null;

  constructor(opts: { holdMs?: number } = {}) {
    this.holdMs = opts.holdMs ?? 150;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (this.waitingRes) {
      try {
        this.waitingRes.end(JSON.stringify({ ok: true, result: [] }));
      } catch {
        /* already closed */
      }
      this.waitingRes = null;
    }
    for (const t of this.holdTimers) clearTimeout(t);
    this.holdTimers.clear();
    (this.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  setConflict(v: boolean): void {
    this.conflict = v;
  }

  /** Queues an update for the next getUpdates call (or answers one already waiting). */
  pushUpdate(u: { update_id: number; callback_query?: unknown }): void {
    if (this.waitingRes) {
      const res = this.waitingRes;
      this.waitingRes = null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: [u] }));
      return;
    }
    this.pendingUpdates.push(u);
  }

  getUpdatesCalls(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.endsWith('/getUpdates'));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://stub');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* not json */
      }
      this.requests.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, body });

      if (url.pathname.endsWith('/getUpdates')) {
        if (this.conflict) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }));
          return;
        }
        const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
        const ready = this.pendingUpdates.filter((u) => u.update_id >= offset);
        if (ready.length > 0) {
          this.pendingUpdates = [];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: ready }));
          return;
        }
        // Long-poll: hold briefly (far shorter than the real `timeout=30`
        // param, which the stub deliberately ignores) then answer empty.
        this.waitingRes = res;
        const t = setTimeout(() => {
          this.holdTimers.delete(t);
          if (this.waitingRes === res) {
            this.waitingRes = null;
            try {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true, result: [] }));
            } catch {
              /* client gone */
            }
          }
        }, this.holdMs);
        this.holdTimers.add(t);
        return;
      }

      // answerCallbackQuery / editMessageReplyMarkup / sendMessage — generic ok.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  }
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
    }, 15);
  });
}

// ---------- shared daemon fixtures (real DB, real RunManager) ----------
let dir: string;
let dataDir: string;
let db: DB;
let clock: FakeClock;
let rm: RunManager;
let broadcastMock: ReturnType<typeof vi.fn>;

function seedTask(deliveryJson: string): string {
  const id = `t-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, repo_path, delivery_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'notify-task', 'do the thing', null, deliveryJson, now, now);
  return id;
}

function seedRun(taskId: string): string {
  const id = `r-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for) VALUES (?, ?, '{}', 'running', ?, ?)`,
  ).run(id, taskId, now, now);
  return id;
}

function seedApproval(runId: string, reqId: string | null): string {
  const id = newId(); // 26-char ULID — matches both sendApproval's callback_data and the poller's regex
  const now = Date.now();
  db.prepare(
    `INSERT INTO approvals (id, run_id, kind, payload_json, requested_at, timeout_at, fallback) VALUES (?, ?, 'permission', ?, ?, ?, 'deny-and-continue')`,
  ).run(id, runId, JSON.stringify({ tool: 'Bash', reqId }), now, now + 60_000);
  return id;
}

function readApproval(id: string): { responded_at: number | null; response_json: string | null } {
  return db.prepare('SELECT responded_at, response_json FROM approvals WHERE id=?').get(id) as any;
}

function readOffset(): number | undefined {
  const row = db.prepare('SELECT "offset" FROM telegram_poll_state WHERE id=1').get() as { offset: number } | undefined;
  return row?.offset;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-telegram-approvals-'));
  dataDir = path.join(dir, 'data');
  const opened = openDatabase(dataDir);
  db = opened.db;
  createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
  clock = new FakeClock(Date.now());
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // telegram_poll_state is a single-row table shared by every test in this
  // file (same `db`, opened once in beforeAll) — reset it so each test's own
  // update_id numbering starts from a known offset (0), independent of how
  // far a previous test advanced it.
  db.exec('DELETE FROM telegram_poll_state');
  broadcastMock = vi.fn();
  rm = new RunManager({
    db,
    clock,
    dataDir,
    runnerChildModule: path.resolve(import.meta.dirname, '../src/runner-child.js'),
    maxParallel: 10,
    notify: vi.fn(),
    broadcast: broadcastMock,
    safetyJournal: new SafetyJournal(path.join(dir, 'journal.jsonl')),
  });
});

describe('Telegram inbound approvals: inline-keyboard callback resolves via respondToApproval', () => {
  it('(a) a callback from the configured chat resolves the approval, forwards to the live child, answers Approved, strips the keyboard, and persists the advanced offset', async () => {
    const stub = new TelegramStub();
    await stub.listen();
    const logs: string[] = [];
    const poller = new TelegramApprovalsPoller({ db, runManager: rm, botToken: 'test-token', apiBase: stub.baseUrl, log: (m) => logs.push(m) });

    const respondToChildSpy = vi.spyOn(rm, 'respondToChild').mockReturnValue(true);

    try {
      const taskId = seedTask(JSON.stringify({ telegram: { chatId: '777' } }));
      const runId = seedRun(taskId);
      const approvalId = seedApproval(runId, 'req-1');

      stub.pushUpdate({
        update_id: 1,
        callback_query: {
          id: 'cbq-1',
          data: `a:${approvalId}`,
          from: { id: 555 },
          message: { message_id: 42, chat: { id: 777, type: 'private' } },
        },
      });

      poller.start();
      await waitFor(() => stub.requests.some((r) => r.path.endsWith('/answerCallbackQuery')));

      const answer = stub.requests.find((r) => r.path.endsWith('/answerCallbackQuery'));
      expect(answer?.body).toMatchObject({ callback_query_id: 'cbq-1', text: 'Approved' });

      await waitFor(() => stub.requests.some((r) => r.path.endsWith('/editMessageReplyMarkup')));
      const edit = stub.requests.find((r) => r.path.endsWith('/editMessageReplyMarkup'));
      expect(edit?.body).toMatchObject({ chat_id: 777, message_id: 42, reply_markup: { inline_keyboard: [] } });

      const row = readApproval(approvalId);
      expect(row.responded_at).not.toBeNull();
      expect(JSON.parse(row.response_json!)).toMatchObject({
        decision: 'approved',
        source: { kind: 'telegram', userId: '555', chatId: '777' },
      });

      expect(respondToChildSpy).toHaveBeenCalledWith(runId, 'req-1', true);

      await waitFor(() => readOffset() === 2);
    } finally {
      await poller.stop();
      await stub.close();
    }
  });

  it('(b) a callback from a different chat id is refused: the approval is untouched and the bot is told "Not allowed"', async () => {
    const stub = new TelegramStub();
    await stub.listen();
    const poller = new TelegramApprovalsPoller({ db, runManager: rm, botToken: 'test-token', apiBase: stub.baseUrl, log: () => {} });
    const respondToChildSpy = vi.spyOn(rm, 'respondToChild').mockReturnValue(true);

    try {
      const taskId = seedTask(JSON.stringify({ telegram: { chatId: '777' } }));
      const runId = seedRun(taskId);
      const approvalId = seedApproval(runId, 'req-2');

      stub.pushUpdate({
        update_id: 1,
        callback_query: {
          id: 'cbq-2',
          data: `a:${approvalId}`,
          from: { id: 999 },
          message: { message_id: 7, chat: { id: 4242, type: 'private' } }, // wrong chat
        },
      });

      poller.start();
      await waitFor(() => stub.requests.some((r) => r.path.endsWith('/answerCallbackQuery')));

      const answer = stub.requests.find((r) => r.path.endsWith('/answerCallbackQuery'));
      expect(answer?.body).toMatchObject({ callback_query_id: 'cbq-2', text: 'Not allowed' });

      expect(readApproval(approvalId).responded_at).toBeNull();
      expect(stub.requests.some((r) => r.path.endsWith('/editMessageReplyMarkup'))).toBe(false);
      expect(respondToChildSpy).not.toHaveBeenCalled();
    } finally {
      await poller.stop();
      await stub.close();
    }
  });

  it('(b2) in a group chat, a user not on telegram.allowedUserIds is refused even from the right chat', async () => {
    const stub = new TelegramStub();
    await stub.listen();
    const poller = new TelegramApprovalsPoller({ db, runManager: rm, botToken: 'test-token', apiBase: stub.baseUrl, log: () => {} });

    try {
      const taskId = seedTask(JSON.stringify({ telegram: { chatId: '777', allowedUserIds: [111, 222] } }));
      const runId = seedRun(taskId);
      const approvalId = seedApproval(runId, 'req-2b');

      stub.pushUpdate({
        update_id: 1,
        callback_query: {
          id: 'cbq-2b',
          data: `a:${approvalId}`,
          from: { id: 999 }, // right chat, wrong user
          message: { message_id: 7, chat: { id: 777, type: 'group' } },
        },
      });

      poller.start();
      await waitFor(() => stub.requests.some((r) => r.path.endsWith('/answerCallbackQuery')));
      const answer = stub.requests.find((r) => r.path.endsWith('/answerCallbackQuery'));
      expect(answer?.body).toMatchObject({ text: 'Not allowed' });
      expect(readApproval(approvalId).responded_at).toBeNull();
    } finally {
      await poller.stop();
      await stub.close();
    }
  });

  it('(c) a second callback for an already-resolved approval answers "Already resolved" and does not touch the row', async () => {
    const stub = new TelegramStub();
    await stub.listen();
    const poller = new TelegramApprovalsPoller({ db, runManager: rm, botToken: 'test-token', apiBase: stub.baseUrl, log: () => {} });

    try {
      const taskId = seedTask(JSON.stringify({ telegram: { chatId: '777' } }));
      const runId = seedRun(taskId);
      const approvalId = seedApproval(runId, null);

      // Resolved once already, via the API path (mirrors the API route calling the same function).
      const first = rm.respondToApproval(approvalId, 'denied', { kind: 'api' });
      expect(first.status).toBe('resolved');
      const before = readApproval(approvalId);
      expect(before.responded_at).not.toBeNull();

      stub.pushUpdate({
        update_id: 1,
        callback_query: {
          id: 'cbq-3',
          data: `a:${approvalId}`,
          from: { id: 555 },
          message: { message_id: 9, chat: { id: 777, type: 'private' } },
        },
      });

      poller.start();
      await waitFor(() => stub.requests.some((r) => r.path.endsWith('/answerCallbackQuery')));
      const answer = stub.requests.find((r) => r.path.endsWith('/answerCallbackQuery'));
      expect(answer?.body).toMatchObject({ callback_query_id: 'cbq-3', text: 'Already resolved' });

      const after = readApproval(approvalId);
      expect(after.responded_at).toBe(before.responded_at);
      expect(after.response_json).toBe(before.response_json);
    } finally {
      await poller.stop();
      await stub.close();
    }
  });

  it('(d) a 409 from getUpdates stops the loop and logs once; polling never resumes for this process', async () => {
    const stub = new TelegramStub();
    await stub.listen();
    stub.setConflict(true);
    const logs: string[] = [];
    const poller = new TelegramApprovalsPoller({ db, runManager: rm, botToken: 'test-token', apiBase: stub.baseUrl, log: (m) => logs.push(m) });

    try {
      poller.start();
      await waitFor(() => stub.getUpdatesCalls().length >= 1);
      await waitFor(() => logs.some((l) => l.includes('409')));

      const countAfterConflict = stub.getUpdatesCalls().length;
      await new Promise((r) => setTimeout(r, 300));
      expect(stub.getUpdatesCalls().length).toBe(countAfterConflict); // no retries
      expect(logs.filter((l) => l.includes('409')).length).toBe(1); // logged loudly, exactly once
    } finally {
      await poller.stop();
      await stub.close();
    }
  });

  it('(e) restart with a persisted offset does not re-request updates below it', async () => {
    const stub = new TelegramStub();
    await stub.listen();

    const taskId = seedTask(JSON.stringify({ telegram: { chatId: '777' } }));
    const runId = seedRun(taskId);
    const approvalId = seedApproval(runId, 'req-e');
    vi.spyOn(rm, 'respondToChild').mockReturnValue(true);

    const poller1 = new TelegramApprovalsPoller({ db, runManager: rm, botToken: 'test-token', apiBase: stub.baseUrl, log: () => {} });
    try {
      stub.pushUpdate({
        update_id: 41,
        callback_query: {
          id: 'cbq-e',
          data: `a:${approvalId}`,
          from: { id: 555 },
          message: { message_id: 1, chat: { id: 777, type: 'private' } },
        },
      });
      poller1.start();
      await waitFor(() => readOffset() === 42);
    } finally {
      await poller1.stop();
    }

    const persisted = readOffset();
    expect(persisted).toBe(42);
    const countBeforeRestart = stub.getUpdatesCalls().length;

    const poller2 = new TelegramApprovalsPoller({ db, runManager: rm, botToken: 'test-token', apiBase: stub.baseUrl, log: () => {} });
    try {
      poller2.start();
      await waitFor(() => stub.getUpdatesCalls().length > countBeforeRestart);
      const firstCallAfterRestart = stub.getUpdatesCalls()[countBeforeRestart]!; // poller2's very first request, not any leftover from poller1
      expect(firstCallAfterRestart.query.get('offset')).toBe(String(persisted));
    } finally {
      await poller2.stop();
      await stub.close();
    }
  });
});
