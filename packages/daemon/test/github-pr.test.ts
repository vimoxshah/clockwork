/**
 * One-click PR (P0 / T-303), PAT-only: remote parsing, verified push,
 * REST lookup/create with an injected fetch (no network in this suite),
 * full orchestration against file:// remotes, and route contracts.
 *
 * The PAT never appears in any message — asserted, not assumed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  parseGitHubRemote,
  isSshRemote,
  scrub,
  assertSafeBranch,
  assertSafeBranch,
  buildPrTitle,
  buildPrBody,
  collectPrContext,
  pushBranch,
  findOpenPr,
  createPr,
  validatePat,
  openPr,
} from '../src/github-pr.js';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const PAT = 'test-pat-0123456789abcdef';
const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000 }).toString();
}

function initRepo(dir: string): void {
  git(dir, 'init', '-b', 'main');
  git(dir, '-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base');
}

/** Stub fetch: records the request, answers from a script. */
function stubFetch(script: Record<string, { status: number; json: any }>): any {
  const calls: Array<{ url: string; method: string; headers: any; body: any }> = [];
  const fn: any = async (url: string, opts: any) => {
    calls.push({ url, method: opts?.method ?? 'GET', headers: opts?.headers, body: opts?.body ? JSON.parse(opts.body) : undefined });
    const key = `${opts?.method ?? 'GET'} ${new URL(url).pathname}${new URL(url).search}`;
    const hit = script[key] ?? { status: 404, json: { message: 'not stubbed' } };
    return { status: hit.status, json: async () => hit.json };
  };
  return { fn, calls };
}

