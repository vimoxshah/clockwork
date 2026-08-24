/**
 * Typed repositories over better-sqlite3 prepared statements (ADR-022).
 * Validation happens at the API boundary via shared zod schemas (S-26);
 * these functions assume validated input.
 */
import type { DB } from './db.js';
import { newId } from '@clockwork/shared';
import type { TaskCreate, TaskPatch } from '@clockwork/shared';

export interface TaskRow {
  id: string;
  name: string;
  prompt: string;
  profile_id: string | null;
  repo_path: string | null;
  model: string | null;
  permission_mode: string;
  budget_usd: number;
  max_turns: number;
  timeout_sec: number;
  base_branch: string | null;
  context_json: string;
  delivery_json: string;
  missed_policy: string;
  missed_window_sec: number;
  overlap_policy: string;
  retry_on_transient: number;
  flexible: number;
  chain_after: string | null;
  chain_on: string | null;
  template_id: string | null;
  enabled: number;
  version: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ScheduleRow {
  id: string;
  task_id: string;
  kind: 'once' | 'rrule' | 'cron' | 'queue';
  rrule: string | null;
  cron: string | null;
  run_at: number | null;
  tz: string;
  next_fire: number | null;
  enabled: number;
}

export class TaskRepo {
  constructor(private readonly db: DB) {}

  get(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL').get(id) as unknown as TaskRow | undefined;
  }

  list(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC').all() as unknown as TaskRow[];
  }

  scheduleFor(taskId: string): ScheduleRow | undefined {
    return this.db.prepare('SELECT * FROM schedules WHERE task_id=?').get(taskId) as unknown as ScheduleRow | undefined;
  }

  create(input: TaskCreate, resolvedProfileId: string | null, nextFire: number | null): TaskRow {
    const now = Date.now();
    const id = newId();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, name, prompt, profile_id, repo_path, model, engine, byok_id, chain_after, chain_on, permission_mode,
            budget_usd, max_turns, timeout_sec, base_branch, context_json, delivery_json,
            missed_policy, missed_window_sec, overlap_policy, retry_on_transient, enabled, version,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.prompt,
          resolvedProfileId,
          input.repoPath ?? null,
          input.model ?? null,
          input.engine ?? null,
          input.byokId ?? null,
          input.chainAfter ?? null,
          input.chainOn ?? null,
          input.permissionMode,
          input.budget.maxUsd,
          input.budget.maxTurns,
          input.budget.timeoutSec,
          input.baseBranch ?? null,
          JSON.stringify(input.context ?? { files: [] }),
          JSON.stringify(input.delivery ?? {}),
          input.missedPolicy,
          input.missedWindowSec,
          input.overlapPolicy,
          input.retryOnTransient ? 1 : 0,
          now,
          now,
        );
      if (input.schedule.kind !== 'queue') {
        this.db
          .prepare(
            `INSERT INTO schedules (id, task_id, kind, rrule, cron, run_at, tz, next_fire, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          )
          .run(
            newId(),
            id,
            input.schedule.kind,
            input.schedule.rrule ?? null,
            input.schedule.cron ?? null,
            input.schedule.runAt ?? null,
            input.schedule.tz,
            nextFire,
          );
      } else {
        // ASAP queue mode (FR-4): a queue-kind schedule row keeps the task on the tray
        this.db
          .prepare(
            `INSERT INTO schedules (id, task_id, kind, tz, next_fire, enabled) VALUES (?, ?, 'queue', ?, NULL, 0)`,
          )
          .run(newId(), id, input.schedule.tz);
      }
    });
    tx();
    return this.get(id)!;
  }

  /** Optimistic-concurrency patch (S-82). Returns row or throws 'version_conflict'. */
  patch(id: string, input: TaskPatch, expectedVersion: number | undefined, nextFire: number | null): TaskRow | 'version_conflict' | 'not_found' {
    const existing = this.get(id);
    if (!existing) return 'not_found';
    if (expectedVersion !== undefined && expectedVersion !== existing.version) return 'version_conflict';
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      const map: Array<[keyof TaskPatch, string, (v: any) => unknown]> = [
        ['name', 'name', (v) => v],
        ['prompt', 'prompt', (v) => v],
        ['profileId', 'profile_id', (v) => v],
        ['repoPath', 'repo_path', (v) => v],
        ['baseBranch', 'base_branch', (v) => v],
        ['model', 'model', (v) => v],
        ['permissionMode', 'permission_mode', (v) => v],
        ['missedPolicy', 'missed_policy', (v) => v],
        ['missedWindowSec', 'missed_window_sec', (v) => v],
        ['overlapPolicy', 'overlap_policy', (v) => v],
        ['retryOnTransient', 'retry_on_transient', (v) => (v ? 1 : 0)],
        ['enabled', 'enabled', (v) => (v ? 1 : 0)],
        ['engine', 'engine', (v) => v],
        ['byokId', 'byok_id', (v) => v],
        ['chainAfter', 'chain_after', (v) => v],
        ['chainOn', 'chain_on', (v) => v],
      ];
      for (const [k, col, cast] of map) {
        if (input[k] !== undefined) {
          sets.push(`${col}=?`);
          vals.push(cast(input[k]));
        }
      }
      if (input.budget) {
        sets.push('budget_usd=?, max_turns=?, timeout_sec=?');
        vals.push(input.budget.maxUsd, input.budget.maxTurns, input.budget.timeoutSec);
      }
      if (input.context) {
        sets.push('context_json=?');
        vals.push(JSON.stringify(input.context));
      }
      if (input.delivery) {
        sets.push('delivery_json=?');
        vals.push(JSON.stringify(input.delivery));
      }
      sets.push('version=version+1');
      sets.push('updated_at=?');
      vals.push(now, id);
      this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id=? AND deleted_at IS NULL`).run(...vals);

      if (input.schedule) {
        const sched = this.scheduleFor(id);
        if (sched) {
          this.db
            .prepare('UPDATE schedules SET kind=?, rrule=?, cron=?, run_at=?, tz=?, next_fire=?, enabled=? WHERE id=?')
            .run(
              input.schedule.kind,
              input.schedule.rrule ?? null,
              input.schedule.cron ?? null,
              input.schedule.runAt ?? null,
              input.schedule.tz,
              nextFire,
              input.schedule.kind === 'queue' ? 0 : 1,
              sched.id,
            );
        }
      }
    });
    tx();
    return this.get(id)!;
  }

  softDelete(id: string): boolean {
    const r = this.db.prepare('UPDATE tasks SET deleted_at=? WHERE id=? AND deleted_at IS NULL').run(Date.now(), id);
    return r.changes > 0;
  }
}

