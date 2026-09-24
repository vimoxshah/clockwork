/**
 * One-click PR from a run report (P0 / T-303), PAT-only by product decision.
 *
 * No `gh` CLI, no octokit, no stored OAuth: the user pastes a GitHub PAT
 * once (Settings → GitHub, 0600 file via writeDeliveryCreds, env bridge
 * CLOCKWORK_DELIVER_GITHUB_PAT free through loadDeliveryCreds), and every
 * GitHub touch uses it in exactly two ways:
 *
 *   1. `git push` with `-c http.https://github.com/.extraHeader=` — the PAT
 *      travels in a header git never echoes and never persists. An SSH
 *      origin is refused loudly (ssh_origin) instead of silently failing:
 *      the daemon's child env has no SSH_AUTH_SOCK and the sandbox denies
 *      .ssh reads, so SSH push cannot work from here.
 *   2. api.github.com REST with `Authorization: Bearer` — lookup (duplicate
 *      detection, the idempotency story) and create.
 *
 * Every outward message passes through scrub(): even though neither channel
 * echoes the PAT, a transport error could in theory, so the secret is
 * stripped from all reasons/messages by construction, asserted in tests.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit, hasCommitsBeyondBase, diffStat, preflightRepo } from '@clockwork/runner';
import type { DiffFileStat } from '@clockwork/shared';

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export type PrFailureReason =
  | 'no_pat'
  | 'no_remote'
  | 'not_github'
  | 'ssh_origin'
  | 'repo_invalid'
  | 'branch_missing'
  | 'worktree_missing'
  | 'empty_diff'
  | 'push_failed'
  | 'auth_failed'
  | 'already_exists'
  | 'network'
  | 'api_error';

export interface PrFailure {
  ok: false;
  reason: PrFailureReason;
  message: string;
}

/** Belt-and-braces: the PAT must never appear in any outward message. */
export function scrub(pat: string | undefined, s: string): string {
  if (!pat) return s;
  return s.split(pat).join('[redacted]');
}

/**
 * Branch names reach spawnSync argv and REST paths from a DB row the agent
 * never writes — but the row is still data, not code. A leading `-` would
 * become a git flag (option injection); anything outside the git ref-safe set
 * is refused rather than quoted and hoped over.
 */
export function assertSafeBranch(branch: string): { ok: true } | PrFailure {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.startsWith('/') || branch.includes('..')) {
    return { ok: false, reason: 'branch_missing', message: `Branch name '${branch.slice(0, 60)}' is not a safe ref — refusing to push it.` };
  }
  return { ok: true };
}

/**
 * Parse a git remote URL into a github.com owner/repo. Only github.com —
 * anything else is not_github, never silently rewritten.
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const u = url.trim();
  let m = u.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1]!, repo: m[2]! };
  m = u.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1]!, repo: m[2]! };
  return null;
}

export function isSshRemote(url: string): boolean {
  return /^git@github\.com:/i.test(url.trim()) || /^ssh:\/\//i.test(url.trim());
}

export function readRemoteOrigin(repoPath: string): { url: string } | PrFailure {
  const r = runGit(['config', '--get', 'remote.origin.url'], repoPath);
  const url = r.out.trim();
  if (r.code !== 0 || !url) {
    return { ok: false, reason: 'no_remote', message: 'No origin remote is configured on this repository.' };
  }
  return { url };
}

export interface PrContext {
  owner: string;
  repo: string;
  base: string;
  /** Directory to run git in: the preserved worktree, else the main repo. */
  workDir: string;
  branch: string;
  diffStat: DiffFileStat[];
  commits: number;
}

/**
 * Verify everything a PR needs before any network or push happens:
 * repo, branch, base, and a non-empty diff. Pure local git, no PAT needed.
 */
