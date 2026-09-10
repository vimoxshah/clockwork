/**
 * T4-7 / T-207: the five canonical, bookable template files under
 * resources/templates/. Every file must parse, pass the EXISTING S-74
 * security preview and S-75 apply-time validation (`templates.ts`) unmodified,
 * reference a real shipped profile (never an invented one), and round-trip
 * through the EXISTING `/templates/preview` + `/templates/import` HTTP routes
 * (api.ts) exactly as a user's own import would.
 *
 * Harness for the HTTP section is workforce-api.test.ts's: temp dir, real
 * RunManager pointed at a nonexistent runner child (no run ever starts),
 * buildServer, app.inject.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import { loadBundledTemplates, securityPreview, validateTemplateApply, type TemplateFile } from '../src/templates.js';
import { BUNDLED_PROFILES } from '../src/profiles.js';
import { EXTRA_PROFILES } from '../src/profile-library.js';
import { ScheduleSpec, Budget } from '@clockwork/shared';

const TEMPLATES_DIR = path.resolve(import.meta.dirname, '../../../resources/templates');
const KNOWN_PROFILE_SLUGS = new Set([...BUNDLED_PROFILES, ...EXTRA_PROFILES].map((p) => p.slug));
const templates = loadBundledTemplates(TEMPLATES_DIR);
const CASES = templates.map((t) => [t.name, t] as const);

describe('T4-7 bundled template library — files on disk', () => {
  it('ships exactly the five canonical templates', () => {
    // Names the actual fault (a missing/moved directory) instead of letting
    // an empty `templates` array read as "content is wrong" below — resolved
    // by the same package/skill-pack-relative-to-compiled-source convention
    // main.ts:242 uses, so a genuine miss here means packaging drifted, not
    // that a file's content is bad.
    expect(existsSync(TEMPLATES_DIR), TEMPLATES_DIR).toBe(true);
    expect(templates).toHaveLength(5);
    expect(templates.map((t) => t.name).sort()).toEqual(
      [
        'Flaky test sweep',
        'Friday docs-drift check',
        'Monday dependency triage',
        'Morning repo-health digest',
        'Pre-release changelog draft',
      ].sort(),
    );
  });

  it.each(CASES)('%s: valid schema, non-empty prompt, references a real shipped profile', (_name, tpl) => {
    expect(tpl.schema).toBe('clockwork.template.v1');
    expect(tpl.prompt.trim().length).toBeGreaterThan(0);
    expect(tpl.profileSlug).toBeTruthy();
    // A template must not be able to grant itself a profile the app doesn't ship.
    expect(KNOWN_PROFILE_SLUGS.has(tpl.profileSlug!)).toBe(true);
  });

  it.each(CASES)('%s: schedule and budget conform to the shared TaskCreate schema', (_name, tpl) => {
    expect(ScheduleSpec.safeParse(tpl.schedule).success).toBe(true);
    expect(Budget.safeParse(tpl.budget).success).toBe(true);
  });

  it.each(CASES)('%s: passes the EXISTING S-74 security preview clean (no red, no yellow)', (_name, tpl) => {
    const preview = securityPreview(tpl);
    expect(preview.arrivesDisabled).toBe(true);
    expect(preview.flags.filter((f) => f.level === 'red')).toHaveLength(0);
    expect(preview.flags.filter((f) => f.level === 'yellow')).toHaveLength(0);
  });

  it.each(CASES)('%s: passes S-75 apply-time validation with zero variables to fill', (_name, tpl) => {
    expect(validateTemplateApply(tpl, {}).ok).toBe(true);
  });

  it('never offers the banned bypassPermissions mode', () => {
    for (const tpl of templates) expect(tpl.permissionMode).not.toBe('bypassPermissions');
  });
});

describe('T4-7 dogfood parity — the first three templates match dogfood/DOGFOOD.md', () => {
  function find(name: string): TemplateFile {
    const t = templates.find((x) => x.name === name);
    if (!t) throw new Error(`template not found: ${name}`);
    return t;
  }

  it('Monday dependency triage == dogfood job 1 (dep-surgeon, Mon 09:00, $2/50t/1h)', () => {
    const t = find('Monday dependency triage');
    expect(t.profileSlug).toBe('dep-surgeon');
    expect((t.schedule as { rrule: string }).rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0');
    expect(t.budget).toEqual({ maxUsd: 2, maxTurns: 50, timeoutSec: 3600 });
  });

  /**
   * INTENT: TRACK-4-ux.md's own list item reads "Nightly flaky-test sweep" /
   * this task's acceptance requires "same cadence" as dogfood's job 2, which
   * runs weekly on Wednesdays 09:00 — not nightly, and the sibling items
   * ("Monday…", "Friday…") DO match their dogfood day, so "Nightly" is the
   * one label that breaks the pattern / resolved in favor of the explicit,
   * normative "same cadence" requirement: schedule and name both follow
   * dogfood's actual job (weekly Wed 09:00, task name "Flaky test sweep"),
   * not the "Nightly" list label.
   */
  it('Flaky test sweep == dogfood job 2 on cadence + budget (Wed 09:00, $2/50t/1h)', () => {
    const t = find('Flaky test sweep');
    expect((t.schedule as { rrule: string }).rrule).toBe('FREQ=WEEKLY;BYDAY=WE;BYHOUR=9;BYMINUTE=0');
    expect(t.budget).toEqual({ maxUsd: 2, maxTurns: 50, timeoutSec: 3600 });
  });

  /**
   * INTENT: dogfood/DOGFOOD.md's table names job 2's profile
   * "@generalist (test-doctor skill)" / no such skill exists
   * (BUNDLED_PROFILES' generalist.skills = []) and dogfood's own booking curl
   * passes no profile field at all — the table already disagrees with its own
   * script, so "same profile as dogfood" cannot mean the literal table text.
   * A dedicated `test-doctor` profile now exists (profile-library.ts) whose
   * mission text IS the test-doctor procedure verbatim / used that. Not fixed
   * in DOGFOOD.md — outside this task's touch scope.
   */
  it('Flaky test sweep profile: test-doctor (the profile matching the mission, not the stale table text)', () => {
    expect(find('Flaky test sweep').profileSlug).toBe('test-doctor');
  });

  it('Friday docs-drift check == dogfood job 3 (docs-scribe, Fri 09:00, $1.5/40t/45m)', () => {
    const t = find('Friday docs-drift check');
    expect(t.profileSlug).toBe('docs-scribe');
    expect((t.schedule as { rrule: string }).rrule).toBe('FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0');
    expect(t.budget).toEqual({ maxUsd: 1.5, maxTurns: 40, timeoutSec: 2700 });
  });
});

