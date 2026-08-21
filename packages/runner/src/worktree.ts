/**
 * Git worktree lifecycle (arch §5, ADR-006, S-84/S-85/S-38).
 * Worktree = accident isolation (NOT a security claim — ADR-012).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface WorktreeResult {
  ok: boolean;
  worktreePath?: string;
  branch?: string;
  baseSha?: string;
  basedOnLocalState: boolean; // S-35
  error?: string;
  stderr?: string;
}

export function runGit(args: string[], cwd?: string, timeoutMs = 30_000): { code: number; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  return {
    code: r.status ?? -1,
    out: (r.stdout ?? '').toString(),
    err: (r.stderr ?? '').toString(),
  };
}

export function isGitRepo(repoPath: string): boolean {
  if (!existsSync(repoPath)) return false;
  const r = runGit(['rev-parse', '--git-dir'], repoPath);
  return r.code === 0;
}

/** Preflight per S-36/S-69/S-87: repo exists, has commits, base branch resolvable. */
export function preflightRepo(
  repoPath: string,
  baseBranch: string | null | undefined,
): { ok: boolean; reason?: string; message?: string; defaultBranch?: string } {
  if (!existsSync(repoPath) || !isGitRepo(repoPath)) {
    return { ok: false, reason: 'repo_invalid', message: `Not a git repository: ${repoPath}` };
  }
  const head = runGit(['rev-parse', '--verify', 'HEAD'], repoPath);
  if (head.code !== 0) {
    return { ok: false, reason: 'repo_invalid', message: 'Repository has no commits yet.' };
  }
  let target = baseBranch?.trim() || null;
  if (!target) {
    const origin = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath);
    if (origin.code === 0) {
      target = origin.out.trim().replace('refs/remotes/origin/', '');
    } else {
      // detached HEAD or no remote — fall back to current branch name
      const cur = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
      target = cur.out.trim();
      if (target === 'HEAD') return { ok: false, reason: 'repo_preflight', message: 'Detached HEAD and no remote default branch; set an explicit base branch.' };
    }
  }
  const verify = runGit(['rev-parse', '--verify', `${target}^{commit}`], repoPath);
  if (verify.code !== 0) {
    return { ok: false, reason: 'repo_preflight', message: `Base branch '${target}' does not resolve to a commit.` };
  }
  return { ok: true, defaultBranch: target };
}

export interface CreateWorktreeOpts {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string | null;
  /** S-84: hooks disabled by default via per-worktree core.hooksPath override. */
  hooksEnabled: boolean;
}

/**
 * Cut a worktree + branch from the task's base branch. Fetch first when a
 * remote exists; on fetch failure proceed from local HEAD with the S-35 flag.
 * One retry after 10s on failure (S-38).
 */
export async function createWorktree(opts: CreateWorktreeOpts): Promise<WorktreeResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = createWorktreeOnce(opts);
    if (result.ok) return result;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 10_000));
  }
  const last = createWorktreeOnce(opts);
  return last.ok ? last : { ...last, error: last.error ?? 'worktree_error' };
}

