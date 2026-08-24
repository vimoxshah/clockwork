/**
 * Event triggers (goal #27): inbound webhook events fire tasks.
 *
 * EVENT -> RULE -> AGENT -> APPROVAL -> RESULT
 *
 * A trigger binds an inbound event source to a task. When a matching event
 * arrives, the task is enqueued exactly like run-now (same policy gates,
 * same budget, same audit trail). The raw event payload is stored with the
 * run and available to prompts via {{event.*}} placeholders.
 *
 * Sources shipped: 'webhook' (any external system) + 'github' (x-hub-signature
 * verified). HMAC secrets are stored in the DB only as SHA-256 hashes —
 * never plaintext.
 */
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

export type TriggerSource = 'webhook' | 'github';

export interface TriggerRow {
  id: string;
  name: string;
  source: TriggerSource;
  /** match filter applied to the event payload (dot-path -> expected value) */
  filter_json: string | null;
  secret_hash: string | null; // sha256 of shared secret; null = unauthenticated
  task_id: string;
  enabled: number;
  created_at: number;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time verification of GitHub's x-hub-signature-256. */
export function verifyGithubSignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const mac = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  let given: Buffer;
  try {
    given = Buffer.from(signatureHeader.slice(7), 'hex');
  } catch {
    return false;
  }
  return given.length === mac.length && timingSafeEqual(given, mac);
}

/** Generic bearer-style check for plain webhooks. */
export function verifyWebhookSecret(provided: string | undefined, secretHash: string): boolean {
  if (!provided) return false;
  return hashSecret(provided) === secretHash;
}

/**
 * Dot-path filter: { 'action': 'opened', 'pull_request.user.login': 'octocat' }
 * returns true iff every path in the payload resolves to the expected value.
 */
export function matchesFilter(payload: unknown, filterJson: string | null): boolean {
  if (!filterJson) return true;
  let filter: Record<string, unknown>;
  try {
    filter = JSON.parse(filterJson);
  } catch {
    return false;
  }
  const resolve = (obj: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  return Object.entries(filter).every(([path, expected]) => resolve(payload, path) === expected);
}
