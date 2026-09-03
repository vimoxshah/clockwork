/**
 * Every engine runner must get its child env from buildRunEnv(), and must not
 * widen it afterwards.
 *
 * This is the companion to run-env-allowlist.test.ts, which proves the
 * allowlist FUNCTION is airtight by feeding it a hostile env. That behavioural
 * test cannot see a runner that calls buildRunEnv() and then spreads
 * process.env over the result, or one that builds its own env object and never
 * calls it at all. Both would silently falsify the published claim.
 *
 * So this file checks the WIRING, by reading the runner sources. It stays
 * private to this repo: it names internal files, whereas run-env.ts and its
 * behavioural test are published for auditing.
 *
 * Listed explicitly, never globbed — a guard that discovers its own inputs
 * goes quiet exactly when a file is renamed out from under it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const RUNNERS = ['claude-cli-runner.ts', 'codex-runner.ts', 'opencode-runner.ts', 'hermes-runner.ts'];

const read = (f: string): string => readFileSync(resolve(SRC, f), 'utf8');

describe('runner env wiring', () => {
  it('finds every runner it claims to guard', () => {
    for (const f of RUNNERS) {
      expect(existsSync(resolve(SRC, f)), `${f} is gone — this guard is now blind to it`).toBe(true);
    }
    expect(RUNNERS.length).toBe(4);
  });

  it('builds every run env through buildRunEnv()', () => {
    const offenders = RUNNERS.filter((f) => !/buildRunEnv\(/.test(read(f)));
    expect(offenders, `runners not using the shared allowlist: ${offenders.join(', ')}`).toEqual([]);
  });

  it('never spreads process.env into a spawned child', () => {
    // The single change that would break the published claim outright.
    const offenders = RUNNERS.filter((f) => /\.\.\.process\.env/.test(read(f)));
    expect(offenders, `runners spreading process.env: ${offenders.join(', ')}`).toEqual([]);
  });

  it('never hand-rolls an env object alongside the shared one', () => {
    // Catches a runner that keeps buildRunEnv() for one spawn and assembles a
    // second env literal for another.
    const offenders = RUNNERS.filter((f) => /env(:\s*Record<string, string>)?\s*=\s*\{\s*$/m.test(read(f)));
    expect(offenders, `runners declaring their own env object: ${offenders.join(', ')}`).toEqual([]);
  });
});
