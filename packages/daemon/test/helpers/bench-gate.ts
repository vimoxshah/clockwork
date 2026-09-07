/**
 * The opt-in gate for wall-clock assertions in `workforce-bench.test.ts`.
 *
 * WHY THIS EXISTS
 *   A latency bound asserted inside the default `pnpm test` makes the suite's
 *   colour a property of the machine, not of the code. Measured on 2026-09-06
 *   on one Apple M4, one commit, inside 90 minutes: six runs of this bench
 *   under `CLOCKWORK_BENCH_ASSERT=1` split three red and three green. The red
 *   ones came at `uptime` load averages of 12.5-27.1 and measured the S-64
 *   year view at 623.17 / 684.26 / 579.59ms; the green ones came at load
 *   7.4-7.9 and measured 383.93 / 376.56 / 349.59ms against the same 500ms
 *   bound. The default `pnpm test` stayed green throughout. A red build that
 *   means "your laptop was busy" trains people to ignore red.
 *
 * WHAT IT DOES
 *   Every wall-clock bound in the bench goes through `assertLatency`. By
 *   default it MEASURES, PRINTS the number and PRINTS the verdict against the
 *   bound, and does not fail. With `CLOCKWORK_BENCH_ASSERT=1` it asserts the
 *   bound, so a performance run can still turn red on a real regression.
 *
 *   Correctness assertions are never gated: row counts, corpus integrity,
 *   HTTP status codes and response shape assert unconditionally in both modes.
 *
 * NOT A TEST FILE
 *   `packages/daemon/vitest.config.ts` collects only files ending in
 *   `.test.ts`, so this module is never run as a suite. It is unit-tested
 *   from `claims-honesty.test.ts`.
 */
import { expect } from 'vitest';

/** Set this to `1` (or `true`) to assert the bounds instead of reporting them. */
export const LATENCY_ASSERT_ENV = 'CLOCKWORK_BENCH_ASSERT';

/** True when the caller opted in to hard wall-clock assertions. */
export function latencyAssertionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[LATENCY_ASSERT_ENV];
  return v === '1' || v === 'true';
}

/**
 * Assert a measured duration against a claimed bound — but only when the
 * caller opted in. Returns whether the measurement was inside the bound, which
 * is true or false in BOTH modes: the number is the benchmark's product and is
 * reported either way.
 */
export function assertLatency(label: string, actualMs: number, boundMs: number): boolean {
  const within = actualMs < boundMs;
  if (latencyAssertionsEnabled()) {
    expect(actualMs, `${label}: ${actualMs.toFixed(2)}ms against a ${boundMs}ms bound`).toBeLessThan(boundMs);
    return within;
  }
  console.info(
    `[bench] ${label}: ${actualMs.toFixed(2)}ms vs ${boundMs}ms bound — ${within ? 'WITHIN' : 'EXCEEDED'} ` +
      `(measured, not asserted; set ${LATENCY_ASSERT_ENV}=1 to assert)`,
  );
  return within;
}
