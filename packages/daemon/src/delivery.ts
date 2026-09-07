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
  /** `smtp://user:pass@host:587` or `smtps://…:465` — see parseSmtpUrl */
  smtpUrl?: string;
  /** envelope + From address for email delivery; falls back to the SMTP username */
  smtpFrom?: string;
  /**
   * Slack incoming-webhook URL. This *is* the Slack credential — anyone
   * holding it can post to the channel — so it lives here with the bot token
   * and never in a task row (DeliveryConfig.slack carries no URL).
   */
  slackWebhookUrl?: string;
  /**
   * WhatsApp/other personal gateways: unused by any adapter, by decision.
   * ADR-018 and `plan/02-architecture.md` §240 define a gateway as any HTTP
   * endpoint that accepts the signed Run Report payload, so a gateway is
   * configured as a `webhook` target (its own bearer auth, if it needs one,
   * belongs to the bridge). Kept because `loadDeliveryCreds` preserves unknown
   * keys and some installs already set them.
   */
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
  channel: 'os' | 'telegram' | 'webhook' | 'slack' | 'email';
  to: string; // chat id / url / comma-separated recipients / '' when the credential names the destination
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

// ---------- Generic HMAC-signed webhook (fronts a user gateway/Discord/ntfy/anything) ----------
import { createHmac, randomUUID } from 'node:crypto';

/**
 * An error's own message plus its `cause` — undici puts the useful half of a
 * failed `fetch` in the cause, and a receipt that only says "fetch failed"
 * tells a user nothing.
 */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as Error & { cause?: unknown }).cause;
  if (cause === undefined || cause === null) return e.message;
  return `${e.message}: ${cause instanceof Error ? cause.message : String(cause)}`;
}

/** Replace every occurrence of a secret with a marker. No-op when absent. */
function scrubSecret(text: string, secret: string | null | undefined): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

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

// ---------- Slack incoming webhook (T-310) — Block Kit, plain fetch, no lib ----------
//
// The generic webhook above can already POST to a Slack incoming webhook; what
// arrives is `{"schema":"clockwork.run-report.v1",…}` rendered as a wall of
// JSON. This adapter exists for the formatting, not the transport.
//
// Block Kit rather than a text layout because an approval has to be *scanned*:
// a header line, the tool and command as a code block, and the auto-deny
// moment as Slack's own `<!date^…>` token so every reader sees it in their own
// timezone. `text` is still filled in — that is what Slack puts in the
// notification and hands to screen readers when `blocks` is present.
//
// No Approve/Deny buttons: Slack interactivity POSTs the click to a public
// HTTPS request URL, and the daemon binds loopback only (S-2), so a button
// would be a control that silently does nothing. Telegram's inline keyboard
// works because we *poll* the Bot API (telegram-approvals.ts) instead of being
// called in to.

export interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

export interface SlackBlock {
  type: string;
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  elements?: SlackTextObject[];
}

export interface SlackMessage {
  /** notification + accessibility fallback; Slack requires it alongside blocks */
  text: string;
  blocks: SlackBlock[];
}

/** Slack's own limits (api.slack.com/reference/block-kit/blocks). */
const SLACK_HEADER_MAX = 150;
const SLACK_SECTION_MAX = 3000;
/** A `fields` item is capped tighter than a section's own `text`. */
const SLACK_FIELD_MAX = 2000;

/** Fixed message for the "does this webhook reach that channel?" self-test. */
export const SLACK_TEST_MESSAGE = 'Clockwork test message — this webhook can reach this channel.';

/**
 * Slack treats `&`, `<` and `>` as markup everywhere, including inside a code
 * fence, so a command summary with a redirect or an `<html>` tag renders as a
 * broken link unless it is escaped first (api.slack.com/reference/surfaces/formatting).
 */
export function escapeSlackText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape, then fit a Slack length limit. The cut is taken on the RAW text and
 * re-escaped, so it can never land inside an `&amp;` and leave `&am`.
 */
