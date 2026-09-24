/**
 * LIVE GitHub verification for one-click PRs (P0.5): real push + real PR
 * against a scratch repo, then immediate close + branch delete. This is the
 * "actual GitHub behavior, not just mocked success" half — the default suite
 * covers the matrix with stubs, this proves the wire.
 *
 * NEVER runs under vitest (top-level process.exit guard, docker-live
 * precedent). Run explicitly:
 *
 *   CLOCKWORK_LIVE_GITHUB_REPO=vimoxshah/<scratch-repo> \
 *   CLOCKWORK_LIVE_GITHUB_PAT=<pat-with-contents-write> \
 *   ./packages/daemon/node_modules/.bin/tsx packages/daemon/test/github-pr-live.standalone.ts
 *
 * It creates branch clockwork/live-probe-<ts>, pushes one empty commit,
 * opens a PR through the REAL openPr() + collectPrContext() code paths,
 * asserts the duplicate lookup returns it, then closes the PR and deletes
 * the branch, leaving the repo exactly as found. Any leftover on failure is
 * named in the output for manual cleanup.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectPrContext, openPr } from '../src/github-pr.js';

const UNDER_VITEST = typeof (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ !== 'undefined';
if (UNDER_VITEST) {
  console.log('SKIP: github-pr-live runs standalone (npx tsx), not under vitest');
  process.exit(0);
}

const REPO = process.env.CLOCKWORK_LIVE_GITHUB_REPO ?? '';
const PAT = process.env.CLOCKWORK_LIVE_GITHUB_PAT ?? '';
if (!REPO || !PAT) {
  console.log('SKIP: set CLOCKWORK_LIVE_GITHUB_REPO and CLOCKWORK_LIVE_GITHUB_PAT to run live verification');
  process.exit(0);
}

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 60_000 }).toString();

const fail = (msg: string): never => {
  console.error(`FAIL ${msg}`);
  process.exit(1);
};

const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-ghpr-live-'));
const branch = `clockwork/live-probe-${Date.now()}`;
let prNumber = 0;
try {
  execFileSync('git', ['clone', `https://github.com/${REPO}.git`, 'work'], { cwd: dir, timeout: 120_000 });
  const work = path.join(dir, 'work');
  git(work, 'checkout', '-b', branch);
  git(work, '-c', 'user.email=live@probe.test', '-c', 'user.name=live-probe', 'commit', '--allow-empty', '-m', 'live probe');
  const ctx = collectPrContext({ repoPath: work, worktreePath: null, branch, baseBranch: null });
  if (!('owner' in ctx)) fail(`collect refused live repo: ${(ctx as any).reason}`);
  const created = await openPr(
    ctx as any,
    { pat: PAT, summary: 'Live probe — safe to close.', taskName: 'live-probe', runId: 'run_live', costUsd: 0, turns: 0 },
  );
  if (!created.ok || !created.created) fail(`create failed: ${JSON.stringify(created)}`);
  prNumber = (created as any).pr.number;
  console.log(`PASS created PR #${prNumber} ${(created as any).pr.url}`);
  // Duplicate path against the real API.
  const dup = await openPr(
    ctx as any,
    { pat: PAT, summary: 'x', taskName: 'x', runId: 'run_live', costUsd: 0, turns: 0 },
  );
  if (!dup.ok || (dup as any).created || (dup as any).pr.number !== prNumber) fail(`duplicate lookup missed: ${JSON.stringify(dup)}`);
  console.log(`PASS duplicate lookup returned #${prNumber} without creating`);
} finally {
  if (prNumber > 0) {
    // Close + delete through the API so the scratch repo is left as found.
    const headers = { Authorization: `Bearer ${PAT}`, Accept: 'application/vnd.github+json' };
    await fetch(`https://api.github.com/repos/${REPO}/pulls/${prNumber}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed' }),
    });
    await fetch(`https://api.github.com/repos/${REPO}/git/refs/heads/${branch}`, { method: 'DELETE', headers });
    console.log(`CLEANUP closed PR #${prNumber} and deleted ${branch}`);
  }
  rmSync(dir, { recursive: true, force: true });
}
console.log('GITHUB-PR-LIVE: ALL CHECKS PASSED');
