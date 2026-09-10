/**
 * T1-8: the schema half of "quiet hours gets a setter".
 *
 * `scheduler.ts:readQuietHours` has read `delivery_json.quietHours` since
 * ADR-030, but `DeliveryConfig` never carried the key — zod strips unknown
 * keys by default, so the value was dropped on every write and only a direct
 * SQLite write could ever set it. This suite proves the round trip now holds:
 * what a caller sends survives `DeliveryConfig`/`TaskCreate` parsing intact,
 * not merely that the inferred TS type has grown a `quietHours` member (a
 * type can claim a field while the runtime schema still strips its value —
 * that mismatch is exactly the bug this closes, so every assertion here is on
 * the parsed VALUE, never on `typeof`/a type-only check).
 *
 * The scheduler-reachability half — that a `quietHours` value seeded into
 * `delivery_json` actually makes the running `Scheduler` defer a due fire —
 * lives in the sibling file `quiet-hours-deferral.test.ts`. Neither file
 * touches `quiet-hours.test.ts` (pure window-math only) or any of the twelve
 * F1–F12 feature suites `claims-honesty.test.ts` counts.
 */
import { describe, expect, it } from 'vitest';
import { DeliveryConfig, TaskCreate } from '@clockwork/shared';

describe('DeliveryConfig accepts and round-trips quietHours', () => {
  it('parses a quietHours value and returns it unchanged — not stripped as an unknown key', () => {
    const input = { osNotify: true, quietHours: { startHour: 23, endHour: 7 } };
    const parsed = DeliveryConfig.parse(input);
    expect(parsed.quietHours).toEqual({ startHour: 23, endHour: 7 });
  });

  it('leaves quietHours undefined when the caller sends none — no invented default window', () => {
    const parsed = DeliveryConfig.parse({});
    expect(parsed.quietHours).toBeUndefined();
  });

  it('rejects an out-of-range hour rather than silently clamping or stripping it', () => {
    const tooHigh = DeliveryConfig.safeParse({ quietHours: { startHour: 24, endHour: 7 } });
    expect(tooHigh.success).toBe(false);
    const negative = DeliveryConfig.safeParse({ quietHours: { startHour: -1, endHour: 7 } });
    expect(negative.success).toBe(false);
  });

  it('rejects a non-integer hour', () => {
    const result = DeliveryConfig.safeParse({ quietHours: { startHour: 2.5, endHour: 7 } });
    expect(result.success).toBe(false);
  });

  it('does not disturb the other delivery channels sent alongside it', () => {
    const input = {
      telegram: { chatId: '12345' },
      quietHours: { startHour: 23, endHour: 7 },
    };
    const parsed = DeliveryConfig.parse(input);
    expect(parsed.telegram).toEqual({ chatId: '12345' });
    expect(parsed.quietHours).toEqual({ startHour: 23, endHour: 7 });
  });

  it('round-trips through TaskCreate — the schema POST /tasks and PATCH /tasks actually validate against', () => {
    const body = {
      name: 'Nightly sweep',
      prompt: 'Do the thing.',
      schedule: { kind: 'once' as const, runAt: Date.now() + 3_600_000, tz: 'America/New_York' },
      delivery: { quietHours: { startHour: 23, endHour: 7 } },
    };
    const parsed = TaskCreate.parse(body);
    expect(parsed.delivery.quietHours).toEqual({ startHour: 23, endHour: 7 });
  });

  it('a task with no quietHours still gets the pre-existing default delivery shape unchanged', () => {
    const body = {
      name: 'Nightly sweep',
      prompt: 'Do the thing.',
      schedule: { kind: 'once' as const, runAt: Date.now() + 3_600_000, tz: 'UTC' },
    };
    const parsed = TaskCreate.parse(body);
    expect(parsed.delivery).toEqual({ osNotify: true });
  });

  it('TaskCreate rejects an invalid quietHours the same way DeliveryConfig does', () => {
    const body = {
      name: 'Nightly sweep',
      prompt: 'Do the thing.',
      schedule: { kind: 'once' as const, runAt: Date.now() + 3_600_000, tz: 'UTC' },
      delivery: { quietHours: { startHour: 23, endHour: 24 } },
    };
    const result = TaskCreate.safeParse(body);
    expect(result.success).toBe(false);
  });
});
