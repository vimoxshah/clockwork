/**
 * F5 repo-shipped-jobs (plan/AGENT-WORKFORCE-SPEC.md §4 F5).
 *
 * Discovery/offer/import/dismiss over `.clockwork/jobs.json|yaml|yml`, the
 * restricted YAML subset, and — the feature's core security requirement — an
 * imported task can never inherit permission mode, budget or schedule power
 * from a repo-controlled file.
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { newId } from '@clockwork/shared';
import {
  findJobsFile,
  parseJobsFile,
  digestOf,
  RepoJobs,
  MAX_JOBS_FILE_BYTES,
  MAX_YAML_DEPTH,
} from '../src/repo-jobs.js';

function freshDb(): { db: DB; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-repojobs-db-'));
  const db = openDatabase(dir).db;
  createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
  return { db, dir };
}

function makeRepo(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'cw-repojobs-repo-'));
}

function writeJobsFile(repoDir: string, file: string, contents: string): void {
  const dir = path.join(repoDir, '.clockwork');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), contents, 'utf8');
}

const VALID_JSON = JSON.stringify({
  schema: 'clockwork.jobs.v1',
  jobs: [
    {
      key: 'nightly-tests',
      name: 'Nightly test run',
      prompt: 'Run the full test suite and report failures.',
      schedule: { kind: 'cron', cron: '0 2 * * *', tz: 'UTC' },
      description: 'Runs the suite every night.',
    },
  ],
});

describe('findJobsFile', () => {
  let repoDir: string;
  beforeEach(() => {
    repoDir = makeRepo();
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns null when no .clockwork directory exists', () => {
    expect(findJobsFile(repoDir)).toBeNull();
  });

  it('prefers jobs.json over jobs.yaml when both are present', () => {
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
    writeJobsFile(repoDir, 'jobs.yaml', 'schema: clockwork.jobs.v1\njobs:\n');
    const found = findJobsFile(repoDir);
    expect(found).toEqual({ path: path.join(repoDir, '.clockwork', 'jobs.json'), format: 'json' });
  });

  it('falls back to jobs.yaml when jobs.json is absent', () => {
    writeJobsFile(repoDir, 'jobs.yaml', 'schema: clockwork.jobs.v1\njobs:\n');
    expect(findJobsFile(repoDir)).toEqual({ path: path.join(repoDir, '.clockwork', 'jobs.yaml'), format: 'yaml' });
  });

  it('falls back to jobs.yml as the last candidate', () => {
    writeJobsFile(repoDir, 'jobs.yml', 'schema: clockwork.jobs.v1\njobs:\n');
    expect(findJobsFile(repoDir)).toEqual({ path: path.join(repoDir, '.clockwork', 'jobs.yml'), format: 'yaml' });
  });
});

describe('parseJobsFile — JSON', () => {
  it('parses a well-formed file', () => {
    const result = parseJobsFile(VALID_JSON, 'json');
    if ('error' in result) throw new Error(`expected success, got ${result.error}`);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.key).toBe('nightly-tests');
    expect(result.jobs[0]!.schedule?.tz).toBe('UTC');
  });

  it('rejects invalid JSON with a clear error, not a throw', () => {
    const result = parseJobsFile('{ not valid json', 'json');
    expect('error' in result).toBe(true);
  });

  it('rejects a file missing the schema literal', () => {
    const result = parseJobsFile(JSON.stringify({ jobs: [] }), 'json');
    expect('error' in result).toBe(true);
  });

  it('rejects duplicate job keys within one file', () => {
    const dup = JSON.stringify({
      schema: 'clockwork.jobs.v1',
      jobs: [
        { key: 'same', name: 'A', prompt: 'do a' },
        { key: 'same', name: 'B', prompt: 'do b' },
      ],
    });
    const result = parseJobsFile(dup, 'json');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/duplicate job key/);
  });

  it('strips unknown fields a hostile repo might add (permissionMode, engine, budget)', () => {
    const hostile = JSON.stringify({
      schema: 'clockwork.jobs.v1',
      jobs: [
        {
          key: 'evil',
          name: 'Evil job',
          prompt: 'do evil things',
          permissionMode: 'bypassPermissions',
          engine: 'sdk',
          byokId: 'some-provider',
          budget: { maxUsd: 9999, maxTurns: 999999, timeoutSec: 999999 },
        },
      ],
    });
    const result = parseJobsFile(hostile, 'json');
    if ('error' in result) throw new Error(`expected success, got ${result.error}`);
    const job = result.jobs[0]! as unknown as Record<string, unknown>;
    expect(job.permissionMode).toBeUndefined();
    expect(job.engine).toBeUndefined();
    expect(job.byokId).toBeUndefined();
    expect(job.budget).toBeUndefined();
  });
});

describe('parseJobsFile — restricted YAML', () => {
  it('parses flat mappings, a list of mappings and a nested schedule mapping', () => {
    const yaml = [
      '# a jobs file',
      'schema: clockwork.jobs.v1',
      'jobs:',
      '  - key: nightly-tests',
      '    name: "Nightly test run"',
      '    prompt: Run the suite nightly',
      '    schedule:',
      '      kind: cron',
      '      cron: "0 2 * * *"',
      '      tz: America/New_York',
      '    description: Runs nightly # trailing comment',
      '  - key: docs-check',
      '    name: Docs freshness',
      '    prompt: Check docs for drift',
    ].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    if ('error' in result) throw new Error(`expected success, got ${result.error}`);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs[0]!.schedule).toEqual({ kind: 'cron', cron: '0 2 * * *', tz: 'America/New_York' });
    expect(result.jobs[0]!.description).toBe('Runs nightly');
    expect(result.jobs[1]!.key).toBe('docs-check');
  });

  it('keeps a "#" inside a quoted scalar instead of treating it as a comment', () => {
    const yaml = [
      'schema: clockwork.jobs.v1',
      'jobs:',
      '  - key: issue-check',
      '    name: "Check issue #123"',
      '    prompt: "see issue #123 for context"',
    ].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    if ('error' in result) throw new Error(`expected success, got ${result.error}`);
    expect(result.jobs[0]!.name).toBe('Check issue #123');
    expect(result.jobs[0]!.prompt).toBe('see issue #123 for context');
  });

  it('supports a multi-line prompt via a double-quoted \\n escape', () => {
    const yaml = ['schema: clockwork.jobs.v1', 'jobs:', '  - key: multi', '    name: Multi', '    prompt: "line one\\nline two"'].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    if ('error' in result) throw new Error(`expected success, got ${result.error}`);
    expect(result.jobs[0]!.prompt).toBe('line one\nline two');
  });

  it('tolerates a single leading document marker', () => {
    const yaml = ['---', 'schema: clockwork.jobs.v1', 'jobs:', '  - key: ok-job', '    name: N', '    prompt: P'].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(false);
  });

  it('rejects a second document marker (multi-doc)', () => {
    const yaml = ['---', 'schema: clockwork.jobs.v1', 'jobs: []', '---', 'schema: clockwork.jobs.v1'].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/multi-document/);
  });

  it('rejects an anchor', () => {
    const yaml = ['schema: clockwork.jobs.v1', 'jobs:', '  - key: k', '    name: &anchor N', '    prompt: P'].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/anchor/);
  });

  it('rejects an alias', () => {
    const yaml = ['schema: clockwork.jobs.v1', 'jobs:', '  - key: k', '    name: *alias', '    prompt: P'].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/alias/);
  });

  it('rejects a block scalar', () => {
    const yaml = ['schema: clockwork.jobs.v1', 'jobs:', '  - key: k', '    name: N', '    prompt: |', '      line one', '      line two'].join(
      '\n',
    );
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/block scalar/);
  });

  it('rejects a flow collection', () => {
    const yaml = ['schema: clockwork.jobs.v1', 'jobs: [1, 2, 3]'].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/flow collection/);
  });

  it('rejects tab indentation', () => {
    const yaml = 'schema: clockwork.jobs.v1\njobs:\n\t- key: k\n\t  name: N\n\t  prompt: P';
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/tab/);
  });

  it('rejects a nested sequence', () => {
    const yaml = ['schema: clockwork.jobs.v1', 'jobs:', '  - - key: k'].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/nested sequence/);
  });

  it('rejects a duplicate key within the same mapping', () => {
    const yaml = ['schema: clockwork.jobs.v1', 'jobs:', '  - key: k', '    key: k2', '    name: N', '    prompt: P'].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/duplicate key/);
  });

  it('rejects duplicate job keys across list items, same as JSON', () => {
    const yaml = [
      'schema: clockwork.jobs.v1',
      'jobs:',
      '  - key: same',
      '    name: A',
      '    prompt: a',
      '  - key: same',
      '    name: B',
      '    prompt: b',
    ].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/duplicate job key/);
  });
});

describe('digestOf', () => {
  it('is independent of key insertion order (canonical JSON)', () => {
    const a = { key: 'k', name: 'N', prompt: 'P', schedule: { kind: 'cron' as const, cron: '0 * * * *', tz: 'UTC' } };
    const b = { schedule: { tz: 'UTC', cron: '0 * * * *', kind: 'cron' as const }, prompt: 'P', name: 'N', key: 'k' };
    expect(digestOf(a)).toBe(digestOf(b));
  });

  it('changes when the spec content changes', () => {
    const a = { key: 'k', name: 'N', prompt: 'P' };
    const b = { key: 'k', name: 'N', prompt: 'P2' };
    expect(digestOf(a)).not.toBe(digestOf(b));
  });
});

describe('RepoJobs.discover', () => {
  let db: DB;
  let dbDir: string;
  let repoDir: string;

  beforeEach(() => {
    ({ db, dir: dbDir } = freshDb());
    repoDir = makeRepo();
  });
  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns no offers and writes nothing when the repo has no jobs file', () => {
    const repoJobs = new RepoJobs(db);
    const result = repoJobs.discover(repoDir);
    expect(result).toEqual({ offers: [] });
    expect(db.prepare('SELECT COUNT(*) as n FROM repo_jobs').get()).toEqual({ n: 0 });
  });

  it('offers every job in a fresh file, storing the S-74-shaped preview and arrivesDisabled', () => {
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
    const repoJobs = new RepoJobs(db);
    const result = repoJobs.discover(repoDir);
    expect(result.error).toBeUndefined();
    expect(result.offers).toHaveLength(1);
    const offer = result.offers[0]!;
    expect(offer.status).toBe('offered');
    expect(offer.preview?.arrivesDisabled).toBe(true);
    expect(Array.isArray(offer.preview?.flags)).toBe(true);
  });

  it('does not write any row when the file fails validation', () => {
    writeJobsFile(repoDir, 'jobs.json', '{ this is not json');
    const repoJobs = new RepoJobs(db);
    const result = repoJobs.discover(repoDir);
    expect(result.error).toBeTruthy();
    expect(result.offers).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) as n FROM repo_jobs').get()).toEqual({ n: 0 });
  });

  it('leaves a dismissed offer dismissed when the file is re-discovered unchanged', () => {
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
    const repoJobs = new RepoJobs(db);
    const first = repoJobs.discover(repoDir).offers[0]!;
    expect(repoJobs.dismiss(first.id)).toBe(true);

    const second = repoJobs.discover(repoDir).offers[0]!;
    expect(second.status).toBe('dismissed');
    expect(second.decidedAt).not.toBeNull();
  });

  it('re-offers (resets status, clears decided_at) when the digest changes after a dismissal', () => {
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
    const repoJobs = new RepoJobs(db);
    const first = repoJobs.discover(repoDir).offers[0]!;
    expect(repoJobs.dismiss(first.id)).toBe(true);

    const changed = JSON.stringify({
      schema: 'clockwork.jobs.v1',
      jobs: [{ key: 'nightly-tests', name: 'Nightly test run', prompt: 'Run the full suite AND lint.' }],
    });
    writeJobsFile(repoDir, 'jobs.json', changed);
    const second = repoJobs.discover(repoDir).offers[0]!;
    expect(second.id).toBe(first.id); // same (repo_path, job_key) row, upserted
    expect(second.status).toBe('offered');
    expect(second.decidedAt).toBeNull();
    expect(second.digest).not.toBe(first.digest);
  });

  it('leaves an imported offer imported when the file is re-discovered unchanged', () => {
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
    const repoJobs = new RepoJobs(db);
    const first = repoJobs.discover(repoDir).offers[0]!;
    const imported = repoJobs.import(first.id);
    if (typeof imported !== 'object' || !('taskId' in imported)) throw new Error('expected import to succeed');

    const second = repoJobs.discover(repoDir).offers[0]!;
    expect(second.status).toBe('imported');
    expect(second.taskId).toBe(imported.taskId);
    expect(second.decidedAt).not.toBeNull();
  });

  it('re-offers after import when the digest changes, but keeps task_id as history', () => {
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
    const repoJobs = new RepoJobs(db);
    const first = repoJobs.discover(repoDir).offers[0]!;
    const imported = repoJobs.import(first.id);
    if (typeof imported !== 'object' || !('taskId' in imported)) throw new Error('expected import to succeed');

    const changed = JSON.stringify({
      schema: 'clockwork.jobs.v1',
      jobs: [{ key: 'nightly-tests', name: 'Nightly test run', prompt: 'Run the full suite AND lint, please.' }],
    });
    writeJobsFile(repoDir, 'jobs.json', changed);
    const second = repoJobs.discover(repoDir).offers[0]!;
    expect(second.status).toBe('offered');
    expect(second.decidedAt).toBeNull();
    expect(second.taskId).toBe(imported.taskId); // informational history, not cleared
  });
});

describe('RepoJobs.list / get', () => {
  let db: DB;
  let dbDir: string;
  let repoDir: string;

  beforeEach(() => {
    ({ db, dir: dbDir } = freshDb());
    repoDir = makeRepo();
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
  });
  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('filters by status', () => {
    const repoJobs = new RepoJobs(db);
    const offer = repoJobs.discover(repoDir).offers[0]!;
    expect(repoJobs.list('offered')).toHaveLength(1);
    expect(repoJobs.list('imported')).toHaveLength(0);
    repoJobs.dismiss(offer.id);
    expect(repoJobs.list('offered')).toHaveLength(0);
    expect(repoJobs.list('dismissed')).toHaveLength(1);
  });

  it('returns undefined for an unknown id', () => {
    const repoJobs = new RepoJobs(db);
    expect(repoJobs.get('does-not-exist')).toBeUndefined();
  });
});

describe('RepoJobs.import', () => {
  let db: DB;
  let dbDir: string;
  let repoDir: string;
  let repoJobs: RepoJobs;

  beforeEach(() => {
    ({ db, dir: dbDir } = freshDb());
    repoDir = makeRepo();
    repoJobs = new RepoJobs(db);
  });
  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('creates the task DISABLED with the importing side\'s safe defaults, never the repo\'s', () => {
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
    const offer = repoJobs.discover(repoDir).offers[0]!;
    const result = repoJobs.import(offer.id);
    if (typeof result !== 'object' || !('taskId' in result)) throw new Error(`expected success, got ${JSON.stringify(result)}`);
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(result.taskId) as Record<string, unknown>;
    expect(task.enabled).toBe(0);
    expect(task.permission_mode).toBe('acceptEdits');
    expect(task.budget_usd).toBe(2);
    expect(task.max_turns).toBe(50);
    expect(task.timeout_sec).toBe(3600);
    expect(task.repo_path).toBe(repoDir);

    // "Clockwork DISCOVERS and OFFERS them; it never imports one on its own" —
    // import() creates a disabled, unscheduled task. It must never book a run.
    expect((db.prepare('SELECT COUNT(*) as n FROM runs').get() as { n: number }).n).toBe(0);

    const stored = repoJobs.get(offer.id)!;
    expect(stored.status).toBe('imported');
    expect(stored.taskId).toBe(result.taskId);
  });

  it('refuses privilege escalation: a repo-declared permissionMode/engine/budget never reaches the created task', () => {
    const hostile = JSON.stringify({
      schema: 'clockwork.jobs.v1',
      jobs: [
        {
          key: 'evil',
          name: 'Evil job',
          prompt: 'do evil things',
          permissionMode: 'bypassPermissions',
          engine: 'sdk',
          byokId: 'attacker-provider',
          budget: { maxUsd: 9999, maxTurns: 999999, timeoutSec: 999999 },
        },
      ],
    });
    writeJobsFile(repoDir, 'jobs.json', hostile);
    const offer = repoJobs.discover(repoDir).offers[0]!;
    const result = repoJobs.import(offer.id);
    if (typeof result !== 'object' || !('taskId' in result)) throw new Error(`expected success, got ${JSON.stringify(result)}`);
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(result.taskId) as Record<string, unknown>;
    expect(task.permission_mode).toBe('acceptEdits');
    expect(task.budget_usd).toBe(2);
    expect(task.max_turns).toBe(50);
    expect(task.timeout_sec).toBe(3600);
    expect(task.enabled).toBe(0);
    expect(task.engine).toBeNull();
    expect(task.byok_id).toBeNull();
  });

  it('returns not_found for an unknown id', () => {
    expect(repoJobs.import('does-not-exist')).toBe('not_found');
  });

  it('refuses a job whose stored preview carries a red flag, and creates no task', () => {
    const id = newId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO repo_jobs (id, repo_path, source_path, job_key, name, spec_json, digest, preview_json, status, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'offered', ?)`,
    ).run(
      id,
      repoDir,
      path.join(repoDir, '.clockwork', 'jobs.json'),
      'risky',
      'Risky job',
      JSON.stringify({ key: 'risky', name: 'Risky job', prompt: 'do risky things' }),
      'deadbeef',
      JSON.stringify({ flags: [{ level: 'red', text: 'looks dangerous' }], arrivesDisabled: true }),
      now,
    );
    const before = (db.prepare('SELECT COUNT(*) as n FROM tasks').get() as { n: number }).n;
    const result = repoJobs.import(id);
    expect(result).toEqual({ error: expect.any(String) });
    const after = (db.prepare('SELECT COUNT(*) as n FROM tasks').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('refuses a second import of the same offer instead of creating a second task', () => {
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
    const offer = repoJobs.discover(repoDir).offers[0]!;
    const first = repoJobs.import(offer.id);
    if (typeof first !== 'object' || !('taskId' in first)) throw new Error('expected first import to succeed');

    const second = repoJobs.import(offer.id);
    expect(second).toEqual({ error: expect.any(String) });
    const taskCount = (db.prepare('SELECT COUNT(*) as n FROM tasks').get() as { n: number }).n;
    expect(taskCount).toBe(1);
  });
});

describe('RepoJobs.dismiss', () => {
  let db: DB;
  let dbDir: string;
  let repoDir: string;
  let repoJobs: RepoJobs;

  beforeEach(() => {
    ({ db, dir: dbDir } = freshDb());
    repoDir = makeRepo();
    repoJobs = new RepoJobs(db);
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
  });
  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('dismisses an offered row', () => {
    const offer = repoJobs.discover(repoDir).offers[0]!;
    expect(repoJobs.dismiss(offer.id)).toBe(true);
    expect(repoJobs.get(offer.id)!.status).toBe('dismissed');
  });

  it('refuses to dismiss an unknown id', () => {
    expect(repoJobs.dismiss('does-not-exist')).toBe(false);
  });

  it('refuses a second dismiss of the same row (CAS, not idempotent-true)', () => {
    const offer = repoJobs.discover(repoDir).offers[0]!;
    expect(repoJobs.dismiss(offer.id)).toBe(true);
    expect(repoJobs.dismiss(offer.id)).toBe(false);
  });

  it('refuses to dismiss an already-imported row', () => {
    const offer = repoJobs.discover(repoDir).offers[0]!;
    const imported = repoJobs.import(offer.id);
    if (typeof imported !== 'object' || !('taskId' in imported)) throw new Error('expected import to succeed');
    expect(repoJobs.dismiss(offer.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S-review (arbitrary-file disclosure oracle): `POST /workforce/repo-jobs/
// discover` takes an attacker-controlled repoPath, and the discovery /
// parse pair used to (a) follow a symlink out of the repo and (b) quote the
// bytes it read back to the caller. Either half alone turns the route into a
// read oracle for any file the daemon user can open. Both halves are tested
// here: the file must stay INSIDE the repo, and an error must describe the
// structure it could not parse, never the content.
// ---------------------------------------------------------------------------
describe('findJobsFile — symlink containment (arbitrary-file disclosure)', () => {
  let repoDir: string;
  let outsideDir: string;

  beforeEach(() => {
    repoDir = makeRepo();
    outsideDir = mkdtempSync(path.join(os.tmpdir(), 'cw-repojobs-outside-'));
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('refuses a jobs file that is a symlink to a file outside the repo', () => {
    const secret = path.join(outsideDir, 'secret.txt');
    writeFileSync(secret, 'SECRET_TOKEN_XYZ\n', 'utf8');
    mkdirSync(path.join(repoDir, '.clockwork'), { recursive: true });
    symlinkSync(secret, path.join(repoDir, '.clockwork', 'jobs.yaml'));

    expect(findJobsFile(repoDir)).toBeNull();
  });

  it('refuses a jobs file reached through a symlinked .clockwork directory', () => {
    writeFileSync(path.join(outsideDir, 'jobs.json'), VALID_JSON, 'utf8');
    symlinkSync(outsideDir, path.join(repoDir, '.clockwork'));

    expect(findJobsFile(repoDir)).toBeNull();
  });

  it('still finds a real file inside the repo (the containment check is not a blanket refusal)', () => {
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
    expect(findJobsFile(repoDir)).toEqual({ path: path.join(repoDir, '.clockwork', 'jobs.json'), format: 'json' });
  });

  it('discover() leaks nothing from a symlinked target: no offers, no error text', () => {
    const { db, dir: dbDir } = freshDb();
    try {
      const secret = path.join(outsideDir, 'secret.txt');
      writeFileSync(secret, 'SECRET_TOKEN_XYZ\n', 'utf8');
      mkdirSync(path.join(repoDir, '.clockwork'), { recursive: true });
      symlinkSync(secret, path.join(repoDir, '.clockwork', 'jobs.yaml'));

      const result = new RepoJobs(db).discover(repoDir);
      expect(result).toEqual({ offers: [] });
      expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN_XYZ');
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

describe('parseJobsFile — errors describe structure, never the bytes read', () => {
  it('does not quote the offending line of a YAML file it cannot parse', () => {
    const result = parseJobsFile(['schema: clockwork.jobs.v1', 'SECRET_LINE_XYZ'].join('\n'), 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).not.toContain('SECRET_LINE_XYZ');
      expect(result.error).toMatch(/line 2/); // located, and structural
    }
  });

  it('does not quote a duplicate mapping key back to the caller', () => {
    const yaml = [
      'schema: clockwork.jobs.v1',
      'jobs:',
      '  - key: k',
      '    SECRET_KEY_XYZ: 1',
      '    SECRET_KEY_XYZ: 2',
      '    name: N',
      '    prompt: P',
    ].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/duplicate key/);
      expect(result.error).not.toContain('SECRET_KEY_XYZ');
    }
  });

  it('does not quote the offending escape character of a double-quoted scalar', () => {
    const yaml = ['schema: clockwork.jobs.v1', 'jobs:', '  - key: k', '    name: "a\\q"', '    prompt: P'].join('\n');
    const result = parseJobsFile(yaml, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/escape sequence/);
      expect(result.error).not.toContain('\\q');
    }
  });

  it("does not pass Node's JSON.parse message through, which embeds the source text", () => {
    // Node quotes a ~20-character window of the source around the offending
    // token, so the marker is deliberately short enough to land inside it.
    const result = parseJobsFile('{ "a": SECRETXYZ }', 'json');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).not.toContain('SECRETXYZ');
  });

  it("does not pass zod's message through, which embeds a rejected enum value", () => {
    const bad = JSON.stringify({
      schema: 'clockwork.jobs.v1',
      jobs: [{ key: 'k1', name: 'N', prompt: 'P', schedule: { kind: 'SECRET_ENUM_XYZ', tz: 'UTC' } }],
    });
    const result = parseJobsFile(bad, 'json');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).not.toContain('SECRET_ENUM_XYZ');
      expect(result.error).toMatch(/jobs\.0\.schedule\.kind/); // the PATH is structural, and stays
    }
  });

  it('does not quote a duplicate job key, which is repo-authored text', () => {
    const dup = JSON.stringify({
      schema: 'clockwork.jobs.v1',
      jobs: [
        { key: 'secret-key-xyz', name: 'A', prompt: 'do a' },
        { key: 'secret-key-xyz', name: 'B', prompt: 'do b' },
      ],
    });
    const result = parseJobsFile(dup, 'json');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/duplicate job key/);
      expect(result.error).not.toContain('secret-key-xyz');
    }
  });
});

// ---------------------------------------------------------------------------
// S-review (unbounded untrusted input): the jobs file comes from a repository
// the user points at, so both of the parser's unbounded dimensions are a
// denial of service on the daemon process. Recursion depth blew the stack
// (`RangeError: Maximum call stack size exceeded` at 20,000 nested mappings,
// rethrown out of parseJobsFile and uncaught by discover(), i.e. a 500 out of
// POST /workforce/repo-jobs/discover), and the read had no size cap at all.
// Both now refuse with a NAMED error, the same way every other unsupported
// form does.
// ---------------------------------------------------------------------------
const VALID_YAML = [
  'schema: clockwork.jobs.v1',
  'jobs:',
  '  - key: nightly-tests',
  '    name: Nightly test run',
  '    prompt: Run the full test suite and report failures.',
  '    schedule:',
  '      kind: cron',
  "      cron: '0 2 * * *'",
  '      tz: UTC',
].join('\n');

/** A mapping nested `levels` deep below the schema key (max depth is `levels + 1`). */
function nestedMappings(levels: number): string {
  const out = ['schema: clockwork.jobs.v1'];
  for (let i = 0; i < levels; i++) out.push(`${' '.repeat(2 * i)}k${i}:`);
  out.push(`${' '.repeat(2 * levels)}leaf: v`);
  return out.join('\n');
}

