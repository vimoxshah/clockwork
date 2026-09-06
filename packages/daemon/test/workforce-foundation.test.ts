/**
 * Agent Workforce foundation guards (plan/AGENT-WORKFORCE-SPEC.md).
 *
 * Twelve feature agents build against migration 0008 without reading each
 * other's code. These tests are the frozen contract they build against: if a
 * table, a column or a registry key moves, the break surfaces here rather than
 * in twelve half-finished features.
 *
 * What each test defends is named in its title. Nothing here asserts that a
 * feature WORKS — each feature's own suite does that. What the registry block
 * at the bottom defends is that the registry never claims MORE than the code
 * delivers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { FEATURES } from '../src/features.js';
import { RunReport, AUTONOMY_RUNG_SETTINGS, nextRung, autonomyRungs } from '@clockwork/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '../migrations');
const MIGRATION_ID = '0008_agent_workforce';

/** Every table migration 0008 owns. */
const NEW_TABLES = [
  'workforce_prefs',
  'plan_execute_pairs',
  'agent_memories',
  'office_hours',
  'sentinels',
  'sentinel_trips',
  'repo_jobs',
  'run_outcomes',
  'autonomy_offers',
  'remediation_proposals',
] as const;

/** Every column 0008 adds to a pre-existing table. */
const NEW_COLUMNS: Array<[table: string, column: string]> = [
  ['profiles', 'may_require_approval'],
  ['profiles', 'autonomy_rung'],
  ['profiles', 'autonomy_streak_required'],
  ['tasks', 'plan_stage'],
  ['task_failure_streaks', 'diagnostic_run_id'],
  ['task_failure_streaks', 'diagnostic_at'],
];

/** The twelve workforce capability keys, in spec order. */
const WORKFORCE_KEYS = [
  'plan_then_execute',
  'shift_handoff',
  'office_hours',
  'sentinel_worker',
  'repo_shipped_jobs',
  'accept_with_note',
  'earned_autonomy',
  'self_healing',
  'proposed_events',
  'agent_timesheets',
  'performance_reviews',
  'proof_of_work_export',
] as const;