function slackClip(raw: string, max: number): string {
  let take = Math.min(raw.length, max);
  for (;;) {
    const out = escapeSlackText(raw.slice(0, take));
    if (out.length <= max || take === 0) return out;
    take -= Math.max(1, out.length - max);
  }
}

function stateGlyph(state: string): string {
  switch (state) {
    case 'completed':
      return '✅';
    case 'failed':
      return '❌';
    case 'budget_exceeded':
      return '💸';
    case 'timed_out':
      return '⏱️';
    case 'cancelled':
      return '🚫';
    default:
      return '⏰';
  }
}

export function slackReportMessage(p: RunReportPayload): SlackMessage {
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: slackClip(`${stateGlyph(p.state)} ${p.taskName} — ${p.state.replace(/_/g, ' ')}`, SLACK_HEADER_MAX),
        emoji: true,
      },
    },
  ];
  if (p.failureReason) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackClip(`*Reason:* ${p.failureReason}`, SLACK_SECTION_MAX) } });
  }
  const notes: string[] = [];
  if (p.ranLateMs && p.ranLateMs > 60_000) notes.push(`⏳ Ran ${Math.round(p.ranLateMs / 60000)}m late (machine slept).`);
  if (p.coveredOccurrences?.length) notes.push(`Covers ${p.coveredOccurrences.length} missed occurrence(s).`);
  if (notes.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackClip(notes.join('\n'), SLACK_SECTION_MAX) } });
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackClip(p.summary || '(no summary)', SLACK_SECTION_MAX) } });

  const fields: SlackTextObject[] = [
    { type: 'mrkdwn', text: `*Cost*\n$${p.costUsd.toFixed(2)}` },
    { type: 'mrkdwn', text: `*Turns*\n${p.turns}` },
  ];
  if (p.branch) fields.push({ type: 'mrkdwn', text: slackClip(`*Branch*\n${p.branch}`, SLACK_FIELD_MAX) });
  if (p.profile) fields.push({ type: 'mrkdwn', text: slackClip(`*Agent*\n@${p.profile.slug}`, SLACK_FIELD_MAX) });
  blocks.push({ type: 'section', fields });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: slackClip(`Run \`${p.runId}\``, SLACK_SECTION_MAX) }] });

  return { text: escapeSlackText(formatReportText(p)), blocks };
}

export function slackApprovalMessage(p: ApprovalNotifyPayload): SlackMessage {
  // Slack's date token: every reader sees the deadline in their own timezone,
  // and the text after `|` is what non-Slack surfaces (email digests, exports)
  // fall back to.
  const deadline = `<!date^${Math.floor(p.timeoutAt / 1000)}^{date_short_pretty} at {time}|${new Date(p.timeoutAt).toISOString()}>`;
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: slackClip(`🔒 Approval needed — ${p.taskName}`, SLACK_HEADER_MAX), emoji: true },
    },
    { type: 'section', text: { type: 'mrkdwn', text: slackClip(`*${p.engine}* is waiting to run *${p.tool}*`, SLACK_SECTION_MAX) } },
    { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${slackClip(p.commandSummary, SLACK_SECTION_MAX - 8)}\`\`\`` } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Auto-denies*\n${deadline}` },
        { type: 'mrkdwn', text: slackClip(`*Run*\n\`${p.runId}\``, SLACK_FIELD_MAX) },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: slackClip(`Answer in Clockwork's Inbox — approval \`${p.approvalId}\``, SLACK_SECTION_MAX),
        },
      ],
    },
  ];
  return { text: escapeSlackText(formatApprovalText(p)), blocks };
}

/** Thrown on a non-2xx from the incoming webhook; `description` is Slack's own body ("invalid_token", "channel_not_found"). */
export class SlackApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly description: string | null,
  ) {
    super(`slack ${status}: ${description ?? '(no description)'}`);
    this.name = 'SlackApiError';
  }
}

