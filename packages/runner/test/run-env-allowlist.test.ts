/**
 * The run environment is an ALLOWLIST, and that is load-bearing.
 *
 * The landing page claims SSH agents and credential helpers are unreadable
 * from inside a run. That claim is true, but NOT because of the sandbox
 * profile — the profile permits `system-socket` and the agent socket lives
 * outside every credential deny path. It is true because
 * claude-cli-runner.ts builds the child env from a fixed allowlist and
 * SSH_AUTH_SOCK never reaches the process.
 *
 * Nothing tested that until now. Adding one inherited variable would silently
 * falsify a published security claim, and an earlier audit of this very claim
 * reached the WRONG conclusion by probing the sandbox with the developer's own
 * environment instead of the one a run receives.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { generateSeatbeltProfile, wrapWithSandbox } from '../src/sandbox.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src/claude-cli-runner.ts');

/** The env a real run gets — mirrors claude-cli-runner.ts:133. */
const RUN_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? os.homedir(),
  TERM: 'dumb',
  NO_COLOR: '1',
  LANG: process.env.LANG ?? 'en_US.UTF-8',
  SHELL: '/bin/zsh',
  ...(process.env.USER ? { USER: process.env.USER } : {}),
  ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
};

describe('run environment allowlist', () => {
  it('is built as an allowlist, not a copy of process.env', () => {
    const src = readFileSync(SRC, 'utf8');
    const block = src.slice(src.indexOf('const env: Record<string, string> = {'), src.indexOf('const child = spawn'));
    expect(block, 'the runner must not spread process.env into the child').not.toMatch(/\.\.\.process\.env/);
    expect(block).toContain('PATH:');
    expect(block).toContain('HOME:');
  });

  it('never forwards a credential-bearing variable', () => {
    const src = readFileSync(SRC, 'utf8');
    const block = src.slice(src.indexOf('const env: Record<string, string> = {'), src.indexOf('const child = spawn'));
    const forbidden = [
      'SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY', 'GIT_ASKPASS', 'GPG_AGENT_INFO', 'NPM_TOKEN',
    ];
    const leaked = forbidden.filter((v) => block.includes(v));
    expect(leaked, `credential variables forwarded into runs: ${leaked.join(', ')}`).toEqual([]);
  });

  it.skipIf(process.platform !== 'darwin')('ssh-agent is genuinely unreachable under that env', () => {
    // The empirical half. Probing with the developer's own env reaches the
    // agent and would wrongly suggest the claim is false — that mistake was
    // actually made. This asserts the shipped configuration.
    const dir = mkdtempSync(join(os.tmpdir(), 'cw-envtest-'));
    const { profile } = generateSeatbeltProfile({ writePaths: [dir], readPaths: [dir] });
    const pf = join(dir, 'p.sb');
    writeFileSync(pf, profile);
    const w = wrapWithSandbox(['/usr/bin/ssh-add', '-l'], pf);

    let out = '';
    try {
      out = execFileSync(w[0]!, w.slice(1), { encoding: 'utf8', env: RUN_ENV, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    // "no identities" would mean the agent WAS reached. We require the
    // connection itself to fail.
    expect(out, `ssh-agent was reachable from a run: ${out.trim()}`).toMatch(/could not open a connection/i);
    expect(RUN_ENV.SSH_AUTH_SOCK).toBeUndefined();
  });
});