export function collectPrContext(opts: {
  repoPath: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
}): PrContext | PrFailure {
  const { repoPath, worktreePath, branch, baseBranch } = opts;
  if (!branch) {
    return { ok: false, reason: 'branch_missing', message: 'This run recorded no branch — there is nothing to open a PR from.' };
  }
  if (!repoPath) {
    return { ok: false, reason: 'repo_invalid', message: 'This run has no repository (scratch task) — PRs need a repo task.' };
  }
  const pre = preflightRepo(repoPath, baseBranch);
  if (!pre.ok || !pre.defaultBranch) {
    return { ok: false, reason: 'repo_invalid', message: pre.message ?? `Not a usable git repository: ${repoPath}` };
  }
  const base = pre.defaultBranch;
  // The worktree may be pruned by retention; the branch usually survives in
  // the main repo (retention owns branches, worktree.ts:147). Push from
  // wherever the branch still exists.
  const candidates = [worktreePath, repoPath].filter((p): p is string => !!p && existsSync(p));
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'worktree_missing',
      message: 'The run worktree was pruned and the repository path is gone — nothing left to push.',
    };
  }
  let workDir: string | null = null;
  for (const dir of candidates) {
    const v = runGit(['rev-parse', '--verify', `${branch}^{commit}`], dir);
    if (v.code === 0) {
      workDir = dir;
      break;
    }
  }
  if (!workDir) {
    return { ok: false, reason: 'branch_missing', message: `Branch '${branch}' no longer exists locally — it may have been pruned.` };
  }
  const safe = assertSafeBranch(branch);
  if (!safe.ok) return safe;
  const baseSha = runGit(['rev-parse', '--verify', `${base}^{commit}`], workDir).out.trim();
  if (!baseSha) {
    return { ok: false, reason: 'repo_invalid', message: `Base branch '${base}' does not resolve to a commit.` };
  }
  const count = runGit(['rev-list', '--count', `${baseSha}..${branch}`], workDir);
  const commits = parseInt(count.out.trim() || '0', 10);
  if (count.code !== 0 || commits <= 0 || !hasCommitsBeyondBase(workDir, baseSha)) {
    return {
      ok: false,
      reason: 'empty_diff',
      message: `Branch '${branch}' has no commits beyond '${base}' — creating a PR would open an empty one, so this refuses.`,
    };
  }
  // Single source: the remote is read from the directory we will actually
  // push from. A linked worktree shares the main repo's config, so the two
  // agree in practice — but agreeing by construction beats agreeing by luck.
  const remote = readRemoteOrigin(workDir);
  if (!('url' in remote)) return remote;
  const parsed = parseGitHubRemote(remote.url);
  if (!parsed) {
    return {
      ok: false,
      reason: 'not_github',
      message: 'The origin remote is not a github.com URL — Clockwork only opens PRs on GitHub.',
    };
  }
  return { owner: parsed.owner, repo: parsed.repo, base, workDir, branch, diffStat: diffStat(workDir, baseSha).slice(0, 30), commits };
}

/**
 * Push the branch. The PAT travels in a 0600 temp git config included via
 * `-c include.path=` — argv carries only the temp path, never the secret
 * (argv is world-visible in ps; the file is owner-only and deleted in
 * `finally`). Nothing is persisted into any repo git config.
 * SSH origins are refused: this process has no ssh-agent and no .ssh reads.
 */
