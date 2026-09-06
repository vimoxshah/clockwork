/**
 * Reachable approvals — inbound half (ADR-036): the daemon long-polls the
 * Telegram Bot API's getUpdates for callback_query events (inline-keyboard
 * taps on the message TelegramChannel.sendApproval already sent) and resolves
 * them through the exact same RunManager.respondToApproval the local API
 * route uses.
 *
 * Outbound-only by construction: this is a client of api.telegram.org, never
 * a server. The daemon keeps binding 127.0.0.1 (docs/security.md) — nothing
 * here opens a port or accepts an inbound connection.
 */
import type { DB } from './db.js';
import { taskDeliveryJsonOf, type RunManager } from './run-manager.js';

const DEFAULT_API_BASE = 'https://api.telegram.org';
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const LONG_POLL_TIMEOUT_SEC = 30;

export interface TelegramApprovalsPollerDeps {
  db: DB;
  runManager: Pick<RunManager, 'respondToApproval'>;
  botToken: string;
  /** Override for tests — points the poller at a local HTTP stub. */
  apiBase?: string;
  /** Defaults to console.error; injectable so tests can assert on log calls. */
  log?: (msg: string) => void;
}

interface TgUpdate {
  update_id: number;
  callback_query?: TgCallbackQuery;
}

interface TgCallbackQuery {
  id: string;
  data?: string;
  from?: { id?: number | string };
  message?: { message_id?: number; chat?: { id?: number | string; type?: string } };
}

/** Thrown by getUpdates on HTTP 409 (webhook set, or another poller owns this token). */
class TelegramConflictError extends Error {}

/** Thrown internally when a fetch aborts because stop() was called — never a real network error. */
class PollerStoppedError extends Error {}

function readOffset(db: DB): number {
  const row = db.prepare('SELECT "offset" FROM telegram_poll_state WHERE id=1').get() as { offset: number } | undefined;
  return row?.offset ?? 0;
}

function writeOffset(db: DB, offset: number): void {
  db.prepare(
    `INSERT INTO telegram_poll_state (id, "offset") VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET "offset" = excluded."offset"`,
  ).run(offset);
}

export class TelegramApprovalsPoller {
  private readonly db: DB;
  private readonly runManager: Pick<RunManager, 'respondToApproval'>;
  private readonly botToken: string;
  private readonly apiBase: string;
  private readonly log: (msg: string) => void;

  private readonly shutdown = new AbortController();
  private stopped = false;
  private loopPromise: Promise<void> | null = null;

  constructor(deps: TelegramApprovalsPollerDeps) {
    this.db = deps.db;
    this.runManager = deps.runManager;
    this.botToken = deps.botToken;
    this.apiBase = deps.apiBase ?? DEFAULT_API_BASE;
    this.log = deps.log ?? ((msg) => process.stderr.write(`[telegram-approvals] ${msg}\n`));
  }

