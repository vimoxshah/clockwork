/**
 * F12 proof-of-work-export (plan/AGENT-WORKFORCE-SPEC.md, §F12).
 *
 * Defends: self-contained (no remote resources, one <style>, zero <script>),
 * masked (maskSecrets over every interpolated string, no flag to disable it),
 * escaped (agent-authored text cannot inject markup), redactPaths strips
 * repoPath/worktreePath/branch, includeTranscript defaults off, and a run
 * whose report has not landed yet (or is malformed) still renders instead of
 * throwing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { proofOfWorkHtml, proofFilenameFor } from '../src/proof-of-work.js';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

let db: DB;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-proof-'));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
  createMigrator(db, MIGRATIONS).migrate();
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('task-1', 'Nightly review', 'p', ?, ?)`).run(
    Date.now(),
    Date.now(),
  );
});

interface SeedRunOptions {
  id?: string;
  jobspec?: Record<string, unknown>;
  report?: Record<string, unknown> | null;
  reportRaw?: string | null;
  transcriptPath?: string | null;
  journalPath?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  costUsd?: number;
  turns?: number;
}

function seedRun(opts: SeedRunOptions = {}): string {
  const id = opts.id ?? 'run-1';
  const now = Date.now();
  const jobspecJson = JSON.stringify({ taskName: 'Nightly review', engine: 'cli', ...opts.jobspec });
  const reportJson =
    opts.reportRaw !== undefined ? opts.reportRaw : opts.report === undefined ? null : opts.report === null ? null : JSON.stringify(opts.report);
  db.prepare(
    `INSERT INTO runs
       (id, task_id, jobspec_json, state, state_changed_at, worktree_path, branch,
        transcript_path, journal_path, cost_usd, turns, started_at, ended_at,
        scheduled_for, outcome_reason, report_json)
     VALUES (?, 'task-1', ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    jobspecJson,
    now,
    opts.worktreePath ?? null,
    opts.branch ?? null,
    opts.transcriptPath ?? null,
    opts.journalPath ?? null,
    opts.costUsd ?? 1.2345,
    opts.turns ?? 4,
    now - 60_000,
    now,
    now - 120_000,
    null,
    reportJson,
  );
  return id;
}

describe('proofOfWorkHtml — refusal and missing-data paths', () => {
  it('returns not_found for an unknown run id', () => {
    expect(proofOfWorkHtml(db, 'nope')).toBe('not_found');
  });

  it('renders a page for a run whose report has not landed yet (report_json NULL)', () => {
    const id = seedRun({ report: null });
    const html = proofOfWorkHtml(db, id);
    expect(html).not.toBe('not_found');
    expect(typeof html).toBe('string');
    expect(html as string).toContain('Nightly review');
    expect(html as string).toContain('no summary');
  });

  it('renders a page instead of throwing when report_json is malformed', () => {
    const id = seedRun({ reportRaw: 'not json{{{' });
    expect(() => proofOfWorkHtml(db, id)).not.toThrow();
    const html = proofOfWorkHtml(db, id);
    expect(html).not.toBe('not_found');
  });

  it('renders a page instead of throwing when timeline/diffStat are the wrong shape', () => {
    const id = seedRun({ report: { summary: 'ok', timeline: 'garbage', diffStat: { path: 'x' } } });
    expect(() => proofOfWorkHtml(db, id)).not.toThrow();
    const html = proofOfWorkHtml(db, id);
    expect(html).not.toBe('not_found');
  });

  it('renders a page instead of throwing when a timeline entry has a non-numeric timestamp', () => {
    const id = seedRun({ report: { summary: 'ok', timeline: [{ at: 'bad', kind: 'note', text: 'x' }] } });
    expect(() => proofOfWorkHtml(db, id)).not.toThrow();
    const html = proofOfWorkHtml(db, id) as string;
    expect(html).not.toBe('not_found');
    expect(html).toContain('x');
  });
});

describe('proofOfWorkHtml — self-contained output', () => {
  it('carries no script, no stylesheet link, no remote image, and exactly one inline style block', () => {
    const id = seedRun({ report: { summary: 'did the thing' } });
    const html = proofOfWorkHtml(db, id) as string;
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
    expect(html).not.toMatch(/<img[^>]+src=["']?http/i);
    expect(html.match(/<style/g)?.length).toBe(1);
  });
});

describe('proofOfWorkHtml — masking (S-68, no flag to disable it)', () => {
  const secret = 'AKIAABCDEFGHIJKLMNOP';

  it('masks a planted secret in the summary, the failure reason and a timeline entry', () => {
    const id = seedRun({
      report: {
        summary: `ran fine, key was ${secret}`,
        failureReason: `blew up on ${secret}`,
        timeline: [{ at: Date.now(), kind: 'note', text: `saw ${secret} in logs` }],
      },
    });
    const html = proofOfWorkHtml(db, id) as string;
    expect(html).not.toContain(secret);
    expect(html.match(/\[AWS-KEY-MASKED\]/g)?.length).toBe(3);
  });

  it('masks a planted secret in the transcript tail when includeTranscript is on', () => {
    const transcriptPath = path.join(dir, 'transcript-mask.jsonl');
    writeFileSync(transcriptPath, `${JSON.stringify({ type: 'result', result: `token secret ${secret} used` })}\n`);
    const id = seedRun({ transcriptPath, report: { summary: 'ok' } });
    const html = proofOfWorkHtml(db, id, { includeTranscript: true }) as string;
    expect(html).not.toContain(secret);
    expect(html).toContain('[AWS-KEY-MASKED]');
  });
});

describe('proofOfWorkHtml — escaping (report content is agent-authored text)', () => {
  it('escapes a script tag and quote/ampersand characters in the summary', () => {
    const id = seedRun({ report: { summary: `<script>alert(1)</script> "quoted" & <b>bold</b>` } });
    const html = proofOfWorkHtml(db, id) as string;
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).toContain('&amp;');
  });
});

describe('proofOfWorkHtml — includeTranscript (off by default)', () => {
  it('omits the transcript tail by default even when a transcript file exists', () => {
    const transcriptPath = path.join(dir, 'transcript-default.jsonl');
    const marker = 'UNIQUE-MARKER-DEFAULT-OFF';
    writeFileSync(transcriptPath, `${JSON.stringify({ type: 'result', result: marker })}\n`);
    const id = seedRun({ transcriptPath, report: { summary: 'ok' } });
    const html = proofOfWorkHtml(db, id) as string;
    expect(html).not.toContain(marker);
    expect(html).toContain('Not included');
  });

  it('includes the transcript tail when includeTranscript is explicitly requested', () => {
    const transcriptPath = path.join(dir, 'transcript-on.jsonl');
    const marker = 'UNIQUE-MARKER-INCLUDED';
    writeFileSync(transcriptPath, `${JSON.stringify({ type: 'result', result: marker })}\n`);
    const id = seedRun({ transcriptPath, report: { summary: 'ok' } });
    const html = proofOfWorkHtml(db, id, { includeTranscript: true }) as string;
    expect(html).toContain(marker);
  });

  it('does not throw and renders an unavailable marker when includeTranscript is on but the run has no transcript path', () => {
    const id = seedRun({ transcriptPath: null, journalPath: null, report: { summary: 'ok' } });
    expect(() => proofOfWorkHtml(db, id, { includeTranscript: true })).not.toThrow();
    const html = proofOfWorkHtml(db, id, { includeTranscript: true }) as string;
    expect(html).toContain('transcript not available');
  });
});

describe('proofOfWorkHtml — redactPaths', () => {
  it('shows repoPath, worktreePath and branch by default', () => {
    const id = seedRun({
      jobspec: { repoPath: '/Users/alice/secret-repo' },
      worktreePath: '/Users/alice/.clockwork/worktrees/x/run-1',
      branch: 'clockwork/run-1',
      report: { summary: 'ok' },
    });
    const html = proofOfWorkHtml(db, id) as string;
    expect(html).toContain('/Users/alice/secret-repo');
    expect(html).toContain('/Users/alice/.clockwork/worktrees/x/run-1');
    expect(html).toContain('clockwork/run-1');
  });

  it('replaces repoPath, worktreePath and branch with [redacted] when redactPaths is set', () => {
    const id = seedRun({
      jobspec: { repoPath: '/Users/alice/secret-repo' },
      worktreePath: '/Users/alice/.clockwork/worktrees/x/run-1',
      branch: 'clockwork/run-1',
      report: { summary: 'ok' },
    });
    const html = proofOfWorkHtml(db, id, { redactPaths: true }) as string;
    expect(html).not.toContain('/Users/alice/secret-repo');
    expect(html).not.toContain('/Users/alice/.clockwork/worktrees/x/run-1');
    expect(html).not.toContain('clockwork/run-1');
    expect(html.match(/\[redacted\]/g)?.length).toBe(3);
  });
});

describe('proofOfWorkHtml — includeDiffStat', () => {
  it('omits diff file paths when includeDiffStat is false', () => {
    const id = seedRun({
      report: { summary: 'ok', diffStat: [{ path: 'src/secret-module.ts', additions: 3, deletions: 1, binary: false }] },
    });
    const html = proofOfWorkHtml(db, id, { includeDiffStat: false }) as string;
    expect(html).not.toContain('src/secret-module.ts');
  });

  it('includes diff file paths by default', () => {
    const id = seedRun({
      report: { summary: 'ok', diffStat: [{ path: 'src/mod.ts', additions: 3, deletions: 1, binary: false }] },
    });
    const html = proofOfWorkHtml(db, id) as string;
    expect(html).toContain('src/mod.ts');
  });
});

describe('proofFilenameFor', () => {
  it('names the file deterministically from the run id', () => {
    expect(proofFilenameFor('abc')).toBe('clockwork-proof-abc.html');
  });
});
