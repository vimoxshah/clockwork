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

/**
 * Sandbox wiring. sandbox.ts and its escape suite prove the PROFILE contains
 * a process; nothing below proves a production run is ever inside one. Until
 * this block existed, no runner was — `new ClaudeCliRunner()` at the
 * runner-child call site passed no spec, and the other engines had no hook at
 * all — while docs/security.md said "every run executes inside a per-run
 * macOS Seatbelt profile". Same source-reading approach as above, same reason.
 */
const RUNNER_CHILD = resolve(SRC, '../../daemon/src/runner-child.ts');
const API_AGENT = 'api-agent-runner.ts';

describe('sandbox wiring', () => {
  it('every engine runner routes its argv through the shared sandbox helper', () => {
    const offenders = RUNNERS.filter((f) => !/applySandbox\(/.test(read(f)));
    expect(offenders, `runners that never wrap with sandbox-exec: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the BYOK api-agent shell also routes through the sandbox helper and the env allowlist', () => {
    const src = read(API_AGENT);
    expect(/applySandbox\(/.test(src), 'api-agent-runner never wraps its bash in sandbox-exec').toBe(true);
    expect(/buildRunEnv\(/.test(src), 'api-agent-runner execFile inherits process.env (leaks CW_BYOK_KEY)').toBe(true);
  });

  it('runner-child constructs a SandboxSpec and hands it to every runner it builds', () => {
    expect(existsSync(RUNNER_CHILD), 'runner-child.ts moved — guard is blind').toBe(true);
    const src = readFileSync(RUNNER_CHILD, 'utf8');
    expect(/buildSandboxSpec\(/.test(src), 'runner-child never builds a SandboxSpec').toBe(true);
    // A constructor call with no options is exactly the production bug this guards against.
    const bare = src.match(/new (ClaudeCliRunner|CodexRunner|OpenCodeRunner|HermesRunner)\(\s*\)/g) ?? [];
    expect(bare, `runners constructed with no sandbox option: ${bare.join(', ')}`).toEqual([]);
  });

  it('runner-child scrubs the BYOK key from its own env after reading it', () => {
    const src = readFileSync(RUNNER_CHILD, 'utf8');
    expect(/delete process\.env\.CW_BYOK_KEY/.test(src), 'CW_BYOK_KEY stays readable by every child the agent spawns').toBe(true);
  });
});