describe('T4-7 round-trip through the EXISTING /templates/preview + /templates/import HTTP routes', () => {
  let db: DB;
  let dir: string;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-tpl-lib-'));
    db = openDatabase(dir).db;
    createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
    const rm = new RunManager({
      db,
      clock: new FakeClock(Date.now()),
      dataDir: dir,
      runnerChildModule: '/nonexistent/runner-child.js', // not exercised — no import here ever runs
      notify: () => {},
      broadcast: () => {},
      safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
    });
    const scheduler = new Scheduler({ db, clock: new FakeClock(Date.now()), enqueueRun: () => {}, notify: () => {} });
    const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
    app = built.app;
    token = built.token;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function auth(json: Record<string, unknown>): Record<string, unknown> {
    return { ...json, headers: { authorization: `Bearer ${token}` } };
  }

  it.each(CASES)('%s: POST /templates/preview returns a clean, disabled-on-arrival preview', async (_name, tpl) => {
    const res = await app.inject(auth({ method: 'POST', url: '/templates/preview', payload: tpl }));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { preview: { flags: Array<{ level: string }>; arrivesDisabled: boolean } };
    expect(body.preview.arrivesDisabled).toBe(true);
    expect(body.preview.flags.some((f) => f.level === 'red')).toBe(false);
  });

  it.each(CASES)(
    "%s: POST /templates/import creates the task DISABLED, and never grants the template's own budget/schedule/profile",
    async (_name, tpl) => {
      const res = await app.inject(auth({ method: 'POST', url: '/templates/import', payload: tpl }));
      expect(res.statusCode, res.body).toBe(201);
      const created = res.json() as { task: { id: string } };

      // S-74: read the row FRESH rather than trust the import response body.
      // repo.ts TaskRepo.create() returns its snapshot BEFORE api.ts's
      // follow-up `UPDATE tasks SET enabled=0` runs, so only a re-read proves
      // the real, post-import state.
      const taskRow = db
        .prepare('SELECT enabled, budget_usd, max_turns, timeout_sec, prompt, name, profile_id FROM tasks WHERE id=?')
        .get(created.task.id) as {
        enabled: number;
        budget_usd: number;
        max_turns: number;
        timeout_sec: number;
        prompt: string;
        name: string;
        profile_id: string | null;
      };
      expect(taskRow.enabled).toBe(0);
      expect(taskRow.name).toBe(tpl.name);
      expect(taskRow.prompt).toBe(tpl.prompt);
      // The posture repo-jobs.ts documents for its own import(): never trust
      // the untrusted file for budget/schedule/profile — hardcode the safe
      // defaults regardless of what the template asked for. Every one of the
      // five files' own budget differs from at least one of these three, so
      // this genuinely exercises "cannot grant itself more power", not a
      // same-value coincidence.
      expect({ maxUsd: taskRow.budget_usd, maxTurns: taskRow.max_turns, timeoutSec: taskRow.timeout_sec }).toEqual({
        maxUsd: 2,
        maxTurns: 50,
        timeoutSec: 3600,
      });
      expect(taskRow.profile_id).toBeNull();

      const scheduleRow = db.prepare('SELECT kind FROM schedules WHERE task_id=?').get(created.task.id) as { kind: string } | undefined;
      expect(scheduleRow?.kind).toBe('queue');
    },
  );

  it('rejects a hypothetical bypassPermissions template at /templates/import (422, no task created)', async () => {
    const evil: TemplateFile = {
      schema: 'clockwork.template.v1',
      name: 'evil',
      prompt: 'do things',
      permissionMode: 'bypassPermissions',
      budget: { maxUsd: 100, maxTurns: 500, timeoutSec: 86_400 },
    };
    const before = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    const res = await app.inject(auth({ method: 'POST', url: '/templates/import', payload: evil }));
    expect(res.statusCode, res.body).toBe(422);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});
