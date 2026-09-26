/**
 * Worker agent (P4): the loop that makes THIS daemon a worker of another.
 *
 * Enabled only by environment — CLOCKWORK_WORKER_PRIMARY (primary base URL)
 * plus CLOCKWORK_WORKER_TOKEN (the bearer issued at approve). Nothing here
 * runs on a primary; a daemon with no worker env never polls anyone.
 *
 * Each poll: heartbeat → next-job → accept or decline → on accept, adapt the
 * jobspec's machine paths to THIS dataDir, insert the SAME run id locally so
 * both ledgers link, let the local pump execute it, and POST the terminal
 * outcome back. One job at a time: a second poll waits while one is active.
 *
 * Honesty rules for this file:
 * - A repo the worker does not have is DECLINED (loudly, with the path), not
 *   executed elsewhere and not silently requeued. Pins exist to keep work off
 *   machines; running pinned work on the wrong machine would defeat them.
 * - The worker never reports what it did not execute: only its own finalized
 *   terminal state is posted. A crash between finalize and POST leaves the
 *   primary row claimed; the primary's silence sweep marks it worker_lost.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';

export interface WorkerAgentOptions {
  db: DB;
  dataDir: string;
  primaryUrl: string;
  token: string;
  pump: () => void;
  intervalMs?: number;
  log?: (message: string) => void;
}

interface PrimaryJob {
  id: string;
  jobspec: Record<string, any>;
}

async function primaryFetch(opts: WorkerAgentOptions, path: string, init?: RequestInit): Promise<Response> {
  const url = `${opts.primaryUrl.replace(/\/$/, '')}${path}`;
  return fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), 'x-clockwork-worker': opts.token, 'content-type': 'application/json' },
  });
}

/**
 * The worker ledger is its own: pulled tasks do not exist here, and
 * runs.task_id is a foreign key. A stub row carries the pulled definition so
 * local history, inbox and reports read normally. It never schedules (no
 * schedules row) and never chains (no edges) — it is a record, not a task.
 */