/** The URL is the credential, so redact it (and its long path segments) out of any text. */
function redactSlackUrl(text: string, url: string): string {
  let out = scrubSecret(text, url);
  try {
    for (const seg of new URL(url).pathname.split('/')) {
      if (seg.length >= 8) out = scrubSecret(out, seg);
    }
  } catch {
    /* not parseable: the whole-URL pass above is all we can do */
  }
  return out;
}

export class SlackChannel implements DeliveryChannel {
  readonly name = 'slack';

  private async post(message: { text: string; blocks?: SlackBlock[] }, cred: DeliveryConfigCred): Promise<void> {
    const url = cred.slackWebhookUrl?.trim();
    if (!url) throw new Error('missing slack webhook url');
    if (!url.startsWith('https://')) throw new Error('slack webhook url must be https');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      });
    } catch (e) {
      throw new Error(redactSlackUrl(describeError(e), url));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SlackApiError(res.status, redactSlackUrl(body.trim().slice(0, 200), url) || null);
    }
  }

  /**
   * `target` is ignored on purpose: one incoming webhook posts to exactly one
   * Slack channel (Slack's model), and letting a task name the URL would put
   * the credential in SQLite. A second Slack destination means a second
   * webhook, configured in Settings.
   */
  async send(payload: RunReportPayload, _target: string, cred: DeliveryConfigCred): Promise<void> {
    await this.post(slackReportMessage(payload), cred);
  }

  async sendApproval(payload: ApprovalNotifyPayload, _target: string, cred: DeliveryConfigCred): Promise<void> {
    await this.post(slackApprovalMessage(payload), cred);
  }

  /** POST /delivery-config/test-slack: a short fixed message, no retry. */
  async sendTest(cred: DeliveryConfigCred): Promise<void> {
    await this.post({ text: SLACK_TEST_MESSAGE }, cred);
  }
}

// ---------- SMTP / email (T-310) — node:net + node:tls, no mail dependency ----------
//
// `plan/03-tech-stack.md` row 13 penciled in nodemailer. No dependency was
// added, because the job is *submission of one plain-text message to the
// user's own relay*, and that is a line protocol Node's standard library
// already reaches: EHLO, opportunistic STARTTLS, AUTH PLAIN/LOGIN, MAIL/RCPT/
// DATA. What this client deliberately does NOT do — and what would make
// nodemailer the right answer if it were ever needed: attachments and
// multipart bodies, HTML alternatives, XOAUTH2/OAuth2, DKIM signing,
// pipelining, connection pooling, DSN/SMTPUTF8, and internationalised
// (non-ASCII) addresses. Delivery, spam scoring and DKIM stay the relay's job,
// which is the same division of labour as the WhatsApp gateway (ADR-018).
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';

/** Fixed message for the "does this relay accept our mail?" self-test. */
export const SMTP_TEST_MESSAGE = 'Clockwork test message — your SMTP relay accepted this mail.';

export interface SmtpEndpoint {
  host: string;
  port: number;
  /** `smtps:` — TLS from the first byte (port 465) rather than STARTTLS (587) */
  implicitTls: boolean;
  user: string | null;
  pass: string | null;
  /** `?allowInsecureAuth=1` — permit AUTH on a cleartext connection */
  allowInsecureAuth: boolean;
}

/**
 * `smtp://user:pass@host:587` / `smtps://user:pass@host:465`. Userinfo is
 * percent-decoded, because a mail password routinely contains `@`, `:` and
 * `/` and a URL cannot carry those raw.
 */
export function parseSmtpUrl(raw: string): SmtpEndpoint {
  const u = new URL(raw); // throws on nonsense, which the caller reports as a receipt
  const scheme = u.protocol.replace(':', '');
  if (scheme !== 'smtp' && scheme !== 'smtps') throw new Error(`unsupported smtp url scheme: ${scheme}`);
  if (!u.hostname) throw new Error('smtp url has no host');
  const implicitTls = scheme === 'smtps';
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : implicitTls ? 465 : 587,
    implicitTls,
    user: u.username ? decodeURIComponent(u.username) : null,
    pass: u.password ? decodeURIComponent(u.password) : null,
    allowInsecureAuth: u.searchParams.get('allowInsecureAuth') === '1',
  };
}

