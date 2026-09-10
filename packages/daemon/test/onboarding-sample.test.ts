/**
 * T4-2 — GET /onboarding/sample: where a one-click first run should point.
 *
 * The risky half of "run a sample job now" is not booking it, it is deciding
 * WHAT to book it against. The route is allowed three places it already knows
 * about and no search at all, so these tests are mostly about what it refuses
 * to do: it does not walk the disk, it does not guess when it finds nothing,
 * and it creates nothing itself.
 *
 * `$HOME` is repointed at a temp tree per test, because "the first git repo
 * the folder browser finds" is defined against $HOME and there is no other
 * honest way to assert it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer, requiresAuth } from '../src/api.js';
import { ProfileRepo } from '../src/repo.js';
import { seedBuiltinProfiles } from '../src/profiles.js';
import { ONBOARDING_BUNDLED_SAMPLE_JOB } from '../src/profile-library.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

let db: DB;
let dir: string;
let home: string;
let realHome: string | undefined;
let app: FastifyInstance;
let token: string;

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

/** A repo a run could actually use: initialised AND carrying a commit. */
function makeRepo(at: string): string {
  makeEmptyRepo(at);
  writeFileSync(path.join(at, 'README.md'), '# sample\n');
  const ident = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=Test'];
  execFileSync('git', [...ident, 'add', '.'], { cwd: at, encoding: 'utf8' });
  execFileSync('git', [...ident, 'commit', '-qm', 'init'], { cwd: at, encoding: 'utf8' });
  return at;
}

/** `git init` and nothing else — a repo with no commits, which no run can use. */
function makeEmptyRepo(at: string): string {
  mkdirSync(at, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: at, encoding: 'utf8' });
  return at;
}

interface SampleAnswer {
  repo: { path: string; name: string; source: string } | null;
  lookedIn: string[];
  profileSlug: string;
  profileId: string | null;
  job: { name: string; prompt: string; bundled: boolean };
}

async function ask(): Promise<SampleAnswer> {
  const res = await app.inject({
    method: 'GET',
    url: '/onboarding/sample',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SampleAnswer;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-onb-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'cw-onb-home-'));
  realHome = process.env.HOME;
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  seedBuiltinProfiles(new ProfileRepo(db)); // main.ts:466 does this before buildServer
  const clock = new FakeClock(Date.now());
  const rm = new RunManager({
    db,
    clock,
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js', // nothing here executes a run
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock, dataDir: dir, enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
  app = built.app;
  token = built.token;
  await app.ready();
  process.env.HOME = home;
});

afterEach(() => {
  // A repo the daemon has been pointed at outranks one it had to look for, so
  // a task left behind by one case would decide the next one. Hard delete, not
  // the API's soft delete: the route reads soft-deleted rows on purpose.
  db.prepare('DELETE FROM tasks').run();
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
});

afterAll(async () => {
  process.env.HOME = realHome;
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('T4-2 GET /onboarding/sample — finding a repo the user already has', () => {
  it('takes the first git repo the folder browser would badge, in the browser’s own order', async () => {
    // /fs/browse lists $HOME top level, hides dotted entries, sorts by
    // localeCompare and badges an entry whose `.git` is a directory. So:
    // `alpha-notes` is skipped for having no .git, `.hidden-repo` for being
    // dotted, and `beta-work` wins over `zeta-work` on the sort.
    mkdirSync(path.join(home, 'alpha-notes'), { recursive: true });
    makeRepo(path.join(home, '.hidden-repo'));
    makeRepo(path.join(home, 'beta-work'));
    makeRepo(path.join(home, 'zeta-work'));

    const answer = await ask();

    expect(answer.repo).not.toBeNull();
    expect(answer.repo!.name).toBe('beta-work');
    expect(answer.repo!.path).toBe(path.join(home, 'beta-work'));
    expect(answer.repo!.source).toBe('home');
  });

  it('does not descend: a repo one level below the browser’s listing is not found', async () => {
    // The point of the route, negatively stated. `~/projects/deep` is exactly
    // the repo a filesystem walk would return and the picker would not.
    makeRepo(path.join(home, 'projects', 'deep'));

    const answer = await ask();

    expect(answer.repo, 'a nested repo means the route started searching').toBeNull();
  });

  it('prefers a repo the daemon has already been pointed at over one it had to look for', async () => {
    const booked = makeRepo(path.join(home, 'zzz-booked'));
    makeRepo(path.join(home, 'aaa-browsable'));
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'something the user booked earlier',
        prompt: 'work',
        repoPath: booked,
        schedule: { kind: 'once', runAt: Date.now() + 600_000, tz: 'UTC' },
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const answer = await ask();

    // `aaa-browsable` sorts first and would win the $HOME scan. It loses.
    expect(answer.repo!.path).toBe(booked);
    expect(answer.repo!.source).toBe('booked');
  });

  it('still prefers a booked repo after the task is deleted — the choice outlives the row', async () => {
    const booked = makeRepo(path.join(home, 'zzz-booked'));
    makeRepo(path.join(home, 'aaa-browsable'));
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'deleted later',
        prompt: 'work',
        repoPath: booked,
        schedule: { kind: 'once', runAt: Date.now() + 600_000, tz: 'UTC' },
      },
    });
    const id = (created.json() as { id: string }).id;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/tasks/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(removed.statusCode).toBe(200);

    expect((await ask()).repo!.path).toBe(booked);
  });

  it('finds a repo Clockwork cloned for the user, which the browser cannot see', async () => {
    // POST /repos/clone writes to ~/.clockwork/repos, a dotted path /fs/browse
    // hides. Without this source, "clone a repo" in Settings would be followed
    // by "no git repository found".
    const cloned = makeRepo(path.join(home, '.clockwork', 'repos', 'acme-api'));

    const answer = await ask();

    expect(answer.repo!.path).toBe(cloned);
    expect(answer.repo!.source).toBe('cloned');
    expect(answer.repo!.name).toBe('acme-api');
  });

  it('ignores a directory that only wears the badge', async () => {
    // An empty `.git` DIRECTORY earns the browser's git badge, and `git
    // rev-parse` answers yes for it too — by walking UP and finding whatever
    // repository the temp tree happens to sit inside. Only the toplevel
    // comparison catches this one.
    mkdirSync(path.join(home, 'costume', '.git'), { recursive: true });

    expect((await ask()).repo).toBeNull();
  });

  it('ignores a repo with no commits, which would fail the run’s own preflight', async () => {
    // `git init` and nothing else. It is a real repository by every cheap
    // test, and `preflightRepo` refuses it with "Repository has no commits
    // yet" — so a sample pointed here is a guaranteed failed first run.
    makeEmptyRepo(path.join(home, 'aaa-brand-new'));
    const usable = makeRepo(path.join(home, 'bbb-real'));

    expect((await ask()).repo!.path).toBe(usable);
  });

  it('will not offer a plain directory just because $HOME itself is a repo', async () => {
    // Dotfiles-as-home-repo, a real setup. Every directory under $HOME then
    // answers yes to `git rev-parse`, because it walks up. `Documents` still
    // has no `.git` of its own, so the browser would not badge it and neither
    // does this — the badge and the toplevel check agree.
    makeRepo(home);
    mkdirSync(path.join(home, 'Documents'), { recursive: true });

    expect((await ask()).repo).toBeNull();
  });

  it('will not offer a booked path that is a sub-directory of a repo', async () => {
    // The `booked` source gets no badge check, so the toplevel comparison is
    // the only thing standing between "a path in the tasks table" and "an
    // agent pointed at packages/daemon/src".
    const real = makeRepo(path.join(home, 'zzz-monorepo'));
    const inner = path.join(real, 'packages');
    mkdirSync(inner, { recursive: true });
    const browsable = makeRepo(path.join(home, 'aaa-browsable'));
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'booked at a sub-directory',
        prompt: 'work',
        repoPath: inner,
        schedule: { kind: 'once', runAt: Date.now() + 600_000, tz: 'UTC' },
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const answer = await ask();

    expect(answer.repo!.path).not.toBe(inner);
    expect(answer.repo!.path).toBe(browsable);
    expect(answer.repo!.source).toBe('home');
  });
});