const columns = (db: DB, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe('agent workforce foundation — migration 0008', () => {
  let db: DB;

  beforeAll(() => {
    db = new Database(':memory:') as unknown as DB;
    db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
    createMigrator(db, loadMigrationsFrom(MIGRATIONS_DIR)).migrate();
  });

  afterAll(() => db.close());

  it('is the only migration the workforce adds, and it applied', () => {
    const applied = (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(applied).toContain(MIGRATION_ID);
    // Filename order is load-bearing (db.ts sorts by name), so 0008 must be last.
    expect(applied[applied.length - 1]).toBe(MIGRATION_ID);
    const beyond = applied.filter((id) => /^\d{4}/.test(id) && Number(id.slice(0, 4)) > 8);
    expect(beyond, `a second workforce migration appeared: ${beyond.join(', ')}`).toEqual([]);
  });

  it('creates every table the twelve features own', () => {
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    const missing = NEW_TABLES.filter((t) => !present.has(t));
    expect(missing, `migration 0008 lost tables: ${missing.join(', ')}`).toEqual([]);
  });

  it('adds every column the twelve features own, without disturbing the existing ones', () => {
    for (const [table, column] of NEW_COLUMNS) {
      expect(columns(db, table), `${table}.${column} missing`).toContain(column);
    }
    // The pre-existing shape must survive ADD COLUMN untouched.
    expect(columns(db, 'tasks')).toEqual(expect.arrayContaining(['id', 'prompt', 'version', 'deleted_at', 'chain_after']));
    expect(columns(db, 'task_failure_streaks')).toEqual(expect.arrayContaining(['task_id', 'kind', 'count', 'last_at']));
  });

  it('leaves every profile that exists today untouched by the autonomy columns', () => {
    // may_require_approval defaults 0 so office-hours shifts nobody by surprise;
    // autonomy_rung is NULL — not 'plan' — so no profile is misreported as
    // sitting on a rung its owner never chose.
    const now = Date.now();
    db.prepare(
      `INSERT INTO profiles (id, slug, name, engine, created_at, updated_at) VALUES ('p-legacy','legacy','Legacy','cli',?,?)`,
    ).run(now, now);
    const row = db
      .prepare('SELECT may_require_approval, autonomy_rung, autonomy_streak_required FROM profiles WHERE id=?')
      .get('p-legacy') as { may_require_approval: number; autonomy_rung: string | null; autonomy_streak_required: number | null };
    expect(row.may_require_approval).toBe(0);
    expect(row.autonomy_rung).toBeNull();
    expect(row.autonomy_streak_required).toBeNull();
  });

  it('seeds exactly one workforce_prefs row and refuses a second', () => {
    const prefs = db.prepare('SELECT * FROM workforce_prefs').all() as Array<Record<string, unknown>>;
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({
      id: 1,
      office_hours_enabled: 0,
      autonomy_streak_required: 5,
      self_heal_failure_threshold: 3,
      human_hourly_rate_usd: null,
      review_period_days: 30,
    });
    expect(() => db.prepare('INSERT INTO workforce_prefs (id) VALUES (2)').run()).toThrow();
  });

  it('cascades run_outcomes so the retention sweep can still DELETE FROM runs', () => {
    // retention-audit.ts sweep() issues a bare `DELETE FROM runs ...`. An
    // un-cascaded FK to runs(id) would abort the whole sweep once a single
    // acceptance existed — the exact reason run_outcomes.run_id cascades.
    const now = Date.now();
    db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('t-ret','t','p',?,?)`).run(now, now);
    db.prepare(
      `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, ended_at) VALUES ('r-ret','t-ret','{}','completed',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO run_outcomes (run_id, task_id, profile_id, decision, decided_at) VALUES ('r-ret','t-ret',NULL,'accepted',?)`,
    ).run(now);

    expect(() =>
      db.prepare("DELETE FROM runs WHERE state IN ('completed','failed') AND ended_at < ?").run(now + 1),
    ).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) c FROM run_outcomes').get() as { c: number }).c).toBe(0);
  });

  it('records one decision per run — a second accept updates, never duplicates', () => {
    const now = Date.now();
    db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('t-dup','t','p',?,?)`).run(now, now);
    db.prepare(
      `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at) VALUES ('r-dup','t-dup','{}','completed',?)`,
    ).run(now);
    const write = db.prepare(
      `INSERT INTO run_outcomes (run_id, task_id, profile_id, decision, note, decided_at)
       VALUES (?,?,NULL,?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET decision=excluded.decision, note=excluded.note, decided_at=excluded.decided_at`,
    );
    write.run('r-dup', 't-dup', 'accepted', null, now);
    write.run('r-dup', 't-dup', 'rejected', 'changed my mind', now + 1);
    const rows = db.prepare("SELECT decision, note FROM run_outcomes WHERE run_id='r-dup'").all();
    expect(rows).toEqual([{ decision: 'rejected', note: 'changed my mind' }]);
  });

  it('keeps a repo from offering the same job twice', () => {
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO repo_jobs (id, repo_path, source_path, job_key, name, spec_json, digest, discovered_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    ins.run('rj1', '/repo/a', '/repo/a/.clockwork/jobs.yaml', 'nightly', 'Nightly', '{}', 'd1', now);
    expect(() =>
      ins.run('rj2', '/repo/a', '/repo/a/.clockwork/jobs.yaml', 'nightly', 'Nightly again', '{}', 'd2', now),
    ).toThrow();
    // a different repo may reuse the key
    expect(() => ins.run('rj3', '/repo/b', '/repo/b/.clockwork/jobs.yaml', 'nightly', 'Nightly', '{}', 'd1', now)).not.toThrow();
  });

  it('uses millisecond epoch integers and no DDL SQLite cannot run', () => {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, `${MIGRATION_ID}.sql`), 'utf8');
    // Timestamps: every existing comparison is ms-based, so a DATETIME/TEXT
    // column would silently break next_fire and heartbeat maths.
    expect(sql).not.toMatch(/\bDATETIME\b/i);
    expect(sql).not.toMatch(/\bCURRENT_TIMESTAMP\b/i);
    expect(sql).not.toMatch(/\bBOOLEAN\b/i);
    // Forward-only: no rollback path exists anywhere in this codebase.
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
    // SQLite cannot add a NOT NULL column without a default.
    for (const line of sql.split('\n').filter((l) => /ALTER TABLE/i.test(l))) {
      if (/NOT NULL/i.test(line)) expect(line, `un-defaulted NOT NULL: ${line}`).toMatch(/DEFAULT/i);
    }
  });
});

