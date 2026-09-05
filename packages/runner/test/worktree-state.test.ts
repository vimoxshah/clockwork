/**
 * inspectWorktree drives finalize's prune-or-preserve decision. The case that
 * matters is a LINKED worktree with a rebase in flight: its markers live in the
 * main repo's .git/worktrees/<name>/, not under <worktree>/.git (which is a
 * file), so a naive existsSync('<worktree>/.git/rebase-merge') would say
 * "clean" and let finalize force-delete a half-done rebase. A Product Hunt user
 * asked about exactly this case on 2026-09-04.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectWorktree } from '../src/worktree.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let tmp: string;
let repo: string;
let wt: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cw-wtstate-'));
  repo = path.join(tmp, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t'], repo);
  git(['config', 'user.name', 't'], repo);
  writeFileSync(path.join(repo, 'f.txt'), '1\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'init'], repo);
  wt = path.join(tmp, 'wt');
  git(['worktree', 'add', '-q', '-b', 'run/x', wt, 'main'], repo);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('inspectWorktree', () => {
  it('a missing path is reported as such, not as clean', () => {
    expect(inspectWorktree(path.join(tmp, 'nope'))).toEqual({ exists: false, dirty: false, interruptedOp: null });
  });

  it('a fresh linked worktree is clean with no operation in flight', () => {
    expect(inspectWorktree(wt)).toEqual({ exists: true, dirty: false, interruptedOp: null });
  });

  it('an untracked file makes it dirty', () => {
    writeFileSync(path.join(wt, 'scratch.txt'), 'wip\n');
    expect(inspectWorktree(wt).dirty).toBe(true);
    rmSync(path.join(wt, 'scratch.txt'));
    expect(inspectWorktree(wt).dirty).toBe(false);
  });

  it('a conflicting rebase in a LINKED worktree is detected via --git-path, and clears on abort', () => {
    // Diverge: main and run/x both edit f.txt.
    writeFileSync(path.join(repo, 'f.txt'), 'main\n');
    git(['commit', '-qam', 'main edit'], repo);
    writeFileSync(path.join(wt, 'f.txt'), 'branch\n');
    git(['commit', '-qam', 'branch edit'], wt);

    let conflicted = false;
    try {
      git(['rebase', 'main'], wt);
    } catch {
      conflicted = true; // expected: the process "died" mid-rebase
    }
    expect(conflicted).toBe(true);

    const mid = inspectWorktree(wt);
    expect(mid.exists).toBe(true);
    expect(mid.interruptedOp).toBe('rebase');
    expect(mid.dirty).toBe(true);

    git(['rebase', '--abort'], wt);
    expect(inspectWorktree(wt).interruptedOp).toBeNull();
  });
});