function createWorktreeOnce(opts: CreateWorktreeOpts): WorktreeResult {
  const { repoPath, worktreePath, branch } = opts;
  try {
    mkdirSync(path.dirname(worktreePath), { recursive: true });

    // Determine base commit. Fetch-first when remote configured (offline-tolerant, S-35).
    let baseRef = opts.baseBranch ?? '';
    let basedOnLocal = false;
    const remotes = runGit(['remote'], repoPath);
    if (remotes.code === 0 && remotes.out.trim().length > 0 && opts.baseBranch) {
      const fetchR = runGit(['fetch', '--quiet', 'origin', opts.baseBranch], repoPath, 60_000);
      if (fetchR.code === 0) {
        const remoteOk = runGit(['rev-parse', '--verify', `origin/${opts.baseBranch}^{commit}`], repoPath);
        if (remoteOk.code === 0) baseRef = `origin/${opts.baseBranch}`;
      } else {
        basedOnLocal = true;
      }
    }
    if (!baseRef || runGit(['rev-parse', '--verify', `${baseRef}^{commit}`], repoPath).code !== 0) {
      // fall back to local HEAD of base branch or plain HEAD
      const head = runGit(['rev-parse', 'HEAD'], repoPath);
      if (head.code !== 0) return { ok: false, basedOnLocalState: false, error: 'repo_invalid', stderr: 'no commits' };
      baseRef = head.out.trim();
      basedOnLocal = true;
    }

    // Clean any stale branch/worktree rows pointing at our paths.
    runGit(['worktree', 'prune'], repoPath);

    const add = runGit(['worktree', 'add', '-b', branch, worktreePath, baseRef], repoPath, 60_000);
    if (add.code !== 0) {
      // Branch may already exist from a crashed prior attempt — reuse it.
      const retry = runGit(['worktree', 'add', worktreePath, branch], repoPath, 60_000);
      if (retry.code !== 0) {
        return { ok: false, basedOnLocalState: basedOnLocal, error: 'worktree_error', stderr: add.err || retry.err };
      }
    }

    // S-84: disable repo-managed hooks inside Clockwork worktrees unless opted in.
    if (!opts.hooksEnabled) {
      const hookDir = path.join(worktreePath, '.clockwork-hooks-empty');
      mkdirSync(hookDir, { recursive: true });
      runGit(['config', 'core.hooksPath', '.clockwork-hooks-empty'], worktreePath);
    }

    const sha = runGit(['rev-parse', 'HEAD'], worktreePath);
    return {
      ok: true,
      worktreePath,
      branch,
      baseSha: sha.out.trim() || undefined,
      basedOnLocalState: basedOnLocal,
    };
  } catch (e) {
    return { ok: false, basedOnLocalState: false, error: 'worktree_error', stderr: String(e) };
  }
}

/** Remove worktree; keep the branch (retention policy owns branches). */
export function removeWorktree(repoPath: string, worktreePath: string): void {
  if (!existsSync(worktreePath)) return;
  runGit(['worktree', 'remove', '--force', worktreePath], repoPath, 60_000);
  rmSync(worktreePath, { recursive: true, force: true });
  runGit(['worktree', 'prune'], repoPath);
}

/** S-39: prune branch immediately when the agent committed nothing. */
export function pruneBranch(repoPath: string, branch: string): void {
  runGit(['branch', '-D', branch], repoPath);
}

/** Diffstat for the report (FR-15): name-only + numstat vs merge-base. */
export function diffStat(worktreePath: string, baseSha: string): Array<{ path: string; additions: number; deletions: number }> {
  const r = runGit(['diff', '--numstat', baseSha], worktreePath);
  if (r.code !== 0) return [];
  return r.out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [a, d, p] = line.split('\t');
      const binA = a === '-';
      return {
        path: p ?? '',
        additions: binA ? 0 : parseInt(a ?? '0', 10),
        deletions: binA ? 0 : parseInt(d ?? '0', 10),
        binary: binA,
      };
    })
    .filter((s) => s.path.length > 0);
}

/** Did the agent commit anything? (S-39 / committedSomething in report) */
export function hasCommitsBeyondBase(worktreePath: string, baseSha: string): boolean {
  const r = runGit(['rev-list', '--count', `${baseSha}..HEAD`], worktreePath);
  return r.code === 0 && parseInt(r.out.trim() || '0', 10) > 0;
}

/** Write .gitattributes-free scratch dir for no-repo tasks (FR-9). */
export function ensureScratchDir(scratchRoot: string, runId: string): string {
  const p = path.join(scratchRoot, runId);
  mkdirSync(p, { recursive: true });
  writeFileSync(path.join(p, '.clockwork-scratch'), '', { flag: 'a' });
  return p;
}