export interface ProfileRow {
  id: string;
  slug: string;
  name: string;
  color: string | null;
  avatar: string | null;
  engine: string;
  model: string | null;
  permission_mode: string | null;
  budget_usd: number | null;
  max_turns: number | null;
  timeout_sec: number | null;
  skills_json: string;
  mcp_allow_json: string;
  context_roots_json: string;
  system_prompt_extra: string | null;
  delivery_json: string | null;
  builtin: number;
}

export class ProfileRepo {
  constructor(private readonly db: DB) {}

  get(id: string): ProfileRow | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE id=?').get(id) as unknown as ProfileRow | undefined;
  }

  bySlug(slug: string): ProfileRow | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE slug=?').get(slug) as unknown as ProfileRow | undefined;
  }

  list(): ProfileRow[] {
    return this.db.prepare('SELECT * FROM profiles ORDER BY builtin DESC, name ASC').all() as unknown as ProfileRow[];
  }

  upsert(p: ProfileRow): void {
    this.db
      .prepare(
        `INSERT INTO profiles (id, slug, name, color, avatar, engine, model, permission_mode,
          budget_usd, max_turns, timeout_sec, skills_json, mcp_allow_json, context_roots_json,
          system_prompt_extra, delivery_json, builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET name=excluded.name, color=excluded.color`,
      )
      .run(
        p.id, p.slug, p.name, p.color, p.avatar, p.engine, p.model, p.permission_mode,
        p.budget_usd, p.max_turns, p.timeout_sec, p.skills_json, p.mcp_allow_json,
        p.context_roots_json, p.system_prompt_extra, p.delivery_json, p.builtin,
        Date.now(), Date.now(),
      );
  }
}

export class RunRepo {
  constructor(private readonly db: DB) {}

  list(filter: { state?: string; taskId?: string; limit?: number }): unknown[] {
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (filter.state) {
      conds.push('state=?');
      vals.push(filter.state);
    }
    if (filter.taskId) {
      conds.push('task_id=?');
      vals.push(filter.taskId);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    vals.push(Math.min(filter.limit ?? 200, 1000));
    return this.db
      .prepare(`SELECT * FROM runs ${where} ORDER BY COALESCE(scheduled_for, state_changed_at) DESC LIMIT ?`)
      .all(...vals);
  }

  report(runId: string): { run: unknown; reportJson: string | null } | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as any;
    if (!r) return undefined;
    return { run: r, reportJson: r.report_json ?? null };
  }
}

/** FTS index maintenance (FR-29-lite): updated on finalize + task save. */
export function indexRun(db: DB, runId: string, title: string, body: string): void {
  db.prepare(`DELETE FROM search_idx WHERE kind='run' AND ref_id=?`).run(runId);
  db.prepare(`INSERT INTO search_idx (kind, ref_id, title, body) VALUES ('run', ?, ?, ?)`).run(runId, title, body.slice(0, 500_000));
}

export function indexTask(db: DB, taskId: string, title: string, body: string): void {
  db.prepare(`DELETE FROM search_idx WHERE kind='task' AND ref_id=?`).run(taskId);
  db.prepare(`INSERT INTO search_idx (kind, ref_id, title, body) VALUES ('task', ?, ?, ?)`).run(taskId, title, body);
}