export interface SmtpCapabilities {
  keywords: Set<string>;
  auth: Set<string>;
}

/** Parse an EHLO reply's lines (first line is the greeting) into capabilities. */
export function parseEhloCaps(lines: string[]): SmtpCapabilities {
  const keywords = new Set<string>();
  const auth = new Set<string>();
  for (const rawLine of lines.slice(1)) {
    const parts = rawLine.replace(/^\d{3}[- ]?/, '').trim().split(/\s+/);
    const kw = (parts[0] ?? '').toUpperCase();
    if (!kw) continue;
    // Old sendmail advertises `AUTH=PLAIN LOGIN` beside/instead of `AUTH …`.
    if (kw === 'AUTH' || kw.startsWith('AUTH=')) {
      keywords.add('AUTH');
      const inline = kw.startsWith('AUTH=') ? [kw.slice(5)] : [];
      for (const m of [...inline, ...parts.slice(1)]) if (m) auth.add(m.toUpperCase());
      continue;
    }
    keywords.add(kw);
  }
  return { keywords, auth };
}

interface SmtpReply {
  code: number;
  /** raw lines, code prefixes included */
  lines: string[];
  /** the human half, code prefixes stripped */
  text: string;
}

/**
 * The reply reader — the part a hand-rolled SMTP client gets wrong. A reply is
 * complete only on a line whose code is followed by a SPACE (`250 ok`); a
 * hyphen (`250-PIPELINING`) means more is coming. TCP splits and merges
 * writes freely, so lines are cut out of a rolling buffer rather than taken
 * one-per-`data`-event.
 */
class SmtpWire {
  private sock: net.Socket | tls.TLSSocket;
  private buf = '';
  private lines: string[] = [];
  private queued: SmtpReply[] = [];
  private waiter: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private failure: Error | null = null;
  secure: boolean;

  constructor(
    sock: net.Socket | tls.TLSSocket,
    secure: boolean,
    private readonly timeoutMs: number,
  ) {
    this.sock = sock;
    this.secure = secure;
    this.attach();
  }

  private onData = (chunk: Buffer): void => {
    this.buf += chunk.toString('utf8');
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i < 0) break;
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const lines = this.lines;
        this.lines = [];
        this.deliver({
          code: Number(line.slice(0, 3)),
          lines,
          text: lines.map((l) => l.slice(4)).join(' ').trim(),
        });
      }
    }
  };

  private onError = (e: Error): void => this.fail(e);
  private onClose = (): void => this.fail(new Error('smtp: connection closed by the relay'));

  private attach(): void {
    this.sock.on('data', this.onData);
    this.sock.on('error', this.onError);
    this.sock.on('close', this.onClose);
  }

  private deliver(reply: SmtpReply): void {
    const w = this.waiter;
    if (!w) {
      this.queued.push(reply);
      return;
    }
    this.waiter = null;
    clearTimeout(w.timer);
    w.resolve(reply);
  }

  private fail(e: Error): void {
    this.failure = e;
    const w = this.waiter;
    if (!w) return;
    this.waiter = null;
    clearTimeout(w.timer);
    w.reject(e);
  }

  read(): Promise<SmtpReply> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`smtp: timed out after ${this.timeoutMs}ms waiting for a reply`));
      }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  async cmd(line: string): Promise<SmtpReply> {
    this.write(`${line}\r\n`);
    return this.read();
  }

  write(data: string): void {
    this.sock.write(data);
  }

  /** Hand the raw socket over for a TLS upgrade: no listeners, no buffer. */
  detach(): void {
    this.sock.removeListener('data', this.onData);
    this.sock.removeListener('error', this.onError);
    this.sock.removeListener('close', this.onClose);
  }

  /** Take over the upgraded socket. Anything buffered pre-TLS is discarded (RFC 3207 §4.2). */
  attachTo(sock: net.Socket | tls.TLSSocket): void {
    this.sock = sock;
    this.buf = '';
    this.lines = [];
    this.queued = [];
    this.failure = null;
    this.secure = true;
    this.attach();
  }

  close(): void {
    this.detach();
    this.sock.destroy();
  }
}

