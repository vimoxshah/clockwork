/**
 * F7 earned-autonomy (plan/AGENT-WORKFORCE-SPEC.md, §F7).
 *
 * Defends the refusals, not the happy path: a rung is OFFERED and never
 * auto-granted (maybeOffer leaves the profile row byte-identical), enrolment is
 * opt-in so a NULL rung is never written a default and never constrained, a
 * declined offer is not re-offered at the same streak, an accepted promotion
 * cannot chain a second one off the same streak, a corrupt stored rung fails
 * CLOSED instead of reading as "unenrolled", 'default' permission mode is not
 * ranked above the acceptEdits rung, a rejection breaks the streak, a second
 * respond is 'already_resolved' and does not write the profile twice, and the
 * streak requirement falls profile-override -> workforce_prefs -> 5.
 *
 * The streak is driven through the REAL `Acceptance` + `HandoffMemory` writing
 * real `run_outcomes` rows — stubbing `acceptedStreak` would test nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { AutonomyPolicy } from '../src/autonomy-policy.js';
import { Acceptance } from '../src/acceptance.js';
import { HandoffMemory } from '../src/handoff.js';
import { PolicyEngine } from '../src/policy-engine.js';
import type { AutonomyRung } from '@clockwork/shared';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

function freshDb(): DB {
  const db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
  createMigrator(db, MIGRATIONS).migrate();
  return db;
}

function insertProfile(db: DB, id: string, slug: string, permissionMode = 'acceptEdits'): void {
  db.prepare(
    `INSERT INTO profiles (id, slug, name, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, slug, `Profile ${slug}`, permissionMode, 1_000, 1_000);
}

function insertTask(db: DB, id: string, profileId: string | null): void {
  db.prepare(`INSERT INTO tasks (id, name, prompt, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    `task-${id}`,
    'do the thing',
    profileId,
    1_000,
    1_000,
  );
}

let runSeq = 0;

/** One decided run for `profileId`, through the real acceptance path. */
function decide(
  db: DB,
  acceptance: Acceptance,
  taskId: string,
  profileId: string,
  decision: 'accepted' | 'accepted_with_note' | 'rejected',
  at: number,
): void {
  const runId = `run-${++runSeq}`;
  db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at) VALUES (?, ?, ?, 'completed', ?)`).run(
    runId,
    taskId,
    JSON.stringify({ taskId, profile: { id: profileId, slug: 'p', name: 'P' } }),
    at,
  );
  const res = acceptance.record(
    runId,
    decision === 'accepted_with_note' ? { decision, note: 'nice work' } : { decision },
    'local',
    at,
  );
  if (res === 'not_found') throw new Error('fixture run went missing');
}

/** `n` accepted outcomes in a row, newest last. */
function acceptRuns(db: DB, acceptance: Acceptance, taskId: string, profileId: string, n: number, base = 10_000): void {
  for (let i = 0; i < n; i++) decide(db, acceptance, taskId, profileId, 'accepted', base + i);
}

function profileRow(db: DB, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM profiles WHERE id=?').get(id) as Record<string, unknown>;
}

function setRung(db: DB, id: string, rung: string | null): void {
  db.prepare('UPDATE profiles SET autonomy_rung=? WHERE id=?').run(rung, id);
}

describe('AutonomyPolicy', () => {
  let db: DB;
  let acceptance: Acceptance;
  let autonomy: AutonomyPolicy;

  beforeEach(() => {
    runSeq = 0;
    db = freshDb();
    acceptance = new Acceptance(db, new HandoffMemory(db));
    autonomy = new AutonomyPolicy(db, new PolicyEngine(db), acceptance);
    insertProfile(db, 'p1', 'scout');
    insertTask(db, 't1', 'p1');
  });

  // -------------------------------------------------------------------------
  describe('state', () => {
    it('returns undefined for a profile that does not exist', () => {
      expect(autonomy.state('nope')).toBeUndefined();
    });

    it('reports a NULL rung as not-enrolled and never eligible, however long the streak', () => {
      acceptRuns(db, acceptance, 't1', 'p1', 20);
      const s = autonomy.state('p1');
      expect(s?.rung).toBeNull();
      expect(s?.streak).toBe(20);
      expect(s?.eligible).toBe(false);
      // reading state must not enrol anybody
      expect(profileRow(db, 'p1').autonomy_rung).toBeNull();
    });

    it('counts accepted_with_note toward the streak but stops at a rejection', () => {
      setRung(db, 'p1', 'plan');
      decide(db, acceptance, 't1', 'p1', 'rejected', 10_000);
      decide(db, acceptance, 't1', 'p1', 'accepted', 10_001);
      decide(db, acceptance, 't1', 'p1', 'accepted_with_note', 10_002);
      expect(autonomy.state('p1')?.streak).toBe(2);
    });

    it('prefers the profile streak override over workforce_prefs', () => {
      db.prepare('UPDATE workforce_prefs SET autonomy_streak_required=9 WHERE id=1').run();
      db.prepare('UPDATE profiles SET autonomy_streak_required=2 WHERE id=?').run('p1');
      expect(autonomy.state('p1')?.streakRequired).toBe(2);
    });

    it('falls back to workforce_prefs when the profile carries no override', () => {
      db.prepare('UPDATE workforce_prefs SET autonomy_streak_required=9 WHERE id=1').run();
      expect(profileRow(db, 'p1').autonomy_streak_required).toBeNull();
      expect(autonomy.state('p1')?.streakRequired).toBe(9);
    });

    it('ignores a zero override instead of making every profile instantly eligible', () => {
      db.prepare('UPDATE profiles SET autonomy_streak_required=0 WHERE id=?').run('p1');
      expect(autonomy.state('p1')?.streakRequired).toBe(5);
    });

    it('falls back to 5 when the workforce_prefs singleton is missing', () => {
      db.prepare('DELETE FROM workforce_prefs WHERE id=1').run();
      expect(autonomy.state('p1')?.streakRequired).toBe(5);
    });

    it('is never eligible at the top rung — there is nothing above unattended', () => {
      setRung(db, 'p1', 'unattended');
      acceptRuns(db, acceptance, 't1', 'p1', 50);
      const s = autonomy.state('p1');
      expect(s?.rung).toBe('unattended');
      expect(s?.eligible).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('enroll', () => {
    it("returns 'not_found' for an unknown profile and writes nothing", () => {
      expect(autonomy.enroll('nope', 'plan', 2_000)).toBe('not_found');
      expect(profileRow(db, 'p1').autonomy_rung).toBeNull();
    });

    it("applies the rung's concrete profile settings, not just the label", () => {
      const s = autonomy.enroll('p1', 'plan', 2_000);
      expect(s).not.toBe('not_found');
      const row = profileRow(db, 'p1');
      expect(row.autonomy_rung).toBe('plan');
      expect(row.permission_mode).toBe('plan');
      expect(row.may_require_approval).toBe(1);
      expect(row.updated_at).toBe(2_000);
    });

    it('enrolling at unattended clears the approval flag (acceptEdits + no approval)', () => {
      autonomy.enroll('p1', 'unattended', 2_000);
      const row = profileRow(db, 'p1');
      expect(row.autonomy_rung).toBe('unattended');
      expect(row.permission_mode).toBe('acceptEdits');
      expect(row.may_require_approval).toBe(0);
    });

    it('does not read the streak — enrolling is a human act, not a promotion', () => {
      acceptRuns(db, acceptance, 't1', 'p1', 50);
      const s = autonomy.enroll('p1', 'plan', 2_000);
      if (s === 'not_found') throw new Error('unreachable');
      expect(s.rung).toBe('plan'); // stayed where the human put it
    });
  });

  // -------------------------------------------------------------------------
  describe('evaluate — the fail-closed gate', () => {
    it('ignores a task with no profile', () => {
      expect(autonomy.evaluate({ profileId: null, permissionMode: 'acceptEdits' })).toBeNull();
    });

    it('ignores a profile id that names no profile — that is not this gate to judge', () => {
      expect(autonomy.evaluate({ profileId: 'ghost', permissionMode: 'acceptEdits' })).toBeNull();
    });

    it('never constrains an unenrolled profile — enrolment is opt-in', () => {
      acceptRuns(db, acceptance, 't1', 'p1', 20);
      expect(autonomy.evaluate({ profileId: 'p1', permissionMode: 'acceptEdits' })).toBeNull();
      expect(autonomy.evaluate({ profileId: 'p1', permissionMode: 'default' })).toBeNull();
    });

    it('refuses a permission mode above the plan rung, naming the profile and the way out', () => {
      autonomy.enroll('p1', 'plan', 2_000);
      const v = autonomy.evaluate({ profileId: 'p1', permissionMode: 'acceptEdits' });
      expect(v?.code).toBe('autonomy_rung_exceeded');
      expect(v?.message).toContain('scout');
      expect(v?.message).toContain('plan');
      expect(v?.message).toContain('acceptEdits');
    });

    it('allows plan mode on the plan rung', () => {
      autonomy.enroll('p1', 'plan', 2_000);
      expect(autonomy.evaluate({ profileId: 'p1', permissionMode: 'plan' })).toBeNull();
    });

    it("refuses 'default' on the plan rung but allows it on acceptEdits — default is not more autonomous", () => {
      autonomy.enroll('p1', 'plan', 2_000);
      expect(autonomy.evaluate({ profileId: 'p1', permissionMode: 'default' })?.code).toBe('autonomy_rung_exceeded');
      autonomy.enroll('p1', 'acceptEdits', 2_100);
      expect(autonomy.evaluate({ profileId: 'p1', permissionMode: 'default' })).toBeNull();
    });

    it('allows every mode at the acceptEdits and unattended rungs', () => {
      for (const rung of ['acceptEdits', 'unattended'] as AutonomyRung[]) {
        autonomy.enroll('p1', rung, 2_000);
        for (const mode of ['plan', 'acceptEdits', 'default'] as const) {
          expect(autonomy.evaluate({ profileId: 'p1', permissionMode: mode })).toBeNull();
        }
      }
    });

    it('fails CLOSED on a corrupt stored rung — an unrecognized value is not a licence', () => {
      setRung(db, 'p1', 'superuser');
      expect(autonomy.evaluate({ profileId: 'p1', permissionMode: 'acceptEdits' })?.code).toBe(
        'autonomy_rung_exceeded',
      );
      expect(autonomy.evaluate({ profileId: 'p1', permissionMode: 'plan' })).toBeNull();
      expect(autonomy.state('p1')?.rung).toBe('plan');
    });
  });

  // -------------------------------------------------------------------------
  describe('maybeOffer — offered, never granted', () => {
    beforeEach(() => {
      db.prepare('UPDATE workforce_prefs SET autonomy_streak_required=3 WHERE id=1').run();
    });

    it('offers nothing below the required streak', () => {
      autonomy.enroll('p1', 'plan', 2_000);
      acceptRuns(db, acceptance, 't1', 'p1', 2);
      expect(autonomy.maybeOffer('p1', 20_000)).toBeNull();
      expect(db.prepare('SELECT COUNT(*) c FROM autonomy_offers').get()).toEqual({ c: 0 });
    });

    it('offers the next rung once earned and leaves the profile row byte-identical', () => {
      autonomy.enroll('p1', 'plan', 2_000);
      acceptRuns(db, acceptance, 't1', 'p1', 3);
      const before = profileRow(db, 'p1');

      const offer = autonomy.maybeOffer('p1', 20_000);
      expect(offer?.fromRung).toBe('plan');
      expect(offer?.toRung).toBe('acceptEdits');
      expect(offer?.streak).toBe(3);
      expect(offer?.status).toBe('offered');
      expect(offer?.decidedAt).toBeNull();

      // THE invariant: an offer grants nothing.
      expect(profileRow(db, 'p1')).toEqual(before);
    });

    it('offers nothing while an offer is still open', () => {
      autonomy.enroll('p1', 'plan', 2_000);
      acceptRuns(db, acceptance, 't1', 'p1', 5);
      expect(autonomy.maybeOffer('p1', 20_000)).not.toBeNull();
      expect(autonomy.maybeOffer('p1', 20_001)).toBeNull();
      expect(db.prepare('SELECT COUNT(*) c FROM autonomy_offers').get()).toEqual({ c: 1 });
    });

    it('does not re-offer a declined rung at the same streak, and offers again once the streak grows', () => {
      autonomy.enroll('p1', 'plan', 2_000);
      acceptRuns(db, acceptance, 't1', 'p1', 3);
      const first = autonomy.maybeOffer('p1', 20_000);
      if (!first) throw new Error('expected an offer');
      autonomy.respond(first.id, 'declined', 21_000);

      expect(autonomy.maybeOffer('p1', 22_000)).toBeNull(); // same streak: the human already said no

      decide(db, acceptance, 't1', 'p1', 'accepted', 23_000); // streak 4 > 3
      const second = autonomy.maybeOffer('p1', 24_000);
      expect(second?.streak).toBe(4);
      expect(second?.toRung).toBe('acceptEdits');
    });

    it('does not chain a second promotion off the same earned streak', () => {
      autonomy.enroll('p1', 'plan', 2_000);
      acceptRuns(db, acceptance, 't1', 'p1', 3);
      const first = autonomy.maybeOffer('p1', 20_000);
      if (!first) throw new Error('expected an offer');
      autonomy.respond(first.id, 'accepted', 21_000);
      expect(profileRow(db, 'p1').autonomy_rung).toBe('acceptEdits');

      // Streak is still 3 — the acceptEdits -> unattended jump must be earned again.
      expect(autonomy.maybeOffer('p1', 22_000)).toBeNull();

      decide(db, acceptance, 't1', 'p1', 'accepted', 23_000);
      const second = autonomy.maybeOffer('p1', 24_000);
      expect(second?.fromRung).toBe('acceptEdits');
      expect(second?.toRung).toBe('unattended');
    });

    it('offers nothing to an unenrolled profile, however long the streak', () => {
      acceptRuns(db, acceptance, 't1', 'p1', 30);
      expect(autonomy.maybeOffer('p1', 20_000)).toBeNull();
      expect(profileRow(db, 'p1').autonomy_rung).toBeNull(); // and still does not enrol it
    });

    it('offers nothing at the top rung', () => {
      autonomy.enroll('p1', 'unattended', 2_000);
      acceptRuns(db, acceptance, 't1', 'p1', 30);
      expect(autonomy.maybeOffer('p1', 20_000)).toBeNull();
    });

    it('offers nothing for a profile that does not exist', () => {
      expect(autonomy.maybeOffer('ghost', 20_000)).toBeNull();
    });

    it('withdraws eligibility when a rejection breaks the streak', () => {
      autonomy.enroll('p1', 'plan', 2_000);
      acceptRuns(db, acceptance, 't1', 'p1', 5);
      decide(db, acceptance, 't1', 'p1', 'rejected', 19_000);
      expect(autonomy.state('p1')?.streak).toBe(0);
      expect(autonomy.maybeOffer('p1', 20_000)).toBeNull();
    });

    it('counts only that profile’s own outcomes', () => {
      insertProfile(db, 'p2', 'other');
      insertTask(db, 't2', 'p2');
      autonomy.enroll('p1', 'plan', 2_000);
      acceptRuns(db, acceptance, 't2', 'p2', 10);
      expect(autonomy.state('p1')?.streak).toBe(0);
      expect(autonomy.maybeOffer('p1', 20_000)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('respond — the only promotion path', () => {
    function earnedOffer(): string {
      db.prepare('UPDATE workforce_prefs SET autonomy_streak_required=3 WHERE id=1').run();
      autonomy.enroll('p1', 'plan', 2_000);
      acceptRuns(db, acceptance, 't1', 'p1', 3);
      const o = autonomy.maybeOffer('p1', 20_000);
      if (!o) throw new Error('expected an offer');
      return o.id;
    }

    it("returns 'not_found' for an unknown offer id", () => {
      expect(autonomy.respond('nope', 'accepted', 21_000)).toBe('not_found');
    });

    it("promotes the profile and applies the new rung's settings", () => {
      const id = earnedOffer();
      const res = autonomy.respond(id, 'accepted', 21_000);
      if (typeof res === 'string') throw new Error(res);
      expect(res.status).toBe('accepted');
      expect(res.decidedAt).toBe(21_000);
      const row = profileRow(db, 'p1');
      expect(row.autonomy_rung).toBe('acceptEdits');
      expect(row.permission_mode).toBe('acceptEdits');
      expect(row.may_require_approval).toBe(1);
      expect(row.updated_at).toBe(21_000);
      // the gate opens with the rung
      expect(autonomy.evaluate({ profileId: 'p1', permissionMode: 'acceptEdits' })).toBeNull();
    });

    it('accepting a promotion to unattended clears the approval flag', () => {
      autonomy.enroll('p1', 'acceptEdits', 2_000);
      db.prepare('UPDATE workforce_prefs SET autonomy_streak_required=2 WHERE id=1').run();
      acceptRuns(db, acceptance, 't1', 'p1', 2);
      const o = autonomy.maybeOffer('p1', 20_000);
      if (!o) throw new Error('expected an offer');
      expect(o.toRung).toBe('unattended');
      autonomy.respond(o.id, 'accepted', 21_000);
      const row = profileRow(db, 'p1');
      expect(row.autonomy_rung).toBe('unattended');
      expect(row.may_require_approval).toBe(0);
    });

    it('declining leaves the profile exactly where it was', () => {
      const id = earnedOffer();
      const before = profileRow(db, 'p1');
      const res = autonomy.respond(id, 'declined', 21_000);
      if (typeof res === 'string') throw new Error(res);
      expect(res.status).toBe('declined');
      expect(profileRow(db, 'p1')).toEqual(before);
    });

    it("a second answer is 'already_resolved' and does not write the profile again", () => {
      const id = earnedOffer();
      expect(autonomy.respond(id, 'declined', 21_000)).not.toBe('already_resolved');
      const afterFirst = profileRow(db, 'p1');

      // The losing writer must not promote — CAS in SQL, not read-then-write.
      expect(autonomy.respond(id, 'accepted', 22_000)).toBe('already_resolved');
      expect(profileRow(db, 'p1')).toEqual(afterFirst);
      const row = db.prepare('SELECT status, decided_at FROM autonomy_offers WHERE id=?').get(id);
      expect(row).toEqual({ status: 'declined', decided_at: 21_000 });
    });

    it('re-answering an accepted offer does not re-apply the promotion', () => {
      const id = earnedOffer();
      autonomy.respond(id, 'accepted', 21_000);
      db.prepare('UPDATE profiles SET permission_mode=? WHERE id=?').run('plan', 'p1'); // human narrowed it by hand
      expect(autonomy.respond(id, 'accepted', 22_000)).toBe('already_resolved');
      expect(profileRow(db, 'p1').permission_mode).toBe('plan');
    });
  });

  // -------------------------------------------------------------------------
  describe('listOffers', () => {
    it('filters by status and returns newest first', () => {
      db.prepare('UPDATE workforce_prefs SET autonomy_streak_required=1 WHERE id=1').run();
      autonomy.enroll('p1', 'plan', 2_000);
      acceptRuns(db, acceptance, 't1', 'p1', 1);
      const first = autonomy.maybeOffer('p1', 20_000);
      if (!first) throw new Error('expected an offer');
      autonomy.respond(first.id, 'declined', 20_500);
      acceptRuns(db, acceptance, 't1', 'p1', 1, 21_000);
      const second = autonomy.maybeOffer('p1', 22_000);
      if (!second) throw new Error('expected a second offer');

      expect(autonomy.listOffers().map((o) => o.id)).toEqual([second.id, first.id]);
      expect(autonomy.listOffers('offered').map((o) => o.id)).toEqual([second.id]);
      expect(autonomy.listOffers('declined').map((o) => o.id)).toEqual([first.id]);
      expect(autonomy.listOffers('accepted')).toEqual([]);
    });
  });
});
