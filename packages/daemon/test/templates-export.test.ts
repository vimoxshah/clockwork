/**
 * T4-8: export a task as a template.
 *
 * Two layers, same split templates-library.test.ts already uses for the
 * bundled side: `exportTaskTemplate`/`IMPORT_GRANT`/
 * `collapseImportPermissionMode` (templates.ts) asserted directly, then the
 * full HTTP round trip (`GET /tasks/:id/export-template` →
 * `POST /templates/preview` → `POST /templates/import`) over `app.inject`,
 * the same harness templates-library.test.ts uses for the bundled files.
 *
 * Harness: temp dir, real RunManager pointed at a nonexistent runner child
 * (no run ever starts), buildServer, app.inject — copied from
 * templates-library.test.ts, not imported from it (that file has no exports
 * of its own harness pieces).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import { collapseImportPermissionMode, exportTaskTemplate, IMPORT_GRANT, type TemplateFile } from '../src/templates.js';

// AWS's own published example access key ID (docs use this exact string) —
// matches SECRET_PATTERNS' `AKIA[0-9A-Z]{16}` in @clockwork/runner/context.ts.
const PLANTED_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const PLANTED_ANTHROPIC_KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz012345';

describe('exportTaskTemplate + IMPORT_GRANT (templates.ts, no HTTP)', () => {
  it('masks a credential in the prompt with the same maskSecrets proof-of-work.ts uses', () => {
    const tpl = exportTaskTemplate({
      name: 'Rotate keys',
      prompt: `Rotate this and report done: ${PLANTED_AWS_KEY}`,
      permission_mode: 'acceptEdits',
    });
    expect(tpl.prompt).not.toContain(PLANTED_AWS_KEY);
    expect(tpl.prompt).toContain('[AWS-KEY-MASKED]');
  });

  it('declares budget/schedule/missedPolicy/overlapPolicy/delivery from IMPORT_GRANT, not from any live task value — the function is never even given those fields', () => {
    const tpl = exportTaskTemplate({ name: 'x', prompt: 'do the thing', permission_mode: 'plan' });
    expect(tpl.budget).toEqual(IMPORT_GRANT.budget);
    expect(tpl.schedule).toEqual(IMPORT_GRANT.schedule);
    expect(tpl.missedPolicy).toBe(IMPORT_GRANT.missedPolicy);
    expect(tpl.overlapPolicy).toBe(IMPORT_GRANT.overlapPolicy);
    expect(tpl.delivery).toEqual(IMPORT_GRANT.delivery);
  });

  it('omits repoPath, baseBranch and profileSlug — meaningless to a recipient, and discarded on import regardless', () => {
    const tpl = exportTaskTemplate({ name: 'x', prompt: 'y', permission_mode: 'acceptEdits' });
    expect('repoPath' in tpl).toBe(false);
    expect('baseBranch' in tpl).toBe(false);
    expect('profileSlug' in tpl).toBe(false);
  });

  it('passes name and prompt through unchanged when there is nothing to mask', () => {
    const tpl = exportTaskTemplate({ name: 'Nightly digest', prompt: 'summarize open TODOs', permission_mode: 'plan' });
    expect(tpl.name).toBe('Nightly digest');
    expect(tpl.prompt).toBe('summarize open TODOs');
    expect(tpl.schema).toBe('clockwork.template.v1');
  });

  it("collapseImportPermissionMode: 'plan' passes through, every other value (including the schema-legal 'default') becomes 'acceptEdits'", () => {
    expect(collapseImportPermissionMode('plan')).toBe('plan');
    expect(collapseImportPermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(collapseImportPermissionMode('default')).toBe('acceptEdits');
    expect(collapseImportPermissionMode('bypassPermissions')).toBe('acceptEdits');
    expect(collapseImportPermissionMode(undefined)).toBe('acceptEdits');
    expect(collapseImportPermissionMode('plan')).toBe(exportTaskTemplate({ name: 'x', prompt: 'y', permission_mode: 'plan' }).permissionMode);
  });

  it("exportTaskTemplate's permissionMode agrees with collapseImportPermissionMode for every input — the same function decides both directions", () => {
    for (const mode of ['plan', 'acceptEdits', 'default', 'anything-else']) {
      const tpl = exportTaskTemplate({ name: 'x', prompt: 'y', permission_mode: mode });
      expect(tpl.permissionMode).toBe(collapseImportPermissionMode(mode));
    }
  });
});

describe('T4-8 round trip through the EXISTING HTTP routes: export → preview → import', () => {
  let db: DB;
  let dir: string;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-tpl-export-'));
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

  /**
   * A task whose prompt AND delivery config both carry something that must
   * not survive export. `budget` is deliberately far from IMPORT_GRANT's
   * $2/50/3600 — the task prompt's own illustrative example ("looks like a
   * $50 budget and silently gets $2") — so a passing assertion here is not a
   * same-value coincidence.
   */
  async function createLoadedTask(permissionMode: 'plan' | 'acceptEdits'): Promise<string> {
    const res = await app.inject(
      auth({
        method: 'POST',
        url: '/tasks',
        payload: {
          name: `Loaded task (${permissionMode})`,
          prompt: `Rotate ${PLANTED_AWS_KEY} and ${PLANTED_ANTHROPIC_KEY}, then report done.`,
          schedule: { kind: 'once', runAt: Date.now() + 3_600_000, tz: 'UTC' },
          permissionMode,
          budget: { maxUsd: 50, maxTurns: 500, timeoutSec: 86_000 },
          delivery: {
            osNotify: true,
            webhook: { url: `https://hooks.example.com/x?token=${PLANTED_ANTHROPIC_KEY}`, secretRef: PLANTED_ANTHROPIC_KEY },
          },
        },
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it('sanity: the planted delivery credential really is stored on the task (guards the guard below)', async () => {
    const taskId = await createLoadedTask('acceptEdits');
    const row = db.prepare('SELECT delivery_json FROM tasks WHERE id=?').get(taskId) as { delivery_json: string };
    expect(row.delivery_json).toContain(PLANTED_ANTHROPIC_KEY);
  });

  it.each(['plan', 'acceptEdits'] as const)(
    'permissionMode=%s: GET /tasks/:id/export-template masks the prompt credential and never carries the delivery credential, budget, or schedule',
    async (permissionMode) => {
      const taskId = await createLoadedTask(permissionMode);

      const res = await app.inject(auth({ method: 'GET', url: `/tasks/${taskId}/export-template` }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-disposition']).toContain(`clockwork-template-${taskId}.json`);

      // Checked against the RAW response body, not just the parsed prompt
      // field — a leak anywhere in the serialized file is the failure this
      // guards, not only a leak in the one field maskSecrets touches.
      expect(res.body).not.toContain(PLANTED_AWS_KEY);
      expect(res.body).not.toContain(PLANTED_ANTHROPIC_KEY);

      const tpl = res.json() as TemplateFile;
      expect(tpl.schema).toBe('clockwork.template.v1');
      expect(tpl.prompt).toContain('[AWS-KEY-MASKED]');
      expect(tpl.prompt).toContain('[ANTHROPIC-KEY-MASKED]');
      expect(tpl.permissionMode).toBe(permissionMode);
      // The "must not overstate" property, concretely: the task's REAL
      // budget ($50/500/86000) never appears — only IMPORT_GRANT's.
      expect(tpl.budget).toEqual(IMPORT_GRANT.budget);
      expect(tpl.budget.maxUsd).not.toBe(50);
      expect(tpl.schedule).toEqual(IMPORT_GRANT.schedule);
      expect(tpl.delivery).toEqual({ osNotify: true }); // the webhook/secretRef never travel
      expect('repoPath' in tpl).toBe(false);
      expect('profileSlug' in tpl).toBe(false);
    },
  );

  it.each(['plan', 'acceptEdits'] as const)(
    'permissionMode=%s: the exported file, fed to POST /templates/preview, shows a clean disabled-on-arrival preview',
    async (permissionMode) => {
      const taskId = await createLoadedTask(permissionMode);
      const exportRes = await app.inject(auth({ method: 'GET', url: `/tasks/${taskId}/export-template` }));
      const tpl = exportRes.json() as TemplateFile;

      const previewRes = await app.inject(auth({ method: 'POST', url: '/templates/preview', payload: tpl }));
      expect(previewRes.statusCode, previewRes.body).toBe(200);
      const body = previewRes.json() as { preview: { flags: Array<{ level: string; text: string }>; arrivesDisabled: boolean } };
      expect(body.preview.arrivesDisabled).toBe(true);
      expect(body.preview.flags.length).toBeGreaterThan(0);
      expect(body.preview.flags.some((f) => f.level === 'red')).toBe(false);
      expect(body.preview.flags.some((f) => /arrive DISABLED/.test(f.text))).toBe(true);
    },
  );

  it.each(['plan', 'acceptEdits'] as const)(
    'permissionMode=%s: export → import reproduces name/prompt(masked)/permissionMode, arrives DISABLED, and grants exactly IMPORT_GRANT — never the source task’s own budget',
    async (permissionMode) => {
      const taskId = await createLoadedTask(permissionMode);
      const exportRes = await app.inject(auth({ method: 'GET', url: `/tasks/${taskId}/export-template` }));
      const tpl = exportRes.json() as TemplateFile;

      const importRes = await app.inject(auth({ method: 'POST', url: '/templates/import', payload: tpl }));
      expect(importRes.statusCode, importRes.body).toBe(201);
      const created = importRes.json() as { task: { id: string }; flags: Array<{ level: string }> };
      expect(created.flags.length).toBeGreaterThan(0);

      // S-74: read the row FRESH rather than trust the import response body —
      // repo.ts TaskRepo.create() returns its snapshot BEFORE api.ts's
      // follow-up `UPDATE tasks SET enabled=0` runs (templates-library.test.ts
      // documents the same precaution for the bundled files).
      const row = db
        .prepare('SELECT enabled, name, prompt, permission_mode, budget_usd, max_turns, timeout_sec, profile_id, repo_path, delivery_json FROM tasks WHERE id=?')
        .get(created.task.id) as {
        enabled: number;
        name: string;
        prompt: string;
        permission_mode: string;
        budget_usd: number;
        max_turns: number;
        timeout_sec: number;
        profile_id: string | null;
        repo_path: string | null;
        delivery_json: string;
      };
      expect(row.enabled, 'S-74: imported tasks arrive disabled regardless of payload intent').toBe(0);
      expect(row.name).toBe(tpl.name);
      expect(row.prompt).toBe(tpl.prompt); // the MASKED prompt — the raw credential was never in tpl.prompt to begin with
      expect(row.prompt).not.toContain(PLANTED_AWS_KEY);
      expect(row.permission_mode).toBe(permissionMode);
      expect(
        { maxUsd: row.budget_usd, maxTurns: row.max_turns, timeoutSec: row.timeout_sec },
        'grants IMPORT_GRANT.budget, never the exporting task’s real $50/500/86000',
      ).toEqual(IMPORT_GRANT.budget);
      expect(row.profile_id).toBeNull();
      expect(row.repo_path).toBeNull();
      expect(JSON.parse(row.delivery_json)).toEqual(IMPORT_GRANT.delivery);

      const scheduleRow = db.prepare('SELECT kind FROM schedules WHERE task_id=?').get(created.task.id) as { kind: string } | undefined;
      expect(scheduleRow?.kind).toBe(IMPORT_GRANT.schedule.kind);
    },
  );

  it('404s exporting a task that does not exist', async () => {
    const res = await app.inject(auth({ method: 'GET', url: '/tasks/nonexistent-task-id/export-template' }));
    expect(res.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const taskId = await createLoadedTask('acceptEdits');
    const res = await app.inject({ method: 'GET', url: `/tasks/${taskId}/export-template` });
    expect(res.statusCode).toBe(401);
  });
});
