/**
 * Delivery dispatch (FR-18/S-43): daemon-side; runs after report persistence;
 * failures recorded as receipts, never affecting run outcome.
 */
import type { DeliveryConfig } from '@clockwork/shared';
import { channelFor, loadDeliveryCreds, withRetry, type DeliveryReceiptT, type RunReportPayload } from './delivery.js';

export async function deliverReport(
  dataDir: string,
  taskId: string,
  taskDeliveryJson: string,
  payload: RunReportPayload,
): Promise<DeliveryReceiptT[]> {
  const receipts: DeliveryReceiptT[] = [];
  let cfg: DeliveryConfig = { osNotify: true };
  try {
    cfg = JSON.parse(taskDeliveryJson || '{}');
  } catch {}

  const creds = loadDeliveryCreds(dataDir);

  // os channel handled by notifier already when enabled; chat/webhook here:
  const jobs: Array<Promise<void>> = [];
  if (cfg.telegram?.chatId) {
    const ch = channelFor('telegram');
    if (ch) {
      jobs.push(
        withRetry(() => ch.send(payload, cfg.telegram!.chatId, creds)).then((r) => {
          receipts.push({ ...r, channel: "telegram" });
        }),
      );
    }
  }
  if (cfg.webhook?.url) {
    const ch = channelFor('webhook');
    if (ch) {
      jobs.push(
        withRetry(() => ch.send(payload, cfg.webhook!.url, creds)).then((r) => {
          receipts.push({ ...r, channel: "webhook" });
        }),
      );
    }
  }
  await Promise.all(jobs);
  void taskId;
  return receipts;
}