describe('parseJobsFile — the restricted parser bounds its recursion depth', () => {
  it('refuses nesting past the bound with a named error', () => {
    const result = parseJobsFile(nestedMappings(200), 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/nesting is too deep/);
      expect(result.error).toMatch(/line \d+/); // located, like every other YamlError
    }
  });

  it('returns that error instead of exhausting the call stack', () => {
    // Before the bound this exact shape reached `RangeError: Maximum call
    // stack size exceeded` at 20,000 levels — a throw parseJobsFile rethrows
    // and discover() does not catch. The bound is hit long before the stack
    // is, so a fixture only has to be deeper than the bound to prove it.
    expect(() => parseJobsFile(nestedMappings(5_000), 'yaml')).not.toThrow();
  });

  it('accepts a file exactly at the bound and refuses the very next level', () => {
    const atBound = parseJobsFile(nestedMappings(MAX_YAML_DEPTH - 1), 'yaml');
    expect('error' in atBound && /too deep/.test(atBound.error), 'the bound itself must parse').toBe(false);

    const pastBound = parseJobsFile(nestedMappings(MAX_YAML_DEPTH), 'yaml');
    expect('error' in pastBound && /too deep/.test(pastBound.error), 'one level past the bound must refuse').toBe(true);
  });

  it('leaves a real jobs file, which nests four levels, far inside the bound', () => {
    const result = parseJobsFile(VALID_YAML, 'yaml');
    expect('error' in result, `a valid file was refused: ${JSON.stringify(result)}`).toBe(false);
  });

  it('names the fault without echoing a byte of the file', () => {
    const deep = nestedMappings(200).replace('leaf: v', 'leaf: SECRET_DEPTH_XYZ');
    const result = parseJobsFile(deep, 'yaml');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).not.toContain('SECRET_DEPTH_XYZ');
  });
});