describe('agent workforce foundation — shared contract', () => {
  it('accepts a report written before proposedEvents existed', () => {
    // Stored reports are read with bare JSON.parse and never re-validated, so
    // the field must be OPTIONAL, not defaulted: a default would make the key
    // required in the report literal and force an edit to run-manager.ts.
    const legacy = {
      runId: 'r', taskId: 't', taskName: 'n', profile: null, engine: 'cli', cliVersion: null,
      state: 'completed', failureReason: null, summary: 's', branch: null, baseSha: null,
      transcriptPath: null, startedAt: null, endedAt: null,
    };
    const parsed = RunReport.parse(legacy);
    expect(parsed.proposedEvents).toBeUndefined();
    expect(RunReport.parse({ ...legacy, proposedEvents: [{ key: 'k', title: 'Review PR 42' }] }).proposedEvents).toEqual([
      { key: 'k', title: 'Review PR 42', notes: null, durationMin: 15, suggestedAt: null },
    ]);
  });

  it('maps every autonomy rung to a real permission mode — bypassPermissions is banned', () => {
    for (const rung of autonomyRungs) {
      const s = AUTONOMY_RUNG_SETTINGS[rung];
      expect(['plan', 'acceptEdits']).toContain(s.permissionMode);
    }
    // The top rung is unattended-but-not-unrestricted: acceptEdits with the
    // approval flag cleared, because permissionModes has no fourth value.
    expect(AUTONOMY_RUNG_SETTINGS.unattended).toEqual({ permissionMode: 'acceptEdits', mayRequireApproval: false });
    expect(nextRung('plan')).toBe('acceptEdits');
    expect(nextRung('acceptEdits')).toBe('unattended');
    expect(nextRung('unattended')).toBeNull();
  });
});

