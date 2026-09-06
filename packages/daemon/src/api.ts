/**
 * Daemon API (T-107, arch §6): loopback-only Fastify + SSE, bearer token
 * (generated at install, stored 0600), optimistic task versioning (S-82).
 * The UI is a pure client; anything scriptable here is scriptable by users.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync, writeFileSync, renameSync, realpathSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { ByokStore, validateProvider, keychainGet } from './byok.js';
import { RetentionAudit } from './retention-audit.js';
import { PolicyEngine } from './policy-engine.js';
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
  PROVIDER_KIND_META,
} from '@clockwork/shared';
import type { DB } from './db.js';
import { TaskRepo, ProfileRepo, RunRepo, indexTask } from './repo.js';
import type { RunManager } from './run-manager.js';
import type { Scheduler } from './scheduler.js';
import { nextOccurrenceAfter } from './recurrence.js';
import { isGitRepo } from '@clockwork/runner';
import { loadDeliveryCreds, writeDeliveryCreds, maskBotToken, TelegramChannel, TelegramApiError } from './delivery.js';

export interface ApiDeps {
  db: DB;
  dataDir: string;
  runManager: RunManager;
  scheduler: Scheduler;
  version: string;
  /** Test-only override for the Telegram Bot API base URL (defaults to api.telegram.org). */
  telegramApiBase?: string;
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

/**
 * Mint a replacement token, invalidating the old one immediately.
 *
 * This is remediation, not hygiene. Until the SSE auth fix, /events carried
 * the bearer token in its query string, so an existing token may already be
 * sitting in proxy logs, browser history and Referer headers. Without this a
 * user has no way to replace a credential that grants arbitrary code
 * execution.
 */
/**
 * Constant-time bearer check. A plain `!==` on the token returns as soon as
 * two bytes differ, which leaks a prefix oracle. Not practically exploitable
 * against a 256-bit token over loopback, but the fix is two lines and the
 * daemon is being prepared for exposure beyond loopback.
 *
 * Length is compared first because timingSafeEqual throws on a mismatch; the
 * length of a rejected credential is not a useful secret.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  // S-review (Hermes): an early length return is a timing branch. The token's
  // length is public (43 chars of base64url), so the leaked bit was not a
  // secret — but hashing both sides to a fixed 32 bytes removes the branch
  // altogether and lets timingSafeEqual do the whole comparison.
  const given = createHash('sha256').update(header.slice(7), 'utf8').digest();
  const want = createHash('sha256').update(token, 'utf8').digest();
  return timingSafeEqual(given, want);
}

export function rotateToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const next = randomBytes(32).toString('base64url');
  // S-review (Hermes): writeFileSync is not atomic. A crash mid-write leaves a
  // truncated token file and then NOBODY can authenticate. Write a temp file
  // and rename — rename is atomic within a filesystem.
  const finalPath = path.join(dataDir, 'api-token');
  const tmpPath = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, next, { mode: 0o600 });
  renameSync(tmpPath, finalPath);
  return next;
}

/**
 * Shared $HOME confinement + credential-directory refusal, used by both
 * /fs/browse and POST /calendars/ics/import-path. Extracted so there is
 * exactly one place that decides what a path is allowed to touch — callers
 * translate `reason` into their own route-appropriate status code and
 * wording.
 *
 * Reimport does NOT call this: its sourcePath was already guarded once, at
 * import time, and re-validating a path the daemon itself recorded would
 * only let it silently start ignoring a source whose containing directory
 * later (legitimately) picked up a `.git`-style false positive. It still
 * fails safely — a missing/unreadable file 422s below.
 */
type HomeGuardResult = { ok: true; path: string } | { ok: false; reason: 'not_found' | 'outside_home' | 'credential_dir' };

