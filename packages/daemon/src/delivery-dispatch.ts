/**
 * Delivery dispatch (FR-18/S-43): daemon-side; runs after report persistence;
 * failures recorded as receipts, never affecting run outcome.
 */
import { readFileSync } from 'node:fs';
import type { DeliveryConfig } from '@clockwork/shared';
import { channelFor, withRetry, type DeliveryReceiptT, type RunReportPayload } from './delivery.js';

/** Credential source: OS keychain lands with the Tauri step; env/file bridge for v1 CLI use. */
function loadCreds(dataDir: string): Record<string, string> {
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
  return out;
}

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

  const creds = loadCreds(dataDir);

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
