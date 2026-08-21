import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorktree,
  diffStat,
  ensureScratchDir,
  hasCommitsBeyondBase,
  preflightRepo,
  pruneBranch,
  removeWorktree,
} from '../src/worktree.js';

let repoDir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeAll(() => {
  repoDir = mkdtempSync(path.join(os.tmpdir(), 'cw-repo-'));
  git(repoDir, 'init', '-b', 'main');
  git(repoDir, 'config', 'user.email', 'test@clockwork.local');
  git(repoDir, 'config', 'user.name', 'Clockwork Test');
  writeFileSync(path.join(repoDir, 'README.md'), '# toy\n');
  mkdirSync(path.join(repoDir, 'src'));
  writeFileSync(path.join(repoDir, 'src', 'a.ts'), 'export const a = 1;\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-m', 'init');
  // A repo-managed pre-commit hook that would fail runs if executed (S-84).
  // Installed AFTER the initial commit (the user's repo already has history).
  const hooks = path.join(repoDir, '.githooks');
  mkdirSync(hooks);
  writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  execFileSync('chmod', ['+x', path.join(hooks, 'pre-commit')]);
  git(repoDir, 'config', 'core.hooksPath', '.githooks');
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('repo preflight (S-36/S-69/S-87)', () => {
  it('accepts a healthy repo', () => {
    expect(preflightRepo(repoDir, null)).toMatchObject({ ok: true });
  });

  it('rejects missing path / non-git dir', () => {
    expect(preflightRepo('/nonexistent-xyz', null).ok).toBe(false);
    expect(preflightRepo(os.tmpdir(), null).reason).toBe('repo_invalid');
  });

  it('rejects unresolvable base branch (S-87)', () => {
    const r = preflightRepo(repoDir, 'deleted-upstream-branch');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('repo_preflight');
  });
});

describe('worktree lifecycle (ADR-006)', () => {
  it('creates worktree + branch cut from base, hooks disabled by default (S-84)', async () => {
    const wt = path.join(repoDir + '-wt1');
    const res = await createWorktree({
      repoPath: repoDir,
      worktreePath: wt,
      branch: 'clockwork/task/abc',
      baseBranch: 'main',
      hooksEnabled: false,
    });
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(wt!, 'README.md'))).toBe(true);

    // S-84: the hook that exits 1 must NOT run in our worktree — commit works.
    writeFileSync(path.join(wt!, 'src', 'b.ts'), 'export const b = 2;\n');
    git(wt!, 'add', '-A');
    git(wt!, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'agent work');
    const hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: wt!, encoding: 'utf8' }).trim();
    expect(hooksPath.length).toBeGreaterThan(0); // overridden away from repo's .githooks
    expect(hasCommitsBeyondBase(wt!, res.baseSha!)).toBe(true);

    const stat = diffStat(wt!, res.baseSha!);
    expect(stat.some((s) => s.path.includes('b.ts'))).toBe(true);
  });

  it('S-39: analysis-only run prunes its branch cleanly', async () => {
    const wt = path.join(repoDir + '-wt2');
    const res = await createWorktree({
      repoPath: repoDir,
      worktreePath: wt,
      branch: 'clockwork/task/empty',
      baseBranch: 'main',
      hooksEnabled: false,
    });
    expect(res.ok).toBe(true);
    expect(hasCommitsBeyondBase(wt!, res.baseSha!)).toBe(false); // nothing committed
    removeWorktree(repoDir, wt!);
    pruneBranch(repoDir, 'clockwork/task/empty');
    expect(existsSync(wt!)).toBe(false);
    const branches = git(repoDir, 'branch', '--list', 'clockwork/*');
    expect(branches).not.toContain('clockwork/task/empty');
  });

  it('reports basedOnLocalState when fetch impossible (S-35) and reuses stale branch after crash', async () => {
    // simulate crashed prior attempt leaving the branch behind
    git(repoDir, 'branch', 'clockwork/crash/r1');
    const wt = path.join(repoDir + '-wt3');
    const res = await createWorktree({
      repoPath: repoDir,
      worktreePath: wt,
      branch: 'clockwork/crash/r1',
      baseBranch: 'main',
      hooksEnabled: false,
    });
    expect(res.ok).toBe(true);
    removeWorktree(repoDir, wt!);
  });
});

describe('scratch dirs (no-repo tasks)', () => {
  it('ensures an isolated scratch dir per run', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cw-scratch-root-'));
    const p = ensureScratchDir(root, 'run-1');
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(path.join(p, '.clockwork-scratch'), 'utf8')).toBe('');
    rmSync(root, { recursive: true, force: true });
  });
});
