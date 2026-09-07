/**
 * F8 — self-healing (plan/AGENT-WORKFORCE-SPEC.md §4).
 *
 * The invariant under test everywhere below: the agent never edits its own
 * prompt. A diagnostic run may only ever produce a PROPOSAL, and the proposal
 * only becomes a write when a human applies it — once.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { clearFailureStreak, recordAuthFailureAndMaybePause } from '../src/policies.js';
import { SelfHealing, diagnosticPromptFor, DIAGNOSTIC_MARKER } from '../src/self-healing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = loadMigrationsFrom(resolve(HERE, '../migrations'));

const TASK = 'task-1';
const NOW = 1_700_000_000_000;

interface Booked {
  taskId: string;
  prompt: string;
  runId: string | null;
}

describe('F8 self-healing', () => {
  let db: DB;
  let booked: Booked[];
  /** what the injected booker returns next; null models a refused booking */
  let bookResult: () => string | null;
  let healer: SelfHealing;

  const addTask = (id: string, opts: { prompt?: string; profileId?: string | null; deleted?: boolean } = {}): void => {
    db.prepare(
      `INSERT INTO tasks (id, name, prompt, profile_id, permission_mode, context_json, delivery_json,
                          missed_policy, missed_window_sec, overlap_policy, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'acceptEdits', '[]', '{}', 'run-late', 21600, 'skip', ?, ?, ?)`,
    ).run(id, `task ${id}`, opts.prompt ?? 'do the thing', opts.profileId ?? null, opts.deleted ? NOW : null, NOW, NOW);
  };

  const addProfile = (id: string, slug: string): void => {
    db.prepare(
      `INSERT INTO profiles (id, slug, name, engine, skills_json, mcp_allow_json, context_roots_json, builtin, created_at, updated_at)
       VALUES (?, ?, ?, 'cli', '[]', '[]', '[]', 0, ?, ?)`,
    ).run(id, slug, slug, NOW, NOW);
  };

  /** Insert a finished run. `prompt` lands in the jobspec, where the marker lives. */
  const addRun = (
    id: string,
    opts: {
      taskId?: string;
      state?: string;
      outcomeReason?: string | null;
      prompt?: string;
      transcript?: string | null;
      endedAt?: number;
      reportJson?: string | null;
    } = {},
  ): string => {
    db.prepare(
      `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, transcript_path, scheduled_for, ended_at, outcome_reason, report_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.taskId ?? TASK,
      JSON.stringify({ runId: id, prompt: opts.prompt ?? 'do the thing' }),
      opts.state ?? 'failed',
      NOW,
      opts.transcript === undefined ? `/transcripts/${id}.jsonl` : opts.transcript,
      NOW,
      opts.endedAt ?? NOW,
      opts.outcomeReason ?? null,
      opts.reportJson ?? null,
    );
    return id;
  };

  /** Register the run the injected booker will claim to have created. */
  const bookerReturns = (runId: string | null): void => {
    bookResult = () => runId;
  };

  const streak = (): { kind: string; count: number; diagnostic_run_id: string | null; diagnostic_at: number | null } | undefined =>
    db.prepare('SELECT kind, count, diagnostic_run_id, diagnostic_at FROM task_failure_streaks WHERE task_id=?').get(TASK) as never;

  const setThreshold = (n: number): void => {
    db.prepare('UPDATE workforce_prefs SET self_heal_failure_threshold=? WHERE id=1').run(n);
  };

  /** A report whose summary ends with the fenced block the diagnostic asks for. */
  const reportWith = (block: unknown, extra = ''): string =>
    JSON.stringify({
      summary: `Ran out of context every time.${extra}\n\n\`\`\`clockwork-remediation\n${
        typeof block === 'string' ? block : JSON.stringify(block, null, 2)
      }\n\`\`\`\n`,
    });

  /** Drive the streak to `n` failures with distinct real run rows. */
  const failTimes = (n: number, startIndex = 0): void => {
    for (let i = 0; i < n; i++) {
      const id = `run-f${startIndex + i}`;
      addRun(id, { endedAt: NOW + i });
      healer.onRunFailed(TASK, id, NOW + i);
    }
  };

  beforeEach(() => {
    db = new Database(':memory:') as unknown as DB;
    db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
    createMigrator(db, MIGRATIONS).migrate();
    booked = [];
    bookResult = () => 'run-diagnostic';
    healer = new SelfHealing({
      db,
      bookRun: (taskId, prompt) => {
        const runId = bookResult();
        booked.push({ taskId, prompt, runId });
        return runId;
      },
    });
    addTask(TASK);
  });

  // -------------------------------------------------------------------------
  // booking the diagnostic
  // -------------------------------------------------------------------------

  it('books nothing while the streak is below the configured threshold', () => {
    failTimes(2); // default threshold is 3
    expect(booked).toHaveLength(0);
    expect(streak()?.count).toBe(2);
    expect(streak()?.diagnostic_at).toBeNull();
  });

  it('books exactly one diagnostic per streak, no matter how many more runs fail', () => {
    bookerReturns('run-diag');
    failTimes(3);
    expect(booked).toHaveLength(1);
    expect(streak()?.diagnostic_run_id).toBe('run-diag');
    expect(streak()?.diagnostic_at).toBe(NOW + 2);

    failTimes(3, 10); // three more failures on the same streak
    expect(booked).toHaveLength(1);
    expect(streak()?.count).toBe(6);
  });

  it('reads the threshold from workforce_prefs rather than a hardcoded 3', () => {
    setThreshold(2);
    bookerReturns('run-diag');
    failTimes(2);
    expect(booked).toHaveLength(1);
  });

  it('re-arms after clearFailureStreak, because a recovered task gets a clean slate', () => {
    bookerReturns('run-diag-1');
    failTimes(3);
    expect(booked).toHaveLength(1);

    clearFailureStreak(db, TASK); // what run-manager does on a completed run
    expect(streak()).toBeUndefined();

    bookerReturns('run-diag-2');
    failTimes(3, 20);
    expect(booked).toHaveLength(2);
    expect(streak()?.diagnostic_run_id).toBe('run-diag-2');
  });

  it('leaves diagnostic_at NULL when the booker refuses, so the next failure retries', () => {
    bookerReturns(null);
    failTimes(3);
    expect(booked).toHaveLength(1);
    expect(streak()?.diagnostic_at).toBeNull();
    expect(streak()?.diagnostic_run_id).toBeNull();

    bookerReturns('run-diag-late');
    failTimes(1, 30);
    expect(booked).toHaveLength(2);
    expect(streak()?.diagnostic_run_id).toBe('run-diag-late');
  });

  it('survives a booker that throws without losing the finalizing run', () => {
    bookResult = () => {
      throw new Error('policy gate refused');
    };
    failTimes(3);
    expect(streak()?.diagnostic_at).toBeNull();
  });

  it('hands the diagnostic the failed transcripts, oldest first', () => {
    bookerReturns('run-diag');
    failTimes(3);
    const prompt = booked[0]!.prompt;
    expect(prompt).toContain('/transcripts/run-f0.jsonl');
    expect(prompt.indexOf('/transcripts/run-f0.jsonl')).toBeLessThan(prompt.indexOf('/transcripts/run-f2.jsonl'));
  });

  // -------------------------------------------------------------------------
  // refusals on the counting side
  // -------------------------------------------------------------------------

  it('never counts a completed or cancelled run as a failure', () => {
    const done = addRun('run-ok', { state: 'completed' });
    const stopped = addRun('run-cancel', { state: 'cancelled' });
    expect(healer.onRunFailed(TASK, done, NOW)).toBeNull();
    expect(healer.onRunFailed(TASK, stopped, NOW)).toBeNull();
    expect(streak()).toBeUndefined();
  });

  it('leaves the auth failure class to policies.ts instead of double-counting it', () => {
    const authRun = addRun('run-auth', { outcomeReason: 'auth' });
    expect(healer.onRunFailed(TASK, authRun, NOW)).toBeNull();
    expect(streak()).toBeUndefined();
  });

  it('continues the shared streak row that policies.ts already opened as kind=auth', () => {
    recordAuthFailureAndMaybePause(db, TASK); // policies.ts writes count=1, kind='auth'
    expect(streak()?.kind).toBe('auth');
    failTimes(1);
    expect(streak()?.kind).toBe('failure');
    expect(streak()?.count).toBe(2); // same row, not a second table
  });

  // S-review (high): F8 increments the SAME `task_failure_streaks` row that
  // policies.ts uses for the S-40/S-41 guarantee, and policies.ts incremented
  // it blindly. That silently redefined "auto-pause after 2 consecutive AUTH
  // failures" as "pause after 1 auth failure preceded by any work failure".
  // Sharing the ROW is the spec's design (§F8); sharing the auth COUNT is the
  // regression.
  it('does not let a work failure count toward the S-40/S-41 two-auth-failure pause', () => {
    failTimes(1); // F8: count=1, kind='failure'
    expect(streak()?.count).toBe(1);

    const first = recordAuthFailureAndMaybePause(db, TASK);
    expect(first).toEqual({ paused: false, consecutive: 1 }); // ONE auth failure, not two
    expect(db.prepare('SELECT enabled FROM tasks WHERE id=?').get(TASK)).toEqual({ enabled: 1 });

    // and the original guarantee is intact: the SECOND consecutive auth failure pauses.
    const second = recordAuthFailureAndMaybePause(db, TASK);
    expect(second).toEqual({ paused: true, consecutive: 2 });
    expect(db.prepare('SELECT enabled FROM tasks WHERE id=?').get(TASK)).toEqual({ enabled: 0 });
  });

  it('pauses on two consecutive auth failures with no work failure involved (S-40/S-41, unchanged)', () => {
    expect(recordAuthFailureAndMaybePause(db, TASK)).toEqual({ paused: false, consecutive: 1 });
    expect(recordAuthFailureAndMaybePause(db, TASK)).toEqual({ paused: true, consecutive: 2 });
  });

  it('never books a diagnostic for a diagnostic that failed', () => {
    bookerReturns('run-diag');
    failTimes(3);
    // the diagnostic run itself now exists, and it failed
    addRun('run-diag', { prompt: diagnosticPromptFor('t', 'p', []) });
    const before = streak()!.count;
    expect(healer.onRunFailed(TASK, 'run-diag', NOW + 100)).toBeNull();
    expect(streak()!.count).toBe(before); // not even counted
    expect(booked).toHaveLength(1);
  });

  it('still recognises a diagnostic run after the streak row that named it is gone', () => {
    // A diagnostic that COMPLETES makes run-manager clear the streak, taking
    // diagnostic_run_id with it. The jobspec marker is what stops the recursion.
    addRun('run-diag', { prompt: diagnosticPromptFor('t', 'p', []) });
    clearFailureStreak(db, TASK);
    expect(streak()).toBeUndefined();
    expect(healer.onRunFailed(TASK, 'run-diag', NOW + 100)).toBeNull();
    expect(streak()).toBeUndefined();
  });

  it('refuses an unknown run and a deleted task', () => {
    expect(healer.onRunFailed(TASK, 'no-such-run', NOW)).toBeNull();
    addTask('gone', { deleted: true });
    const r = addRun('run-gone', { taskId: 'gone' });
    expect(healer.onRunFailed('gone', r, NOW)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM task_failure_streaks').get()).toEqual({ c: 0 });
  });

  // -------------------------------------------------------------------------
  // proposals
  // -------------------------------------------------------------------------

  const seedDiagnostic = (reportJson: string | null, id = 'run-diag'): string => {
    addRun(id, { prompt: diagnosticPromptFor('t', 'p', []), state: 'completed', reportJson });
    return id;
  };

  it('turns a diagnostic report into a proposal plus an inbox approval', () => {
    const report = reportWith({ target: 'prompt', proposedValue: 'be terser', rationale: 'context blew up' });
    const runId = seedDiagnostic(report);
    const p = healer.proposeFrom(runId, TASK, report, NOW)!;

    expect(p.target).toBe('prompt');
    expect(p.proposedValue).toBe('be terser');
    expect(p.rationale).toBe('context blew up');
    expect(p.currentValue).toBe('do the thing'); // snapshot at proposal time
    expect(p.status).toBe('proposed');
    expect(p.decidedAt).toBeNull();

    const approval = db.prepare('SELECT * FROM approvals WHERE id=?').get(p.approvalId!) as never as {
      run_id: string;
      kind: string;
      fallback: string;
      payload_json: string;
      responded_at: number | null;
    };
    expect(approval.run_id).toBe(runId);
    expect(approval.kind).toBe('question');
    expect(approval.fallback).toBe('deny-and-continue');
    expect(approval.responded_at).toBeNull();
    expect(JSON.parse(approval.payload_json).proposalId).toBe(p.id);
  });

  it('proposes nothing from a run that is not a diagnostic', () => {
    const report = reportWith({ target: 'prompt', proposedValue: 'be terser' });
    const runId = addRun('run-normal', { state: 'completed', reportJson: report });
    expect(healer.proposeFrom(runId, TASK, report, NOW)).toBeNull();
    expect(healer.list()).toHaveLength(0);
  });

  it('proposes nothing when the report is missing, blockless, or malformed', () => {
    const runId = seedDiagnostic(null);
    expect(healer.proposeFrom(runId, TASK, null, NOW)).toBeNull();
    expect(healer.proposeFrom(runId, TASK, 'not json at all', NOW)).toBeNull();
    expect(healer.proposeFrom(runId, TASK, JSON.stringify({ summary: 'I found nothing conclusive.' }), NOW)).toBeNull();
    expect(healer.proposeFrom(runId, TASK, reportWith('{ this is not json'), NOW)).toBeNull();
    expect(healer.proposeFrom(runId, TASK, reportWith({ target: 'firmware', proposedValue: 'x' }), NOW)).toBeNull();
    expect(healer.proposeFrom(runId, TASK, reportWith({ target: 'prompt', proposedValue: '' }), NOW)).toBeNull();
    expect(healer.list()).toHaveLength(0);
  });

  it('proposes nothing when an engine truncated the block mid-way', () => {
    // hermes/opencode cap summary at 400 chars; a half-read block must not
    // become a pending edit to somebody's prompt.
    const full = reportWith({ target: 'prompt', proposedValue: 'a'.repeat(600), rationale: 'too long' });
    const truncated = JSON.stringify({ summary: (JSON.parse(full) as { summary: string }).summary.slice(0, 400) });
    const runId = seedDiagnostic(truncated);
    expect(healer.proposeFrom(runId, TASK, truncated, NOW)).toBeNull();
  });

  it('refuses a profile proposal naming a profile that does not exist', () => {
    const report = reportWith({ target: 'profile', proposedValue: 'ghost-profile' });
    const runId = seedDiagnostic(report);
    expect(healer.proposeFrom(runId, TASK, report, NOW)).toBeNull();
  });

  it('stores the profile id, not the slug, so apply cannot fail on the foreign key', () => {
    addProfile('prof-1', 'careful-reviewer');
    const report = reportWith({ target: 'profile', proposedValue: 'careful-reviewer' });
    const runId = seedDiagnostic(report);
    const p = healer.proposeFrom(runId, TASK, report, NOW)!;
    expect(p.proposedValue).toBe('prof-1');
    expect(p.currentValue).toBeNull();
  });

  it('proposes once per diagnostic run even if finalize is reached twice', () => {
    const report = reportWith({ target: 'prompt', proposedValue: 'be terser' });
    const runId = seedDiagnostic(report);
    expect(healer.proposeFrom(runId, TASK, report, NOW)).not.toBeNull();
    expect(healer.proposeFrom(runId, TASK, report, NOW + 1)).toBeNull();
    expect(healer.list()).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) c FROM approvals').get()).toEqual({ c: 1 });
  });

  it('lists by status and honours the limit', () => {
    addProfile('prof-1', 'careful-reviewer');
    const a = healer.proposeFrom(
      seedDiagnostic(reportWith({ target: 'prompt', proposedValue: 'v1' }), 'run-d1'),
      TASK,
      reportWith({ target: 'prompt', proposedValue: 'v1' }),
      NOW,
    )!;
    healer.proposeFrom(
      seedDiagnostic(reportWith({ target: 'profile', proposedValue: 'careful-reviewer' }), 'run-d2'),
      TASK,
      reportWith({ target: 'profile', proposedValue: 'careful-reviewer' }),
      NOW + 1,
    );
    healer.reject(a.id, NOW + 2);
    expect(healer.list('proposed').map((p) => p.target)).toEqual(['profile']);
    expect(healer.list('rejected').map((p) => p.id)).toEqual([a.id]);
    expect(healer.list(undefined, 1)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // apply / reject — the only writes to the task
  // -------------------------------------------------------------------------

  const proposal = (target: 'prompt' | 'profile', value: string, runId = 'run-diag'): string => {
    const report = reportWith({ target, proposedValue: value, rationale: 'because' });
    const p = healer.proposeFrom(seedDiagnostic(report, runId), TASK, report, NOW)!;
    return p.id;
  };

  const task = (): { prompt: string; profile_id: string | null; version: number } =>
    db.prepare('SELECT prompt, profile_id, version FROM tasks WHERE id=?').get(TASK) as never;

  it('applies a prompt change once, bumps version, and closes the inbox item', () => {
    const id = proposal('prompt', 'be terser');
    const applied = healer.apply(id, NOW + 10);
    expect(typeof applied).not.toBe('string');
    expect((applied as { status: string }).status).toBe('applied');
    expect(task().prompt).toBe('be terser');
    expect(task().version).toBe(2); // an open editor now gets a 409

    const approvalId = healer.get(id)!.approvalId!;
    const responded = db.prepare('SELECT responded_at FROM approvals WHERE id=?').get(approvalId) as never as {
      responded_at: number | null;
    };
    expect(responded.responded_at).toBe(NOW + 10);
  });

  it('refuses a second apply and writes the task only once', () => {
    const id = proposal('prompt', 'be terser');
    healer.apply(id, NOW + 10);
    db.prepare('UPDATE tasks SET prompt=? WHERE id=?').run('a human edited it after', TASK);
    expect(healer.apply(id, NOW + 20)).toBe('already_resolved');
    expect(task().prompt).toBe('a human edited it after'); // not clobbered
    expect(task().version).toBe(2); // not bumped again
  });

  it('applies a profile change by id', () => {
    addProfile('prof-1', 'careful-reviewer');
    const id = proposal('profile', 'careful-reviewer');
    healer.apply(id, NOW + 10);
    expect(task().profile_id).toBe('prof-1');
    expect(task().prompt).toBe('do the thing'); // the prompt is untouched
  });

  it('rejects without touching the task, and refuses to be rejected twice', () => {
    const id = proposal('prompt', 'be terser');
    const rejected = healer.reject(id, NOW + 10);
    expect((rejected as { status: string }).status).toBe('rejected');
    expect(task().prompt).toBe('do the thing');
    expect(task().version).toBe(1);
    expect(healer.reject(id, NOW + 20)).toBe('already_resolved');
    expect(healer.apply(id, NOW + 30)).toBe('already_resolved');
    expect(task().prompt).toBe('do the thing');
  });

  it('still applies when the human answered in the inbox first', () => {
    // POST /approvals/:id/respond CAS-closes the approvals row and knows nothing
    // about proposals; the workforce route must still land the change (§2.4).
    const id = proposal('prompt', 'be terser');
    const approvalId = healer.get(id)!.approvalId!;
    db.prepare('UPDATE approvals SET responded_at=?, response_json=? WHERE id=?').run(
      NOW + 5,
      JSON.stringify({ decision: 'approved' }),
      approvalId,
    );
    const applied = healer.apply(id, NOW + 10);
    expect((applied as { status: string }).status).toBe('applied');
    expect(task().prompt).toBe('be terser');
    const responded = db.prepare('SELECT responded_at FROM approvals WHERE id=?').get(approvalId) as never as {
      responded_at: number;
    };
    expect(responded.responded_at).toBe(NOW + 5); // the first writer still wins
  });

  it('reports not_found for an unknown proposal id', () => {
    expect(healer.apply('nope', NOW)).toBe('not_found');
    expect(healer.reject('nope', NOW)).toBe('not_found');
    expect(healer.get('nope')).toBeUndefined();
  });

  it('leaves a proposal open when the profile it names was deleted after proposing', () => {
    addProfile('prof-1', 'careful-reviewer');
    const id = proposal('profile', 'careful-reviewer');
    db.prepare('DELETE FROM profiles WHERE id=?').run('prof-1');
    expect(healer.apply(id, NOW + 10)).toBe('not_found');
    expect(healer.get(id)!.status).toBe('proposed'); // still there for a human to reject
    expect(healer.get(id)!.decidedAt).toBeNull();
    expect(task().profile_id).toBeNull();
  });

  it('leaves a proposal open when the task it targets was deleted', () => {
    const id = proposal('prompt', 'be terser');
    db.prepare('UPDATE tasks SET deleted_at=? WHERE id=?').run(NOW + 1, TASK);
    expect(healer.apply(id, NOW + 10)).toBe('not_found');
    expect(healer.get(id)!.status).toBe('proposed');
  });

  // -------------------------------------------------------------------------
  // the diagnostic prompt
  // -------------------------------------------------------------------------

  it('tells the diagnostic to propose and to change nothing, and marks itself', () => {
    const p = diagnosticPromptFor('nightly triage', 'the old prompt', ['/t/a.jsonl', '/t/b.jsonl']);
    expect(p.startsWith(DIAGNOSTIC_MARKER)).toBe(true);
    expect(p).toContain('Do NOT edit, create, move or delete any file');
    expect(p).toContain('nightly triage');
    expect(p).toContain('the old prompt');
    expect(p).toContain('/t/a.jsonl');
    expect(p).toContain('```clockwork-remediation');
    expect(p).toContain('no proposal is better than a guess');
  });

  it('says so plainly when no transcripts were retained', () => {
    expect(diagnosticPromptFor('t', 'p', [])).toContain('no transcripts were retained');
  });
});