describe('T4-2 GET /onboarding/sample — when there is nothing to review', () => {
  it('says so, names where it looked, and offers the bundled sample instead of a guess', async () => {
    mkdirSync(path.join(home, 'Documents'), { recursive: true });
    mkdirSync(path.join(home, 'Downloads'), { recursive: true });

    const answer = await ask();

    expect(answer.repo, 'nothing found must be null, never a nearby directory').toBeNull();
    expect(answer.job.bundled).toBe(true);
    expect(answer.job).toEqual(ONBOARDING_BUNDLED_SAMPLE_JOB);
    // "Say so" has to be specific enough to act on.
    expect(answer.lookedIn.length).toBeGreaterThan(0);
    expect(answer.lookedIn.join(' ')).toContain('~');
  });

  it('carries the sample to review inside the prompt, so the fallback writes nothing to disk', async () => {
    const answer = await ask();

    // The whole reason the fallback is a snippet and not a scaffolded repo:
    // the answer to "we found nothing of yours" must not be "so we created
    // something in your home folder".
    expect(answer.job.prompt).toContain('billing.ts');
    expect(answer.job.prompt).toContain('SELECT * FROM orders');
    expect(answer.job.prompt).toContain('everything you need is in this prompt');
  });
});

describe('T4-2 GET /onboarding/sample — what it must not do', () => {
  it('books nothing: asking twice leaves the tasks table empty', async () => {
    makeRepo(path.join(home, 'beta-work'));
    const before = (db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c;

    await ask();
    await ask();

    expect((db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c).toBe(before);
    expect((db.prepare('SELECT COUNT(*) c FROM runs').get() as { c: number }).c).toBe(0);
  });

  it('is never anonymous — it discloses a directory name under $HOME', async () => {
    expect(requiresAuth('/onboarding/sample')).toBe(true);
    const res = await app.inject({ method: 'GET', url: '/onboarding/sample' });
    expect(res.statusCode).toBe(401);
  });

  it('names the read-only reviewer, and resolves it to a profile that exists', async () => {
    const answer = await ask();

    expect(answer.profileSlug).toBe('code-reviewer');
    // Struck clause from T4-7: the sample must NOT use the first bundled
    // template. That is Dep Surgeon, which edits manifests and lockfiles.
    expect(answer.profileSlug).not.toBe('dep-surgeon');
    expect(answer.profileId, 'the seeded Code Reviewer profile must resolve').not.toBeNull();
    const row = db.prepare('SELECT slug FROM profiles WHERE id=?').get(answer.profileId) as { slug: string };
    expect(row.slug).toBe('code-reviewer');
  });
});
