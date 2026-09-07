/**
 * Delivery config contract (fixes the T-211/T-310 env-var loader bug):
 * `GET/PUT /delivery-config` and `POST /delivery-config/test-telegram`,
 * plus unit coverage of `loadDeliveryCreds`/`writeDeliveryCreds`/`maskBotToken`
 * in ../src/delivery.ts (no standalone delivery.test.ts exists yet).
 *
 * The Telegram Bot API is a real local HTTP stub (node:http), matching the
 * existing convention in telegram-approvals.test.ts, so the request URL
 * (which embeds the bot token) is genuinely exercised rather than mocked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { loadDeliveryCreds, writeDeliveryCreds, maskBotToken } from '../src/delivery.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

// ---------- unit: loadDeliveryCreds / writeDeliveryCreds ----------
describe('loadDeliveryCreds (env + file bridge)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-deliv-creds-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    // Env mutations must never leak into other tests in this file — every
    // other test's `configured` assertions depend on a clean environment.
    delete process.env.CLOCKWORK_DELIVER_TELEGRAM_BOT_TOKEN;
    delete process.env.CLOCKWORK_DELIVER_WEBHOOK_SECRET;
    delete process.env.CLOCKWORK_DELIVER_WEBHOOK_URL;
    delete process.env.CLOCKWORK_DELIVER_SLACK_WEBHOOK_URL;
    delete process.env.CLOCKWORK_DELIVER_SMTP_URL;
    delete process.env.CLOCKWORK_DELIVER_SMTP_FROM;
  });

  it('loads a camelCase field from a SCREAMING_SNAKE env var (the bug: k.toLowerCase() alone produced telegram_bot_token, which never matched)', () => {
    process.env.CLOCKWORK_DELIVER_TELEGRAM_BOT_TOKEN = 'env-tok-123';
    const creds = loadDeliveryCreds(dir);
    expect(creds.telegramBotToken).toBe('env-tok-123');
  });

  it('maps WEBHOOK_URL and WEBHOOK_SECRET to webhookUrl/webhookSecret', () => {
    process.env.CLOCKWORK_DELIVER_WEBHOOK_URL = 'https://example.test/hook';
    process.env.CLOCKWORK_DELIVER_WEBHOOK_SECRET = 'env-whsec';
    const creds = loadDeliveryCreds(dir);
    expect(creds.webhookUrl).toBe('https://example.test/hook');
    expect(creds.webhookSecret).toBe('env-whsec');
  });

  // The three T-310 credentials ride the same SCREAMING_SNAKE -> camelCase
  // bridge, so an install that keeps its secrets in the environment (no file
  // on disk) reaches Slack and SMTP too.
  it('maps SLACK_WEBHOOK_URL, SMTP_URL and SMTP_FROM to their camelCase fields', () => {
    process.env.CLOCKWORK_DELIVER_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T0/B0/envsecret';
    process.env.CLOCKWORK_DELIVER_SMTP_URL = 'smtp://user:pw@relay.example.com:587';
    process.env.CLOCKWORK_DELIVER_SMTP_FROM = 'env@example.com';
    const creds = loadDeliveryCreds(dir);
    expect(creds.slackWebhookUrl).toBe('https://hooks.slack.com/services/T0/B0/envsecret');
    expect(creds.smtpUrl).toBe('smtp://user:pw@relay.example.com:587');
    expect(creds.smtpFrom).toBe('env@example.com');
  });

  it('the delivery-creds.json file still wins over env on the same key, and merges keys the env does not set', () => {
    process.env.CLOCKWORK_DELIVER_TELEGRAM_BOT_TOKEN = 'env-tok';
    writeFileSync(path.join(dir, 'delivery-creds.json'), JSON.stringify({ telegramBotToken: 'file-tok', webhookSecret: 'file-whsec' }));
    const creds = loadDeliveryCreds(dir);
    expect(creds.telegramBotToken).toBe('file-tok'); // file wins
    expect(creds.webhookSecret).toBe('file-whsec'); // file-only key still merged in
  });
});

describe('writeDeliveryCreds (read-modify-write, 0600)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-deliv-write-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes mode 0600 and round-trips a string value', () => {
    writeDeliveryCreds(dir, { telegramBotToken: 'abc123' });
    const p = path.join(dir, 'delivery-creds.json');
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(p, 'utf8')).telegramBotToken).toBe('abc123');
  });

  it('null clears a key; absent key leaves siblings untouched; unrelated keys survive', () => {
    const p = path.join(dir, 'delivery-creds.json');
    writeFileSync(p, JSON.stringify({ telegramBotToken: 'keep-me', smtpUrl: 'smtp://unrelated' })); // default mode (0644), no chmod yet
    writeDeliveryCreds(dir, { webhookSecret: 'new-secret' }); // telegramBotToken absent from patch
    // The file already existed (hand-written above), so writeFileSync's own
    // `mode` option is ignored by Node for an existing file — this is exactly
    // the case the explicit chmodSync call exists to cover.
    expect(statSync(p).mode & 0o777).toBe(0o600);
    let f = JSON.parse(readFileSync(p, 'utf8'));
    expect(f.telegramBotToken).toBe('keep-me');
    expect(f.webhookSecret).toBe('new-secret');
    expect(f.smtpUrl).toBe('smtp://unrelated');

    writeDeliveryCreds(dir, { telegramBotToken: null });
    f = JSON.parse(readFileSync(p, 'utf8'));
    expect(f.telegramBotToken).toBeUndefined();
    expect(f.webhookSecret).toBe('new-secret'); // untouched
    expect(f.smtpUrl).toBe('smtp://unrelated'); // untouched
  });
});

describe('maskBotToken', () => {
  it('matches the contract example exactly: 8-char id prefix, 3-char secret peek, 3-char tail', () => {
    const masked = maskBotToken('12345678:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxQ7');
    expect(masked).toBe('12345678:AAE…xQ7');
  });

  it('never contains the full secret half, only a bounded peek', () => {
    const token = '12345678:AAEexampleTokenPortionThatIsLong1234567';
    const masked = maskBotToken(token);
    expect(masked.startsWith('12345678:')).toBe(true);
    expect(masked).toContain('…');
    expect(masked).not.toContain(token.slice(9)); // full secret half never present verbatim
  });

  it('does not throw and does not fully expose a short colon-shaped token', () => {
    const masked = maskBotToken('1:ab');
    expect(masked).not.toBe('1:ab');
  });

  it('does not throw and does not fully expose a short colon-less token', () => {
    const masked = maskBotToken('abcdefg'); // 7 chars — a naive prefix(4)+suffix(3) would leak all of it
    expect(masked).not.toBe('abcdefg');
    expect(masked.length).toBeLessThan('abcdefg'.length + 1);
  });

  it('handles an empty-ish odd token without throwing', () => {
    expect(() => maskBotToken('')).not.toThrow();
    expect(() => maskBotToken(':')).not.toThrow();
  });
});

// ---------- a REAL local HTTP stub standing in for api.telegram.org ----------
interface RecordedRequest {
  path: string;
  body: any;
}
type StubResponder = (req: RecordedRequest) => { status: number; json: unknown };

class TelegramStub {
  server: http.Server;
  port = 0;
  requests: RecordedRequest[] = [];
  respond: StubResponder = () => ({ status: 200, json: { ok: true, result: {} } });

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
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
      const rec: RecordedRequest = { path: url.pathname, body };
      this.requests.push(rec);
      const { status, json } = this.respond(rec);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  }
}

// ---------- a REAL loopback SMTP relay standing in for the user's own ----------
//
// Small on purpose: the protocol itself (STARTTLS, split replies, multi-line
// continuations, dot-stuffing) is hammered in smtp-delivery.test.ts. What this
// one exists to prove is that POST /delivery-config/test-smtp actually reaches
// a socket with the stored credential, and what it reports back when the relay
// says no.
interface FakeSmtp {
  port: number;
  /** every command line the client sent, in order */
  log: string[];
  /** each accepted DATA payload, un-terminated */
  mail: string[];
  close: () => Promise<void>;
}

