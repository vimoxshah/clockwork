/**
 * DeliveryChannel adapters (FR-18 / ADR-018 / T-211/T-310).
 * Daemon-side only; credentials never enter runner processes. One payload
 * schema for every channel. Failures NEVER affect run outcome (S-43):
 * retried x3 exponential, receipt recorded in the report footer.
 */
export interface RunReportPayload {
  runId: string;
  taskName: string;
  state: string;
  failureReason?: string | null;
  summary: string;
  branch?: string | null;
  costUsd: number;
  turns: number;
  ranLateMs?: number;
  coveredOccurrences?: number[];
  profile?: { name: string; slug: string } | null;
}

export interface DeliveryConfigCred {
  telegramBotToken?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  smtpUrl?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
}

/**
 * Reachable approvals (outbound half): a permission request waiting on a
 * human. Deliberately excludes the full jobspec/env — only enough to act on
 * from a phone. `commandSummary` is caller-truncated/masked before this is
 * built; channels never see secrets or the loopback API token.
 */
export interface ApprovalNotifyPayload {
  approvalId: string;
  runId: string;
  taskName: string;
  engine: string;
  tool: string;
  commandSummary: string;
  /** epoch ms after which the child auto-denies (fail-safe) */
  timeoutAt: number;
}

export interface ChannelTarget {
  channel: 'os' | 'telegram' | 'webhook';
  to: string; // chat id / url / etc
}

export interface DeliveryReceiptT {
  channel: string;
  ok: boolean;
  error: string | null;
  attempts: number;
}

export interface DeliveryChannel {
  readonly name: string;
  send(payload: RunReportPayload, target: string, cred: DeliveryConfigCred): Promise<void>;
  sendApproval(payload: ApprovalNotifyPayload, target: string, cred: DeliveryConfigCred): Promise<void>;
}

const RETRIES = 3;

/** Shared retry wrapper implementing S-43 exactly. */
export async function withRetry(fn: () => Promise<void>): Promise<DeliveryReceiptT> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      await fn();
      return { channel: '', ok: true, error: null, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  }
  return { channel: '', ok: false, error: String(lastErr), attempts: RETRIES };
}

export function formatReportText(p: RunReportPayload): string {
  const lines = [
    `⏰ ${p.taskName}${p.profile ? ` (@${p.profile.slug})` : ''} — ${p.state.replace('_', ' ')}`,
  ];
  if (p.failureReason) lines.push(`Reason: ${p.failureReason}`);
  if (p.ranLateMs && p.ranLateMs > 60_000) lines.push(`⏳ Ran ${Math.round(p.ranLateMs / 60000)}m late (machine slept).`);
  if (p.coveredOccurrences?.length) lines.push(`Covers ${p.coveredOccurrences.length} missed occurrence(s).`);
  lines.push('');
  lines.push((p.summary || '(no summary)').slice(0, 3500));
  lines.push('');
  lines.push(`$${p.costUsd.toFixed(2)} · ${p.turns} turns${p.branch ? ` · ${p.branch}` : ''}`);
  return lines.join('\n');
}

/** Compact "a human needs to answer" message — same shape for every channel. */
export function formatApprovalText(p: ApprovalNotifyPayload): string {
  const lines = [
    `🔒 ${p.taskName} (${p.engine}) is waiting on your approval`,
    `${p.tool}: ${p.commandSummary}`,
    `Auto-denies at ${new Date(p.timeoutAt).toISOString()} if nobody answers.`,
    `Answer in Clockwork's Inbox.`,
    `Approval ${p.approvalId}`,
  ];
  return lines.join('\n');
}

// ---------- OS notification (always available) ----------
export class OsChannel implements DeliveryChannel {
  readonly name = 'os';
  async send(): Promise<void> {
    // OS notifications are sent by the daemon notifier directly; this adapter
    // exists so per-task channel lists can include 'os' uniformly.
  }
  async sendApproval(): Promise<void> {
    // Same as send(): the daemon notifier fires the OS notification directly
    // (run-manager.ts), matching the outcome-notification convention.
  }
}

/** Fixed message for the "does this bot reach that chat?" self-test. */
export const TELEGRAM_TEST_MESSAGE = 'Clockwork test message — your bot can reach this chat.';

/**
 * Thrown by `TelegramChannel.post` on a non-2xx response. `description`, when
 * present, is the Telegram API's own `description` field (e.g. "Bad Request:
 * chat not found") — callers that surface an error to a human (test-telegram)
 * should prefer it over `message`, which stays richer for receipts/logs.
 */
export class TelegramApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly description: string | null,
  ) {
    super(`telegram ${status}: ${description ?? '(no description)'}`);
    this.name = 'TelegramApiError';
  }
}

// ---------- Telegram Bot API (T-211) — plain fetch, no lib ----------
export class TelegramChannel implements DeliveryChannel {
  readonly name = 'telegram';

  constructor(private readonly apiBase: string = 'https://api.telegram.org') {}

