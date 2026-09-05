/**
 * ADR-034 finding #2: applySandbox() writes a fresh `cw-sb-` directory
 * (containing profile.sb) under os.tmpdir() on EVERY call. ClaudeCliRunner
 * cleans its own up; codex/opencode/hermes now do too (see
 * runner-env-wiring.test.ts's source guard — they need a real binary to
 * actually spawn). api-agent-runner is different: it calls
 * applySandbox once per run_command TOOL CALL inside a single BYOK run, so an
 * agent that calls run_command N times used to leak N profile directories.
 *
 * This drives execTool('run_command', ...) against a REAL SandboxSpec, built
 * the same way runner-child builds one (mirrors sandbox-production-spec.test.ts),
 * through a real `sandbox-exec` (darwin only) — no mocks of the thing under test.
 *
 * Race-safety: os.tmpdir() is redirected (via TMPDIR) to a private, empty root
 * for this file's own worker only, so counting cw-sb-* dirs can never be
 * confused by another test file's concurrent use of the real /tmp.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySandbox, buildSandboxSpec, cliWorkDirFor } from '../src/sandbox.js';
import { execTool } from '../src/api-agent-runner.js';

const onMac = process.platform === 'darwin';

describe.skipIf(!onMac)('api-agent-runner run_command: Seatbelt profile dir cleanup', () => {
  const originalTmpdir = process.env.TMPDIR;
  let isolatedRoot: string;
  let worktree: string;
  let cliWork: string;

  beforeAll(() => {
    // Every applySandbox() call in this suite lands under isolatedRoot instead
    // of the real /tmp, so "no growth" can be asserted without any chance of
    // a sibling test file's own cw-sb-* dir being mistaken for a leak here.
    isolatedRoot = mkdtempSync(path.join(os.tmpdir(), 'cw-apiagent-root-'));
    process.env.TMPDIR = isolatedRoot;
    // Prove the redirect actually took: os.tmpdir() reads TMPDIR lazily on
    // every call, so if this ever stops being true, every "no growth"
    // assertion below would still read 0 → 0 against the REAL /tmp and pass
    // for the wrong reason.
    expect(os.tmpdir()).toBe(isolatedRoot);
    worktree = path.join(isolatedRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    // cliWorkDirFor resolves the worktree's REAL path (macOS /tmp -> /private/tmp
    // symlink) and is hardcoded under the real /tmp regardless of TMPDIR — it
    // must be captured now, while `worktree` still exists on disk, or
    // resolveReal() falls back to the un-resolved literal and afterAll cleans
    // up a path buildSandboxSpec never actually created, leaking the real one.
    cliWork = cliWorkDirFor(worktree);
  });

  afterAll(() => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    rmSync(isolatedRoot, { recursive: true, force: true });
    rmSync(cliWork, { recursive: true, force: true });
  });

  function sandboxDirCount(): number {
    return readdirSync(isolatedRoot).filter((f) => f.startsWith('cw-sb-')).length;
  }

  it('sandboxDirCount actually detects a profile dir (positive control for every "no growth" assertion below)', () => {
    const spec = buildSandboxSpec({
      worktreePath: worktree,
      scratchPath: null,
      repoPath: null,
      contextRoots: [],
      cacheRoot: path.join(isolatedRoot, 'cache-control'),
    });
    const before = sandboxDirCount();
    const { profilePath } = applySandbox(['true'], spec);
    expect(profilePath).toBeTruthy();
    expect(profilePath!.startsWith(isolatedRoot)).toBe(true);
    expect(sandboxDirCount()).toBe(before + 1);
    rmSync(path.dirname(profilePath!), { recursive: true, force: true });
    expect(sandboxDirCount()).toBe(before);
  });

  it('removes the per-call profile dir once run_command succeeds', async () => {
    const spec = buildSandboxSpec({
      worktreePath: worktree,
      scratchPath: null,
      repoPath: null,
      contextRoots: [],
      cacheRoot: path.join(isolatedRoot, 'cache-a'),
    });
    const before = sandboxDirCount();
    const out = await execTool('run_command', { command: 'echo cw-probe-ok' }, worktree, spec);
    expect(out).toContain('cw-probe-ok');
    expect(sandboxDirCount()).toBe(before); // not before+1 — the leak this closes
  });

  it('removes the profile dir even when the command exits non-zero', async () => {
    const spec = buildSandboxSpec({
      worktreePath: worktree,
      scratchPath: null,
      repoPath: null,
      contextRoots: [],
      cacheRoot: path.join(isolatedRoot, 'cache-b'),
    });
    const before = sandboxDirCount();
    const out = await execTool('run_command', { command: 'exit 7' }, worktree, spec);
    expect(out).toContain('EXIT-ERROR');
    expect(sandboxDirCount()).toBe(before);
  });

  it('never accumulates across repeated run_command calls in the same run', async () => {
    const spec = buildSandboxSpec({
      worktreePath: worktree,
      scratchPath: null,
      repoPath: null,
      contextRoots: [],
      cacheRoot: path.join(isolatedRoot, 'cache-c'),
    });
    const before = sandboxDirCount();
    for (let i = 0; i < 3; i++) {
      await execTool('run_command', { command: `echo call-${i}` }, worktree, spec);
    }
    expect(sandboxDirCount()).toBe(before);
  });

  it('a null spec (CW_SANDBOX=off) never creates a profile dir to begin with', async () => {
    const before = sandboxDirCount();
    const out = await execTool('run_command', { command: 'echo unsandboxed' }, worktree, null);
    expect(out).toContain('unsandboxed');
    expect(sandboxDirCount()).toBe(before);
  });
});
