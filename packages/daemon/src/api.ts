/**
 * Daemon API (T-107, arch §6): loopback-only Fastify + SSE, bearer token
 * (generated at install, stored 0600), optimistic task versioning (S-82).
 * The UI is a pure client; anything scriptable here is scriptable by users.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  TaskCreate,
  TaskPatch,
  ProfileCreate,
  ProfilePatch,
  API_VERSION,
  newId,
  type JobSpec,
  slugify,
  branchFor,
} from '@clockwork/shared';
import type { DB } from './db.js';
import { TaskRepo, ProfileRepo, RunRepo, indexTask } from './repo.js';
import type { RunManager } from './run-manager.js';
import type { Scheduler } from './scheduler.js';
import { nextOccurrenceAfter } from './recurrence.js';
import { isGitRepo } from '@clockwork/runner';

export interface ApiDeps {
  db: DB;
  dataDir: string;
  runManager: RunManager;
  scheduler: Scheduler;
  version: string;
}

export function loadOrCreateToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const tokenPath = path.join(dataDir, 'api-token');
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf8').trim();
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

export async function buildServer(deps: ApiDeps): Promise<{ app: FastifyInstance; token: string; sseClients: Set<FastifyReply> }> {
  const app = Fastify({ logger: false });
  const tasks = new TaskRepo(deps.db);
  const profiles = new ProfileRepo(deps.db);
  const runs = new RunRepo(deps.db);
  const token = loadOrCreateToken(deps.dataDir);
  const sseClients = new Set<FastifyReply>();

  // serve the built UI when present (single-port product surface)
  const uiDist = path.resolve(import.meta.dirname, '../../ui/dist');
  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, prefix: '/' });
  }

  let paused = false;

  // ---- auth hook: bearer token on data routes; static UI + health open ----
  app.addHook('onRequest', async (req, reply) => {
    const url = (req.raw.url ?? '').split('?')[0]!;
    const needsAuth =
      /^\/(tasks|runs|approvals|profiles|search|widget|queue|onboarding|pause-all|resume|capacity)/.test(url) ||
      url.startsWith('/events');
    if (!needsAuth) return; // /health + static UI assets carry no user data
    // SSE handled via query param (EventSource cannot set headers)
    const header = req.headers.authorization;
    const qpToken = url.startsWith('/events')
      ? new URL(req.raw.url ?? '', 'http://x').searchParams.get('token')
      : null;
    if (header !== `Bearer ${token}` && qpToken !== token) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  const broadcast = (event: Record<string, unknown>): void => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try {
        client.raw.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  // wire manager broadcasts to SSE
  const origBroadcast = deps.runManager['deps'].broadcast;
  deps.runManager['deps'].broadcast = (e) => {
    origBroadcast(e);
    broadcast(e);
  };

  // ---- health (S-61 handshake) ----
  app.get('/health', async () => {
    const active = deps.runManager.countActive();
    const queued = (deps.db.prepare("SELECT COUNT(*) c FROM runs WHERE state='queued'").get() as any).c;
    const nextFire = (
      deps.db.prepare('SELECT MIN(next_fire) nf FROM schedules WHERE enabled=1 AND next_fire IS NOT NULL').get() as any
    ).nf;
    return {
      ok: true,
      apiVersion: API_VERSION,
      daemonVersion: deps.version,
      paused,
      activeRuns: active,
      queuedRuns: queued,
      nextFire,
    };
  });

  // ---- tasks ----
  const validateAndMaterialize = (input: TaskCreate): { ok: true; nextFire: number | null; profileId: string | null } | { ok: false; error: string } => {
    // @mention resolution (FR-28)
    let profileId: string | null = input.profileId ?? null;
    if (!profileId && input.profileSlugMention) {
      const p = profiles.bySlug(input.profileSlugMention.replace(/^@/, ''));
      if (!p) return { ok: false, error: `unknown profile @${input.profileSlugMention}` };
      profileId = p.id;
    }
    // repo validation at save (S-36/S-69)
    if (input.repoPath) {
      if (!isGitRepo(input.repoPath)) {
        return { ok: false, error: `repo_path is not a git repository: ${input.repoPath}` };
      }
    }
    // schedule validation + materialization (S-23/S-26)
    let nextFire: number | null = null;
    if (input.schedule.kind === 'once') {
      if ((input.schedule.runAt ?? 0) < Date.now()) {
        return { ok: false, error: 'schedule is in the past — pick a future time or use run-now' };
      }
      nextFire = input.schedule.runAt ?? null;
    } else if (input.schedule.kind === 'rrule' || input.schedule.kind === 'cron') {
      try {
        nextFire = nextOccurrenceAfter(
          {
            kind: input.schedule.kind === 'rrule' ? 'rrule' : 'cron',
            rrule: input.schedule.rrule,
            cron: input.schedule.cron,
            tz: input.schedule.tz,
          },
          Date.now(),
          7, // save-time horizon check: must have a fire within a week? no — full horizon but bounded work
        );
        if (nextFire == null && input.schedule.kind === 'rrule') {
          return { ok: false, error: 'RRULE has no future occurrences' };
        }
      } catch (e) {
        return { ok: false, error: `invalid recurrence: ${String(e)}` };
      }
    }
    return { ok: true, nextFire, profileId };
  };

  app.post('/tasks', async (req, reply) => {
    const parsed = TaskCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const v = validateAndMaterialize(parsed.data);
    if (!v.ok) return reply.code(422).send({ error: v.error });
    const row = tasks.create(parsed.data, v.profileId, v.nextFire);
    indexTask(deps.db, row.id, row.name, row.prompt);
    broadcast({ type: 'task.changed', taskId: row.id, at: Date.now() });
    return reply.code(201).send(view(row, v.nextFire));
  });

  app.get('/tasks', async () => {
    return tasks.list().map((row) => {
      const s = tasks.scheduleFor(row.id);
      return view(row, s?.next_fire ?? null);
    });
  });

  app.get('/tasks/:id', async (req, reply) => {
    const row = tasks.get((req.params as any).id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const s = tasks.scheduleFor(row.id);
    return view(row, s?.next_fire ?? null);
  });

  app.patch('/tasks/:id', async (req, reply) => {
    const parsed = TaskPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    }
    // S-72: chain validation at save — linear only, cycles rejected
    if ('chainAfter' in (req.body as any)) {
      const { validateChain } = await import('./templates.js');
      const err = validateChain(deps.db, (req.params as any).id, (req.body as any).chainAfter ?? null);
      if (err) return reply.code(422).send({ error: err });
    }
    let nextFire: number | null | undefined;
    if (parsed.data.schedule) {
      const probe = validateAndMaterialize({
        ...(parsed.data as any),
        name: parsed.data.name ?? 'probe',
        prompt: parsed.data.prompt ?? 'probe',
        budget: parsed.data.budget ?? { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
        schedule: parsed.data.schedule,
      } as TaskCreate);
      if (!probe.ok) return reply.code(422).send({ error: probe.error });
      nextFire = probe.nextFire;
    }
    const res = tasks.patch((req.params as any).id, parsed.data, (req.body as any)?.version, nextFire ?? null);
    if (res === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (res === 'version_conflict') return reply.code(409).send({ error: 'version_conflict' }); // S-82
    broadcast({ type: 'task.changed', taskId: res.id, at: Date.now() });
    const s = tasks.scheduleFor(res.id);
    return view(res, s?.next_fire ?? null);
  });

  app.delete('/tasks/:id', async (req, reply) => {
    const ok = tasks.softDelete((req.params as any).id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return { deleted: true }; // S-6: soft delete; in-flight run completes, history retained
  });

  app.post('/tasks/:id/run-now', async (req, reply) => {
    const row = tasks.get((req.params as any).id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const runId = enqueueRunNow(deps.db, row);
    deps.runManager.pump();
    return reply.code(202).send({ runId });
  });

  // ---- templates (T-203) ----
  const { securityPreview, validateTemplateApply } = await import('./templates.js');

  /** S-74: preview WITHOUT importing — full prompt/permissions/budget diff vs defaults. */
  app.post('/templates/preview', async (req, reply) => {
    const tpl = req.body as any;
    if (!tpl || tpl.schema !== 'clockwork.template.v1') {
      return reply.code(422).send({ error: 'invalid template schema' });
    }
    return { preview: securityPreview(tpl), template: tpl };
  });

  app.post('/templates/import', async (req, reply) => {
    const tpl = req.body as any;
    if (!tpl || tpl.schema !== 'clockwork.template.v1') {
      return reply.code(422).send({ error: 'invalid template schema' });
    }
    const preview = securityPreview(tpl);
    if (preview.flags.some((f) => f.level === 'red')) {
      return reply.code(422).send({ error: 'template rejected by security preview', flags: preview.flags });
    }
    const created = tasks.create(
      {
        name: String(tpl.name ?? 'Imported template').slice(0, 120),
        prompt: String(tpl.prompt ?? ''),
        profileId: undefined,
        repoPath: undefined, // S-75: user re-picks at apply
        permissionMode: tpl.permissionMode === 'plan' ? 'plan' : 'acceptEdits',
        budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
        schedule: { kind: 'queue', tz: 'UTC' }, // imported = not scheduled until reviewed
        missedPolicy: 'run-late',
        missedWindowSec: 21_600,
        overlapPolicy: 'skip',
        retryOnTransient: false,
        context: { files: [] },
        delivery: { osNotify: true },
      },
      null,
      null,
    );
    // S-74: arrives DISABLED regardless of payload intent
    deps.db.prepare('UPDATE tasks SET enabled=0 WHERE id=?').run(created.id);
    broadcast({ type: 'task.changed', taskId: created.id, at: Date.now() });
    return reply.code(201).send({ task: view(created), flags: preview.flags });
  });

  /** S-75: apply with variable fill + validation. */
  app.post('/tasks/:id/apply-template-vars', async (req, reply) => {
    const row = tasks.get((req.params as any).id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const vars = (req.body as any)?.vars ?? {};
    const tpl: any = { schema: 'clockwork.template.v1', name: row.name, prompt: row.prompt };
    const check = validateTemplateApply(tpl, vars);
    if (!check.ok) return reply.code(422).send({ error: check.error });
    let prompt = row.prompt;
    for (const [k, v] of Object.entries(vars)) {
      prompt = prompt.replaceAll(`{{${k}}}`, String(v));
    }
    deps.db.prepare('UPDATE tasks SET prompt=?, version=version+1, updated_at=? WHERE id=?').run(prompt, Date.now(), row.id);
    return { applied: true };
  });

  // ---- runs ----
  app.get('/runs', async (req) => {
    const q = req.query as any;
    return runs.list({
      state: q.state,
      taskId: q.taskId,
      limit: q.limit ? parseInt(String(q.limit), 10) : undefined,
    });
  });

  app.get('/runs/:id/report', async (req, reply) => {
    const r = runs.report((req.params as any).id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return { run: r.run, report: r.reportJson ? JSON.parse(r.reportJson) : null };
  });

  app.post('/runs/:id/cancel', async (req, reply) => {
    const ok = deps.runManager.cancel((req.params as any).id);
    return ok ? reply.code(202).send({ cancelling: true }) : reply.code(409).send({ error: 'not_cancellable' });
  });

  /** Transcript tail (S-68: masked best-effort) for the report viewer. */
  app.get('/runs/:id/transcript', async (req, reply) => {
    const run = deps.db
      .prepare('SELECT transcript_path, journal_path FROM runs WHERE id=?')
      .get((req.params as any).id) as any;
    if (!run) return reply.code(404).send({ error: 'not_found' });
    const p = run.transcript_path ?? null;
    const fallback = run.journal_path ?? null;
    const source =
      (p && existsSync(p) ? { path: p, kind: 'raw' as const } : null) ??
      (fallback && existsSync(fallback) ? { path: fallback, kind: 'journal' as const } : null);
    if (!source) return { available: false, lines: [] };
    try {
      const raw = await import('node:fs').then((fs) => fs.readFileSync(source.path, 'utf8'));
      const { maskSecrets } = await import('@clockwork/runner');
      const allLines = raw.split('\n').filter((l) => l.trim().length > 0);
      const render = (l: string): string => {
        try {
          const o = JSON.parse(l);
          // journal wrapper → unwrap inner engine line
          if (source.kind === 'journal' && typeof o?.line === 'string') return render(o.line);
          if (o.type === 'assistant' && o.message?.content) {
            const texts = (o.message.content as any[]).filter((c) => c.type === 'text').map((c) => c.text);
            if (texts.length) return `▸ ${maskSecrets(texts.join(' ').slice(0, 400))}`;
          }
          if (o.type === 'result') return `■ result: ${maskSecrets(String(o.result ?? '').slice(0, 400))}`;
        } catch {}
        return maskSecrets(l.slice(0, 300));
      };
      const tail = allLines.slice(-400).map(render);
      return { available: true, totalLines: allLines.length, lines: tail };
    } catch (e) {
      return reply.code(500).send({ error: `unreadable: ${String(e).slice(0, 80)}` });
    }
  });

  // ---- approvals (rows exist from M1 fail-safe; responses land M2 UI) ----
  app.get('/approvals', async () => {
    return deps.db.prepare('SELECT * FROM approvals WHERE responded_at IS NULL ORDER BY requested_at ASC').all();
  });

  app.post('/approvals/:id/respond', async (req, reply) => {
    const id = (req.params as any).id;
    const body = req.body as any;
    const now = Date.now();
    // CAS on responded_at (S-57): first writer wins
    const r = deps.db
      .prepare(`UPDATE approvals SET responded_at=?, response_json=? WHERE id=? AND responded_at IS NULL`)
      .run(now, JSON.stringify(body ?? {}), id);
    if (r.changes === 0) return reply.code(409).send({ error: 'already_resolved' });
    // Forward into the live run when the child's decision window is still open.
    let forwarded = false;
    try {
      const row = deps.db.prepare('SELECT run_id, payload_json FROM approvals WHERE id=?').get(id) as any;
      if (row) {
        const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json ?? {};
        const decision = body?.decision === 'approved';
        if (payload.reqId) {
          forwarded = deps.runManager.respondToChild(row.run_id, String(payload.reqId), decision);
        }
      }
    } catch {
      /* forwarding best-effort; the CAS record stands either way */
    }
    deps.runManager.pump();
    return { resolved: true, forwarded };
  });

  // ---- profiles ----
  app.get('/profiles', async () => profiles.list());

  // ---- calendar range (month/week views): runs + expanded occurrences ----
  app.get('/calendar', async (req, reply) => {
    const q = req.query as any;
    const to = q.to ? parseInt(String(q.to), 10) : Date.now() + 31 * 86_400_000;
    const from = q.from ? parseInt(String(q.from), 10) : to - 62 * 86_400_000;
    if (!(from > 0 && to > from)) return reply.code(422).send({ error: 'invalid range' });

    const { occurrencesBetween } = await import('./recurrence.js');

    // Runs whose scheduled_for OR started/ended fall in range.
    const runRows = deps.db
      .prepare(
        `SELECT id, task_id, state, outcome_reason, scheduled_for, started_at, ended_at, cost_usd, turns, jobspec_json
         FROM runs
         WHERE (scheduled_for BETWEEN ? AND ?)
            OR (started_at BETWEEN ? AND ?)
            OR (ended_at BETWEEN ? AND ?)
         ORDER BY COALESCE(scheduled_for, started_at, ended_at) ASC`,
      )
      .all(from, to, from, to, from, to) as unknown as Array<Record<string, unknown>>;

    // Bookings: expand every enabled schedule into the visible window.
    const bookings: Array<{ taskId: string; name: string; at: number; kind: 'booking' }> = [];
    const scheds = deps.db
      .prepare(
        `SELECT s.id, s.task_id, s.kind, s.rrule, s.cron, s.run_at, s.tz, s.next_fire,
                t.name AS task_name
         FROM schedules s JOIN tasks t ON t.id = s.task_id
         WHERE s.enabled = 1 AND t.enabled = 1 AND t.deleted_at IS NULL`,
      )
      .all() as unknown as Array<{
      id: string; task_id: string; kind: string; rrule: string | null; cron: string | null;
      run_at: number | null; tz: string; next_fire: number | null; task_name: string;
    }>;
    for (const s of scheds) {
      try {
        if (s.kind === 'queue') continue;
        let ats: number[] = [];
        if (s.kind === 'once') {
          ats = s.run_at != null && s.run_at >= from && s.run_at <= to && s.next_fire != null ? [s.run_at] : [];
        } else {
          ats = occurrencesBetween(
            { kind: s.kind as 'rrule' | 'cron', rrule: s.rrule, cron: s.cron, runAt: s.run_at, tz: s.tz },
            Math.max(from, Date.now() - 1000),
            to,
            62,
          );
        }
        for (const at of ats) {
          bookings.push({ taskId: s.task_id, name: s.task_name, at, kind: 'booking' });
        }
      } catch {
        /* one bad schedule must not break the calendar */
      }
    }
    bookings.sort((a, b) => a.at - b.at);

    // Human events from subscribed ICS feeds (read-only; never written to).
    let humans: Array<{ uid: string; name: string; at: number; allDay: boolean }> = [];
    try {
      const { loadIcsSources, fetchIcs } = await import('./ics.js');
      const sources = loadIcsSources(deps.dataDir);
      const seen = new Set<string>();
      for (const src of sources) {
        try {
          const res = await fetchIcs(src.url);
          if (!res.ok || !res.events) continue;
          for (const ev of res.events) {
            if (ev.startMs < from || ev.startMs > to) continue;
            if (seen.has(ev.uid)) continue;
            seen.add(ev.uid);
            humans.push({ uid: ev.uid, name: ev.summary, at: ev.startMs, allDay: ev.allDay });
          }
        } catch {
          /* one bad feed must not break the calendar */
        }
      }
      humans.sort((a, b) => a.at - b.at);
    } catch {
      /* ICS overlay is best-effort */
    }

    return { from, to, runs: runRows, bookings, humans };
  });

  // ---- ICS calendar sources (read-only subscriptions; Settings → Calendars) ----
  app.get('/calendars/ics', async () => {
    const { loadIcsSources } = await import('./ics.js');
    return loadIcsSources(deps.dataDir);
  });
  app.post('/calendars/ics', async (req, reply) => {
    const body = req.body as any;
    const url = String(body?.url ?? '').trim();
    const label = String(body?.label ?? '').trim() || 'My calendar';
    if (!/^https:\/\//i.test(url)) return reply.code(422).send({ error: 'url must be https' });
    const { fetchIcs, loadIcsSources, saveIcsSources } = await import('./ics.js');
    const probe = await fetchIcs(url);
    if (!probe.ok) return reply.code(422).send({ error: probe.error ?? 'feed unreachable' });
    const sources = loadIcsSources(deps.dataDir);
    const id = `ics_${Date.now().toString(36)}`;
    sources.push({ id, url, label });
    saveIcsSources(deps.dataDir, sources);
    return { id, label, url, events: probe.events?.length ?? 0 };
  });
  app.delete('/calendars/ics/:id', async (req) => {
    const { loadIcsSources, saveIcsSources } = await import('./ics.js');
    const id = String((req.params as any).id ?? '');
    const remaining = loadIcsSources(deps.dataDir).filter((s) => s.id !== id);
    saveIcsSources(deps.dataDir, remaining);
    return { removed: id, kept: remaining.length };
  });

  app.post('/profiles', async (req, reply) => {
    const parsed = ProfileCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const d = parsed.data;
    if (profiles.bySlug(d.slug)) return reply.code(409).send({ error: 'slug_exists' });
    const id = newId();
    profiles.upsert({
      id,
      slug: d.slug,
      name: d.name,
      color: d.color ?? null,
      avatar: d.glyph ?? null,
      engine: d.engine,
      model: d.model ?? null,
      permission_mode: d.permissionMode,
      budget_usd: d.budget.maxUsd,
      max_turns: d.budget.maxTurns,
      timeout_sec: d.budget.timeoutSec,
      skills_json: JSON.stringify(d.skills),
      mcp_allow_json: JSON.stringify(d.mcpAllow),
      context_roots_json: JSON.stringify(d.contextRoots),
      system_prompt_extra: d.systemPromptExtra ?? null,
      delivery_json: JSON.stringify(d.delivery),
      builtin: 0,
    });
    return reply.code(201).send(profiles.get(id));
  });

  app.patch('/profiles/:id', async (req, reply) => {
    const existing = profiles.get((req.params as any).id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const parsed = ProfilePatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    const d = parsed.data;
    profiles.upsert({
      ...existing,
      name: d.name ?? existing.name,
      color: d.color ?? existing.color,
      avatar: d.glyph ?? existing.avatar,
      engine: d.engine ?? existing.engine,
      model: d.model ?? existing.model,
      permission_mode: d.permissionMode ?? existing.permission_mode,
      budget_usd: d.budget?.maxUsd ?? existing.budget_usd,
      max_turns: d.budget?.maxTurns ?? existing.max_turns,
      timeout_sec: d.budget?.timeoutSec ?? existing.timeout_sec,
      skills_json: d.skills ? JSON.stringify(d.skills) : existing.skills_json,
      mcp_allow_json: d.mcpAllow ? JSON.stringify(d.mcpAllow) : existing.mcp_allow_json,
      context_roots_json: d.contextRoots ? JSON.stringify(d.contextRoots) : existing.context_roots_json,
      system_prompt_extra: d.systemPromptExtra ?? existing.system_prompt_extra,
    });
    return profiles.get(existing.id);
  });

  // ---- search (FR-29-lite) ----
  app.get('/search', async (req) => {
    const q = String((req.query as any).q ?? '').trim();
    if (q.length === 0) return [];
    const kindFilter = (req.query as any).kind;
    const ftsQuery = q.split(/\s+/).map((w) => `${w}*`).join(' ');
    const sql = kindFilter
      ? `SELECT kind, ref_id, title, snippet(search_idx, 3, '[', ']', '…', 12) AS snip FROM search_idx WHERE search_idx MATCH ? AND kind=? ORDER BY rank LIMIT 50`
      : `SELECT kind, ref_id, title, snippet(search_idx, 3, '[', ']', '…', 12) AS snip FROM search_idx WHERE search_idx MATCH ? ORDER BY rank LIMIT 50`;
    const rows = kindFilter
      ? deps.db.prepare(sql).all(ftsQuery, kindFilter)
      : deps.db.prepare(sql).all(ftsQuery);
    return rows;
  });

  // ---- widget snapshot (read-only scope, ADR-019) ----
  app.get('/widget/snapshot', async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const runsToday = (
      deps.db.prepare('SELECT COUNT(*) c FROM runs WHERE scheduled_for >= ?').get(todayStart.getTime()) as any
    ).c;
    const needsYou = (
      deps.db.prepare(`SELECT COUNT(*) c FROM approvals WHERE responded_at IS NULL`).get() as any
    ).c;
    const unread = (
      deps.db.prepare(`SELECT COUNT(*) c FROM runs WHERE report_json IS NOT NULL AND ended_at > ?`).get(Date.now() - 24 * 3600_000) as any
    ).c;
    const next = deps.db
      .prepare('SELECT next_fire, t.name FROM schedules s JOIN tasks t ON t.id=s.task_id WHERE s.enabled=1 AND s.next_fire IS NOT NULL ORDER BY next_fire LIMIT 1')
      .get() as any;
    return { runsToday, needsYou, recentReports: unread, nextRun: next ?? null, paused };
  });

  // ---- pause-all / resume ----
  app.post('/pause-all', async () => {
    paused = true;
    deps.scheduler.stop();
    broadcast({ type: 'daemon.health', data: { paused }, at: Date.now() });
    return { paused: true };
  });

  app.post('/resume', async () => {
    paused = false;
    deps.scheduler.start();
    broadcast({ type: 'daemon.health', data: { paused: false }, at: Date.now() });
    return { paused: false };
  });

  // ---- queue lane (FR-6): waiting items with position + reason ----
  app.get('/queue', async () => {
    const rows = deps.db
      .prepare(
        `SELECT r.id, r.task_id, r.scheduled_for, r.jobspec_json FROM runs r WHERE r.state='queued' ORDER BY COALESCE(r.scheduled_for, r.state_changed_at) ASC`,
      )
      .all() as unknown as Array<{ id: string; task_id: string; scheduled_for: number | null; jobspec_json: string }>;
    const active = deps.runManager.countActive();
    const maxParallel = 2;
    let position = 0;
    return rows.map((r) => {
      position++;
      const spec = JSON.parse(r.jobspec_json ?? '{}');
      const repoBusy =
        spec.repoPath &&
        (deps.db
          .prepare(`SELECT COUNT(*) c FROM runs WHERE id != ? AND jobspec_json LIKE ? AND state IN ('preparing','running','waiting_approval','finalizing')`)
          .get(r.id, `%${spec.repoPath}%`) as any).c > 0;
      const reason =
        repoBusy ? 'waiting for repo'
        : active + position > maxParallel ? 'waiting for slot'
        : paused ? 'paused'
        : 'starting soon';
      return {
        runId: r.id,
        taskId: r.task_id,
        name: spec.taskName ?? '(task)',
        position,
        reason,
      };
    });
  });

  // ---- onboarding (FR-21): environment detection ----
  app.get('/onboarding/status', async () => {
    const { existsSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { augmentedPath, resolveOnAugmentedPath } = await import('@clockwork/runner');
    const home = process.env.HOME ?? '';
    // Service context: probe binaries on the AUGMENTED path (launchd PATH is minimal).
    const claudeBin = resolveOnAugmentedPath('claude');
    const claudeOk = (() => {
      try {
        execFileSync(claudeBin ?? 'claude', ['--version'], {
          encoding: 'utf8',
          timeout: 8000,
          env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
        });
        return true;
      } catch {
        return false;
      }
    })();
    const authOk = existsSync(`${home}/.claude/.credentials.json`);
    const gitOk = (() => {
      try {
        execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    })();
    const mcpConfigured = existsSync(`${home}/.claude.json`);
    const hasTasks = (deps.db.prepare('SELECT COUNT(*) c FROM tasks WHERE deleted_at IS NULL').get() as any).c > 0;
    return {
      claudeInstalled: claudeOk,
      claudeAuthed: authOk,
      gitInstalled: gitOk,
      mcpDetected: mcpConfigured,
      hasTasks,
      readyToBook: claudeOk && authOk && gitOk,
    };
  });

  // ---- user preferences (notification sound/volume) ----
  app.get('/prefs', async () => readPrefs(deps.dataDir));

  app.put('/prefs', async (req, reply) => {
    const PrefsSchema = z.object({
      soundMode: z.enum(['chime', 'system', 'none']).default('chime'),
      volumePct: z.number().int().min(0).max(100).default(60),
    });
    const parsed = PrefsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'validation' });
    writeFileSync(`${deps.dataDir}/prefs.json`, JSON.stringify(parsed.data, null, 2));
    return readPrefs(deps.dataDir);
  });

  // ---- providers (ADR-026): detect installed CLIs + versions ----
  app.get('/providers', async () => {
    const { execFileSync } = await import('node:child_process');
    const { PROVIDERS } = await import('@clockwork/shared');
    const { resolveOnAugmentedPath, augmentedPath } = await import('@clockwork/runner');
    const out = [];
    for (const p of PROVIDERS) {
      const bin = resolveOnAugmentedPath(p.bin);
      let detected = false;
      let version: string | null = null;
      if (bin) {
        try {
          version = execFileSync(bin, ['--version'], {
            encoding: 'utf8',
            timeout: 8000,
            env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
          }).trim().split('\n')[0] ?? null;
          detected = true;
        } catch {
          detected = false;
        }
      }
      out.push({ id: p.id, label: p.label, bin: p.bin, detected, version, path: bin });
    }
    return out;
  });

  // ---- filesystem browse (repo picker; read-only, home-scoped) ----
  app.get('/fs/browse', async (req, reply) => {
    const { readdirSync, statSync } = await import('node:fs');
    const home = process.env.HOME ?? '/';
    let dir = String((req.query as any).path ?? '').trim() || home;
    try {
      dir = (await import('node:fs')).realpathSync(dir);
    } catch {
      return reply.code(422).send({ error: 'path not found' });
    }
    // Safety: stay under $HOME and never list credential dirs.
    if (!(dir === home || dir.startsWith(home + '/'))) {
      return reply.code(403).send({ error: 'outside home directory' });
    }
    for (const deny of ['.ssh', '.aws', '.gnupg', 'Library/Keychains']) {
      if (dir.includes(deny)) return reply.code(403).send({ error: 'credential directory' });
    }
    let entries: Array<{ name: string; type: 'dir' | 'file'; isGit: boolean }> = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .slice(0, 500)
        .map((e) => {
          let isGit = false;
          try {
            isGit = statSync(`${dir}/${e.name}/.git`).isDirectory();
          } catch {}
          return { name: e.name, type: 'dir' as const, isGit };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      return reply.code(500).send({ error: `unreadable: ${String(e).slice(0, 60)}` });
    }
    return { path: dir, parent: dir !== home ? home + dir.slice(home.length).replace(/\/[^/]+$/, '') || '/' : null, entries };
  });

  // ---- clone a git repo locally so it can be scheduled (FR extension) ----
  app.post('/repos/clone', async (req, reply) => {
    const url = String((req.body as any)?.url ?? '').trim();
    if (!/^https:\/\/[^\s]+|git@[^\s:]+:[^\s]+$/.test(url)) {
      return reply.code(422).send({ error: 'provide an https or ssh git URL' });
    }
    const slug =
      url
        .replace(/\.git$/, '')
        .split(/[/:]/)
        .filter(Boolean)
        .at(-1)!
        .replace(/[^a-zA-Z0-9-_]/g, '-') || 'repo';
    const target = `${process.env.HOME}/.clockwork/repos/${slug}`;
    const { existsSync, mkdirSync } = await import('node:fs');
    if (existsSync(`${target}/.git`)) {
      return { ok: true, alreadyCloned: true, path: target, slug };
    }
    mkdirSync(`${process.env.HOME}/.clockwork/repos`, { recursive: true });
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(
      'git',
      ['clone', '--depth', '1', url, target],
      { encoding: 'utf8', timeout: 180_000, env: { ...process.env } },
    );
    if (r.status !== 0) {
      return reply.code(422).send({
        error: `clone failed: ${(r.stderr ?? '').trim().split('\n').at(-1) ?? 'git error'}`,
      });
    }
    return { ok: true, path: target, slug };
  });

  // ---- usage & limits (capacity samples from live runs; estimate-grade FR-7) ----
  app.get('/usage/status', async () => {
    const rows = deps.db
      .prepare(
        `SELECT at, window_kind, used_pct, source FROM capacity_samples ORDER BY at DESC LIMIT 24`,
      )
      .all() as unknown as Array<{ at: number; window_kind: string | null; used_pct: number | null; source: string }>;
    const byWindow = new Map<string, { at: number; usedPct: number | null; source: string; resetsAt: number | null }>();
    for (const r of rows) {
      const key = r.window_kind ?? 'unknown';
      if (!byWindow.has(key)) {
        byWindow.set(key, {
          at: r.at,
          usedPct: r.used_pct,
          source: r.source,
          resetsAt: null,
        });
      }
    }
    return { windows: [...byWindow.entries()].map(([kind, v]) => ({ kind, ...v })) };
  });

  // ---- SSE (Fastify v5: hijack the reply; the raw response lives on reply.raw) ----
  app.get('/events', (req, reply) => {
    const res = reply.raw;
    reply.hijack();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'daemon.health', connected: true })}\n\n`);
    sseClients.add(reply);
    req.raw.on('close', () => sseClients.delete(reply));
  });

  return { app, token, sseClients };
}

/** FR-5: manual run-now — ad-hoc runs recorded like scheduled ones. */
export function enqueueRunNow(db: DB, taskRow: any): string {
  const now = Date.now();
  const spec = jobSpecForTask(db, taskRow, now);
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for) VALUES (?, ?, ?, 'queued', ?, ?)`,
  ).run(spec.runId, taskRow.id, JSON.stringify(spec), now, now);
  db.prepare('INSERT INTO events (at, run_id, kind, data_json) VALUES (?, ?, ?, ?)').run(now, spec.runId, 'state_changed', JSON.stringify({ to: 'queued', via: 'run-now' }));
  return spec.runId;
}

function jobSpecForTask(db: DB, taskRow: any, now: number) {
  const profile = taskRow.profile_id ? (db.prepare('SELECT * FROM profiles WHERE id=?').get(taskRow.profile_id) as any) : null;
  const slug = slugify(taskRow.name);
  const runId = newId();
  return {
    runId,
    taskId: taskRow.id,
    taskName: taskRow.name,
    taskSlug: slug,
    prompt: taskRow.prompt,
    engine: ((taskRow.engine ?? profile?.engine ?? 'cli') as JobSpec['engine']),
    model: taskRow.model ?? profile?.model ?? null,
    permissionMode: taskRow.permission_mode,
    budget: { maxUsd: taskRow.budget_usd, maxTurns: taskRow.max_turns, timeoutSec: taskRow.timeout_sec },
    repoPath: taskRow.repo_path ?? null,
    baseBranch: taskRow.base_branch ?? null,
    worktreePath: `${process.env.HOME ?? '~'}/.clockwork/worktrees/${slug}/${runId}`,
    branch: branchFor(slug, runId),
    scratchPath: taskRow.repo_path ? null : `${process.env.HOME ?? '~'}/.clockwork/scratch/${runId}`,
    profile: profile
      ? {
          id: profile.id,
          slug: profile.slug,
          name: profile.name,
          color: profile.color ?? null,
          glyph: profile.avatar ?? null,
          systemPromptExtra: profile.system_prompt_extra ?? null,
          skills: JSON.parse(profile.skills_json ?? '[]'),
          contextRoots: JSON.parse(profile.context_roots_json ?? '[]'),
          mcpAllow: JSON.parse(profile.mcp_allow_json ?? '[]'),
        }
      : null,
    contextFiles: JSON.parse(taskRow.context_json ?? '[]'),
    occurrenceAt: null,
    scheduledFor: now,
    createdAt: now,
  };
}

function view(row: any, nextFire: number | null = null): unknown {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    profileId: row.profile_id ?? null,
    repoPath: row.repo_path ?? null,
    baseBranch: row.base_branch ?? null,
    model: row.model ?? null,
    permissionMode: row.permission_mode,
    engine: row.engine ?? null,
    budget: { maxUsd: row.budget_usd, maxTurns: row.max_turns, timeoutSec: row.timeout_sec },
    missedPolicy: row.missed_policy,
    missedWindowSec: row.missed_window_sec,
    overlapPolicy: row.overlap_policy,
    retryOnTransient: Boolean(row.retry_on_transient),
    enabled: Boolean(row.enabled),
    version: row.version,
    nextFire,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** ~/.clockwork/prefs.json — notification sound/volume (validated). */
export function readPrefs(dataDir: string): { soundMode: 'chime' | 'system' | 'none'; volumePct: number } {
  try {
    const raw = JSON.parse(readFileSync(`${dataDir}/prefs.json`, 'utf8'));
    const mode = ['chime', 'system', 'none'].includes(raw?.soundMode) ? raw.soundMode : 'chime';
    const vol = Number.isInteger(raw?.volumePct) ? Math.max(0, Math.min(100, raw.volumePct)) : 60;
    return { soundMode: mode, volumePct: vol };
  } catch {
    return { soundMode: 'chime', volumePct: 60 };
  }
}
