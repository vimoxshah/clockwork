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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import http from 'node:http';
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
  });

  it('GET with no creds configured', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/delivery-config' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      telegram: { configured: false, botTokenMasked: null },
      webhook: { configured: false },
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
});