  /** Fire-and-forget: starts the long-poll loop. Never throws. */
  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.loop().catch((e) => {
      this.log(`loop crashed unexpectedly: ${String(e)}`);
    });
  }

  /** Stops the loop (aborts any in-flight request/backoff sleep) and waits for it to exit. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.shutdown.abort();
    await this.loopPromise?.catch(() => {});
  }

  private async loop(): Promise<void> {
    let offset = readOffset(this.db);
    let backoffMs = MIN_BACKOFF_MS;
    while (!this.stopped) {
      let updates: TgUpdate[];
      try {
        updates = await this.getUpdates(offset);
      } catch (e) {
        if (e instanceof PollerStoppedError) break;
        if (e instanceof TelegramConflictError) {
          this.log(
            '409 Conflict from getUpdates — a webhook is set, or another process already owns this bot token. ' +
              'Stopping the poller for this daemon run (notify-only mode); it retries on next daemon start.',
          );
          break;
        }
        this.log(`getUpdates failed, retrying in ${backoffMs}ms: ${String(e)}`);
        await this.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        continue;
      }
      backoffMs = MIN_BACKOFF_MS;

      for (const update of updates) {
        if (this.stopped) break;
        try {
          if (update.callback_query) {
            await this.handleCallback(update.callback_query);
          }
        } catch (e) {
          this.log(`error handling callback_query (update ${update.update_id}): ${String(e)}`);
        }
        offset = update.update_id + 1;
        writeOffset(this.db, offset);
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.shutdown.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async getUpdates(offset: number): Promise<TgUpdate[]> {
    const params = new URLSearchParams({
      offset: String(offset),
      timeout: String(LONG_POLL_TIMEOUT_SEC),
      allowed_updates: JSON.stringify(['callback_query']),
    });
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}/bot${this.botToken}/getUpdates?${params.toString()}`, {
        signal: this.shutdown.signal,
      });
    } catch (e) {
      if (this.shutdown.signal.aborted) throw new PollerStoppedError();
      throw e;
    }
    if (res.status === 409) throw new TelegramConflictError();
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`getUpdates ${res.status}: ${body.slice(0, 200)}`);
    }
    const parsed = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
    return parsed.result ?? [];
  }

  private async answerCallbackQuery(id: string, text: string): Promise<void> {
    try {
      await fetch(`${this.apiBase}/bot${this.botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callback_query_id: id, text }),
      });
    } catch (e) {
      this.log(`answerCallbackQuery failed: ${String(e)}`);
    }
  }

  private async editMessageReplyMarkup(chatId: number | string, messageId: number | undefined): Promise<void> {
    if (messageId === undefined) return;
    try {
      await fetch(`${this.apiBase}/bot${this.botToken}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
      });
    } catch (e) {
      this.log(`editMessageReplyMarkup failed: ${String(e)}`);
    }
  }

  /**
   * Trust boundary (ADR-036): a callback is honoured ONLY when it arrives on
   * the exact chat the task's delivery config names, and — for a group or
   * supergroup, where anyone present could tap the button — only when the
   * pressing user is also on that task's `telegram.allowedUserIds`. No list
   * configured for a group chat means refuse every callback there.
   */
  private async handleCallback(cq: TgCallbackQuery): Promise<void> {
    const data = String(cq.data ?? '');
    const m = /^([ad]):([0-9A-Za-z]{26})$/.exec(data);
    if (!m) {
      await this.answerCallbackQuery(cq.id, 'Not allowed');
      this.log(`refused callback_query ${cq.id}: unrecognized callback_data`);
      return;
    }
    const decision: 'approved' | 'denied' = m[1] === 'a' ? 'approved' : 'denied';
    const approvalId = m[2]!;

    const approvalRow = this.db.prepare('SELECT run_id FROM approvals WHERE id=?').get(approvalId) as
      | { run_id: string }
      | undefined;
    if (!approvalRow) {
      await this.answerCallbackQuery(cq.id, 'Not found');
      return;
    }
    const runRow = this.db.prepare('SELECT task_id FROM runs WHERE id=?').get(approvalRow.run_id) as
      | { task_id: string }
      | undefined;

    const chat = cq.message?.chat;
    if (!runRow || !chat || chat.id === undefined) {
      await this.answerCallbackQuery(cq.id, 'Not allowed');
      this.log(`refused callback_query ${cq.id}: no message/chat on the callback, or the run's task is gone`);
      return;
    }

    let cfg: { telegram?: { chatId?: string; allowedUserIds?: Array<string | number> } } = {};
    try {
      cfg = JSON.parse(taskDeliveryJsonOf(this.db, runRow.task_id) || '{}');
    } catch {
      /* malformed delivery_json — treated as no telegram config below, refuse */
    }
    const configuredChatId = cfg.telegram?.chatId;
    const chatId = String(chat.id);
    if (!configuredChatId || String(configuredChatId) !== chatId) {
      await this.answerCallbackQuery(cq.id, 'Not allowed');
      this.log(`refused callback_query ${cq.id}: chat ${chatId} does not match the task's configured Telegram chat`);
      return;
    }
    if (chat.type === 'group' || chat.type === 'supergroup') {
      const allowed = cfg.telegram?.allowedUserIds;
      const fromId = cq.from?.id === undefined ? undefined : String(cq.from.id);
      const isAllowed = Array.isArray(allowed) && fromId !== undefined && allowed.map(String).includes(fromId);
      if (!isAllowed) {
        await this.answerCallbackQuery(cq.id, 'Not allowed');
        this.log(`refused callback_query ${cq.id}: user ${fromId ?? '?'} not on the group's telegram.allowedUserIds`);
        return;
      }
    }

    const result = this.runManager.respondToApproval(approvalId, decision, {
      kind: 'telegram',
      userId: String(cq.from?.id ?? ''),
      chatId,
    });
    switch (result.status) {
      case 'resolved':
      case 'run_gone':
        await this.answerCallbackQuery(cq.id, decision === 'approved' ? 'Approved' : 'Denied');
        await this.editMessageReplyMarkup(chat.id, cq.message?.message_id);
        break;
      case 'already_resolved':
        await this.answerCallbackQuery(cq.id, 'Already resolved');
        break;
      case 'not_found':
        await this.answerCallbackQuery(cq.id, 'Not found');
        break;
    }
  }
}