function startFakeSmtp(
  opts: {
    /** EHLO capability lines (after the greeting line) */
    caps?: string[];
    /** first matching prefix wins; the value is written verbatim */
    reply?: Array<[string, string]>;
  } = {},
): Promise<FakeSmtp> {
  const log: string[] = [];
  const mail: string[] = [];
  const caps = opts.caps ?? ['SIZE 10240000'];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    let buf = '';
    let inData = false;
    let dataBuf = '';
    const write = (s: string): void => void sock.write(s + '\r\n');

    const handle = (line: string): void => {
      for (const [prefix, forced] of opts.reply ?? []) {
        if (line.toUpperCase().startsWith(prefix.toUpperCase())) return write(forced);
      }
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO')) {
        write('250-relay.test at your service');
        for (const [i, c] of caps.entries()) write(i === caps.length - 1 ? `250 ${c}` : `250-${c}`);
        return;
      }
      if (upper.startsWith('AUTH PLAIN')) return write('235 2.7.0 Authentication successful');
      if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) return write('250 2.1.0 Ok');
      if (upper.startsWith('DATA')) {
        inData = true;
        return write('354 End data with <CR><LF>.<CR><LF>');
      }
      if (upper.startsWith('QUIT')) {
        write('221 2.0.0 Bye');
        sock.end();
        return;
      }
      write('502 5.5.2 Command not implemented');
    };

    write('220 relay.test ESMTP ready');
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
        handle(line);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
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

