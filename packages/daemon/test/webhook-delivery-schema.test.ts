/**
 * T1-10: the schema half of "an outbound webhook's URL gets a screen".
 *
 * `DeliveryConfig.webhook` (packages/shared/src/schemas.ts) and
 * `selectedChannels()` reading `cfg.webhook.url` (delivery-dispatch.ts) have
 * both worked since T-211/ADR-018 — proven end to end, including the full
 * send/receipt path, by `delivery-channels.test.ts`. Unlike quiet hours
 * (T1-8), the schema and the dispatch fan-out were never the bug here: only
 * the SCREEN was missing — ComposerView.tsx had a Telegram chat id field and
 * no webhook URL field, even though `POST /tasks` always accepted one.
 *
 * What `delivery-channels.test.ts` does not exercise is the boundary the
 * composer actually writes through: `TaskCreate`, the schema `POST /tasks`
 * validates a booking against. This file closes exactly that one gap — the
 * same join `quiet-hours-schema.test.ts` holds for `quietHours` — proof that
 * what a caller sends through `TaskCreate` survives to `delivery.webhook.url`
 * unchanged, not merely that `DeliveryConfig` alone accepts it. Kept small and
 * non-duplicative of `delivery-channels.test.ts` on purpose.
 *
 * Neither this file nor its UI sibling
 * (`packages/ui/test/composer-webhook-url.test.tsx`) touches any of the
 * twelve F1–F12 feature suites `claims-honesty.test.ts` counts.
 */
import { describe, expect, it } from 'vitest';
import { TaskCreate } from '@clockwork/shared';

describe('TaskCreate round-trips delivery.webhook.url — the schema POST /tasks validates against', () => {
  const base = {
    name: 'Ship an alert',
    prompt: 'Do the thing.',
    schedule: { kind: 'once' as const, runAt: Date.now() + 3_600_000, tz: 'UTC' },
  };

  it('a webhook URL entered alongside Telegram survives parsing untouched', () => {
    const parsed = TaskCreate.parse({
      ...base,
      delivery: {
        telegram: { chatId: '12345' },
        webhook: { url: 'https://hooks.example.com/clockwork' },
      },
    });
    expect(parsed.delivery.webhook).toEqual({ url: 'https://hooks.example.com/clockwork' });
    expect(parsed.delivery.telegram).toEqual({ chatId: '12345' });
  });

  it('rejects a non-URL string rather than silently accepting or stripping it', () => {
    const result = TaskCreate.safeParse({ ...base, delivery: { webhook: { url: 'not-a-url' } } });
    expect(result.success).toBe(false);
  });

  it('a task with no webhook still gets the pre-existing default delivery shape unchanged', () => {
    const parsed = TaskCreate.parse(base);
    expect(parsed.delivery).toEqual({ osNotify: true });
  });

  it('composes alongside slack and email, all three surviving together', () => {
    const parsed = TaskCreate.parse({
      ...base,
      delivery: {
        webhook: { url: 'https://hooks.example.com/clockwork' },
        slack: { enabled: true },
        email: { to: ['dana@example.com'] },
      },
    });
    expect(parsed.delivery.webhook).toEqual({ url: 'https://hooks.example.com/clockwork' });
    expect(parsed.delivery.slack).toEqual({ enabled: true });
    expect(parsed.delivery.email).toEqual({ to: ['dana@example.com'] });
  });
});