describe('agent workforce foundation — capability registry honesty', () => {
  it('registers all twelve features', () => {
    const keys = new Set(FEATURES.map((f) => f.key));
    const missing = WORKFORCE_KEYS.filter((k) => !keys.has(k));
    expect(missing, `unregistered workforce features: ${missing.join(', ')}`).toEqual([]);
  });

  // This block used to be one assertion: every workforce key is still
  // 'planned', because none of them ran. The twelve modules and their wiring
  // have now landed, and spec §0 rule 2 / §6 item 7 make the flip the
  // integrator's job — so that assertion is replaced, not relaxed, by three
  // guards that are each harder to satisfy dishonestly than the original.

  /**
   * The status each workforce key is allowed to claim, and nothing else.
   * Editing a value here is deliberately a chore: it forces whoever raises a
   * claim to raise it in a diff a reviewer reads.
   */
  const CLAIMED: Record<(typeof WORKFORCE_KEYS)[number], 'planned' | 'available' | 'enforced'> = {
    plan_then_execute: 'enforced',
    shift_handoff: 'available',
    office_hours: 'enforced',
    sentinel_worker: 'available',
    repo_shipped_jobs: 'available',
    accept_with_note: 'available',
    earned_autonomy: 'enforced',
    self_healing: 'available',
    proposed_events: 'available',
    agent_timesheets: 'available',
    performance_reviews: 'available',
    proof_of_work_export: 'available',
  };

  /** The route that makes each feature reachable, verbatim as api.ts registers it. */
  const ROUTE: Record<(typeof WORKFORCE_KEYS)[number], string> = {
    plan_then_execute: "app.post('/workforce/plan-execute'",
    shift_handoff: "app.post('/workforce/handoff/:taskId'",
    office_hours: "app.post('/workforce/office-hours'",
    sentinel_worker: "app.post('/workforce/sentinels'",
    repo_shipped_jobs: "app.post('/workforce/repo-jobs/discover'",
    accept_with_note: "app.post('/workforce/runs/:runId/outcome'",
    earned_autonomy: "app.get('/workforce/autonomy/offers'",
    self_healing: "app.get('/workforce/remediations'",
    proposed_events: "app.get('/workforce/runs/:runId/proposed-events'",
    agent_timesheets: "app.get('/workforce/timesheets'",
    performance_reviews: "app.get('/workforce/performance'",
    proof_of_work_export: "app.get('/workforce/runs/:runId/proof-of-work'",
  };

  it('claims exactly the status the integration pass verified — no key drifts upward on its own', () => {
    const drift = WORKFORCE_KEYS.map((k) => ({ k, actual: FEATURES.find((f) => f.key === k)?.status }))
      .filter(({ k, actual }) => actual !== CLAIMED[k])
      .map(({ k, actual }) => `${k}: registry says '${actual}', this contract says '${CLAIMED[k]}'`);
    expect(drift, 'workforce feature status drifted from the reviewed claim').toEqual([]);
  });

  it('never says available/enforced for a feature api.ts serves no route for', () => {
    // 'available' means a user can reach it through the API right now. The
    // registry may not say that for a feature whose routes were never wired.
    const api = readFileSync(resolve(HERE, '../src/api.ts'), 'utf8');
    const unreachable = WORKFORCE_KEYS.filter(
      (k) => FEATURES.find((f) => f.key === k)?.status !== 'planned' && !api.includes(ROUTE[k]),
    );
    expect(unreachable, 'registry claims a workforce feature exists but api.ts registers no route for it').toEqual([]);
  });

  it("backs every 'enforced' claim with a gate outside the /workforce/ routes", () => {
    // 'enforced' is the strong claim: the daemon refuses or defers a user
    // action because of the feature, whether or not the user ever touches a
    // /workforce/ route. Anything weaker must say 'available'.
    const api = readFileSync(resolve(HERE, '../src/api.ts'), 'utf8');
    const runManager = readFileSync(resolve(HERE, '../src/run-manager.ts'), 'utf8');
    const scheduler = readFileSync(resolve(HERE, '../src/scheduler.ts'), 'utf8');
    const GATES: Partial<Record<(typeof WORKFORCE_KEYS)[number], boolean>> = {
      // F1: run finalize withholds the execute run and opens an approval instead.
      plan_then_execute: runManager.includes('this.deps.planExecute?.onPlanRunFinalized('),
      // F3: the scheduler tick defers a fire into the next answerable window.
      office_hours: scheduler.includes('shiftForApproval(this.deps.db, task.id, fireAt)'),
      // F7: three 403 gates — task create, task patch, webhook fire.
      earned_autonomy:
        (api.match(/autonomy\.evaluate\(/g) ?? []).length >= 3 && api.includes('return reply.code(403).send(avio);'),
    };
    const unbacked = WORKFORCE_KEYS.filter((k) => FEATURES.find((f) => f.key === k)?.status === 'enforced' && GATES[k] !== true);
    expect(unbacked, "'enforced' claimed with no gate outside the /workforce/ routes").toEqual([]);
  });

  it('never sells one of them in the upgrade modal', () => {
    // Same rule feature-honesty.test.ts enforces, asserted from this side so a
    // workforce feature added to FEATURE_COPY fails in its own suite too.
    const src = readFileSync(resolve(HERE, '../../ui/src/components/UpgradeHint.tsx'), 'utf8');
    const block = src.slice(src.indexOf('FEATURE_COPY'), src.indexOf('export function upgradeCopy'));
    const advertised = new Set([...block.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]!));
    expect(advertised.size).toBeGreaterThan(0);
    const sold = WORKFORCE_KEYS.filter((k) => advertised.has(k));
    expect(sold, `upgrade modal sells unbuilt workforce features: ${sold.join(', ')}`).toEqual([]);
  });
});