function expectCode(reply: SmtpReply, codes: number[]): SmtpReply {
  if (!codes.includes(reply.code)) throw new Error(`smtp ${reply.code}: ${reply.text}`);
  return reply;
}

/** Strict servers reject `localhost`; an address literal is always acceptable. */
function ehloName(): string {
  const h = os.hostname();
  return h && h !== 'localhost' && /^[A-Za-z0-9._-]+$/.test(h) ? h : '[127.0.0.1]';
}

const RFC2822_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC2822_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function rfc2822Date(d: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return (
    `${RFC2822_DAYS[d.getUTCDay()]!}, ${p2(d.getUTCDate())} ${RFC2822_MONTHS[d.getUTCMonth()]!} ${d.getUTCFullYear()} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`
  );
}

/**
 * RFC 2047 B-encoding, always — every Clockwork message starts with an emoji
 * (`⏰`/`🔒`), so a raw Subject would be non-conformant 8-bit. Base64 also
 * makes header injection through a task name structurally impossible: a CR or
 * LF cannot survive the encoding. Long subjects fold into several encoded
 * words of ≤75 chars, split on code points so a multi-byte character is never
 * cut in half.
 */
export function encodeMimeSubject(subject: string): string {
  const clean = subject.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
  const encodeWord = (s: string): string => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
  const MAX_BYTES = 45; // base64(45B) = 60 chars + 12 chars of "=?UTF-8?B??=" = 72 <= 75
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of clean) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > MAX_BYTES) {
      words.push(encodeWord(chunk));
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  words.push(encodeWord(chunk));
  return words.join('\r\n ');
}

/** RFC 5321 §4.5.2: a body line starting with '.' gets a second one, or it ends the message. */
export function dotStuff(body: string): string {
  return body
    .split('\r\n')
    .map((l) => (l.startsWith('.') ? `.${l}` : l))
    .join('\r\n');
}