  private async post(text: string, chatId: string, cred: DeliveryConfigCred, extra?: Record<string, unknown>): Promise<void> {
    if (!cred.telegramBotToken) throw new Error('missing telegram bot token');
    const res = await fetch(`${this.apiBase}/bot${cred.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...extra,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let description: string | null = null;
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed.description === 'string') description = parsed.description.slice(0, 200);
      } catch {}
      throw new TelegramApiError(res.status, description ?? (body.slice(0, 200) || null));
    }
  }

  async send(payload: RunReportPayload, chatId: string, cred: DeliveryConfigCred): Promise<void> {
    await this.post(formatReportText(payload), chatId, cred);
  }

  /**
   * Reachable approvals (inbound half, ADR-036): the message carries an
   * inline keyboard so a decision can be made from the chat itself, without
   * opening Clockwork. `callback_data` stays well under Telegram's 64-byte
   * cap (`a:<26-char ULID>` / `d:<26-char ULID>` — 28 bytes). The poller
   * (telegram-approvals.ts) parses this exact prefix.
   */
  async sendApproval(payload: ApprovalNotifyPayload, chatId: string, cred: DeliveryConfigCred): Promise<void> {
    await this.post(formatApprovalText(payload), chatId, cred, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: `a:${payload.approvalId}` },
            { text: 'Deny', callback_data: `d:${payload.approvalId}` },
          ],
        ],
      },
    });
  }

  /** POST /delivery-config/test-telegram: a short fixed message, no retry. */
  async sendTest(chatId: string, cred: DeliveryConfigCred): Promise<void> {
    await this.post(TELEGRAM_TEST_MESSAGE, chatId, cred);
  }
}

// ---------- Generic HMAC-signed webhook (fronts Slack/Discord/ntfy/anything) ----------
import { createHmac } from 'node:crypto';

export class WebhookChannel implements DeliveryChannel {
  readonly name = 'webhook';

  private async post(schema: string, payload: object, url: string, cred: DeliveryConfigCred): Promise<void> {
    const body = JSON.stringify({ schema, ...payload });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cred.webhookSecret) {
      const sig = createHmac('sha256', cred.webhookSecret).update(body).digest('hex');
      headers['x-clockwork-signature'] = `sha256=${sig}`;
    }
    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`webhook ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  async send(payload: RunReportPayload, url: string, cred: DeliveryConfigCred): Promise<void> {
    await this.post('clockwork.run-report.v1', payload, url, cred);
  }

  async sendApproval(payload: ApprovalNotifyPayload, url: string, cred: DeliveryConfigCred): Promise<void> {
    await this.post('clockwork.approval-request.v1', payload, url, cred);
  }
}

/**
 * Same credential sources as the report-delivery path (env + file bridge; OS
 * keychain lands with the Tauri step): `CLOCKWORK_DELIVER_*` env vars and the
 * `delivery-creds.json` file, file wins on overlap. Single source of truth —
 * delivery-dispatch.ts imports this rather than keeping its own copy.
 */
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';

/**
 * `CLOCKWORK_DELIVER_TELEGRAM_BOT_TOKEN` -> `telegramBotToken`. The
 * `DeliveryConfigCred` interface is camelCase; env vars are
 * SCREAMING_SNAKE_CASE, so the suffix must be converted, not just
 * lowercased (lowercasing alone produced `telegram_bot_token`, which never
 * matched any field and silently disabled env-var credentials).
 */
function envSuffixToCamelCase(suffix: string): string {
  return suffix.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function loadDeliveryCreds(dataDir: string): DeliveryConfigCred {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLOCKWORK_DELIVER_') && v) {
      out[envSuffixToCamelCase(k.replace('CLOCKWORK_DELIVER_', ''))] = v;
    }
  }
  try {
    // the file is already camelCase (written by writeDeliveryCreds / hand-edited)
    const f = JSON.parse(readFileSync(`${dataDir}/delivery-creds.json`, 'utf8'));
    if (f && typeof f === 'object') Object.assign(out, f);
  } catch {}
  return out as DeliveryConfigCred;
}

/**
 * Read-modify-write onto `delivery-creds.json` (0600). A string sets/replaces
 * a credential, `null` clears it, an absent key leaves it unchanged. Keys not
 * named in `patch` (including ones this daemon doesn't know about yet) are
 * preserved verbatim.
 */
export function writeDeliveryCreds(dataDir: string, patch: Record<string, string | null | undefined>): void {
  const path = `${dataDir}/delivery-creds.json`;
  let current: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object') current = parsed;
    }
  } catch {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue; // absent key: leave unchanged
    if (v === null) delete current[k];
    else current[k] = v;
  }
  writeFileSync(path, JSON.stringify(current, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync's mode is ignored when the file already exists
}

/**
 * Reveal a prefix/suffix peek of `token` only when the hidden middle is at
 * least as long as what's shown on each side — a short/odd secret falls back
 * to a smaller peek, then to nothing, rather than ever showing more than it
 * hides.
 */
function peek(token: string, prefixLen: number, suffixLen: number): string {
  const shown = prefixLen + suffixLen;
  if (token.length - shown >= shown) return `${token.slice(0, prefixLen)}…${token.slice(-suffixLen)}`;
  if (token.length - prefixLen >= prefixLen) return `${token.slice(0, prefixLen)}…`;
  return '…';
}

/**
 * Mask a bot token for display, e.g. "12345678:AAE…xQ7" — the numeric id
 * (not secret; it's the public half of a Telegram bot token) shown in full up
 * to 8 chars, then a peek of the actual secret half. Never throws on a
 * short/odd/colon-less token.
 */
export function maskBotToken(token: string): string {
  const colon = token.indexOf(':');
  if (colon > 0) {
    const idPart = token.slice(0, colon);
    const secretPart = token.slice(colon + 1);
    return `${idPart.slice(0, 8)}:${peek(secretPart, 3, 3)}`;
  }
  return peek(token, 4, 3);
}

export function channelFor(name: string): DeliveryChannel | null {
  switch (name) {
    case 'os':
      return new OsChannel();
    case 'telegram':
      return new TelegramChannel();
    case 'webhook':
      return new WebhookChannel();
    default:
      return null;
  }
}