export function pushBranch(opts: { workDir: string; branch: string; pat: string; remote?: string }): { ok: true } | PrFailure {
  const remote = opts.remote ?? 'origin';
  const safe = assertSafeBranch(opts.branch);
  if (!safe.ok) return safe;
  const urlR = runGit(['config', '--get', `remote.${remote}.url`], opts.workDir);
  const url = urlR.out.trim();
  if (urlR.code !== 0 || !url) {
    return { ok: false, reason: 'no_remote', message: `Remote '${remote}' is not configured.` };
  }
  if (!/^https:\/\//i.test(url)) {
    // Local remotes (file path or file://) never leave the machine, so the
    // PAT is not involved at all — push directly. This is also what makes the
    // full orchestration testable without network.
    if (/^(file:\/\/|\/)/.test(url)) {
      const r = spawnSync('git', ['push', '--set-upstream', remote, `${opts.branch}:${opts.branch}`], {
        cwd: opts.workDir,
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (r.status === 0) return { ok: true };
      return { ok: false, reason: 'push_failed', message: `Push failed: ${scrub(opts.pat, (r.stderr ?? '').toString()).slice(0, 200) || 'unknown git error'}` };
    }
    return {
      ok: false,
      reason: 'ssh_origin',
      message:
        'The origin remote uses SSH, which this daemon cannot authenticate (no ssh-agent, no key reads). ' +
        'Switch the remote to HTTPS (`git remote set-url origin https://github.com/OWNER/REPO.git`) or push the branch manually, then retry.',
    };
  }
  // Re-validate the host here, not just the scheme: this is the function
  // that actually sends the PAT, so it checks the destination itself rather
  // than trusting the caller's parse.
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return { ok: false, reason: 'not_github', message: 'The origin remote URL does not parse — refusing to send credentials to it.' };
  }
  if (host !== 'github.com' && host !== 'www.github.com') {
    return { ok: false, reason: 'not_github', message: 'The origin remote is not a github.com URL — Clockwork only opens PRs on GitHub.' };
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cw-gh-'));
  try {
    const conf = path.join(tmp, 'auth.conf');
    writeFileSync(conf, `[http "https://github.com/"]\n\textraHeader = Authorization: Bearer ${opts.pat}\n`, { mode: 0o600 });
    chmodSync(conf, 0o600); // writeFileSync mode is ignored when the file exists
    const r = spawnSync(
      'git',
      ['-c', `include.path=${conf}`, 'push', '--set-upstream', remote, `${opts.branch}:${opts.branch}`],
      { cwd: opts.workDir, encoding: 'utf8', timeout: 120_000 },
    );
    const err = (r.stderr ?? '').toString();
    if (r.status === 0) return { ok: true };
    if (/authentication failed|401|403|permission denied|invalid credentials/i.test(err)) {
      return {
        ok: false,
        reason: 'auth_failed',
        message: 'GitHub rejected the push (401/403). The saved PAT may be expired, revoked, or missing the contents:write scope — re-paste it in Settings → GitHub.',
      };
    }
    return { ok: false, reason: 'push_failed', message: `Push failed: ${scrub(opts.pat, err).slice(0, 200) || 'unknown git error'}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

type FetchImpl = typeof fetch;

async function gh(
  pat: string,
  path: string,
  opts: { method?: string; body?: unknown } = {},
  fetchImpl: FetchImpl = fetch,
): Promise<{ status: number; json: any } | PrFailure> {
  let res: Response;
  try {
    res = await fetchImpl(`${GITHUB_API}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    return { ok: false as const, reason: 'network' as const, message: 'Could not reach api.github.com — check network access and retry.' };
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

export interface ExistingPr {
  number: number;
  url: string;
}

/** Duplicate detection: an open PR off this branch head already answers. */
export async function findOpenPr(
  owner: string,
  repo: string,
  branch: string,
  pat: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ pr: ExistingPr | null } | PrFailure> {
  // Encoded: owner/repo/branch arrive from a DB row and a git config —
  // data, so every segment is encoded rather than interpolated raw.
  const r = await gh(
    pat,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?head=${encodeURIComponent(owner)}:${encodeURIComponent(branch)}&state=open`,
    {},
    fetchImpl,
  );
  if ('reason' in r) return r;
  if (r.status === 401 || r.status === 403) {
    return { ok: false, reason: 'auth_failed', message: 'GitHub rejected the PAT (401/403) — re-paste it in Settings → GitHub.' };
  }
  if (r.status !== 200 || !Array.isArray(r.json)) {
    return { ok: false, reason: 'api_error', message: `GitHub lookup failed (HTTP ${r.status}).` };
  }
  const first = r.json[0];
  if (!first) return { pr: null };
  return { pr: { number: first.number, url: first.html_url } };
}

export async function createPr(
  owner: string,
  repo: string,
  input: { title: string; head: string; base: string; body: string },
  pat: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ pr: ExistingPr } | PrFailure> {
  const r = await gh(
    pat,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    { method: 'POST', body: input },
    fetchImpl,
  );
  if ('reason' in r) return r;
  if (r.status === 401 || r.status === 403) {
    return { ok: false, reason: 'auth_failed', message: 'GitHub rejected the PAT (401/403) — re-paste it in Settings → GitHub.' };
  }
  if (r.status !== 201 || !r.json?.html_url) {
    const detail = typeof r.json?.message === 'string' ? r.json.message : `HTTP ${r.status}`;
    // Race loser path: two rapid clicks both push (idempotent), both look up
    // (both miss), both create — GitHub 422s the second with "already exists".
    // That is a duplicate, not a failure: signal it so openPr re-looks-up.
    if (r.status === 422 && /already exists|already.*pull request/i.test(detail)) {
      return { ok: false, reason: 'already_exists', message: detail };
    }
    return { ok: false, reason: 'api_error', message: `GitHub refused the PR: ${scrub(pat, detail).slice(0, 200)}` };
  }
  return { pr: { number: r.json.number, url: r.json.html_url } };
}

export async function validatePat(pat: string, fetchImpl: FetchImpl = fetch): Promise<{ ok: true; login: string } | PrFailure> {
  const r = await gh(pat, '/user', {}, fetchImpl);
  if ('reason' in r) return r;
  if (r.status === 401 || r.status === 403) {
    return { ok: false, reason: 'auth_failed', message: 'GitHub rejected this PAT — check it was copied whole and has contents access to your repos.' };
  }
  if (r.status !== 200 || !r.json?.login) {
    return { ok: false, reason: 'api_error', message: `GitHub validation failed (HTTP ${r.status}).` };
  }
  return { ok: true, login: r.json.login };
}

export function buildPrTitle(taskName: string, runId: string): string {
  const t = `${taskName} (Clockwork ${runId.slice(0, 8)})`;
  return t.length > 120 ? t.slice(0, 117) + '...' : t;
}

export function buildPrBody(input: {
  summary: string;
  diffStat: DiffFileStat[];
  commits: number;
  branch: string;
  base: string;
  costUsd: number;
  turns: number;
  runId: string;
  taskName: string;
}): string {
  const adds = input.diffStat.reduce((a, f) => a + f.additions, 0);
  const dels = input.diffStat.reduce((a, f) => a + f.deletions, 0);
  const rows = input.diffStat
    .slice(0, 30)
    .map((f) => `| \`${f.path}\` | +${f.additions} | −${f.deletions} |`)
    .join('\n');
  const more = input.diffStat.length > 30 ? `\n…and ${input.diffStat.length - 30} more files.` : '';
  return [
    `## Summary`,
    ``,
    input.summary.slice(0, 1500) || '(no summary recorded)',
    ``,
    `## Diff — ${input.commits} commit${input.commits === 1 ? '' : 's'} on \`${input.branch}\` into \`${input.base}\` (+${adds}/−${dels})`,
    ``,
    `| file | + | − |`,
    `|---|---|---|`,
    rows,
    more,
    ``,
    `## Run`,
    ``,
    `- task: ${input.taskName} · run \`${input.runId}\``,
    `- cost: $${input.costUsd.toFixed(2)} · turns: ${input.turns}`,
    ``,
    `---`,
    `Opened by Clockwork running locally on your Mac, with your GitHub PAT. Review the diff before merging.`,
  ].join('\n');
}

/**
 * Full orchestration: verify locally → push → dedupe → create.
 * Order matters: the push lands first so a duplicate lookup sees a head
 * that exists even if a previous attempt died between push and create.
 */
export async function openPr(
  ctx: PrContext,
  opts: { pat: string; title?: string; summary: string; taskName: string; runId: string; costUsd: number; turns: number; pushRemote?: string },
  fetchImpl: FetchImpl = fetch,
): Promise<{ ok: true; created: boolean; pr: ExistingPr } | PrFailure> {
  const pushed = pushBranch({ workDir: ctx.workDir, branch: ctx.branch, pat: opts.pat, remote: opts.pushRemote });
  if (!pushed.ok) return pushed;
  const found = await findOpenPr(ctx.owner, ctx.repo, ctx.branch, opts.pat, fetchImpl);
  if (!found || !('pr' in found)) return found as PrFailure;
  if (found.pr) return { ok: true, created: false, pr: found.pr };
  const created = await createPr(
    ctx.owner,
    ctx.repo,
    {
      title: (opts.title?.trim() || buildPrTitle(opts.taskName, opts.runId)).slice(0, 120),
      head: ctx.branch,
      base: ctx.base,
      body: buildPrBody({
        summary: opts.summary,
        diffStat: ctx.diffStat,
        commits: ctx.commits,
        branch: ctx.branch,
        base: ctx.base,
        costUsd: opts.costUsd,
        turns: opts.turns,
        runId: opts.runId,
        taskName: opts.taskName,
      }),
    },
    opts.pat,
    fetchImpl,
  );
  if (!created || !('pr' in created)) {
    // already_exists is internal-only: the race loser re-looks-up and
    // returns the winner's PR as existing. It never surfaces as a refusal.
    const f = created as PrFailure;
    if (f.reason === 'already_exists') {
      const again = await findOpenPr(ctx.owner, ctx.repo, ctx.branch, opts.pat, fetchImpl);
      if (again && 'pr' in again && again.pr) return { ok: true, created: false, pr: again.pr };
      return { ok: false, reason: 'api_error', message: 'GitHub reported a duplicate PR but none is listed — retry.' };
    }
    return f;
  }
  return { ok: true, created: true, pr: created.pr };
}
