/**
 * Reachable approvals — outbound half (FR-18 sibling): a permission request
 * must reach EVERY configured delivery channel — OS, Telegram, webhook, Slack
 * and email — not just sit in the `approvals` table waiting for someone to
 * open the app.
 *
 * "Every" is the whole point of the suite. Slack and email shipped carrying
 * run reports while `notifyApprovalRequest` kept a private telegram/webhook
 * copy of the fan-out, so a task could be wired for Slack, watch its reports
 * arrive, and never learn a run was waiting on it. The channel list here and
 * the one `deliverReport` uses are now the same list (`deliverApproval` in
 * delivery-dispatch.ts), and these tests are what holds them together.
 *
 * This drives the REAL RunManager.handleChildMessage('permission', ...) path
 * — real DB, real approvals row, real SSE broadcast — and stubs only the two
 * actual transports: node:child_process.spawn (so we can feed a fake child's
 * stdout) and global fetch (Telegram/webhook/Slack HTTP). Email is not stubbed
 * at all: it speaks real SMTP to a real loopback socket, because the point of
 * these two tests is that the bytes leave the daemon. OS notification is
 * observed via the injected `notify` dep, exactly as main.ts wires it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
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
let smtp: FakeSmtp | null = null;

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

// ---- a real, minimal loopback SMTP relay ----
//
// Just enough of the submission dialogue for one message. STARTTLS is NOT
// advertised and the URL carries no credentials, so the client neither
// upgrades nor authenticates — the protocol itself (split replies, STARTTLS,
// AUTH PLAIN/LOGIN) is smtp-delivery.test.ts's job. Here the only question is
// whether an approval request reaches the email channel at all, so the assert
// is on the message the relay accepted.
interface FakeSmtp {
  port: number;
  /** every command line the client sent, in order */
  log: string[];
  /** each accepted DATA payload, un-terminated */
  mail: string[];
  close: () => Promise<void>;
}