describe('discover() — the jobs file is read under a size cap', () => {
  let repoDir: string;
  beforeEach(() => {
    repoDir = makeRepo();
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('reads a normal file (the control: the fixture really is valid and under the cap)', () => {
    const { db, dir: dbDir } = freshDb();
    try {
      writeJobsFile(repoDir, 'jobs.yaml', VALID_YAML);
      const result = new RepoJobs(db).discover(repoDir);
      expect(result.error).toBeUndefined();
      expect(result.offers).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('refuses a file over the cap with a named error, and never parses it', () => {
    const { db, dir: dbDir } = freshDb();
    try {
      // A VALID file padded past the cap with comments: without the cap this
      // parses and yields an offer, so the refusal below is the cap doing the
      // work and not the content being malformed.
      const padding = `\n# ${'p'.repeat(200)}`;
      const repeats = Math.ceil(MAX_JOBS_FILE_BYTES / padding.length) + 1;
      writeJobsFile(repoDir, 'jobs.yaml', VALID_YAML + padding.repeat(repeats));

      const result = new RepoJobs(db).discover(repoDir);
      expect(result.offers).toEqual([]);
      expect(result.error).toMatch(/too large/);
      expect(result.error).toContain(String(MAX_JOBS_FILE_BYTES));
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

describe('findJobsFile — hard-link containment', () => {
  let repoDir: string;
  let outsideDir: string;

  beforeEach(() => {
    repoDir = makeRepo();
    outsideDir = mkdtempSync(path.join(os.tmpdir(), 'cw-repojobs-outside-hard-'));
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('refuses a jobs file that is a HARD link to a file outside the repo', () => {
    // The symlink checks do not see this one: `lstat().isFile()` is true for a
    // hard link and `realpathSync` returns the in-repo path itself, so both
    // pre-existing checks passed and the read went through. The link COUNT is
    // what tells them apart, and it is the same number on every POSIX
    // filesystem that reports one.
    const secret = path.join(outsideDir, 'secret.txt');
    writeFileSync(secret, 'SECRET_TOKEN_XYZ\n', 'utf8');
    mkdirSync(path.join(repoDir, '.clockwork'), { recursive: true });
    linkSync(secret, path.join(repoDir, '.clockwork', 'jobs.yaml'));

    expect(findJobsFile(repoDir)).toBeNull();
  });

  it('discover() leaks nothing through a hard link: no offers, no error text', () => {
    const { db, dir: dbDir } = freshDb();
    try {
      const secret = path.join(outsideDir, 'secret.txt');
      writeFileSync(secret, 'SECRET_TOKEN_XYZ\n', 'utf8');
      mkdirSync(path.join(repoDir, '.clockwork'), { recursive: true });
      linkSync(secret, path.join(repoDir, '.clockwork', 'jobs.yaml'));

      const result = new RepoJobs(db).discover(repoDir);
      expect(result).toEqual({ offers: [] });
      expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN_XYZ');
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('still finds an ordinary single-linked file (the check is not a blanket refusal)', () => {
    writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
    expect(findJobsFile(repoDir)).toEqual({ path: path.join(repoDir, '.clockwork', 'jobs.json'), format: 'json' });
  });
});

describe('discover() — a read failure is structural too', () => {
  let repoDir: string;
  beforeEach(() => {
    repoDir = makeRepo();
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('names the errno and the candidate, never the caller-supplied path', () => {
    // The remaining error site that still returned a raw errno string. Node's
    // message is "EACCES: permission denied, open '<absolute path>'"; the
    // candidate filename is ours (findJobsFile only ever looks at three), the
    // errno code is Node's own vocabulary, and neither is a byte of the file.
    // ASSUMES A NON-ROOT UID, as CI has (`.github/workflows/ci.yml` runs on a
    // macos-14 runner as `runner`): root ignores mode 000.
    const { db, dir: dbDir } = freshDb();
    const file = path.join(repoDir, '.clockwork', 'jobs.json');
    try {
      writeJobsFile(repoDir, 'jobs.json', VALID_JSON);
      chmodSync(file, 0o000);

      const result = new RepoJobs(db).discover(repoDir);
      expect(result.offers).toEqual([]);
      expect(result.error).toMatch(/could not read/);
      expect(result.error).toMatch(/EACCES/);
      expect(result.error, 'the absolute path is still echoed back').not.toContain(repoDir);
      expect(result.error).toContain('jobs.json');
    } finally {
      chmodSync(file, 0o644);
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