export function ensureWorkerTaskRow(db: DB, spec: Record<string, any>, now: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?,?,?,?,?)`,
  ).run(spec.taskId, String(spec.taskName ?? spec.taskId), String(spec.prompt ?? ''), now, now);
}
export function adaptSpecForWorker(spec: Record<string, any>, dataDir: string): Record<string, any> {
  const slug = String(spec.taskSlug ?? 'job');
  const runId = String(spec.runId);
  return {
    ...spec,
    worktreePath: path.join(dataDir, 'worktrees', slug, runId),
    scratchPath: spec.repoPath ? null : path.join(dataDir, 'scratch', runId),
  };
}

export function startWorkerAgent(options: WorkerAgentOptions): { stop(): void } {
  function defaultLog(m: string): void {
    process.stderr.write(`[worker-agent] ${m}\n`);
  }
  const { db, dataDir, intervalMs = 30_000, log = defaultLog } = options;
  let stopped = false;
  // Crash resume: the active run id persists on disk, so a restart between
  // local finalize and primary report re-sends the terminal outcome instead
  // of abandoning it (the primary's sweep would otherwise mark genuinely
  // finished work worker_lost). Run ids only — no secrets in this file.
  const activeFile = path.join(dataDir, 'worker-active.json');
  const readActive = (): string | null => {
    try {
      const raw = readFileSync(activeFile, 'utf8');
      const id = (JSON.parse(raw) as { runId?: unknown }).runId;
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
  };
  const writeActive = (runId: string | null): void => {
    try {
      if (runId) writeFileSync(activeFile, JSON.stringify({ runId }), { mode: 0o600 });
      else rmSync(activeFile, { force: true });
    } catch (e) {
      log(`active-run file write failed: ${(e as Error).message}`);
    }
  };
  let activeRunId: string | null = readActive();
  if (activeRunId) log(`resuming unfinished report for ${activeRunId}`);
  let workerId: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const localTerminal = (runId: string): { state: string; row: any } | null => {
    const row = db.prepare('SELECT state, report_json, cost_usd, turns FROM runs WHERE id=?').get(runId) as any;
    if (!row) return null;
    if (!['completed', 'failed', 'timed_out', 'cancelled', 'budget_exceeded'].includes(row.state)) return null;
    return { state: row.state, row };
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      // Identity first, once: the token resolves to the worker row, and every
      // other protocol route is addressed by that id (a token never stands in
      // for an id — workers must not reach each other's jobs).
      if (!workerId) {
        const me = await primaryFetch(options, `/workers/me`);
        if (me.status === 401) {
          log('identity rejected (401) — token dead (revoked?). Settle manually; polling continues in case it was rotated.');
          return;
        }
        if (!me.ok) {
          log(`identity lookup failed (HTTP ${me.status})`);
          return;
        }
        workerId = ((await me.json()) as any).id as string;
        if (!workerId) return;
      }
      const id = workerId;
      // Heartbeat on EVERY poll, including while a job executes: the sweep
      // marks silence, not idleness, and a long job must not look dead.
      // (Closed a real hole: the heartbeat used to skip during execution.)
      const hb = await primaryFetch(options, `/workers/${id}/heartbeat`, { method: 'POST', body: JSON.stringify({}) });
      if (hb.status === 401) {
        log('heartbeat rejected (401) — token dead (revoked?). Settle manually; polling continues in case it was rotated.');
        workerId = null; // re-resolve: a rotation issues a new identity binding
        return;
      }
      // Finish reporting the active job before pulling another.
      if (activeRunId) {
        const localRow = db.prepare('SELECT id FROM runs WHERE id=?').get(activeRunId) as any;
        if (!localRow) {
          // Local ledger lost the row (wiped DB?) — nothing to report; clear
          // so polling resumes. The primary's sweep already owns the outcome.
          log(`local row ${activeRunId} gone — dropping the resume`);
          activeRunId = null;
          writeActive(null);
          return;
        }
        const done = localTerminal(activeRunId);
        if (!done) return; // still executing locally
        const res = await primaryFetch(options, `/workers/${id}/runs/${activeRunId}/complete`, {
          method: 'POST',
          body: JSON.stringify({
            state: done.state,
            report_json: done.row.report_json ?? JSON.stringify({ summary: '(no report recorded)' }),
            cost_usd: Number(done.row.cost_usd ?? 0),
            turns: Number(done.row.turns ?? 0),
          }),
        });
        // 409 = primary already settled it (sweep won the race) — either way
        // we are done with this job; never report twice.
        if (res.ok || res.status === 409) {
          log(`reported ${activeRunId} as ${done.state}`);
          activeRunId = null;
          writeActive(null);
        } else {
          log(`complete rejected (HTTP ${res.status}) for ${activeRunId} — will retry next poll`);
        }
        return;
      }
      const jr = await primaryFetch(options, `/workers/${id}/next-job`);
      if (jr.status === 204) return;
      if (!jr.ok) {
        log(`next-job failed (HTTP ${jr.status})`);
        return;
      }
      const { run } = (await jr.json()) as { run: PrimaryJob | null };
      if (!run) return;
      const spec = run.jobspec as Record<string, any>;
      if (spec.repoPath && !existsSync(spec.repoPath)) {
        await primaryFetch(options, `/workers/${id}/runs/${run.id}/decline`, {
          method: 'POST',
          body: JSON.stringify({ reason: `repo missing on worker: ${spec.repoPath}` }),
        });
        log(`declined ${run.id}: repo missing (${spec.repoPath})`);
        return;
      }
      const adapted = adaptSpecForWorker(spec, dataDir);
      const now = Date.now();
      // File BEFORE insert: a crash between them leaves a pointer to a row
      // that was never created, which the resume path clears (nothing ever
      // executed). The reverse order would strand an executing row nobody
      // reports — strictly worse.
      writeActive(run.id);
      ensureWorkerTaskRow(db, adapted, now);
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for) VALUES (?, ?, ?, 'queued', ?, ?)`,
      ).run(run.id, adapted.taskId, JSON.stringify(adapted), now, now);
      db.prepare('INSERT INTO events (at, run_id, kind, data_json) VALUES (?, ?, ?, ?)').run(
        now,
        run.id,
        'state_changed',
        JSON.stringify({ to: 'queued', via: 'worker-pull' }),
      );
      activeRunId = run.id;
      options.pump();
      log(`accepted ${run.id} (task ${adapted.taskId})`);
    } catch (e) {
      // Polling must never take the worker daemon down: log and retry next tick.
      log(`poll failed: ${(e as Error).message}`);
    }
  };

  // NOTE: no /workers/me/* protocol paths exist on the primary — identity
  // resolves once through GET /workers/me, and everything else addresses
  // /workers/:id/* with the token alongside. One spelling, enforced above.
  const run = (): void => {
    void poll();
  };
  run();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  return {
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
