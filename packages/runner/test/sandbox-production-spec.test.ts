/**
 * The production spec builder and the wrap helper — the two functions that turn
 * "a profile exists" into "this run is inside one". The macOS block runs a real
 * sandbox-exec against a profile built exactly the way runner-child builds it,
 * and checks the three findings from the 2026-09-05 probe: the CLI work dir
 * must be writable or no shell starts; the cwd-tracking file must be writable
 * or every command exits 1; and nothing else under /tmp or $HOME may be.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applySandbox,
  buildSandboxSpec,
  cliWorkDirFor,
  generateSeatbeltProfile,
  toolCacheEnv,
  SANDBOX_PROFILE_VERSION,
} from '../src/sandbox.js';

const onMac = process.platform === 'darwin';
const uid = process.getuid?.() ?? 0;

describe('cliWorkDirFor', () => {
  it('mirrors the CLI: /tmp/claude-<uid>/<realpath with / as ->', () => {
    // Nonexistent path: realpath falls back to the literal, so the slug is predictable.
    expect(cliWorkDirFor('/a/b c/d')).toBe(`/tmp/claude-${uid}/-a-b c-d`);
  });

  it('resolves symlinks first, so the slug matches what the CLI computes from its real cwd', () => {
    const real = mkdtempSync(path.join(os.tmpdir(), 'cw-real-'));
    const realResolved = execFileSync('/bin/pwd', ['-P'], { cwd: real, encoding: 'utf8' }).trim();
    expect(cliWorkDirFor(real)).toBe(`/tmp/claude-${uid}/${realResolved.replace(/\//g, '-')}`);
    rmSync(real, { recursive: true, force: true });
  });
});

describe('toolCacheEnv', () => {
  it('redirects every known package-manager cache under the given root', () => {
    const expectedKeys = [
      'npm_config_cache',
      'npm_config_store_dir',
      'YARN_CACHE_FOLDER',
      'PIP_CACHE_DIR',
      'XDG_CACHE_HOME',
      'CARGO_HOME',
      'GOMODCACHE',
      'GOCACHE',
      'GEM_HOME',
      'BUNDLE_PATH',
      'UV_CACHE_DIR',
      'POETRY_CACHE_DIR',
      'GRADLE_USER_HOME',
      'COMPOSER_CACHE_DIR',
      'NUGET_PACKAGES',
    ];
    const env = toolCacheEnv('/x');
    expect(Object.keys(env).sort()).toEqual(expectedKeys.sort());
    for (const v of Object.values(env)) expect(v.startsWith('/x/')).toBe(true);
  });
});

describe('buildSandboxSpec', () => {
  it('writes = worktree + CLI work dir + cache root + engine state; reads = repo + context roots', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cw-spec-'));
    const worktree = path.join(tmp, 'wt');
    const repo = path.join(tmp, 'repo');
    const cache = path.join(tmp, 'cache');
    const state = path.join(tmp, 'engine-state');
    const spec = buildSandboxSpec({
      worktreePath: worktree,
      scratchPath: null,
      repoPath: repo,
      contextRoots: ['/ctx/one'],
      engineStatePaths: [state],
      cacheRoot: cache,
    });
    expect(spec.writePaths).toEqual([worktree, cliWorkDirFor(worktree), cache, state]);
    expect(spec.readPaths).toEqual([repo, '/ctx/one']);
    // It creates what it names so the first spawn does not EPERM on mkdir.
    expect(existsSync(cliWorkDirFor(worktree))).toBe(true);
    expect(existsSync(state)).toBe(true);
    for (const dir of Object.values(toolCacheEnv(cache))) expect(existsSync(dir)).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(cliWorkDirFor(worktree), { recursive: true, force: true });
  });

  it('drops a null scratch path instead of emitting an empty allow', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cw-spec-'));
    const spec = buildSandboxSpec({ worktreePath: tmp, scratchPath: null, repoPath: null, contextRoots: [], cacheRoot: path.join(tmp, 'c') });
    expect(spec.writePaths.every((p) => p.length > 0)).toBe(true);
    expect(spec.readPaths).toEqual([]);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(cliWorkDirFor(tmp), { recursive: true, force: true });
  });
});

describe('applySandbox', () => {
  it('a null spec is a no-op — the caller owns logging that escape hatch', () => {
    expect(applySandbox(['claude', '-p', 'x'], null)).toEqual({ argv: ['claude', '-p', 'x'], profilePath: null, version: null });
  });

  it('wraps in sandbox-exec with a written v2 profile that includes the cwd-file allow', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cw-apply-'));
    const { argv, profilePath, version } = applySandbox(['echo', 'hi'], { writePaths: [tmp], readPaths: [] });
    expect(argv.slice(0, 2)).toEqual(['sandbox-exec', '-f']);
    expect(argv.slice(-2)).toEqual(['echo', 'hi']);
    expect(version).toBe(SANDBOX_PROFILE_VERSION);
    expect(version).toBe(2);
    const profile = readFileSync(profilePath!, 'utf8');
    expect(profile).toContain('(regex #"^/private/tmp/claude-[0-9a-f]+-cwd$")');
    expect(profile).toContain(`(allow file-write* (subpath "${realpathSync(tmp)}"))`);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits engine staging-file regexes as exact-name allows', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cw-apply-'));
    const { profilePath } = applySandbox(['true'], { writePaths: [tmp], readPaths: [], writeRegexes: ['^/Users/x/\\.hermes-tmp\\.[0-9]+$'] });
    expect(readFileSync(profilePath!, 'utf8')).toContain('(allow file-write* (regex #"^/Users/x/\\.hermes-tmp\\.[0-9]+$"))');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('merges per-spawn extra write paths without mutating the run spec', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cw-apply-'));
    const extra = mkdtempSync(path.join(os.tmpdir(), 'cw-extra-'));
    const spec = { writePaths: [tmp], readPaths: [] };
    const { profilePath } = applySandbox(['true'], spec, { extraWritePaths: [extra] });
    expect(readFileSync(profilePath!, 'utf8')).toContain(path.basename(extra));
    expect(spec.writePaths).toEqual([tmp]);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(extra, { recursive: true, force: true });
  });

  it('refuses to allowlist a credential path — a thrown error, never a silent widen', () => {
    const ssh = path.join(os.homedir(), '.ssh');
    if (!existsSync(ssh)) return; // resolveReal drops missing paths before the check can fire
    expect(() => applySandbox(['true'], { writePaths: [ssh], readPaths: [] })).toThrow(/credential path/);
  });
});

describe.skipIf(!onMac)('the production profile under a real sandbox-exec', () => {
  let tmp: string;
  let worktree: string;
  let profilePath: string;
  let cliWork: string;

  function inSandbox(argv: string[]): boolean {
    try {
      execFileSync('sandbox-exec', ['-f', profilePath, '--', ...argv], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'cw-prod-'));
    worktree = path.join(tmp, 'wt');
    mkdirSync(worktree); // in production the daemon creates it before spawn; a missing path is (correctly) dropped
    const spec = buildSandboxSpec({ worktreePath: worktree, scratchPath: null, repoPath: null, contextRoots: [], cacheRoot: path.join(tmp, 'cache') });
    cliWork = cliWorkDirFor(worktree);
    const { profile } = generateSeatbeltProfile(spec);
    profilePath = path.join(tmp, 'profile.sb');
    writeFileSync(profilePath, profile);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(cliWork, { recursive: true, force: true });
    for (const f of ['/tmp/claude-ab12-cwd', '/tmp/claude-ab12-cwdx', path.join(os.homedir(), 'cw-escape-probe')]) rmSync(f, { force: true });
  });

  it('lets the engine write its worktree and its CLI work dir', () => {
    expect(inSandbox(['/usr/bin/touch', path.join(worktree, 'ok')])).toBe(true);
    expect(inSandbox(['/usr/bin/touch', path.join(cliWork, 'ok')])).toBe(true);
  });

  it('admits exactly the cwd-tracking filename and nothing else under /tmp', () => {
    expect(inSandbox(['/usr/bin/touch', '/tmp/claude-ab12-cwd'])).toBe(true);
    expect(inSandbox(['/usr/bin/touch', '/tmp/claude-ab12-cwdx'])).toBe(false);
    expect(inSandbox(['/usr/bin/touch', '/tmp/cw-probe-escape'])).toBe(false);
  });

  it('still denies writes to $HOME and reads of credential paths', () => {
    expect(inSandbox(['/usr/bin/touch', path.join(os.homedir(), 'cw-escape-probe')])).toBe(false);
    const hist = path.join(os.homedir(), '.zsh_history');
    if (existsSync(hist)) expect(inSandbox(['/bin/cat', hist])).toBe(false);
  });
});
