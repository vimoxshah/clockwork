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

// ---------- Telegram Bot API (T-211) — plain fetch, no lib ----------
export class TelegramChannel implements DeliveryChannel {
  readonly name = 'telegram';

  private async post(text: string, chatId: string, cred: DeliveryConfigCred): Promise<void> {
    if (!cred.telegramBotToken) throw new Error('missing telegram bot token');
    const res = await fetch(`https://api.telegram.org/bot${cred.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`telegram ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  async send(payload: RunReportPayload, chatId: string, cred: DeliveryConfigCred): Promise<void> {
    await this.post(formatReportText(payload), chatId, cred);
  }

  async sendApproval(payload: ApprovalNotifyPayload, chatId: string, cred: DeliveryConfigCred): Promise<void> {
    await this.post(formatApprovalText(payload), chatId, cred);
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
 * keychain lands with the Tauri step). Duplicated here rather than imported
 * from delivery-dispatch.ts (out of scope for this change) — both read the
 * identical `CLOCKWORK_DELIVER_*` env prefix and `delivery-creds.json` file.
 */
import { readFileSync } from 'node:fs';

export function loadDeliveryCreds(dataDir: string): DeliveryConfigCred {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLOCKWORK_DELIVER_') && v) {
      out[k.replace('CLOCKWORK_DELIVER_', '').toLowerCase()] = v;
    }
  }
  try {
    const f = JSON.parse(readFileSync(`${dataDir}/delivery-creds.json`, 'utf8'));
    if (f && typeof f === 'object') Object.assign(out, f);
  } catch {}
  return out as DeliveryConfigCred;
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
