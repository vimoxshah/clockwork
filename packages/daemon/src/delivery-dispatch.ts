/**
 * Delivery dispatch (FR-18/S-43): daemon-side; runs after report persistence;
 * failures recorded as receipts, never affecting run outcome.
 *
 * One fan-out for both directions — run outcomes (`deliverReport`) and
 * approval requests (`deliverApproval`) — so a channel can never be wired for
 * reports and silently missing for the approval a human is waiting on, which
 * is what happened while the fan-out lived in two places (run-manager.ts held
 * its own copy for approvals).
 */
import type { DeliveryConfig } from '@clockwork/shared';
import {
  channelFor,
  loadDeliveryCreds,
  withRetry,
  type ApprovalNotifyPayload,
  type ChannelTarget,
  type DeliveryChannel,
  type DeliveryConfigCred,
  type DeliveryReceiptT,
  type RunReportPayload,
} from './delivery.js';

/**
 * Which channels one task's config selects, and the target each one needs.
 * Order is stable so a receipt list reads the same way every time.
 *
 * The `os` channel is absent by design: the daemon's native notifier fires it
 * directly (main.ts/run-manager.ts) because it must work with the UI closed.
 * Slack's target is empty — its destination is the credential (one incoming
 * webhook posts to one channel), so nothing about it belongs in a task row.
 */
export function selectedChannels(cfg: DeliveryConfig): ChannelTarget[] {
  const out: ChannelTarget[] = [];
  if (cfg.telegram?.chatId) out.push({ channel: 'telegram', to: cfg.telegram.chatId });
  if (cfg.webhook?.url) out.push({ channel: 'webhook', to: cfg.webhook.url });
  if (cfg.slack && cfg.slack.enabled !== false) out.push({ channel: 'slack', to: '' });
  if (cfg.email?.to?.length) out.push({ channel: 'email', to: cfg.email.to.join(',') });
  return out;
}

function parseConfig(taskDeliveryJson: string): DeliveryConfig {
  try {
    const parsed = JSON.parse(taskDeliveryJson || '{}');
    if (parsed && typeof parsed === 'object') return parsed as DeliveryConfig;
  } catch {
    /* a corrupt row must not stop the notification going out on other channels */
  }
  return { osNotify: true };
}

/**
 * Send through every selected channel in parallel, retrying each per S-43 and
 * turning the outcome into a receipt. Never throws: a transport is not allowed
 * to affect the run or the decision path.
 */
async function fanOut(
  dataDir: string,
  taskDeliveryJson: string,
  send: (ch: DeliveryChannel, target: string, cred: DeliveryConfigCred) => Promise<void>,
): Promise<DeliveryReceiptT[]> {
  const targets = selectedChannels(parseConfig(taskDeliveryJson));
  if (targets.length === 0) return [];
  const creds = loadDeliveryCreds(dataDir);
  const receipts: DeliveryReceiptT[] = [];
  await Promise.all(
    targets.map(async ({ channel, to }) => {
      const ch = channelFor(channel);
      if (!ch) return;
      const r = await withRetry(() => send(ch, to, creds));
      receipts.push({ ...r, channel });
    }),
  );
  return receipts;
}

export async function deliverReport(
  dataDir: string,
  taskId: string,
  taskDeliveryJson: string,
  payload: RunReportPayload,
): Promise<DeliveryReceiptT[]> {
  const receipts = await fanOut(dataDir, taskDeliveryJson, (ch, target, cred) => ch.send(payload, target, cred));
  void taskId;
  return receipts;
}

/**
 * Reachable approvals, outbound half: push the permission request itself to
 * every configured channel. The OS notification is fired by the caller (it
 * rides the daemon's native notifier), and failures here are recorded as a run
 * event by the caller, never surfaced to the decision path.
 */
export async function deliverApproval(
  dataDir: string,
  taskDeliveryJson: string,
  payload: ApprovalNotifyPayload,
): Promise<DeliveryReceiptT[]> {
  return fanOut(dataDir, taskDeliveryJson, (ch, target, cred) => ch.sendApproval(payload, target, cred));
}