function base64Body(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

/** Everything an address may not contain if it is going inside `RCPT TO:<…>`. */
function assertAddress(addr: string, what: string): void {
  if (!/^[^\s<>@",;]+@[A-Za-z0-9._-]+$/.test(addr)) {
    throw new Error(`invalid email ${what}: ${addr.replace(/[\r\n]+/g, ' ').slice(0, 80)}`);
  }
}

function parseRecipients(raw: string): string[] {
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error('no email recipient configured');
  for (const a of list) assertAddress(a, 'recipient');
  return list;
}

export function buildMailMessage(o: {
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** mirrors the webhook's payload-schema header, so a filter can route on it */
  schema: string;
  date?: Date;
  messageId?: string;
}): string {
  const host = o.from.split('@')[1] ?? 'clockwork.local';
  const headers = [
    `From: Clockwork <${o.from}>`,
    `To: ${o.to.join(', ')}`,
    `Subject: ${encodeMimeSubject(o.subject)}`,
    `Date: ${rfc2822Date(o.date ?? new Date())}`,
    `Message-ID: <${o.messageId ?? randomUUID()}@${host}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    `X-Clockwork-Schema: ${o.schema}`,
  ];
  return `${headers.join('\r\n')}\r\n\r\n${dotStuff(base64Body(o.text))}`;
}

export interface SmtpChannelOptions {
  /** per-reply/connect timeout in ms (default 20s) */
  timeoutMs?: number;
  /** passed to `tls.connect` — e.g. a CA for a self-hosted relay */
  tlsOptions?: tls.ConnectionOptions;
  /**
   * How a cleartext socket becomes a secure one after STARTTLS. Production is
   * `tls.connect`; the seam exists so the SMTP suite can drive the protocol
   * either side of the upgrade against a plain loopback server rather than
   * committing a test keypair to the repo (same idea as `TelegramChannel(apiBase)`).
   */
  tlsUpgrade?: (
    socket: net.Socket | tls.TLSSocket,
    host: string,
    tlsOptions?: tls.ConnectionOptions,
  ) => Promise<net.Socket | tls.TLSSocket>;
}

function defaultTlsUpgrade(
  socket: net.Socket | tls.TLSSocket,
  host: string,
  tlsOptions?: tls.ConnectionOptions,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const upgraded = tls.connect({ socket, servername: host, ...tlsOptions });
    upgraded.once('secureConnect', () => resolve(upgraded));
    upgraded.once('error', reject);
  });
}

export class SmtpChannel implements DeliveryChannel {
  readonly name = 'email';

  constructor(private readonly options: SmtpChannelOptions = {}) {}

  async send(payload: RunReportPayload, target: string, cred: DeliveryConfigCred): Promise<void> {
    await this.sendMail({
      to: target,
      subject: `[Clockwork] ${payload.taskName} — ${payload.state.replace(/_/g, ' ')}`,
      text: formatReportText(payload),
      schema: 'clockwork.run-report.v1',
      cred,
    });
  }

  async sendApproval(payload: ApprovalNotifyPayload, target: string, cred: DeliveryConfigCred): Promise<void> {
    await this.sendMail({
      to: target,
      subject: `[Clockwork] Approval needed: ${payload.taskName}`,
      text: formatApprovalText(payload),
      schema: 'clockwork.approval-request.v1',
      cred,
    });
  }

  /** POST /delivery-config/test-smtp: one short message, no retry. */
  async sendTest(target: string, cred: DeliveryConfigCred): Promise<void> {
    await this.sendMail({
      to: target,
      subject: '[Clockwork] test message',
      text: SMTP_TEST_MESSAGE,
      schema: 'clockwork.test.v1',
      cred,
    });
  }

  private async sendMail(o: {
    to: string;
    subject: string;
    text: string;
    schema: string;
    cred: DeliveryConfigCred;
  }): Promise<void> {
    if (!o.cred.smtpUrl) throw new Error('missing smtp url');
    const ep = parseSmtpUrl(o.cred.smtpUrl);
    const recipients = parseRecipients(o.to);
    const from = o.cred.smtpFrom?.trim() || (ep.user?.includes('@') ? ep.user : null);
    if (!from) {
      throw new Error('missing smtp from address: set smtpFrom, or use an email address as the SMTP username');
    }
    assertAddress(from, 'from address');
    const message = buildMailMessage({ from, to: recipients, subject: o.subject, text: o.text, schema: o.schema });
    try {
      await this.deliver(ep, from, recipients, message);
    } catch (e) {
      // A relay's own reply text is safe to surface; the password never is.
      throw new Error(scrubSecret(describeError(e), ep.pass));
    }
  }

  private connect(ep: SmtpEndpoint, timeoutMs: number): Promise<net.Socket | tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const socket = ep.implicitTls
        ? tls.connect({ host: ep.host, port: ep.port, servername: ep.host, ...this.options.tlsOptions })
        : net.connect({ host: ep.host, port: ep.port });
      socket.on('error', () => {
        /* kept for the whole life of the socket: an 'error' with no listener is fatal to the process */
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`smtp: timed out after ${timeoutMs}ms connecting to ${ep.host}:${ep.port}`));
      }, timeoutMs);
      socket.once(ep.implicitTls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (e: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(e);
      });
    });
  }

  private async deliver(ep: SmtpEndpoint, from: string, to: string[], message: string): Promise<void> {
    const timeoutMs = this.options.timeoutMs ?? 20_000;
    const socket = await this.connect(ep, timeoutMs);
    const wire = new SmtpWire(socket, ep.implicitTls, timeoutMs);
    try {
      expectCode(await wire.read(), [220]);
      let caps = parseEhloCaps(expectCode(await wire.cmd(`EHLO ${ehloName()}`), [250]).lines);

      if (!wire.secure && caps.keywords.has('STARTTLS')) {
        expectCode(await wire.cmd('STARTTLS'), [220]);
        wire.detach();
        const upgrade = this.options.tlsUpgrade ?? defaultTlsUpgrade;
        wire.attachTo(await upgrade(socket, ep.host, this.options.tlsOptions));
        // AUTH is normally advertised only after TLS, so the greeting is redone.
        caps = parseEhloCaps(expectCode(await wire.cmd(`EHLO ${ehloName()}`), [250]).lines);
      }

      if (ep.user !== null && ep.pass !== null) {
        if (!wire.secure && !ep.allowInsecureAuth) {
          throw new Error(
            'smtp: refusing to send credentials over an unencrypted connection — use smtps://, a relay that offers STARTTLS, or add ?allowInsecureAuth=1 for a trusted local relay',
          );
        }
        const mech = caps.auth.has('PLAIN') ? 'PLAIN' : caps.auth.has('LOGIN') ? 'LOGIN' : null;
        if (!mech) throw new Error('smtp: relay advertises no AUTH mechanism this client speaks (PLAIN or LOGIN)');
        if (mech === 'PLAIN') {
          const token = Buffer.from(`\u0000${ep.user}\u0000${ep.pass}`, 'utf8').toString('base64');
          expectCode(await wire.cmd(`AUTH PLAIN ${token}`), [235]);
        } else {
          expectCode(await wire.cmd('AUTH LOGIN'), [334]);
          expectCode(await wire.cmd(Buffer.from(ep.user, 'utf8').toString('base64')), [334]);
          expectCode(await wire.cmd(Buffer.from(ep.pass, 'utf8').toString('base64')), [235]);
        }
      }

      expectCode(await wire.cmd(`MAIL FROM:<${from}>`), [250]);
      for (const rcpt of to) expectCode(await wire.cmd(`RCPT TO:<${rcpt}>`), [250, 251]);
      expectCode(await wire.cmd('DATA'), [354]);
      wire.write(`${message}\r\n.\r\n`);
      expectCode(await wire.read(), [250]);
      try {
        await wire.cmd('QUIT');
      } catch {
        /* the message is queued; a missing 221 is not a delivery failure */
      }
    } finally {
      wire.close();
    }
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

/**
 * Mask a Slack incoming-webhook URL for display: the workspace host, then a
 * peek of the last path segment. The path IS the secret, so no segment is ever
 * shown whole. Never throws on a malformed value.
 */
export function maskSlackWebhookUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    return `${u.host}/…/${last ? peek(last, 3, 3) : '…'}`;
  } catch {
    return peek(url, 4, 3);
  }
}

/**
 * Mask an SMTP endpoint for display — scheme, username and host:port, never
 * the password. The port is resolved so the display matches what will actually
 * be dialled.
 */
export function maskSmtpUrl(url: string): string {
  try {
    const ep = parseSmtpUrl(url);
    return `${ep.implicitTls ? 'smtps' : 'smtp'}://${ep.user ? `${ep.user}@` : ''}${ep.host}:${ep.port}`;
  } catch {
    return '(unreadable smtp url)';
  }
}

export function channelFor(name: string): DeliveryChannel | null {
  switch (name) {
    case 'os':
      return new OsChannel();
    case 'telegram':
      return new TelegramChannel();
    case 'webhook':
      return new WebhookChannel();
    case 'slack':
      return new SlackChannel();
    case 'email':
      return new SmtpChannel();
    default:
      return null;
  }
}