function startFakeSmtp(): Promise<FakeSmtp> {
  const log: string[] = [];
  const mail: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    let buf = '';
    let inData = false;
    let dataBuf = '';
    const write = (s: string): void => void sock.write(s + '\r\n');
    write('220 fake.test ESMTP ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mail.push(dataBuf);
            dataBuf = '';
            write('250 2.0.0 Ok: queued as FAKE1');
          } else {
            dataBuf += line + '\r\n';
          }
          continue;
        }
        log.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          write('250-fake.test at your service');
          write('250 SIZE 10240000');
        } else if (upper.startsWith('DATA')) {
          inData = true;
          write('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper.startsWith('QUIT')) {
          write('221 2.0.0 Bye');
          sock.end();
        } else {
          write('250 2.0.0 Ok');
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        log,
        mail,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Headers (unfolded, lowercased keys) + the decoded text body. */
function parseMail(raw: string): { headers: Record<string, string>; body: string } {
  const split = raw.indexOf('\r\n\r\n');
  const unfolded: string[] = [];
  for (const l of raw.slice(0, split).split('\r\n')) {
    if (/^[ \t]/.test(l) && unfolded.length > 0) unfolded[unfolded.length - 1] += l.trimStart();
    else unfolded.push(l);
  }
  const headers: Record<string, string> = {};
  for (const l of unfolded) {
    const c = l.indexOf(':');
    if (c > 0) headers[l.slice(0, c).toLowerCase()] = l.slice(c + 1).trim();
  }
  return {
    headers,
    body: Buffer.from(raw.slice(split + 4).replace(/\r\n/g, ''), 'base64').toString('utf8'),
  };
}

/** RFC 2047 B-encoded words back to text (the subject is always B-encoded). */
function decodeHeader(v: string): string {
  return v.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
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

afterEach(async () => {
  captured.calls.length = 0;
  notifyMock.mockClear();
  broadcastMock.mockClear();
  vi.unstubAllGlobals();
  if (smtp) {
    await smtp.close();
    smtp = null;
  }
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

// ---------------------------------------------------------------------------
// The two channels the private fan-out left out
// ---------------------------------------------------------------------------

const SLACK_HOOK = 'https://hooks.slack.com/services/T0000/B0000/approvalfanout';

/** The one approvals row a run has, so the assert can name the real id. */
function approvalIdOf(runId: string): string {
  const row = db.prepare(`SELECT id FROM approvals WHERE run_id=?`).get(runId) as { id: string } | undefined;
  expect(row, 'no approvals row was written for the run').toBeTruthy();
  return row!.id;
}

/** The one note event a run has for a given key, or null while it has none. */
function noteFor(runId: string, key: string): Record<string, unknown> | null {
  const rows = db.prepare(`SELECT data_json FROM events WHERE run_id=? AND kind='note'`).all(runId) as Array<{
    data_json: string;
  }>;
  for (const r of rows) {
    const data = JSON.parse(r.data_json) as Record<string, unknown>;
    if (key in data) return data;
  }
  return null;
}

describe('reachable approvals reach Slack and email, not only Telegram and the webhook', () => {
  it('a Slack-configured task receives the approval request itself, not just its run report', async () => {
    writeFileSync(path.join(dataDir, 'delivery-creds.json'), JSON.stringify({ slackWebhookUrl: SLACK_HOOK }));

    const task = seedTask('slack-approval-task', JSON.stringify({ osNotify: true, slack: { enabled: true } }));
    const runId = enqueueScratchRun(task.id, 'slack-approval-task');

    rm.pump();
    await waitFor(() => captured.calls.length > 0);
    const { child } = captured.calls[0]!;

    sendPermission(child, 'req-slack', 'Bash', { command: 'kubectl apply -f prod.yaml' });

    // 20s, not the 5s default: S-43 retries each transport three times with
    // a 1s+2s backoff, so a single transient miss under a loaded full-suite
    // run needs more than 5s to produce the call this asserts on.
    await waitFor(() => fetchMock.mock.calls.some((c) => String(c[0]) === SLACK_HOOK), 20_000);
    const call = fetchMock.mock.calls.find((c) => String(c[0]) === SLACK_HOOK)!;
    const body = JSON.parse(String((call[1] as RequestInit).body));

    // Block Kit, the approval layout — not the run-report layout.
    expect(body.blocks[0].text.text).toContain('Approval needed');
    expect(body.blocks[0].text.text).toContain('slack-approval-task');
    const rendered = JSON.stringify(body);
    expect(rendered).toContain('Bash');
    expect(rendered).toContain('kubectl apply -f prod.yaml');
    expect(rendered).toContain(approvalIdOf(runId));
    expect(rendered).toContain(runId);
    // never the whole jobspec
    expect(rendered).not.toContain('worktreePath');

    // The OS path is untouched: one notification, same kind as before.
    expect(notifyMock.mock.calls.length).toBe(1);
    expect(notifyMock.mock.calls[0]![0]).toBe('approval_requested');
  });

  it('an email-configured task receives the approval request over real SMTP', async () => {
    smtp = await startFakeSmtp();
    writeFileSync(
      path.join(dataDir, 'delivery-creds.json'),
      JSON.stringify({ smtpUrl: `smtp://127.0.0.1:${smtp.port}`, smtpFrom: 'clockwork@example.test' }),
    );

    const task = seedTask(
      'email-approval-task',
      JSON.stringify({ osNotify: true, email: { to: ['dana@example.test'] } }),
    );
    const runId = enqueueScratchRun(task.id, 'email-approval-task');

    rm.pump();
    await waitFor(() => captured.calls.length > 0);
    const { child } = captured.calls[0]!;

    const secret = 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    sendPermission(child, 'req-email', 'Bash', { command: `deploy --token=${secret}` });

    // QUIT, not just an accepted DATA: the send is finished, so tearing the
    // relay down in afterEach cannot race the client's last read.
    const srv = smtp;
    await waitFor(() => srv.mail.length === 1 && srv.log.includes('QUIT'), 20_000);

    expect(srv.log.some((l) => l === 'RCPT TO:<dana@example.test>')).toBe(true);
    const { headers, body } = parseMail(srv.mail[0]!);
    expect(headers['x-clockwork-schema']).toBe('clockwork.approval-request.v1');
    expect(headers['to']).toBe('dana@example.test');
    expect(decodeHeader(headers['subject']!)).toBe('[Clockwork] Approval needed: email-approval-task');
    expect(body).toContain('email-approval-task');
    expect(body).toContain('Bash');
    expect(body).toContain(approvalIdOf(runId));
    // masked before the payload is built, so no channel can leak it
    expect(srv.mail[0]!).not.toContain(secret);
    expect(body).toContain('token=[MASKED]');

    expect(notifyMock.mock.calls.length).toBe(1);
  });

  it('a Slack send that fails becomes a receipt on the run, and the run keeps going', async () => {
    // Slack opted in, but no webhook URL is configured: the adapter refuses
    // before any HTTP, which is the cheapest way to a genuine channel failure.
    writeFileSync(path.join(dataDir, 'delivery-creds.json'), JSON.stringify({ telegramBotToken: 'bot-tok' }));

    const task = seedTask('slack-receipt-task', JSON.stringify({ osNotify: true, slack: { enabled: true } }));
    const runId = enqueueScratchRun(task.id, 'slack-receipt-task');

    rm.pump();
    await waitFor(() => captured.calls.length > 0);
    const { child } = captured.calls[0]!;

    sendPermission(child, 'req-slack-fail', 'Bash', { command: 'echo hi' });

    // S-43: retried x3, then recorded as a receipt against the run.
    await waitFor(() => noteFor(runId, 'approvalNotifyFailed') !== null, 20_000);
    const failed = noteFor(runId, 'approvalNotifyFailed')!.approvalNotifyFailed as Array<{
      channel: string;
      ok: boolean;
      error: string | null;
      attempts: number;
    }>;
    expect(failed.map((f) => f.channel)).toEqual(['slack']);
    expect(failed[0]!.ok).toBe(false);
    expect(failed[0]!.attempts).toBe(3);
    expect(failed[0]!.error).toMatch(/slack webhook url/i);

    // The run never learned about it: state untouched, decision path live.
    expect((db.prepare(`SELECT state FROM runs WHERE id=?`).get(runId) as { state: string }).state).toBe('running');
    expect(rm.respondToChild(runId, 'req-slack-fail', false)).toBe(true);
  });
});
