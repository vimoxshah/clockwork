/**
 * The delivery-channel contract (FR-18 / ADR-018 / S-43): the registry, the
 * per-task `DeliveryConfig`, and the dispatch fan-out that turns one into the
 * other — for reports and for approval requests.
 *
 * Slack and email join the registry here. WhatsApp deliberately does NOT, and
 * the last block is the guard for that decision rather than a gap: ADR-018
 * (`decisions/DECISIONS.md:125`) and the gateway contract in
 * `plan/02-architecture.md:240` define a WhatsApp gateway as "any HTTP
 * endpoint that accepts the signed Run Report payload", explicitly so that "an
 * existing personal WhatsApp/Telegram gateway plugs in with zero Clockwork
 * changes". A `whatsapp` adapter would be the generic webhook under a second
 * name, and a second name is a second thing to configure, test and document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeliveryConfig } from '@clockwork/shared';
import { channelFor, type ApprovalNotifyPayload, type RunReportPayload } from '../src/delivery.js';
import { deliverApproval, deliverReport, selectedChannels } from '../src/delivery-dispatch.js';

const HOOK = 'https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/ZzYyXxWwVvUuTtSsRrQq';

const report: RunReportPayload = {
  runId: '01JRUNDISPATCH0000000000AA',
  taskName: 'nightly dependency surgery',
  state: 'completed',
  failureReason: null,
  summary: 'Bumped 4 packages. Tests green.',
  branch: 'clockwork/dep-surgeon/01JR',
  costUsd: 0.42,
  turns: 12,
  profile: { name: 'Dep Surgeon', slug: 'dep-surgeon' },
};

const approval: ApprovalNotifyPayload = {
  approvalId: '01JRAPPROVAL000000000000AA',
  runId: '01JRUNDISPATCH0000000000AA',
  taskName: 'deploy-prod',
  engine: 'cli',
  tool: 'Bash',
  commandSummary: 'kubectl apply -f prod.yaml',
  timeoutAt: 1_800_000_000_000,
};

let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;

const DELIVER_ENV = [
  'CLOCKWORK_DELIVER_TELEGRAM_BOT_TOKEN',
  'CLOCKWORK_DELIVER_WEBHOOK_SECRET',
  'CLOCKWORK_DELIVER_WEBHOOK_URL',
  'CLOCKWORK_DELIVER_SLACK_WEBHOOK_URL',
  'CLOCKWORK_DELIVER_SMTP_URL',
  'CLOCKWORK_DELIVER_SMTP_FROM',
];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-delivery-channels-'));
  for (const k of DELIVER_ENV) delete process.env[k];
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function writeCreds(creds: Record<string, string>): void {
  writeFileSync(path.join(dir, 'delivery-creds.json'), JSON.stringify(creds));
}

describe('the channel registry', () => {
  it('knows every channel the per-task config can name', () => {
    for (const name of ['os', 'telegram', 'webhook', 'slack', 'email']) {
      const ch = channelFor(name);
      expect(ch, `channelFor('${name}') returned null`).not.toBeNull();
      expect(ch!.name).toBe(name);
    }
  });

  it('returns null for a name it does not implement', () => {
    expect(channelFor('carrier-pigeon')).toBeNull();
  });
});

describe('the per-task delivery config', () => {
  it('accepts a Slack opt-in and defaults it to on', () => {
    const cfg = DeliveryConfig.parse({ osNotify: true, slack: {} });
    expect(cfg.slack?.enabled).toBe(true);
    expect(DeliveryConfig.parse({ slack: { enabled: false } }).slack?.enabled).toBe(false);
  });

  it('accepts a list of email recipients and rejects an address that is not one', () => {
    const cfg = DeliveryConfig.parse({ email: { to: ['dana@example.test', 'marcus@example.test'] } });
    expect(cfg.email?.to).toEqual(['dana@example.test', 'marcus@example.test']);
    expect(DeliveryConfig.safeParse({ email: { to: ['not-an-address'] } }).success).toBe(false);
    expect(DeliveryConfig.safeParse({ email: { to: [] } }).success).toBe(false);
  });

  it('cannot carry a Slack webhook URL, because the task row is in SQLite', () => {
    // The incoming-webhook URL *is* the Slack credential (anyone holding it can
    // post), so it lives with the bot token in delivery-creds.json (0600) and
    // never in a task row. zod strips the key rather than storing it.
    const parsed = DeliveryConfig.parse({ slack: { enabled: true, webhookUrl: HOOK } });
    expect(JSON.stringify(parsed)).not.toContain('hooks.slack.com');
    expect(JSON.stringify(parsed)).not.toContain('ZzYyXxWwVvUuTtSsRrQq');
  });

  it('cannot carry an SMTP URL either, for the same reason', () => {
    const parsed = DeliveryConfig.parse({ email: { to: ['dana@example.test'], smtpUrl: 'smtp://u:hunter2@h:587' } });
    expect(JSON.stringify(parsed)).not.toContain('hunter2');
    expect(parsed.email?.to).toEqual(['dana@example.test']);
  });
});

describe('which channels one config selects', () => {
  it('lists them in a stable order with the target each one needs', () => {
    expect(
      selectedChannels({
        osNotify: true,
        telegram: { chatId: 'chat-777' },
        webhook: { url: 'https://example.test/hook' },
        slack: { enabled: true },
        email: { to: ['dana@example.test', 'marcus@example.test'] },
      }),
    ).toEqual([
      { channel: 'telegram', to: 'chat-777' },
      { channel: 'webhook', to: 'https://example.test/hook' },
      { channel: 'slack', to: '' },
      { channel: 'email', to: 'dana@example.test,marcus@example.test' },
    ]);
  });

  it('skips a channel that is present but switched off or empty', () => {
    expect(selectedChannels({ osNotify: true, slack: { enabled: false }, email: { to: [] } })).toEqual([]);
    expect(selectedChannels({ osNotify: true })).toEqual([]);
  });
});

describe('report dispatch', () => {
  it('delivers to Slack and records a receipt', async () => {
    writeCreds({ slackWebhookUrl: HOOK });
    const receipts = await deliverReport(dir, 't-1', JSON.stringify({ osNotify: true, slack: { enabled: true } }), report);

    expect(String(fetchMock.mock.calls[0]![0])).toBe(HOOK);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.blocks[0].type).toBe('header');
    expect(receipts).toEqual([{ channel: 'slack', ok: true, error: null, attempts: 1 }]);
  });

  it('leaves the existing telegram and webhook behaviour exactly as it was', async () => {
    writeCreds({ telegramBotToken: 'bot-tok', webhookSecret: 'whsec' });
    const receipts = await deliverReport(
      dir,
      't-2',
      JSON.stringify({ osNotify: true, telegram: { chatId: 'chat-777' }, webhook: { url: 'https://example.test/hook' } }),
      report,
    );

    expect(fetchMock.mock.calls.length).toBe(2);
    const tg = fetchMock.mock.calls.find((c) => String(c[0]).includes('api.telegram.org'));
    expect(JSON.parse(String((tg![1] as RequestInit).body)).chat_id).toBe('chat-777');
    const wh = fetchMock.mock.calls.find((c) => String(c[0]) === 'https://example.test/hook');
    expect((wh![1] as RequestInit & { headers: Record<string, string> }).headers['x-clockwork-signature']).toMatch(/^sha256=/);
    expect(receipts.map((r) => r.channel).sort()).toEqual(['telegram', 'webhook']);
    expect(receipts.every((r) => r.ok)).toBe(true);
  });

  it('turns an unconfigured credential into a failed receipt, not an exception', async () => {
    writeCreds({});
    const receipts = await deliverReport(
      dir,
      't-3',
      JSON.stringify({ osNotify: true, slack: { enabled: true }, email: { to: ['dana@example.test'] } }),
      report,
    );

    const slack = receipts.find((r) => r.channel === 'slack')!;
    expect(slack.ok).toBe(false);
    expect(slack.attempts).toBe(3); // S-43: retried x3, then reported
    expect(slack.error).toMatch(/slack webhook url/i);

    const email = receipts.find((r) => r.channel === 'email')!;
    expect(email.ok).toBe(false);
    expect(email.attempts).toBe(3);
    expect(email.error).toMatch(/smtp url/i);
  });

  it('reads the Slack URL from the environment bridge as well as the file', async () => {
    process.env.CLOCKWORK_DELIVER_SLACK_WEBHOOK_URL = HOOK;
    const receipts = await deliverReport(dir, 't-4', JSON.stringify({ slack: { enabled: true } }), report);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(HOOK);
    expect(receipts[0]!.ok).toBe(true);
  });
});

describe('approval dispatch', () => {
  it('pushes the approval request to every configured channel and reports per-channel receipts', async () => {
    writeCreds({ telegramBotToken: 'bot-tok', webhookSecret: 'whsec', slackWebhookUrl: HOOK });
    const receipts = await deliverApproval(
      dir,
      JSON.stringify({
        osNotify: true,
        telegram: { chatId: 'chat-777' },
        webhook: { url: 'https://example.test/hook' },
        slack: { enabled: true },
      }),
      approval,
    );

    expect(receipts.map((r) => r.channel).sort()).toEqual(['slack', 'telegram', 'webhook']);
    expect(receipts.every((r) => r.ok && r.attempts === 1)).toBe(true);

    const tg = JSON.parse(String((fetchMock.mock.calls.find((c) => String(c[0]).includes('api.telegram.org'))![1] as RequestInit).body));
    expect(tg.reply_markup.inline_keyboard[0][0].callback_data).toBe(`a:${approval.approvalId}`);

    const wh = JSON.parse(String((fetchMock.mock.calls.find((c) => String(c[0]) === 'https://example.test/hook')![1] as RequestInit).body));
    expect(wh.schema).toBe('clockwork.approval-request.v1');

    const slack = JSON.parse(String((fetchMock.mock.calls.find((c) => String(c[0]) === HOOK)![1] as RequestInit).body));
    expect(slack.blocks[0].text.text).toContain('deploy-prod');
    expect(JSON.stringify(slack)).toContain(approval.approvalId);
  });

  it('never throws out of the notification path when a transport is down (S-43)', async () => {
    writeCreds({ telegramBotToken: 'bot-tok', slackWebhookUrl: HOOK });
    fetchMock.mockImplementation(async () => {
      throw new Error('network is down');
    });
    const receipts = await deliverApproval(
      dir,
      JSON.stringify({ telegram: { chatId: 'chat-777' }, slack: { enabled: true } }),
      approval,
    );
    expect(receipts.length).toBe(2);
    expect(receipts.every((r) => !r.ok && r.attempts === 3)).toBe(true);
  });

  it('sends nothing at all for a task with no channels configured', async () => {
    writeCreds({ telegramBotToken: 'bot-tok', slackWebhookUrl: HOOK });
    expect(await deliverApproval(dir, JSON.stringify({ osNotify: true }), approval)).toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe('WhatsApp needs no adapter of its own (ADR-018)', () => {
  // These two assertions passed before Slack and email were built and pass
  // after: they are the guard on a decision NOT to write code, not evidence of
  // new behaviour.
  it('has no whatsapp channel, by decision', () => {
    expect(channelFor('whatsapp')).toBeNull();
    expect(channelFor('whatsapp-gateway')).toBeNull();
  });

  it('delivers the signed run report to a user gateway through the webhook channel', async () => {
    // The gateway recipe from plan/02-architecture.md §240: a bridge running as
    // its own service on the same machine, reached over loopback. It gets the
    // one payload schema and the HMAC signature, and it owns WhatsApp auth.
    writeCreds({ webhookSecret: 'gateway-shared-secret' });
    const receipts = await deliverReport(
      dir,
      't-wa',
      JSON.stringify({ webhook: { url: 'http://127.0.0.1:8787/whatsapp/send' } }),
      report,
    );

    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe('http://127.0.0.1:8787/whatsapp/send');
    const init = call[1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers['x-clockwork-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(String(init.body)).schema).toBe('clockwork.run-report.v1');
    expect(receipts).toEqual([{ channel: 'webhook', ok: true, error: null, attempts: 1 }]);
  });
});