describe('parseGitHubRemote', () => {
  it('parses https, ssh, .git suffix, trailing slash', () => {
    expect(parseGitHubRemote('https://github.com/o/r')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGitHubRemote('https://github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGitHubRemote('https://github.com/o/r/')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGitHubRemote('git@github.com:o/r.git')).toEqual({ owner: 'o', repo: 'r' });
  });
  it('refuses non-github and garbage', () => {
    expect(parseGitHubRemote('https://gitlab.com/o/r.git')).toBeNull();
    expect(parseGitHubRemote('https://github.com/onlyowner')).toBeNull();
    expect(parseGitHubRemote('/tmp/local.git')).toBeNull();
    expect(parseGitHubRemote('')).toBeNull();
  });
  it('detects ssh remotes', () => {
    expect(isSshRemote('git@github.com:o/r.git')).toBe(true);
    expect(isSshRemote('https://github.com/o/r')).toBe(false);
  });
});

describe('scrub + builders', () => {
  it('strips the PAT everywhere', () => {
    expect(scrub(PAT, `x ${PAT} y ${PAT}`).includes(PAT)).toBe(false);
  });
  it('refuses unsafe branch names (option injection)', () => {
    expect(assertSafeBranch('clockwork/slug/run_1')).toEqual({ ok: true });
    expect(assertSafeBranch('-u')).toMatchObject({ ok: false });
    expect(assertSafeBranch('a..b')).toMatchObject({ ok: false });
    expect(assertSafeBranch('a b')).toMatchObject({ ok: false });
    expect(assertSafeBranch('/x')).toMatchObject({ ok: false });
  });
  it('truncates title and body bounds', () => {
    expect(buildPrTitle('t', 'run_1234567890').length).toBeLessThanOrEqual(120);
    const body = buildPrBody({
      summary: 's'.repeat(5000),
      diffStat: Array.from({ length: 40 }, (_, i) => ({ path: `f${i}`, additions: 1, deletions: 1, binary: false })),
      commits: 2,
      branch: 'b',
      base: 'main',
      costUsd: 1.5,
      turns: 9,
      runId: 'run_1',
      taskName: 't',
    });
    expect(body).toContain('…and 10 more files.');
    expect(body.length).toBeLessThan(6000);
    expect(body.includes(PAT)).toBe(false);
  });
});

describe('REST with injected fetch', () => {
  it('sends Bearer + version headers, parses user', async () => {
    const s = stubFetch({ 'GET /user': { status: 200, json: { login: 'octo' } } });
    const r = await validatePat(PAT, s.fn);
    expect(r).toEqual({ ok: true, login: 'octo' });
    expect(s.calls[0]!.headers.Authorization).toBe(`Bearer ${PAT}`);
  });
  it('401 maps to auth_failed', async () => {
    const s = stubFetch({ 'GET /user': { status: 401, json: { message: 'Bad credentials' } } });
    expect(await validatePat('bad', s.fn)).toEqual({
      ok: false,
      reason: 'auth_failed',
      message: expect.stringContaining('rejected'),
    });
  });
  it('findOpenPr: empty → null, hit → number+url', async () => {
    const empty = stubFetch({ 'GET /repos/o/r/pulls?head=o:b&state=open': { status: 200, json: [] } });
    expect(await findOpenPr('o', 'r', 'b', PAT, empty.fn)).toEqual({ pr: null });
    const hit = stubFetch({
      'GET /repos/o/r/pulls?head=o:b&state=open': { status: 200, json: [{ number: 7, html_url: 'https://github.com/o/r/pull/7' }] },
    });
    expect(await findOpenPr('o', 'r', 'b', PAT, hit.fn)).toEqual({ pr: { number: 7, url: 'https://github.com/o/r/pull/7' } });
  });
  it('createPr posts title/head/base/body, reads 201', async () => {
    const s = stubFetch({ 'POST /repos/o/r/pulls': { status: 201, json: { number: 8, html_url: 'https://github.com/o/r/pull/8' } } });
    const r = await createPr('o', 'r', { title: 't', head: 'b', base: 'main', body: 'x' }, PAT, s.fn);
    expect(r).toEqual({ pr: { number: 8, url: 'https://github.com/o/r/pull/8' } });
    expect(s.calls[0]!.body).toMatchObject({ title: 't', head: 'b', base: 'main' });
  });
  it('network throw maps to network', async () => {
    const boom: any = async () => {
      throw new Error('down');
    };
    expect(await validatePat(PAT, boom)).toMatchObject({ ok: false, reason: 'network' });
  });
});

describe('local git: collect + push', () => {
  let dir: string;
  let repo: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-ghpr-'));
    repo = path.join(dir, 'repo');
    execFileSync('mkdir', ['-p', repo]);
    initRepo(repo);
    git(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('empty diff refuses with reason', () => {
    const r = collectPrContext({ repoPath: repo, worktreePath: null, branch: 'main', baseBranch: 'main' });
    expect(r).toMatchObject({ ok: false, reason: 'empty_diff' });
  });

  it('non-github https refuses before any credential moves (fast, no network)', () => {
    git(repo, 'checkout', '-b', 'cw/x');
    git(repo, 'remote', 'set-url', 'origin', 'https://127.0.0.1:9/o/r.git');
    try {
      const r = pushBranch({ workDir: repo, branch: 'cw/x', pat: PAT });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('not_github');
        expect(r.message.includes(PAT)).toBe(false);
      }
    } finally {
      git(repo, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
      git(repo, 'checkout', 'main');
      git(repo, 'branch', '-D', 'cw/x');
    }
  });

  it('local push failure is reported scrubbed', () => {
    git(repo, 'checkout', '-b', 'cw/y');
    git(repo, '-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'w');
    git(repo, 'remote', 'add', 'broken', '/nonexistent-path-xyz.git');
    try {
      const r = pushBranch({ workDir: repo, branch: 'cw/y', pat: PAT, remote: 'broken' });
      expect(r).toMatchObject({ ok: false, reason: 'push_failed' });
      if (!r.ok) expect(r.message.includes(PAT)).toBe(false);
    } finally {
      git(repo, 'checkout', 'main');
      git(repo, 'branch', '-D', 'cw/y');
      git(repo, 'remote', 'remove', 'broken');
    }
  });

  it('ssh origin refuses loudly', () => {
    git(repo, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
    try {
      expect(pushBranch({ workDir: repo, branch: 'main', pat: PAT })).toMatchObject({ ok: false, reason: 'ssh_origin' });
    } finally {
      git(repo, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    }
  });

  it('non-github https remote refuses before any credential moves', () => {
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.com/o/r.git');
    try {
      const r = pushBranch({ workDir: repo, branch: 'main', pat: PAT });
      expect(r).toMatchObject({ ok: false, reason: 'not_github' });
    } finally {
      git(repo, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    }
  });

  it('race loser dedupes: 422 already-exists → re-lookup returns the winner', async () => {
    const bare = path.join(dir, 'bare3.git');
    execFileSync('git', ['init', '--bare', bare]);
    git(repo, 'checkout', '-b', 'cw/race');
    git(repo, '-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'work');
    git(repo, 'remote', 'add', 'local3', bare);
    try {
      const ctx = collectPrContext({ repoPath: repo, worktreePath: null, branch: 'cw/race', baseBranch: 'main' });
      if (!('owner' in (ctx as any))) throw new Error('collect failed');
      let gets = 0;
      const s = stubFetch({
        'GET /repos/o/r/pulls?head=o:cw%2Frace&state=open': { status: 200, json: [] },
        'POST /repos/o/r/pulls': { status: 422, json: { message: 'A pull request already exists for o:cw/race.' } },
      });
      // Second lookup sees the winner.
      const orig = s.fn;
      const stateful: any = async (url: string, opts: any) => {
        if (String(url).includes('/pulls?head=') && (opts?.method ?? 'GET') === 'GET') {
          gets++;
          if (gets >= 2) return { status: 200, json: async () => [{ number: 11, html_url: 'https://github.com/o/r/pull/11' }] };
        }
        return orig(url, opts);
      };
      const r = await openPr(
        ctx as any,
        { pat: PAT, summary: 'x', taskName: 't', runId: 'run_abc123', costUsd: 0, turns: 0, pushRemote: 'local3' },
        stateful,
      );
      expect(r).toEqual({ ok: true, created: false, pr: { number: 11, url: 'https://github.com/o/r/pull/11' } });
    } finally {
      git(repo, 'checkout', 'main');
      git(repo, 'branch', '-D', 'cw/race');
      git(repo, 'remote', 'remove', 'local3');
    }
  });

  it('full orchestration succeeds against a file remote + stubbed API', async () => {
    const bare = path.join(dir, 'bare.git');
    execFileSync('git', ['init', '--bare', bare]);
    git(repo, 'checkout', '-b', 'cw/feat');
    git(repo, '-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'work');
    git(repo, 'remote', 'add', 'local', bare);
    try {
      const ctx = collectPrContext({ repoPath: repo, worktreePath: null, branch: 'cw/feat', baseBranch: 'main' });
      expect(ctx).toMatchObject({ owner: 'o', repo: 'r', base: 'main' });
      if (!('owner' in (ctx as any))) throw new Error('collect failed');
      const s = stubFetch({
        'GET /repos/o/r/pulls?head=o:cw%2Ffeat&state=open': { status: 200, json: [] },
        'POST /repos/o/r/pulls': { status: 201, json: { number: 9, html_url: 'https://github.com/o/r/pull/9' } },
      });
      const r = await openPr(
        ctx as any,
        { pat: PAT, summary: 'did things', taskName: 't', runId: 'run_abc123', costUsd: 0.5, turns: 3, pushRemote: 'local' },
        s.fn,
      );
      expect(r).toEqual({ ok: true, created: true, pr: { number: 9, url: 'https://github.com/o/r/pull/9' } });
      // pushed for real: the bare repo now has the branch
      expect(git(bare, 'branch').includes('cw/feat')).toBe(true);
    } finally {
      git(repo, 'checkout', 'main');
      git(repo, 'branch', '-D', 'cw/feat');
      git(repo, 'remote', 'remove', 'local');
    }
  });

  it('duplicate path returns existing without creating', async () => {
    const bare = path.join(dir, 'bare2.git');
    execFileSync('git', ['init', '--bare', bare]);
    git(repo, 'checkout', '-b', 'cw/dup');
    git(repo, '-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'work');
    git(repo, 'remote', 'add', 'local2', bare);
    try {
      const ctx = collectPrContext({ repoPath: repo, worktreePath: null, branch: 'cw/dup', baseBranch: 'main' });
      if (!('owner' in (ctx as any))) throw new Error('collect failed');
      const s = stubFetch({
        'GET /repos/o/r/pulls?head=o:cw%2Fdup&state=open': {
          status: 200,
          json: [{ number: 3, html_url: 'https://github.com/o/r/pull/3' }],
        },
      });
      const r = await openPr(
        ctx as any,
        { pat: PAT, summary: 'x', taskName: 't', runId: 'run_abc123', costUsd: 0, turns: 0, pushRemote: 'local2' },
        s.fn,
      );
      expect(r).toEqual({ ok: true, created: false, pr: { number: 3, url: 'https://github.com/o/r/pull/3' } });
      expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
    } finally {
      git(repo, 'checkout', 'main');
      git(repo, 'branch', '-D', 'cw/dup');
      git(repo, 'remote', 'remove', 'local2');
    }
  });
});

describe('routes: /github/* and /runs/:id/open-pr', () => {
  let db: DB;
  let dir: string;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-ghpr-api-'));
    const opened = openDatabase(dir);
    db = opened.db;
    createMigrator(db, MIGRATIONS).migrate();
    const clock = new FakeClock(Date.now());
    const rm = new RunManager({
      db,
      clock,
      dataDir: dir,
      runnerChildModule: '/nonexistent/runner-child.js',
      notify: () => {},
      broadcast: () => {},
      safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
    });
    const scheduler = new Scheduler({ db, clock, enqueueRun: () => {}, notify: () => {} });
    const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
    app = built.app;
    token = built.token;
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const auth = (o: any) => ({ ...o, headers: { authorization: `Bearer ${token}` } });

  it('rejects unauthenticated github routes', async () => {
    expect((await app.inject({ method: 'GET', url: '/github/status' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/github/pat', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/github/validate' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/runs/x/open-pr', payload: {} })).statusCode).toBe(401);
  });

  it('status false → put → status true → clear → status false, PAT never echoed', async () => {
    expect((await app.inject(auth({ method: 'GET', url: '/github/status' }))).json()).toEqual({ configured: false });
    const put = await app.inject(auth({ method: 'PUT', url: '/github/pat', payload: { pat: PAT } }));
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ configured: true });
    expect(JSON.stringify(put.json()).includes(PAT)).toBe(false);
    expect((await app.inject(auth({ method: 'GET', url: '/github/status' }))).json()).toEqual({ configured: true });
    await app.inject(auth({ method: 'PUT', url: '/github/pat', payload: { pat: null } }));
    expect((await app.inject(auth({ method: 'GET', url: '/github/status' }))).json()).toEqual({ configured: false });
  });

  it('validate uses the saved PAT as Bearer and reads login', async () => {
    await app.inject(auth({ method: 'PUT', url: '/github/pat', payload: { pat: PAT } }));
    const seen: any[] = [];
    vi.stubGlobal(
      'fetch',
      (async (url: string, opts: any) => {
        seen.push({ url, auth: opts?.headers?.Authorization });
        return { status: 200, json: async () => ({ login: 'octo' }) };
      }) as any,
    );
    const r = await app.inject(auth({ method: 'POST', url: '/github/validate' }));
    expect(r.json()).toEqual({ ok: true, login: 'octo' });
    expect(seen[0]).toMatchObject({ url: 'https://api.github.com/user', auth: `Bearer ${PAT}` });
    await app.inject(auth({ method: 'PUT', url: '/github/pat', payload: { pat: null } }));
  });

  it('open-pr on unknown run is 404', async () => {
    await app.inject(auth({ method: 'PUT', url: '/github/pat', payload: { pat: PAT } }));
    const r = await app.inject(auth({ method: 'POST', url: '/runs/nope/open-pr', payload: {} }));
    expect(r.statusCode).toBe(404);
    await app.inject(auth({ method: 'PUT', url: '/github/pat', payload: { pat: null } }));
  });

  it('open-pr without a PAT is 422 no_pat', async () => {
    const now = Date.now();
    db.prepare('INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?,?,?,?,?)').run('t1', 't', 'p', now, now);
    db.prepare("INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, report_json) VALUES (?,?,?,?,?,?)").run(
      'run_1',
      't1',
      JSON.stringify({ taskName: 't', repoPath: '/tmp', baseBranch: 'main' }),
      'completed',
      now,
      JSON.stringify({ summary: 's', branch: 'b', costUsd: 0, turns: 0 }),
    );
    const r = await app.inject(auth({ method: 'POST', url: '/runs/run_1/open-pr', payload: {} }));
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: 'no_pat' });
  });
});