function guardHomeScopedPath(inputPath: string): HomeGuardResult {
  const home = process.env.HOME ?? '/';
  let real: string;
  try {
    real = realpathSync(inputPath);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (!(real === home || real.startsWith(home + '/'))) {
    return { ok: false, reason: 'outside_home' };
  }
  for (const deny of ['.ssh', '.aws', '.gnupg', 'Library/Keychains']) {
    if (real.includes(deny)) return { ok: false, reason: 'credential_dir' };
  }
  return { ok: true, path: real };
}

// Body-size ceiling for POST /calendars/ics/import: JSON-wrapping a 5 MiB ICS
// payload (ics.ts MAX_ICS_BYTES) adds escaping + envelope overhead, and
// Fastify's own default bodyLimit (1 MiB) would otherwise reject a legitimate
// upload before the route ever runs its own, more specific 422. Route-scoped
// so every other endpoint keeps the stock 1 MiB ceiling.
const IMPORT_BODY_LIMIT = 12 * 1024 * 1024;

/** label precedence: explicit body.label > X-WR-CALNAME > filename w/o extension > fallback. */
function deriveImportLabel(explicit: unknown, calName: string | null, filename: string): string {
  const trimmedExplicit = typeof explicit === 'string' ? explicit.trim() : '';
  if (trimmedExplicit) return trimmedExplicit;
  if (calName && calName.trim()) return calName.trim();
  if (filename) {
    const base = filename.replace(/\.[^./\\]+$/, '').trim();
    if (base) return base;
  }
  return 'Imported calendar';
}

export async function buildServer(deps: ApiDeps): Promise<{ app: FastifyInstance; token: string; sseClients: Set<FastifyReply> }> {
  const app = Fastify({ logger: false });

  // Raw-body capture for webhook signature verification (goal #27 fix): the
  // stock JSON parser only exposes the re-serialized `req.body`, which can
  // differ byte-for-byte from what a sender (e.g. GitHub) signed —
  // pretty-printing, key order, float formatting and unicode escaping all
  // round-trip differently through `JSON.stringify(JSON.parse(x))`. Override
  // the instance-wide `application/json` parser to stash the exact wire
  // string as `req.rawBody` before parsing, so `handleHook` below can HMAC
  // the bytes actually sent. Parsing itself is delegated to Fastify's own
  // default parser (secure-json-parse, same proto/constructor-poisoning
  // guard as the options this app already runs with) so every OTHER route
  // keeps byte-identical parsing/validation behaviour — only the raw string
  // capture is new. Fastify built-ins only; no added dependency.
  const parseDefaultJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    parseDefaultJson(req, body as string, done);
  });

  const tasks = new TaskRepo(deps.db);
  const profiles = new ProfileRepo(deps.db);
  const runs = new RunRepo(deps.db);
  // Governance services (goals #38/#40/#41) — declared early so all routes can use them.
  const retentionAudit = new RetentionAudit(deps.db);
  const policies = new PolicyEngine(deps.db);
  /** Audit helper: record a control-plane mutation with result snapshot. */
  const audit = (action: string, targetType: string | undefined, targetId: string | undefined, detail?: Record<string, unknown>): void => {
    try {
      retentionAudit.log({ at: Date.now(), action, targetType, targetId, detail });
    } catch { /* audit must never break the request path */ }
  };
  /** Policy gate (goal #38): fail-closed evaluation of a prospective job. */
  const evaluatePolicy = (engine: string | null | undefined, byokId: string | null | undefined, budgetUsd: number): { violation: string } | null => {
    const v = policies.evaluate({ engine: engine ?? 'cli', byokId: byokId ?? null, requestedBudgetUsd: budgetUsd });
    return v ? { violation: `${v.code}: ${v.message}` } : null;
  };
  let token = loadOrCreateToken(deps.dataDir);
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
      /^\/(analytics|retention|audit|policies|capabilities|targets|byok|delivery-config|triggers|trigger-events|ics|usage)/.test(url) ||
      /^\/(license|support|auth)\//.test(url) || // S-review: control plane + diagnostics must not be anonymous
      /^\/(calendars|templates)\//.test(url) || // S-audit: ICS export leaks task data; template preview is control plane
      /^\/fs\//.test(url) || // /fs/browse discloses directory AND file names under $HOME — never anonymous
      url.startsWith('/events');
    if (!needsAuth) return; // /health + static UI assets carry no user data
    // S-audit: /events used to accept ?token= because EventSource cannot set
    // headers. A bearer token in a URL reaches proxy logs, browser history and
    // Referer headers — tolerable on loopback, disqualifying for any remote
    // bind (docs/architecture/byo-runner.md). The client now streams /events
    // via fetch + ReadableStream, which does carry a header, so there is no
    // longer a query-param path to authenticate.
    const header = req.headers.authorization;
    if (!bearerMatches(header, token)) {
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

  // ---- support bundle (commercial gauntlet §36): sanitized diagnostics ----
  // Everything needed to debug a user report; NOTHING secret. No API keys
  // (keychain never read here), no tokens, no prompts, no repo contents.
  app.get('/support/bundle', async () => {
    const os = await import('node:os');
    const count = (sql: string): number =>
      (deps.db.prepare(sql).get() as any)?.c ?? 0;
    const providerRows = byok.list().map((p) => ({
      kind: p.kind,
      auth: p.auth,
      connected: Boolean(p.last_validated_at) && !p.last_error,
      lastError: p.last_error ? p.last_error.slice(0, 120) : null, // provider HTTP text only — no credential material
      modelLabel: p.model_label ?? undefined,
    }));
    const engines = await (async () => {
      try {
        const { PROVIDERS } = await import('@clockwork/shared');
        const { resolveOnAugmentedPath } = await import('@clockwork/runner');
        return PROVIDERS.map((pr: { id: string }) => {
          try {
            const bin = resolveOnAugmentedPath(pr.id);
            return { id: pr.id, onPath: Boolean(bin) };
          } catch {
            return { id: pr.id, onPath: false };
          }
        });
      } catch {
        return [];
      }
    })();
    return {
      generatedAt: new Date().toISOString(),
      app: { daemonVersion: deps.version, apiVersion: API_VERSION },
      platform: { os: os.platform(), release: os.release(), arch: os.arch(), node: process.version },
      counts: {
        tasks: count("SELECT COUNT(*) c FROM tasks WHERE deleted_at IS NULL"),
        runs: count('SELECT COUNT(*) c FROM runs'),
        triggers: count('SELECT COUNT(*) c FROM triggers'),
        providersConfigured: providerRows.length,
      },
      scheduling: { paused },
      providers: providerRows,
      engines,
      entitlement: entitlements.status(),
      notes: [
        'This bundle contains no credentials: API keys live in the macOS Keychain and are never read into diagnostics.',
        'Run reports/transcripts stay local unless you attach them yourself.',
      ],
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
    // S-72: chain validation at creation too (linear, no cycles, one successor)
    if (parsed.data.chainAfter) {
      const { validateChain } = await import('./templates.js');
      const cerr = validateChain(deps.db, '', parsed.data.chainAfter === '' ? null : parsed.data.chainAfter);
      if (cerr && !cerr.includes('not found')) {
        // empty taskId only skips the self-check; cycle/child rules still apply
        if (cerr.includes('cycle') || cerr.includes('successor')) return reply.code(422).send({ error: cerr });
      }
    }
    // Policy gate (goal #38): reject policy-violating tasks at creation.
    const pv = evaluatePolicy(parsed.data.engine, parsed.data.byokId, parsed.data.budget.maxUsd);
    if (pv) {
      audit('task.create_rejected', 'task', undefined, { ...pv, name: parsed.data.name });
      return reply.code(403).send(pv);
    }
    const row = tasks.create(parsed.data, v.profileId, v.nextFire);
    indexTask(deps.db, row.id, row.name, row.prompt);
    audit('task.create', 'task', row.id, { name: row.name, engine: parsed.data.engine ?? null, byokId: parsed.data.byokId ?? null });
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
    // Policy gate on edits that change engine/byok/budget.
    const pvEdit = evaluatePolicy(
      parsed.data.engine ?? (res as unknown as { engine?: string }).engine ?? undefined,
      'byokId' in parsed.data ? ((parsed.data as unknown as { byokId?: string }).byokId ?? undefined) : undefined,
      parsed.data.budget?.maxUsd ?? res.budget_usd,
    );
    if (pvEdit) {
      audit('task.update_rejected', 'task', res.id, { ...pvEdit });
      return reply.code(403).send(pvEdit);
    }
    audit('task.update', 'task', res.id, { fields: Object.keys(parsed.data) });
    broadcast({ type: 'task.changed', taskId: res.id, at: Date.now() });
    const s = tasks.scheduleFor(res.id);
    return view(res, s?.next_fire ?? null);
  });

  app.delete('/tasks/:id', async (req, reply) => {
    const ok = tasks.softDelete((req.params as any).id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    audit('task.delete', 'task', String((req.params as any).id));
    return { deleted: true }; // S-6: soft delete; in-flight run completes, history retained
  });

  app.post('/tasks/:id/run-now', async (req, reply) => {
    const row = tasks.get((req.params as any).id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const runId = enqueueRunNow(deps.db, row);
    audit('run.enqueue', 'run', runId, { taskId: row.id, taskName: row.name, via: 'run-now' });
    deps.runManager.pump();
    return reply.code(202).send({ runId });
  });

  // ---- event triggers (goal #27): EVENT -> RULE -> AGENT ----
  {
    const { hashSecret, verifyGithubSignature, verifyWebhookSecret, matchesFilter } = await import('./triggers.js');
    const newTriggerId = (): string => `trg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const newEventId = (): string => `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    app.get('/triggers', async () => {
      const rows = deps.db.prepare('SELECT * FROM triggers ORDER BY created_at DESC').all() as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        source: r.source,
        filter: r.filter_json ? JSON.parse(String(r.filter_json)) : null,
        hasSecret: Boolean(r.secret_hash),
        taskId: r.task_id,
        enabled: Boolean(r.enabled),
        createdAt: r.created_at,
      }));
    });

    app.post('/triggers', async (req, reply) => {
      const b = req.body as any;
      const name = String(b?.name ?? '').trim();
      const source = String(b?.source ?? 'webhook');
      const taskId = String(b?.taskId ?? '');
      if (!name || !taskId) return reply.code(422).send({ error: 'name and taskId required' });
      if (!['webhook', 'github'].includes(source)) return reply.code(422).send({ error: 'invalid source' });
      if (!tasks.get(taskId)) return reply.code(404).send({ error: 'task not found' });
      // Entitlement (gauntlet §7): free tier caps event triggers ("2 triggers").
      const triggerCap = entitlements.limitFor('event_triggers');
      if (triggerCap !== undefined) {
        const count = (deps.db.prepare('SELECT COUNT(*) c FROM triggers').get() as any).c as number;
        if (count >= triggerCap) {
          return reply.code(402).send({
            error: `The free plan includes ${triggerCap} event triggers; you have ${count}. Clockwork Pro raises the cap to 50.`,
            feature: 'event_triggers',
            requiresPlan: entitlements.gate('event_triggers').requiresPlan,
          });
        }
      }
      const id = newTriggerId();
      const secret = typeof b?.secret === 'string' && b.secret.length >= 8 ? b.secret : null;
      deps.db
        .prepare(
          `INSERT INTO triggers (id, name, source, filter_json, secret_hash, task_id, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(id, name.slice(0, 120), source, b?.filter ? JSON.stringify(b.filter) : null, secret ? hashSecret(secret) : null, taskId, Date.now());
      audit('trigger.create', 'trigger', id, { name, source, taskId, authenticated: Boolean(secret) });
      // Return the plaintext URL token exactly once — it is hashed at rest.
      return reply.code(201).send({ id, secret: secret ?? undefined, webhookPath: `/hooks/${id}` });
    });

    app.patch('/triggers/:id', async (req, reply) => {
      const row = deps.db.prepare('SELECT * FROM triggers WHERE id=?').get((req.params as any).id) as any;
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const b = req.body as any;
      if (typeof b.enabled === 'boolean') {
        deps.db.prepare('UPDATE triggers SET enabled=? WHERE id=?').run(b.enabled ? 1 : 0, row.id);
        audit('trigger.update', 'trigger', row.id, { enabled: b.enabled });
      }
      return { ok: true };
    });

    app.delete('/triggers/:id', async (req, reply) => {
      const row = deps.db.prepare('SELECT id FROM triggers WHERE id=?').get((req.params as any).id) as any;
      if (!row) return reply.code(404).send({ error: 'not_found' });
      deps.db.prepare('DELETE FROM triggers WHERE id=?').run(row.id);
      audit('trigger.delete', 'trigger', row.id, {});
      return reply.code(204).send();
    });

    app.get('/trigger-events', async (req) => {
      const limit = Math.min(200, Math.max(1, parseInt(String((req.query as any)?.limit ?? '50'), 10) || 50));
      const rows = deps.db
        .prepare('SELECT * FROM trigger_events ORDER BY at DESC LIMIT ?')
        .all(limit) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({ ...r, payload: JSON.parse(String(r.payload)), matched: Boolean(r.matched) }));
    });

    // The public hook endpoint. Auth is enforced per-trigger when a secret is set.
    const handleHook = async (req: any, reply: any) => {
      const triggerId = req.params.id;
      // Prefer the exact wire bytes captured by the content-type parser
      // registered near the top of buildServer, so the HMAC covers what the
      // sender actually signed. Falls back to the pre-fix re-serialization
      // only when there is no rawBody — i.e. a non-JSON content type such as
      // text/plain, which Fastify's other built-in parser already hands us
      // as a string body directly (no re-serialization risk there).
      const raw = typeof req.rawBody === 'string' ? req.rawBody : typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      let payload: unknown;
      try {
        payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      } catch {
        payload = null;
      }
      const now = Date.now();

      const respond = (code: number, body: Record<string, unknown>, matched: boolean, note?: string, runId?: string): unknown => {
        deps.db
          .prepare(
            `INSERT INTO trigger_events (id, trigger_id, source, payload, matched, run_id, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(newEventId(), triggerId, 'webhook-or-github', raw, matched ? 1 : 0, runId ?? null, note ?? null, now);
        return reply.code(code).send(body);
      };

      const trg = deps.db.prepare('SELECT * FROM triggers WHERE id=?').get(triggerId) as any;
      if (!trg) return respond(404, { error: 'unknown trigger' }, false, 'unknown_trigger');
      if (!trg.enabled) return respond(409, { error: 'trigger disabled' }, false, 'disabled');

      const src = String(trg.source);
      const sig = req.headers['x-hub-signature-256'] as string | undefined;
      if (src === 'github') {
        // S-audit fix (fail closed): GitHub signatures can only be verified
        // against a plaintext secret via CLOCKWORK_GITHUB_WEBHOOK_SECRET.
        // With no secret configured there is NO verification path — a request
        // carrying any self-asserted header previously passed both checks and
        // fired the task. Now: reject regardless of header presence.
        const envSecret = process.env.CLOCKWORK_GITHUB_WEBHOOK_SECRET;
        if (!envSecret) {
          return respond(503, { error: 'github trigger has no verification secret configured' }, false, 'server_not_configured');
        }
        if (!verifyGithubSignature(raw, sig, envSecret)) {
          return respond(401, { error: 'bad signature' }, false, 'bad_signature');
        }
      } else if (trg.secret_hash && !verifyWebhookSecret(req.headers['x-clockwork-secret'] as string | undefined, String(trg.secret_hash))) {
        return respond(401, { error: 'bad secret' }, false, 'bad_secret');
      }

      if (!matchesFilter(payload, trg.filter_json ? String(trg.filter_json) : null)) {
        return respond(200, { ok: true, fired: false, reason: 'filter_not_matched' }, false, 'filter_not_matched');
      }

      const taskRow = tasks.get(String(trg.task_id));
      if (!taskRow) return respond(410, { error: 'task deleted' }, false, 'task_deleted');

      // Policy gate before firing — same rules as manual run-now.
      const pv = evaluatePolicy((taskRow as any).engine ?? null, (taskRow as any).byok_id ?? null, Number(taskRow.budget_usd ?? 2));
      if (pv) return respond(403, { error: 'policy', ...pv }, false, 'policy_violation');

      const runId = enqueueRunNow(deps.db, taskRow);
      // Stash the event payload into the run's spec so prompts can use {{event.*}}.
      try {
        const specRow = deps.db.prepare('SELECT jobspec_json FROM runs WHERE id=?').get(runId) as any;
        if (specRow) {
          const spec = JSON.parse(specRow.jobspec_json);
          spec.event = { source: src, payload, at: now };
          deps.db.prepare('UPDATE runs SET jobspec_json=? WHERE id=?').run(JSON.stringify(spec), runId);
        }
      } catch { /* non-fatal */ }
      audit('run.enqueue', 'run', runId, { taskId: taskRow.id, taskName: taskRow.name, via: `trigger:${src}` });
      deps.runManager.pump();
      return respond(202, { ok: true, fired: true, runId }, true, undefined, runId);
    };

    // Signature verification uses `req.rawBody` set by the content-type
    // parser above; there is no route-level raw-body option in Fastify (the
    // `{ config: { rawBody: true } }` this line used to carry was a no-op —
    // see docs/triggers.md for the history).
    app.post('/hooks/:id', handleHook);
  }

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
    const decision: import('./run-manager.js').ApprovalDecision = body?.decision === 'approved' ? 'approved' : 'denied';
    // Reachable approvals (ADR-036): CAS/forwarding/broadcast/journal all live
    // in RunManager.respondToApproval — the Telegram inline-keyboard path
    // (telegram-approvals.ts) calls the exact same function, so both surfaces
    // behave identically.
    const result = deps.runManager.respondToApproval(id, decision, { kind: 'api' }, body);
    switch (result.status) {
      case 'not_found':
        return reply.code(404).send({ error: 'not_found' });
      case 'already_resolved':
        return reply.code(409).send({ error: 'already_resolved' });
      case 'resolved':
      case 'run_gone':
        return { resolved: true, forwarded: result.forwarded };
    }
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

    // Human events from calendar sources (read-only; never written to). A
    // `url` source is re-fetched live; a `file` source is a frozen import —
    // it is re-parsed from the stored copy and MUST NOT trigger a fetch.
    let humans: Array<{ uid: string; name: string; at: number; allDay: boolean }> = [];
    try {
      const { loadIcsSources, fetchIcs, readIcsImport, parseIcs } = await import('./ics.js');
      const sources = loadIcsSources(deps.dataDir);
      const seen = new Set<string>();
      for (const src of sources) {
        try {
          let events: Array<{ uid: string; summary: string; startMs: number; allDay: boolean }> | undefined;
          if (src.kind === 'file') {
            const text = readIcsImport(deps.dataDir, src.id);
            if (text == null) continue;
            events = parseIcs(text);
          } else {
            if (!src.url) continue;
            const res = await fetchIcs(src.url);
            if (!res.ok || !res.events) continue;
            events = res.events;
          }
          for (const ev of events) {
            if (ev.startMs < from || ev.startMs > to) continue;
            if (seen.has(ev.uid)) continue;
            seen.add(ev.uid);
            humans.push({ uid: ev.uid, name: ev.summary, at: ev.startMs, allDay: ev.allDay });
          }
        } catch {
          /* one bad feed/import must not break the calendar */
        }
      }
      humans.sort((a, b) => a.at - b.at);
    } catch {
      /* ICS overlay is best-effort */
    }

    return { from, to, runs: runRows, bookings, humans };
  });

  // ---- ICS calendar sources (read-only subscriptions + frozen file imports; Settings → Calendars) ----
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
    sources.push({
      id, kind: 'url', url, label,
      importedAt: null, eventCount: null, sourcePath: null, sourceName: null,
    });
    saveIcsSources(deps.dataDir, sources);
    return { id, label, url, events: probe.events?.length ?? 0 };
  });

  // Upload: the browser reads the file and posts its text. Frozen snapshot —
  // re-import (re-upload) is the only way to refresh it, since there is no
  // path on this machine to re-read from.
  app.post('/calendars/ics/import', { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const body = req.body as any;
    const content = typeof body?.content === 'string' ? body.content : '';
    if (!content) return reply.code(422).send({ error: 'no calendar content was provided' });
    const { validateAndParseIcs, loadIcsSources, saveIcsSources, writeIcsImport } = await import('./ics.js');
    const result = validateAndParseIcs(content);
    if (!result.ok) return reply.code(422).send({ error: result.error });
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : '';
    const label = deriveImportLabel(body?.label, result.calName ?? null, filename);
    const id = `ics_${newId()}`;
    writeIcsImport(deps.dataDir, id, content);
    const importedAt = Date.now();
    const eventCount = result.events?.length ?? 0;
    const sources = loadIcsSources(deps.dataDir);
    sources.push({
      id, kind: 'file', url: null, label,
      importedAt, eventCount, sourcePath: null, sourceName: filename || null,
    });
    saveIcsSources(deps.dataDir, sources);
    return reply.code(201).send({ id, kind: 'file', label, eventCount, importedAt });
  });

  // Import-path: the daemon reads the file itself (so it can be re-imported
  // later). Confined to $HOME, refuses credential directories — same guard
  // /fs/browse uses to decide what may even be listed.
  app.post('/calendars/ics/import-path', async (req, reply) => {
    const body = req.body as any;
    const inputPath = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!inputPath) return reply.code(422).send({ error: 'no path was provided' });
    if (!/\.(ics|ical)$/i.test(inputPath)) {
      return reply.code(422).send({ error: 'only .ics or .ical files can be imported' });
    }
    const guard = guardHomeScopedPath(inputPath);
    if (!guard.ok) {
      if (guard.reason === 'not_found') return reply.code(422).send({ error: 'that file does not exist' });
      if (guard.reason === 'outside_home') {
        return reply.code(403).send({ error: 'that path is outside your home folder — only files under $HOME can be imported' });
      }
      return reply.code(403).send({ error: 'that path is inside a credential directory and cannot be imported' });
    }
    // Re-test the extension on the RESOLVED path: `~/x.ics` may be a symlink to
    // `~/notes.txt`, and the pre-guard check only saw what the caller typed.
    if (!/\.(ics|ical)$/i.test(guard.path)) {
      return reply.code(422).send({ error: 'only .ics or .ical files can be imported' });
    }
    const { MAX_ICS_BYTES } = await import('./ics.js');
    // Check the size before reading. validateAndParseIcs also enforces the
    // ceiling, but only once the whole file is already in memory — a 400 MB
    // file under $HOME would be allocated in full just to be refused.
    try {
      const st = statSync(guard.path);
      if (!st.isFile()) return reply.code(422).send({ error: 'that path is not a file' });
      if (st.size > MAX_ICS_BYTES) {
        return reply.code(422).send({ error: 'that file is larger than 5 MiB — export a smaller date range and try again' });
      }
    } catch {
      return reply.code(422).send({ error: 'that file does not exist' });
    }
    let content: string;
    try {
      content = readFileSync(guard.path, 'utf8');
    } catch (e) {
      return reply.code(422).send({ error: `could not read that file: ${String((e as Error).message ?? e).slice(0, 100)}` });
    }
    const { validateAndParseIcs, loadIcsSources, saveIcsSources, writeIcsImport } = await import('./ics.js');
    const result = validateAndParseIcs(content);
    if (!result.ok) return reply.code(422).send({ error: result.error });
    const filename = path.basename(guard.path);
    const label = deriveImportLabel(body?.label, result.calName ?? null, filename);
    const id = `ics_${newId()}`;
    writeIcsImport(deps.dataDir, id, content);
    const importedAt = Date.now();
    const eventCount = result.events?.length ?? 0;
    const sources = loadIcsSources(deps.dataDir);
    sources.push({
      id, kind: 'file', url: null, label,
      importedAt, eventCount, sourcePath: guard.path, sourceName: filename,
    });
    saveIcsSources(deps.dataDir, sources);
    return reply.code(201).send({ id, kind: 'file', label, eventCount, importedAt });
  });

  // Re-import: re-read sourcePath and replace the stored copy. Only possible
  // for a file source that was imported FROM a path — an uploaded file has
  // no path on this machine to go back to.
  app.post('/calendars/ics/:id/reimport', async (req, reply) => {
    const id = String((req.params as any).id ?? '');
    const { loadIcsSources, saveIcsSources, writeIcsImport, validateAndParseIcs, MAX_ICS_BYTES } = await import('./ics.js');
    const sources = loadIcsSources(deps.dataDir);
    const idx = sources.findIndex((s) => s.id === id);
    if (idx === -1) return reply.code(404).send({ error: 'calendar source not found' });
    const src = sources[idx]!;
    if (src.kind !== 'file') {
      return reply.code(409).send({ error: 'this is a live subscription, not an imported file — there is nothing to re-import' });
    }
    if (!src.sourcePath) {
      return reply.code(409).send({ error: 'this calendar was uploaded, not read from a file on disk — import the file again to refresh it' });
    }
    let content: string;
    try {
      // Same pre-read size guard as import-path: the file may have grown
      // since it was first imported.
      const st = statSync(src.sourcePath);
      if (st.size > MAX_ICS_BYTES) {
        return reply.code(422).send({ error: 'that file is now larger than 5 MiB — export a smaller date range and import it again' });
      }
      content = readFileSync(src.sourcePath, 'utf8');
    } catch {
      return reply.code(422).send({ error: 'that file no longer exists at its original location' });
    }
    const result = validateAndParseIcs(content);
    if (!result.ok) return reply.code(422).send({ error: result.error });
    writeIcsImport(deps.dataDir, id, content);
    const importedAt = Date.now();
    const eventCount = result.events?.length ?? 0;
    sources[idx] = { ...src, eventCount, importedAt };
    saveIcsSources(deps.dataDir, sources);
    return { id, eventCount, importedAt };
  });

  app.delete('/calendars/ics/:id', async (req) => {
    const { loadIcsSources, saveIcsSources, deleteIcsImport } = await import('./ics.js');
    const id = String((req.params as any).id ?? '');
    const remaining = loadIcsSources(deps.dataDir).filter((s) => s.id !== id);
    saveIcsSources(deps.dataDir, remaining);
    deleteIcsImport(deps.dataDir, id);
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
    // Commercial onboarding (gauntlet §32/33): surface provider readiness too.
    let byokCount = 0;
    try {
      byokCount = (deps.db.prepare('SELECT COUNT(*) c FROM byok_configs').get() as any).c > 0
        ? (deps.db.prepare('SELECT COUNT(*) c FROM byok_configs').get() as any).c
        : 0;
    } catch { /* table not created yet */ }
    return {
      claudeInstalled: claudeOk,
      claudeAuthed: authOk,
      gitInstalled: gitOk,
      mcpDetected: mcpConfigured,
      hasTasks,
      readyToBook: claudeOk && authOk && gitOk,
      hasProvider: byokCount > 0 || (claudeOk && authOk),
      byokCount,
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

  // ---- delivery credentials (Telegram bot token / webhook HMAC secret) ----
  app.get('/delivery-config', async () => readDeliveryConfigStatus(deps.dataDir));

  app.put('/delivery-config', async (req, reply) => {
    const DeliveryCredsSchema = z.object({
      telegramBotToken: z.union([z.string(), z.null()]).optional(),
      webhookSecret: z.union([z.string(), z.null()]).optional(),
    });
    const parsed = DeliveryCredsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'validation' });
    writeDeliveryCreds(deps.dataDir, parsed.data);
    audit('delivery-config.update', 'delivery-config', undefined, {
      telegramBotToken: 'telegramBotToken' in parsed.data ? (parsed.data.telegramBotToken === null ? 'cleared' : 'set') : 'unchanged',
      webhookSecret: 'webhookSecret' in parsed.data ? (parsed.data.webhookSecret === null ? 'cleared' : 'set') : 'unchanged',
    });
    return readDeliveryConfigStatus(deps.dataDir);
  });

  app.post('/delivery-config/test-telegram', async (req, reply) => {
    const TestSchema = z.object({ chatId: z.string().min(1) });
    const parsed = TestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'validation' });
    const creds = loadDeliveryCreds(deps.dataDir);
    if (!creds.telegramBotToken) return reply.send({ ok: false, error: 'no bot token configured' });
    const ch = new TelegramChannel(deps.telegramApiBase);
    try {
      await ch.sendTest(parsed.data.chatId, creds);
      return reply.send({ ok: true });
    } catch (e) {
      let msg = e instanceof TelegramApiError ? (e.description ?? e.message) : e instanceof Error ? e.message : String(e);
      // Belt-and-braces: the request URL embeds the token, so scrub it from
      // the error even though it shouldn't be able to reach here (network
      // errors / a misbehaving stub could still echo the URL back).
      if (creds.telegramBotToken) msg = msg.split(creds.telegramBotToken).join('[redacted]');
      return reply.send({ ok: false, error: msg.slice(0, 200) });
    }
  });

  // ---- cost & reliability analytics (ADR-029) ----
  app.get('/analytics', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const to = q.to ? parseInt(String(q.to), 10) : Date.now();
    const days = Math.min(180, Math.max(1, parseInt(String(q.days ?? '30'), 10)));
    const from = to - days * 86_400_000;

    const rows = deps.db
      .prepare(
        `SELECT task_id, state, outcome_reason, started_at, ended_at, cost_usd, turns, jobspec_json
         FROM runs
         WHERE COALESCE(ended_at, scheduled_for) BETWEEN ? AND ?`,
      )
      .all(from, to) as unknown as Array<Record<string, unknown>>;

    type TaskAgg = { taskId: string; name: string; runs: number; completed: number; failed: number; costUsd: number; turns: number; durationMs: number };
    const byTask = new Map<string, TaskAgg>();
    const byEngine = new Map<string, { engine: string; runs: number; completed: number; failed: number; costUsd: number }>();
    let totalRuns = 0;
    let totalCompleted = 0;
    let totalFailed = 0;
    let totalCostUsd = 0;
    let totalTurns = 0;
    const daily = new Map<string, { day: string; runs: number; costUsd: number }>();

    for (const r of rows) {
      totalRuns += 1;
      const state = String(r.state);
      const isDone = state === 'completed';
      const isFail = state === 'failed' || state === 'timed_out';
      if (isDone) totalCompleted += 1;
      if (isFail) totalFailed += 1;
      const cost = Number(r.cost_usd ?? 0);
      totalCostUsd += cost;
      const turns = Number(r.turns ?? 0);
      totalTurns += turns;
      const dur = Number(r.ended_at && r.started_at ? (r.ended_at as number) - (r.started_at as number) : 0);

      const spec = safeParseSpec(r.jobspec_json);
      const name = String(spec.taskName ?? 'unknown');
      const engFromSpec = String(spec.engine ?? 'cli');
      const day = new Date(Number(r.ended_at ?? r.scheduled_for)).toISOString().slice(0, 10);

      const t = byTask.get(String(r.task_id)) ?? { taskId: String(r.task_id), name, runs: 0, completed: 0, failed: 0, costUsd: 0, turns: 0, durationMs: 0 };
      t.runs += 1; if (isDone) t.completed += 1; if (isFail) t.failed += 1;
      t.costUsd += cost; t.turns += turns; t.durationMs += dur;
      byTask.set(String(r.task_id), t);

      const engKey = engFromSpec + (spec.byokId ? ':byok' : '');
      const e = byEngine.get(engKey) ?? { engine: engKey, runs: 0, completed: 0, failed: 0, costUsd: 0 };
      e.runs += 1; if (isDone) e.completed += 1; if (isFail) e.failed += 1; e.costUsd += cost;
      byEngine.set(engKey, e);

      const d = daily.get(day) ?? { day, runs: 0, costUsd: 0 };
      d.runs += 1; d.costUsd += cost;
      daily.set(day, d);
    }

    const tasksOut = [...byTask.values()]
      .sort((a, b) => b.costUsd - a.costUsd)
      .map((t) => ({ ...t, costUsd: round4(t.costUsd), successRate: t.runs ? Math.round((t.completed / t.runs) * 100) : 0, avgDurationMs: t.runs ? Math.round(t.durationMs / t.runs) : 0 }));
    const enginesOut = [...byEngine.values()].map((e) => ({ ...e, costUsd: round4(e.costUsd), successRate: e.runs ? Math.round((e.completed / e.runs) * 100) : 0 }));

    // ---- cost optimization suggestions (goal #35) ----
    const suggestions: Array<{ taskName: string; kind: string; message: string }> = [];

    for (const t of byTask.values()) {
      const avgCost = t.runs ? t.costUsd / t.runs : 0;
      // High-spend + high-failure: the worst combination — money for nothing.
      if (t.failed >= 3 && t.failed > t.completed && t.costUsd > 0.05) {
        suggestions.push({
          taskName: t.name,
          kind: 'failing_task',
          message: `“${t.name}” failed ${t.failed} of ${t.runs} runs ($${round4(t.costUsd)} spent). Fix or pause it before it burns more budget.`,
        });
      }
      // Expensive per-run tasks: suggest a cheaper model profile.
      if (t.completed >= 3 && avgCost > 0.5) {
        suggestions.push({
          taskName: t.name,
          kind: 'cheaper_model',
          message: `“${t.name}” averages $${round4(avgCost)} per successful run. A smaller model (e.g. a Haiku/mini-class) often handles routine jobs at 60–80% lower cost.`,
        });
      }
      // Turn-hungry tasks: prompt scoping suggestion.
      if (t.turns / Math.max(1, t.runs) > 40 && t.completed < t.runs) {
        suggestions.push({
          taskName: t.name,
          kind: 'prompt_scoping',
          message: `“${t.name}” averages ${Math.round(t.turns / t.runs)} turns/run and has failures. Narrowing the prompt scope usually cuts turns dramatically.`,
        });
      }
    }
    suggestions.sort((a, b) => b.kind.localeCompare(a.kind));

    return reply.send({
      range: { from, to, days },
      totals: {
        runs: totalRuns,
        completed: totalCompleted,
        failed: totalFailed,
        successRate: totalRuns ? Math.round((totalCompleted / totalRuns) * 100) : 0,
        costUsd: round4(totalCostUsd),
        turns: totalTurns,
        avgCostPerRun: totalRuns ? round4(totalCostUsd / totalRuns) : 0,
      },
      byTask: tasksOut,
      byProvider: enginesOut,
      daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, costUsd: round4(d.costUsd) })),
      suggestions,
    });
  });

  // ---- providers (ADR-026): detect installed CLIs + versions ----

  app.get('/retention', async () => retentionAudit.getPrefs());

  app.put('/retention', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      // Entitlement (gauntlet §7/§6): free tier keeps history windows within
      // its registry limit ("30 days"); paid tiers may extend.
      const cap = entitlements.limitFor('retention');
      let runDays = b.runDays === null || b.runDays === undefined ? null : Number(b.runDays);
      if (runDays !== null && cap !== undefined) {
        if (runDays > cap) {
          return reply.code(402).send({
            error: `The free plan keeps history up to ${cap} days. Clockwork Pro extends retention.`,
            feature: 'retention',
            requiresPlan: entitlements.gate('retention').requiresPlan,
          });
        }
      }
      retentionAudit.setPrefs(
        runDays,
        b.maxRuns === null || b.maxRuns === undefined ? null : Number(b.maxRuns),
      );
      audit('retention.update', 'settings', 'retention', { runDays: b.runDays ?? null, maxRuns: b.maxRuns ?? null });
      return retentionAudit.getPrefs();
    } catch (e) {
      return reply.code(422).send({ error: String((e as Error).message ?? e) });
    }
  });

  app.post('/retention/sweep', async () => {
    const deleted = retentionAudit.sweep();
    audit('retention.sweep', 'settings', 'retention', { deleted });
    return { deleted };
  });

  app.get('/audit', async (_req, reply) => {
    // Entitlement (gauntlet §7): audit log is a governance feature.
    const gate = entitlements.gate('audit_log');
    if (!gate.allowed) {
      return reply.code(402).send({
        error: `The audit log is included with Clockwork ${gate.requiresPlan}. Your run history stays fully intact — this only controls the tamper-evident event ledger.`,
        feature: 'audit_log',
        requiresPlan: gate.requiresPlan,
      });
    }
    const q = _req.query as Record<string, string>;
    const limit = Math.min(500, Math.max(1, parseInt(String(q.limit ?? '200'), 10)));
    const offset = Math.max(0, parseInt(String(q.offset ?? '0'), 10));
    return { entries: retentionAudit.list(limit, offset) };
  });

  // ---- policy engine (goal #38): enterprise guardrails ----
  app.get('/policies', async (_req, reply) => {
    const gate = entitlements.gate('policy_engine');
    if (!gate.allowed) {
      return reply.code(402).send({
        error: `Policy guardrails are included with Clockwork ${gate.requiresPlan}.`,
        feature: 'policy_engine',
        requiresPlan: gate.requiresPlan,
      });
    }
    return policies.get();
  });

  // ---- capability matrix (goal #43): honest feature gating ----
  app.get('/capabilities', async () => {
    const { capabilityMatrix, getTier } = await import('./features.js');
    return { tier: getTier(), features: capabilityMatrix(), entitlement: entitlements.status() };
  });

  // ---- license activation / deactivation (commercial gauntlet §8-10) ----
  app.post('/license/activate', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof b.token === 'string' ? b.token.trim() : '';
    if (!token) return reply.code(422).send({ error: 'Paste the license key from your purchase receipt.' });
    try {
      const claims = entitlements.activate(token);
      audit('license.activate', 'entitlement', claims.sub, { plan: claims.plan });
      broadcast({ type: 'entitlement', entitlement: entitlements.status() });
      return { ok: true, entitlement: entitlements.status() };
    } catch (e) {
      return reply.code(422).send({ error: String((e as Error).message ?? e) });
    }
  });

  app.post('/license/deactivate', async () => {
    audit('license.deactivate', 'entitlement', undefined, {});
    entitlements.deactivate();
    broadcast({ type: 'entitlement', entitlement: entitlements.status() });
    return { ok: true };
  });

  // ---- execution targets (goals #12/#15): local + docker now, cloud later ----
  app.get('/targets', async () => {
    const { isDockerAvailable } = await import('@clockwork/runner');
    const docker = await isDockerAvailable();
    return {
      targets: [
        { id: 'local', label: 'This Mac (sandboxed worktree)', available: true },
        { id: 'docker', label: 'Ephemeral container (isolated FS/network)', available: docker },
      ],
      default: 'local',
    };
  });

  // ---- credential rotation ----
  // Remediation for a credential that may already be exposed: until the SSE
  // auth fix, /events carried the bearer token in its query string, so it can
  // be sitting in proxy logs and browser history. Rotation is also the only
  // revocation this single-token model has.
  app.post('/auth/rotate', async (_req, reply) => {
    try {
      token = rotateToken(deps.dataDir);
      // S-review (Hermes): rotation had no trace. Record that it happened —
      // never the token itself, not even a prefix.
      process.stdout.write(`clockworkd: api token rotated at ${new Date().toISOString()}\n`);
      // Every existing client — including this one's event stream — is now
      // unauthenticated by design. The caller receives the replacement so it
      // can re-authenticate; nobody else can.
      return await reply.send({ token });
    } catch (e) {
      return await reply.code(500).send({ error: 'rotate_failed', detail: (e as Error).message });
    }
  });

  app.put('/policies', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      policies.set({
        ...(Array.isArray(b.allowedEngines) ? { allowedEngines: b.allowedEngines as string[] } : {}),
        ...(b.maxCostPerRunUsd !== undefined ? { maxCostPerRunUsd: b.maxCostPerRunUsd as number | null } : {}),
        ...(b.requireApprovalOverUsd !== undefined ? { requireApprovalOverUsd: b.requireApprovalOverUsd as number | null } : {}),
      });
      audit('policy.update', 'settings', 'policies', { ...b });
      return policies.get();
    } catch (e) {
      return reply.code(422).send({ error: String((e as Error).message ?? e) });
    }
  });


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

  // ---- BYOK provider configs (ADR-027) ----
  const byok = new ByokStore({ db: deps.db });
  const { EntitlementService } = await import('./entitlements.js');
  const entitlements = new EntitlementService(deps.db);

  app.get('/byok', async () => {
    return { configs: byok.list(), meta: PROVIDER_KIND_META };
  });

  app.post('/byok', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const cfg = byok.create({
        kind: String(b.kind ?? '') as never,
        label: typeof b.label === 'string' && b.label.trim() ? b.label.trim() : undefined,
        baseUrl: typeof b.base_url === 'string' && b.base_url.trim() ? b.base_url.trim() : undefined,
        auth: b.auth === 'env' ? 'env' : 'keychain',
        secret: typeof b.secret === 'string' ? b.secret : undefined,
        envVar: typeof b.env_var === 'string' ? b.env_var : undefined,
        defaultModel: String(b.default_model ?? ''),
        modelLabel: typeof b.model_label === 'string' && b.model_label.trim() ? b.model_label.trim().slice(0, 60) : undefined,
      });
      // optional immediate validation
      if (b.validate_now !== false && cfg.auth === 'keychain') {
        const err = await validateProvider(cfg.kind, byok.baseUrlFor(cfg), keychainGet(cfg.id));
        byok.markValidated(cfg.id, err ?? null);
      }
      return reply.code(201).send(byok.get(cfg.id));
    } catch (e) {
      return reply.code(422).send({ error: String((e as Error).message ?? e) });
    }
  });

  app.post('/byok/:id/rotate', async (req, reply) => {
    try {
      const secret = String(((req.body ?? {}) as Record<string, unknown>).secret ?? '');
      const hint = byok.rotateKey(String((req.params as any).id), secret);
      return { ok: true, hint };
    } catch (e) {
      return reply.code(422).send({ error: String((e as Error).message ?? e) });
    }
  });

  app.post('/byok/:id/test', async (req, reply) => {
    const cfg = byok.get(String((req.params as any).id));
    if (!cfg) return reply.code(404).send({ error: 'not found' });
    let err: string | undefined;
    try {
      err = await validateProvider(cfg.kind, byok.baseUrlFor(cfg), byok.resolveCredential(cfg));
    } catch (e) {
      err = String((e as Error).message ?? e);
    }
    byok.markValidated(cfg.id, err ?? null);
    return { ok: !err, error: err ?? null, validated_at: Date.now() };
  });

  app.delete('/byok/:id', async (req, reply) => {
    byok.delete(String((req.params as any).id));
    return reply.code(204).send();
  });

  app.post('/byok/validate', async (req, reply) => {
    // Dry-run credential check used by the connect flow BEFORE anything is saved.
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = String(b.kind ?? '') as keyof typeof PROVIDER_KIND_META;
    if (!PROVIDER_KIND_META[kind]) return reply.code(422).send({ error: 'unknown provider kind' });
    const baseUrl = typeof b.base_url === 'string' && b.base_url.trim() ? b.base_url.trim() : PROVIDER_KIND_META[kind].defaultBaseUrl;
    const secret = typeof b.secret === 'string' ? b.secret : '';
    if (!secret && kind !== 'custom_openai') return reply.code(422).send({ ok: false, error: 'API key required' });
    const err = await validateProvider(kind as never, baseUrl, secret);
    return err ? { ok: false, error: err } : { ok: true };
  });

  app.post('/byok/:id/default', async (req, reply) => {
    try {
      const id = String((req.params as any).id);
      byok.setDefault(id);
      audit('byok.set_default', 'byok_config', id, {});
      return { ok: true };
    } catch (e) {
      return reply.code(404).send({ error: String((e as Error).message ?? e) });
    }
  });

  // ---- filesystem browse (repo picker / ICS file picker; read-only, home-scoped) ----
  app.get('/fs/browse', async (req, reply) => {
    const { readdirSync, statSync } = await import('node:fs');
    const home = process.env.HOME ?? '/';
    let dir = String((req.query as any).path ?? '').trim() || home;
    // Safety: stay under $HOME and never list credential dirs (shared with import-path).
    const guard = guardHomeScopedPath(dir);
    if (!guard.ok) {
      if (guard.reason === 'not_found') return reply.code(422).send({ error: 'path not found' });
      if (guard.reason === 'outside_home') return reply.code(403).send({ error: 'outside home directory' });
      return reply.code(403).send({ error: 'credential directory' });
    }
    dir = guard.path;
    // Optional `files=ics,ical` — when present, matching FILES are listed
    // alongside directories. Absent = unchanged directories-only behaviour.
    const filesParam = String((req.query as any).files ?? '').trim();
    const wantExts = filesParam
      ? new Set(filesParam.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))
      : null;
    let entries: Array<{ name: string; type: 'dir' | 'file'; isGit: boolean }> = [];
    try {
      const dirents = readdirSync(dir, { withFileTypes: true });
      const dirEntries = dirents
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => {
          let isGit = false;
          try {
            isGit = statSync(`${dir}/${e.name}/.git`).isDirectory();
          } catch {}
          return { name: e.name, type: 'dir' as const, isGit };
        });
      const fileEntries = wantExts
        ? dirents
            .filter((e) => e.isFile() && !e.name.startsWith('.'))
            .filter((e) => wantExts!.has((e.name.split('.').pop() ?? '').toLowerCase()))
            .map((e) => ({ name: e.name, type: 'file' as const, isGit: false }))
        : [];
      // Cap each kind separately. Concatenating first meant a folder with 500+
      // subdirectories listed none of the files the caller explicitly asked for.
      entries = [...dirEntries.slice(0, 500), ...fileEntries.slice(0, 500)].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
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
    byokId: taskRow.byok_id ?? null,
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

function safeParseSpec(raw: unknown): { taskName?: string; byokId?: string | null; engine?: string } {
  try {
    return JSON.parse(String(raw ?? '{}')) as { taskName?: string; byokId?: string | null; engine?: string };
  } catch {
    return {};
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
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
    byokId: row.byok_id ?? null,
    chainAfter: row.chain_after ?? null,
    chainOn: row.chain_on ?? null,
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

/**
 * GET /delivery-config shape: effective (env-merged, file-wins) credential
 * status. Never returns a raw token/secret — `botTokenMasked` only.
 */
export function readDeliveryConfigStatus(dataDir: string): {
  telegram: { configured: boolean; botTokenMasked: string | null };
  webhook: { configured: boolean };
} {
  const creds = loadDeliveryCreds(dataDir);
  return {
    telegram: {
      configured: Boolean(creds.telegramBotToken),
      botTokenMasked: creds.telegramBotToken ? maskBotToken(creds.telegramBotToken) : null,
    },
    webhook: { configured: Boolean(creds.webhookSecret) },
  };
}