// ---------- integration: GET/PUT /delivery-config, POST .../test-telegram ----------
describe('delivery-config API', () => {
  let db: DB;
  let dir: string;
  let app: FastifyInstance;
  let token: string;
  let stub: TelegramStub;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-deliv-api-'));
    const opened = openDatabase(dir);
    db = opened.db;
    createMigrator(db, MIGRATIONS).migrate();
    const clock = new FakeClock(Date.now());

    stub = new TelegramStub();
    await stub.listen();

    const rm = new RunManager({
      db,
      clock,
      dataDir: dir,
      runnerChildModule: '/nonexistent/runner-child.js',
      notify: () => {},
      broadcast: () => {},
      safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
    });
    const scheduler = new Scheduler({ db, clock, enqueueRun: () => {}, notify: () => {} });
    const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test', telegramApiBase: stub.baseUrl });
    app = built.app;
    token = built.token;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await stub.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function auth(json: any): { method: string; url: string; payload?: any; headers: Record<string, string> } {
    return { ...json, headers: { authorization: `Bearer ${token}` } };
  }

  it('rejects unauthenticated GET/PUT/POST', async () => {
    expect((await app.inject({ method: 'GET', url: '/delivery-config' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/delivery-config', payload: {} })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/delivery-config/test-telegram', payload: { chatId: 'x' } })).statusCode,
    ).toBe(401);
    // The two newer self-tests spend a stored credential, so they are the same
    // class of route and must be behind the same token.
    expect((await app.inject({ method: 'POST', url: '/delivery-config/test-slack' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/delivery-config/test-smtp', payload: { to: 'a@b.test' } })).statusCode,
    ).toBe(401);
  });

  // INTENT: code does return telegram/webhook/slack/smtp from
  // readDeliveryConfigStatus / check expects toEqual({telegram, webhook}) —
  // an exhaustive shape assertion that predates the two new channels / spec
  // says the T-310 wiring contract (delivery lane snippet 3) adds `slack` and
  // `smtp` to this response. Resolved in the spec's favour by EXTENDING the
  // expected object — still `toEqual`, not `toMatchObject`, so the assertion
  // stays exhaustive and a fifth channel appearing here would still fail it.
  it('GET with no creds configured', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/delivery-config' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      telegram: { configured: false, botTokenMasked: null },
      webhook: { configured: false },
      slack: { configured: false, webhookUrlMasked: null },
      smtp: { configured: false, endpointMasked: null, from: null },
    });
  });

  it('PUT sets a telegram bot token: file written mode 0600, GET reports configured + a masked (non-full) token', async () => {
    const put = await app.inject(
      auth({ method: 'PUT', url: '/delivery-config', payload: { telegramBotToken: '87654321:AAHexampleSecretPortionabcdefghij' } }),
    );
    expect(put.statusCode).toBe(200);

    const filePath = path.join(dir, 'delivery-creds.json');
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(onDisk.telegramBotToken).toBe('87654321:AAHexampleSecretPortionabcdefghij');

    const get = await app.inject(auth({ method: 'GET', url: '/delivery-config' }));
    const body = get.json();
    expect(body.telegram.configured).toBe(true);
    expect(body.telegram.botTokenMasked).not.toBeNull();
    expect(body.telegram.botTokenMasked).not.toContain('AAHexampleSecretPortionabcdefghij');
    expect(body.telegram.botTokenMasked.startsWith('87654321:')).toBe(true);
  });

  it('PUT with an absent key leaves the other credential untouched', async () => {
    const before = (await app.inject(auth({ method: 'GET', url: '/delivery-config' }))).json();
    expect(before.telegram.configured).toBe(true); // from the previous test

    const put = await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { webhookSecret: 'wh-secret-1' } }));
    expect(put.statusCode).toBe(200);
    expect(put.json().webhook.configured).toBe(true);
    expect(put.json().telegram.configured).toBe(true); // untouched by the PUT above
  });

  it('unrelated keys already in the file survive a PUT', async () => {
    const filePath = path.join(dir, 'delivery-creds.json');
    const current = JSON.parse(readFileSync(filePath, 'utf8'));
    writeFileSync(filePath, JSON.stringify({ ...current, smtpUrl: 'smtp://unrelated-survivor' }));

    const put = await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { webhookSecret: 'wh-secret-2' } }));
    expect(put.statusCode).toBe(200);

    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(onDisk.smtpUrl).toBe('smtp://unrelated-survivor');
    expect(onDisk.webhookSecret).toBe('wh-secret-2');
    // The hand-written rewrite above used the default mode; the route's PUT
    // handler must still leave the file at 0600 (writeFileSync alone cannot
    // fix an existing file's mode — this is what the explicit chmodSync covers).
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('PUT null clears the telegram bot token', async () => {
    const put = await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { telegramBotToken: null } }));
    expect(put.statusCode).toBe(200);
    expect(put.json().telegram).toEqual({ configured: false, botTokenMasked: null });

    const get = await app.inject(auth({ method: 'GET', url: '/delivery-config' }));
    expect(get.json().telegram).toEqual({ configured: false, botTokenMasked: null });
  });

  it('PUT rejects a non-string/non-null value with 422', async () => {
    const res = await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { telegramBotToken: 12345 } }));
    expect(res.statusCode).toBe(422);
  });

  describe('POST /delivery-config/test-telegram', () => {
    const TEST_TOKEN = '11112222:AAJrealisticLookingSecretHalfabcdefghij123';

    it('422 on a missing chatId', async () => {
      const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-telegram', payload: {} }));
      expect(res.statusCode).toBe(422);
    });

    it('ok:false with no bot token configured, without hitting the stub', async () => {
      await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { telegramBotToken: null } }));
      const before = stub.requests.length;
      const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-telegram', payload: { chatId: 'chat-1' } }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false, error: 'no bot token configured' });
      expect(stub.requests.length).toBe(before); // never reached the network
    });

    it('ok:true when the stub accepts the message, and the stub saw the fixed text + chat id', async () => {
      await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { telegramBotToken: TEST_TOKEN } }));
      stub.respond = () => ({ status: 200, json: { ok: true, result: { message_id: 1 } } });
      stub.requests = [];

      const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-telegram', payload: { chatId: 'chat-42' } }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0]!.path).toBe(`/bot${TEST_TOKEN}/sendMessage`);
      expect(stub.requests[0]!.body.chat_id).toBe('chat-42');
      expect(stub.requests[0]!.body.text).toBe('Clockwork test message — your bot can reach this chat.');
    });

    it('maps a non-ok Telegram response to ok:false with the description, truncated, never containing the token', async () => {
      stub.respond = () => ({ status: 400, json: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } });
      stub.requests = [];

      const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-telegram', payload: { chatId: 'nope' } }));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('Bad Request: chat not found');
      expect(body.error.length).toBeLessThanOrEqual(200);
      expect(body.error).not.toContain(TEST_TOKEN);
      expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);
    });

    it('scrubs the token even when it leaks into the error body (e.g. a 404 that echoes the request path)', async () => {
      // A non-JSON-description error (like Fastify's own default 404 body)
      // echoes the request path back, and the path contains `/bot<TOKEN>/...`.
      // This is the actual case the route's belt-and-braces scrub exists for —
      // the two tests above never send the token back, so they can't prove it.
      stub.respond = (req) => ({ status: 404, json: { ok: false, error_code: 404, description: `Route ${req.path} not found` } });
      stub.requests = [];

      const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-telegram', payload: { chatId: 'x' } }));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain('[redacted]');
      expect(body.error).not.toContain(TEST_TOKEN);
      expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // Slack incoming webhook + SMTP relay (T-310), wired the same way as the
  // bot token: the credential lands in the 0600 file, GET returns only a
  // mask, and the test-send route reports the provider's own refusal rather
  // than a generic failure. The two channels differ in exactly one way that
  // shows up at the route boundary — a Slack incoming webhook already names
  // its destination, so test-slack takes no body, while an email needs a
  // recipient.
  // -------------------------------------------------------------------------
  describe('PUT /delivery-config — Slack webhook URL', () => {
    const HOOK = 'https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/ZzYyXxWwVvUuTtSsRrQq';

    it('stores the URL at 0600 and reports it masked — no path segment whole', async () => {
      const put = await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { slackWebhookUrl: HOOK } }));
      expect(put.statusCode).toBe(200);
      expect(put.json().slack.configured).toBe(true);

      const filePath = path.join(dir, 'delivery-creds.json');
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(filePath, 'utf8')).slackWebhookUrl).toBe(HOOK);

      const body = (await app.inject(auth({ method: 'GET', url: '/delivery-config' }))).json();
      expect(body.slack.webhookUrlMasked).toContain('hooks.slack.com');
      // The path IS the credential, so no segment of it may be readable.
      expect(body.slack.webhookUrlMasked).not.toContain('ZzYyXxWwVvUuTtSsRrQq');
      expect(body.slack.webhookUrlMasked).not.toContain('B02GHIJKL');
      expect(JSON.stringify(body)).not.toContain(HOOK);
    });

    it('refuses an http:// webhook with 422 and leaves the stored one alone', async () => {
      const res = await app.inject(
        auth({ method: 'PUT', url: '/delivery-config', payload: { slackWebhookUrl: 'http://hooks.slack.com/services/a/b/ccccccccc' } }),
      );
      expect(res.statusCode).toBe(422);
      const body = (await app.inject(auth({ method: 'GET', url: '/delivery-config' }))).json();
      expect(body.slack.configured).toBe(true); // the https one from the previous test survived
    });

    it('refuses a value that is not a URL at all with 422', async () => {
      const res = await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { slackWebhookUrl: 'T01ABCDEF/B02GHIJKL' } }));
      expect(res.statusCode).toBe(422);
    });

    it('records set/cleared in the audit log and never the URL itself', () => {
      const rows = db
        .prepare("SELECT detail_json FROM audit_log WHERE action = 'delivery-config.update' ORDER BY at DESC, rowid DESC LIMIT 20")
        .all() as Array<{ detail_json: string }>;
      const details = rows.map((r) => r.detail_json);
      expect(details.length).toBeGreaterThan(0);
      expect(details.some((d) => JSON.parse(d).slackWebhookUrl === 'set')).toBe(true);
      for (const d of details) {
        expect(d).not.toContain(HOOK);
        expect(d).not.toContain('ZzYyXxWwVvUuTtSsRrQq');
      }
    });

    it('PUT null clears it', async () => {
      const put = await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { slackWebhookUrl: null } }));
      expect(put.statusCode).toBe(200);
      expect(put.json().slack).toEqual({ configured: false, webhookUrlMasked: null });
    });
  });

  describe('POST /delivery-config/test-slack', () => {
    const HOOK = 'https://hooks.slack.com/services/T09ZZZZZZ/B08YYYYYY/QqWwEeRrTtYyUuIiOoPp';

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** The Slack channel talks to `fetch`; an https loopback stub would need a keypair. */
    function stubFetch(impl: () => Promise<unknown> | never): ReturnType<typeof vi.fn> {
      const fn = vi.fn(impl as () => Promise<unknown>);
      vi.stubGlobal('fetch', fn);
      return fn;
    }

    it('takes no body at all — the credential already names the channel', async () => {
      await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { slackWebhookUrl: HOOK } }));
      const fetchMock = stubFetch(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
      const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-slack' }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toBe(HOOK);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body).text).toBe('Clockwork test message — this webhook can reach this channel.');
    });

    it('ok:false with no webhook configured, without touching the network', async () => {
      await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { slackWebhookUrl: null } }));
      const fetchMock = stubFetch(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
      const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-slack' }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false, error: 'no slack webhook url configured' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("surfaces Slack's own refusal text, truncated, with the URL never in it", async () => {
      await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { slackWebhookUrl: HOOK } }));
      stubFetch(async () => ({ ok: false, status: 403, text: async () => 'invalid_token' }));
      const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-slack' }));
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('invalid_token');
      expect(body.error.length).toBeLessThanOrEqual(200);
      expect(JSON.stringify(body)).not.toContain(HOOK);
    });

    // Measured, not assumed: SlackChannel.post already redacts before it
    // throws, so deleting the route's own `.split(url).join('[redacted]')`
    // leaves this green (verified by mutation). What this test pins is the
    // OUTCOME — the response body never carries the webhook URL — not which
    // of the two layers produced it. The route's scrub stays for the same
    // belt-and-braces reason the Telegram route has one.
    it('the response never carries the webhook URL, even when the transport error quotes it', async () => {
      await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { slackWebhookUrl: HOOK } }));
      stubFetch(() => {
        throw new Error(`request to ${HOOK} failed, reason: ECONNREFUSED`);
      });
      const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-slack' }));
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain('[redacted]');
      expect(body.error).not.toContain('QqWwEeRrTtYyUuIiOoPp');
      expect(JSON.stringify(body)).not.toContain(HOOK);
    });
  });

  describe('PUT /delivery-config — SMTP relay', () => {
    const SMTP_URL = 'smtp://clockwork%40example.com:sup3r-s3cret@smtp.example.com:2525';

    it('stores the URL at 0600 and reports an endpoint without the password', async () => {
      const put = await app.inject(
        auth({ method: 'PUT', url: '/delivery-config', payload: { smtpUrl: SMTP_URL, smtpFrom: 'clockwork@example.com' } }),
      );
      expect(put.statusCode).toBe(200);
      const body = put.json();
      expect(body.smtp.configured).toBe(true);
      expect(body.smtp.endpointMasked).toBe('smtp://clockwork@example.com@smtp.example.com:2525');
      expect(body.smtp.from).toBe('clockwork@example.com');
      expect(body.smtp.endpointMasked).not.toContain('sup3r-s3cret');
      expect(JSON.stringify(body)).not.toContain('sup3r-s3cret');

      const filePath = path.join(dir, 'delivery-creds.json');
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(filePath, 'utf8')).smtpUrl).toBe(SMTP_URL);
    });

    it('refuses a non-smtp scheme with 422', async () => {
      const res = await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { smtpUrl: 'https://smtp.example.com:2525' } }));
      expect(res.statusCode).toBe(422);
    });

    it('refuses a from address that is not an email with 422', async () => {
      const res = await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { smtpFrom: 'postmaster' } }));
      expect(res.statusCode).toBe(422);
    });

    it('never puts the SMTP password in the audit log', () => {
      const rows = db
        .prepare("SELECT detail_json FROM audit_log WHERE action = 'delivery-config.update' ORDER BY at DESC, rowid DESC LIMIT 30")
        .all() as Array<{ detail_json: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => JSON.parse(r.detail_json).smtpUrl === 'set')).toBe(true);
      for (const r of rows) expect(r.detail_json).not.toContain('sup3r-s3cret');
    });

    it('PUT null clears the relay and the from address independently', async () => {
      const cleared = await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { smtpFrom: null } }));
      expect(cleared.json().smtp).toEqual({
        configured: true,
        endpointMasked: 'smtp://clockwork@example.com@smtp.example.com:2525',
        from: null,
      });
      const gone = await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { smtpUrl: null } }));
      expect(gone.json().smtp).toEqual({ configured: false, endpointMasked: null, from: null });
    });
  });

  describe('POST /delivery-config/test-smtp', () => {
    it('422 on a missing or malformed recipient', async () => {
      expect((await app.inject(auth({ method: 'POST', url: '/delivery-config/test-smtp', payload: {} }))).statusCode).toBe(422);
      expect(
        (await app.inject(auth({ method: 'POST', url: '/delivery-config/test-smtp', payload: { to: 'not-an-address' } }))).statusCode,
      ).toBe(422);
    });

    it('ok:false with no relay configured', async () => {
      await app.inject(auth({ method: 'PUT', url: '/delivery-config', payload: { smtpUrl: null } }));
      const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-smtp', payload: { to: 'dana@example.com' } }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false, error: 'no smtp url configured' });
    });

    it('ok:true against a real relay, which received the fixed test body', async () => {
      const relay = await startFakeSmtp();
      try {
        await app.inject(
          auth({
            method: 'PUT',
            url: '/delivery-config',
            payload: { smtpUrl: `smtp://127.0.0.1:${relay.port}`, smtpFrom: 'clockwork@example.com' },
          }),
        );
        const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-smtp', payload: { to: 'dana@example.com' } }));
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });
        expect(relay.log).toContain('MAIL FROM:<clockwork@example.com>');
        expect(relay.log).toContain('RCPT TO:<dana@example.com>');
        expect(relay.mail.length).toBe(1);
        // The body is base64 UTF-8 (every Clockwork message opens with an emoji).
        const decoded = Buffer.from(relay.mail[0]!.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8');
        expect(decoded).toContain('Clockwork test message — your SMTP relay accepted this mail.');
      } finally {
        await relay.close();
      }
    });

    it("surfaces the relay's own rejection text", async () => {
      const relay = await startFakeSmtp({ reply: [['RCPT TO', '550 5.1.1 <dana@example.com>: Recipient address rejected']] });
      try {
        await app.inject(
          auth({
            method: 'PUT',
            url: '/delivery-config',
            payload: { smtpUrl: `smtp://127.0.0.1:${relay.port}`, smtpFrom: 'clockwork@example.com' },
          }),
        );
        const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-smtp', payload: { to: 'dana@example.com' } }));
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toContain('Recipient address rejected');
        expect(body.error.length).toBeLessThanOrEqual(200);
      } finally {
        await relay.close();
      }
    });

    it('never returns the relay password, even when the relay refuses the login', async () => {
      const relay = await startFakeSmtp({ caps: ['SIZE 10240000', 'AUTH PLAIN'], reply: [['AUTH PLAIN', '535 5.7.8 Error: authentication failed']] });
      try {
        await app.inject(
          auth({
            method: 'PUT',
            url: '/delivery-config',
            // ?allowInsecureAuth=1 is what a loopback relay needs; without it
            // the client refuses to send credentials in the clear at all.
            payload: {
              smtpUrl: `smtp://clockwork%40example.com:sup3r-s3cret@127.0.0.1:${relay.port}?allowInsecureAuth=1`,
              smtpFrom: 'clockwork@example.com',
            },
          }),
        );
        const res = await app.inject(auth({ method: 'POST', url: '/delivery-config/test-smtp', payload: { to: 'dana@example.com' } }));
        const body = res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toContain('authentication failed');
        expect(JSON.stringify(body)).not.toContain('sup3r-s3cret');
      } finally {
        await relay.close();
      }
    });
  });
});
