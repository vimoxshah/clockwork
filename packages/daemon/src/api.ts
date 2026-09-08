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
import { AutonomyPolicy } from './autonomy-policy.js';
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
  isTerminal,
  type RunState,
  // ---- Agent Workforce (plan/AGENT-WORKFORCE-SPEC.md) ----
  AgentMemoryWrite, // F2
  PlanExecuteCreate, // F1
  type PlanExecuteStatus, // F1
  OfficeHourCreate, // F3
  SentinelCreate, // F4
  RunOutcomeWrite, // F6
  AutonomyRung, // F7
  AutonomyOfferStatus, // F7
  type PermissionMode, // F7
} from '@clockwork/shared';
import type { DB } from './db.js';
import { TaskRepo, ProfileRepo, RunRepo, indexTask } from './repo.js';
import { PlanExecute } from './plan-execute.js';
import type { RunManager } from './run-manager.js';
import type { Scheduler } from './scheduler.js';
import { nextOccurrenceAfter, type ScheduleLike } from './recurrence.js';
import { guardSchedule } from './schedule-guard.js';
import { OfficeHours, isKnownZone } from './office-hours.js';
import { Sentinels } from './sentinel.js';
import { isGitRepo } from '@clockwork/runner';
import { HandoffMemory } from './handoff.js';
import { Acceptance } from './acceptance.js';
import { proposedEventsFor, toIcs, icsFilenameFor } from './proposed-events.js';
import { proofOfWorkHtml, proofFilenameFor } from './proof-of-work.js';
import { timesheet, setHumanHourlyRate } from './timesheets.js';
import { scorecard, scorecards, reviewPromptFor } from './performance.js';
import {
  loadDeliveryCreds,
  writeDeliveryCreds,
  maskBotToken,
  maskSlackWebhookUrl,
  maskSmtpUrl,
  TelegramChannel,
  TelegramApiError,
  SlackChannel,
  SlackApiError,
  SmtpChannel,
  parseSmtpUrl,
} from './delivery.js';

export interface ApiDeps {
  db: DB;
  dataDir: string;
  runManager: RunManager;
  scheduler: Scheduler;
  /** The version THIS PROCESS started with — fixed for its whole lifetime. */
  version: string;
  /**
   * The version the build ON DISK declares right now, re-read on demand. A
   * long-lived daemon keeps serving `version` while the build under it — and
   * the UI bundle served out of that build — moves on (S-80, the stale-daemon
   * trap). Injected rather than imported from ./main.js, which would make
   * api <-> main a cycle; left unset, /health reports `installedVersion: null`
   * and never claims a skew it cannot prove.
   */
  installedVersion?: () => string | null;
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

/**
 * Does this URL need the bearer token?
 *
 * S-review (auth bypass, critical): this test used to run against
 * `req.raw.url` — the RAW, undecoded URL — while find-my-way percent-DECODES
 * the path before it matches a route. One encoded character in the prefix
 * therefore skipped the hook and still reached the handler: `GET /%74asks`
 * answered 200 with no credential, and so did every `/workforce/` route,
 * including the fifteen mutating ones.
 *
 * The decision now runs over EVERY spelling the router could resolve this URL
 * to — the raw path plus its decoded forms (`decodeURI` is what the router's
 * sanitizer applies to static segments; `decodeURIComponent` is the more
 * permissive reading, and covering both means no decoder disagreement can open
 * a route). Any one of them hitting a protected prefix demands the token. A
 * malformed escape makes decoding throw, and that fails CLOSED.
 *
 * Exported because the fail-closed branch is otherwise untestable: Fastify
 * answers a malformed escape with 400 FST_ERR_BAD_URL before onRequest hooks
 * run, so `app.inject` can never reach it.
 */
export function requiresAuth(rawUrl: string): boolean {
  let target = rawUrl || '';
  // RFC 7230 §5.3.2 absolute-form: `GET http://host/tasks HTTP/1.1` is a legal
  // request line, Node hands the whole thing to us as `req.raw.url`, and the
  // router still matches `/tasks` — verified against a real socket. The old
  // prefix test simply missed it, because the string starts with `http:`.
  // Reduce it to the path the router will use; an unparseable target (the
  // asterisk-form of OPTIONS, say) is refused rather than guessed at.
  if (target !== '' && !target.startsWith('/')) {
    try {
      target = new URL(target).pathname;
    } catch {
      return true; // not origin-form and not a URL — fail closed
    }
  }
  const rawPath = target.split(/[?#]/)[0]!;
  const spellings = new Set<string>([rawPath]);
  try {
    spellings.add(decodeURI(rawPath));
    spellings.add(decodeURIComponent(rawPath));
  } catch {
    return true; // malformed percent-escape — fail closed, never open
  }
  for (const url of spellings) {
    const needsAuth =
      /^\/(tasks|runs|approvals|profiles|search|widget|queue|onboarding|pause-all|resume|capacity)/.test(url) ||
      /^\/(analytics|retention|audit|policies|capabilities|targets|byok|delivery-config|triggers|trigger-events|ics|usage)/.test(url) ||
      /^\/(license|support|auth)\//.test(url) || // S-review: control plane + diagnostics must not be anonymous
      /^\/(calendars|templates)\//.test(url) || // S-audit: ICS export leaks task data; template preview is control plane
      /^\/fs\//.test(url) || // /fs/browse discloses directory AND file names under $HOME — never anonymous
      /^\/workforce\//.test(url) || // all twelve workforce features
      url.startsWith('/events');
    if (needsAuth) return true;
  }
  return false;
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

// ---------------------------------------------------------------------------
// S-64 — the calendar's payload bound and its per-day fold.
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the rows any single `GET /calendar` response may carry, per
 * collection. A caller may ask for fewer with `?limit=`; nobody can ask for
 * more, and every response reports the bound it applied plus whether it hit it
 * (`limits.truncated`) — a capped answer that looked complete would be worse
 * than no bound at all.
 *
 * 5,000 is NFR-3's own corpus size ("calendar renders 5,000 historical runs",
 * plan/01-product-spec.md:91), so the year view that spec describes sits AT
 * the boundary rather than inside it. That is deliberate: the bound exists to
 * stop an unbounded window, and the per-day fold below — not the bound — is
 * what makes a wide window cheap.
 */
export const CALENDAR_ROW_LIMIT = 5_000;

/**
 * How a run state colours a calendar cell.
 *
 * This is the one source of truth for the grouping: the SQL `CASE` arms in the
 * aggregate query are generated from it, and `calendarOutcomeBucket` reads the
 * same table, so the route can never disagree with itself. It mirrors
 * `stateClass()` in `packages/ui/src/components/CalendarView.tsx`, which is
 * what actually paints the cell — `missed` is drawn like a cancellation there,
 * so it is grouped like one here.
 *
 * Anything outside these five groups falls to `other` (today: `scheduled`).
 * `other` is a real bucket, not a silent drop: the six counts always sum back
 * to the day's run count.
 */
export const CALENDAR_OUTCOME_BUCKETS = {
  completed: ['completed'],
  failed: ['failed', 'timed_out', 'budget_exceeded'],
  cancelled: ['cancelled', 'missed'],
  running: ['running', 'queued', 'preparing', 'finalizing'],
  needsYou: ['waiting_approval', 'awaiting_user'],
} as const satisfies Readonly<Record<string, readonly RunState[]>>;

/** The outcome groups a day row reports, `other` included. */
export type CalendarOutcomeBucket = keyof typeof CALENDAR_OUTCOME_BUCKETS | 'other';

const CALENDAR_BUCKET_KEYS = Object.keys(CALENDAR_OUTCOME_BUCKETS) as Array<
  keyof typeof CALENDAR_OUTCOME_BUCKETS
>;

/**
 * Which cell colour a run state belongs to.
 *
 * @param state a run's FSM state, as stored in `runs.state`.
 * @returns the outcome bucket the per-day aggregate counts it under.
 */
export function calendarOutcomeBucket(state: string): CalendarOutcomeBucket {
  for (const key of CALENDAR_BUCKET_KEYS) {
    if ((CALENDAR_OUTCOME_BUCKETS[key] as readonly string[]).includes(state)) return key;
  }
  return 'other';
}

/** One collection's share of the bound: what came back, what exists, was it cut. */
export interface CalendarCollectionLimit {
  returned: number;
  total: number;
  truncated: boolean;
}

/**
 * The local calendar day of an instant as `YYYY-MM-DD`.
 *
 * LOCAL, not UTC, and that is the whole point: the grid snaps every event to
 * local midnight (`todayMidnight` in `packages/ui/src/calendar.ts`), so a run
 * at 23:30 belongs in tonight's cell and not in tomorrow's. The runs half of
 * the fold is done in SQLite with the `localtime` modifier, which resolves
 * through the same OS zone database; `calendar-aggregate.test.ts` re-derives
 * the whole aggregate from the detail rows with THIS function, so the two
 * clocks cannot drift apart unnoticed.
 */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * How far save-time materialization looks for the first fire, one rung at a
 * time. It stops at the rung that answers, so the work stays proportional to
 * how OFTEN a schedule fires, not to how far ahead it fires.
 *
 * The rungs are not arbitrary:
 *  - 8 days answers everything sub-daily through weekly, which is where the
 *    dense rules live. A per-minute rule is decided here and never expanded
 *    across the wide window (measured: a DTSTART-anchored `FREQ=MINUTELY` costs
 *    ~18ms at 8 days and ~1.6s at 732).
 *  - 70 days covers fortnightly and monthly, including `FREQ=MONTHLY;
 *    BYMONTHDAY=31`, whose Jan-31 → Mar-31 gap is 59 days.
 *  - 366*2 is `nextOccurrenceAfter`'s own default. The last rung must equal it:
 *    save then accepts exactly what the scheduler will later be able to
 *    re-materialize, so nothing can be stored that the tick loop cannot see.
 */
const SAVE_HORIZON_LADDER_DAYS = [8, 70, 366 * 2];

/**
 * First fire for a schedule being SAVED. Returns null only when the schedule
 * genuinely has no future occurrence the scheduler could ever reach.
 *
 * A single narrow window is the bug this replaces: at seven days, a monthly or
 * fortnightly recurrence created mid-cycle has no occurrence to find, so an
 * RRULE was refused outright ("RRULE has no future occurrences") and a cron was
 * stored with `next_fire = NULL` — which `Scheduler.tick`'s `next_fire IS NOT
 * NULL` filter then ignores forever.
 *
 * @param s the schedule to expand (rrule or cron; `once` never comes here).
 * @param afterMs materialize the first occurrence strictly after this instant.
 * @param resolve expander, injectable so tests can observe the rungs tried.
 * @returns the first fire in UTC epoch ms, or null when there is none.
 */
export function nextFireForSave(
  s: ScheduleLike,
  afterMs: number,
  resolve: (s: ScheduleLike, afterMs: number, horizonDays?: number) => number | null = nextOccurrenceAfter,
): number | null {
  for (const horizonDays of SAVE_HORIZON_LADDER_DAYS) {
    const hit = resolve(s, afterMs, horizonDays);
    if (hit !== null) return hit;
  }
  return null;
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

/**
 * The largest RRULE COUNT accepted at save time. Cost is linear in COUNT and
 * 40,000,000 measured 79 seconds for a single next-fire; see the call site.
 */
export const MAX_RRULE_COUNT = 100_000;

/** How many upcoming fires POST /schedule/preview answers with. */
export const PREVIEW_RUN_COUNT = 5;

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
  // F2 shift-handoff: one append-only memory writer, shared with F6's
  // Acceptance below so a single instance owns every agent_memories write.
  const handoffMemory = new HandoffMemory(deps.db);
  // Governance services (goals #38/#40/#41) — declared early so all routes can use them.
  const retentionAudit = new RetentionAudit(deps.db);
  const policies = new PolicyEngine(deps.db);
  // F6 accept-with-note: the acceptance signal read by F7/F10/F11 via run_outcomes.
  const acceptance = new Acceptance(deps.db, handoffMemory);
  // F7 earned-autonomy: composes the policy engine (its `evaluate` is folded
  // into the fail-closed chain below) and F6's acceptance signal.
  const autonomy = new AutonomyPolicy(deps.db, policies, acceptance);
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
  // ---- F1 plan-then-execute (plan/AGENT-WORKFORCE-SPEC.md §F1) ----
  const planExecute = new PlanExecute({
    db: deps.db,
    // Books a run for a task that is DISABLED BY DESIGN: enabled=0 is F1's
    // approval gate. This MUST NOT filter on tasks.enabled. pump() reads the
    // `runs` table only (run-manager.ts:108), so the booked run still starts.
    bookRun: (taskId, promptOverride) => {
      // narrow cast for the policy gate; the spread below carries the whole row
      const row = deps.db.prepare('SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL').get(taskId) as
        | { id: string; engine: string | null; byok_id: string | null; budget_usd: number }
        | undefined;
      if (!row) return null;
      const pv = evaluatePolicy(row.engine, row.byok_id, row.budget_usd);
      if (pv) {
        audit('plan_execute.book_rejected', 'task', taskId, pv);
        return null; // the pair stays 'approved' with no execute run — visible, not silent
      }
      // §3: shallow copy — never write the rendered prompt back to tasks.prompt
      const runId = enqueueRunNow(deps.db, { ...row, prompt: promptOverride });
      deps.runManager.pump();
      return runId;
    },
  });
  /**
   * F1's approval gate, asked from the ORDINARY task routes (ADR-039).
   *
   * `enabled=0` gates the execute half against the scheduler and against chain
   * firing, and it is no gate at all against the three routes that reach a task
   * row directly: run-now and the webhook fire path never read it, and PATCH
   * rewrites it. `docs/agent-workforce.md` promises "the execute half never
   * runs without your explicit approval of that specific plan" — these
   * refusals are what make that sentence true of the product rather than of
   * the scheduler alone.
   *
   *   'run'    (run-now, webhook fire) is refused while the pair is not
   *            approved. 'approved'/'executed' means a human read THAT plan, so
   *            a manual re-run is theirs to make; 'rejected' stays refused,
   *            because a rejected plan was never approved either.
   *   'enable' (PATCH {enabled:true}) is refused for an execute half at ANY
   *            status: resolve('approved') books the execute run itself, so
   *            enabled=1 could only ever mean "let the next plan run fire this
   *            half through the chain, carrying a plan nobody read".
   *
   * Returns null for every task that is not an execute half — only createPair
   * writes that table, and it clones a fresh execute task per pair.
   */
  const planExecuteGate = (
    taskId: string,
    action: 'run' | 'enable',
  ): { error: string; code: string; pairId: string; pairStatus: string } | null => {
    const pair = planExecute.pairForExecuteTask(taskId);
    if (!pair) return null;
    const resolveRoute = `POST /workforce/plan-execute/${pair.pairId}/resolve`;
    if (action === 'enable') {
      return {
        error:
          `This task is the execute half of plan-then-execute pair ${pair.pairId}, and it stays disabled by design. ` +
          `Enabling it would let a later plan run fire it through the chain with a plan nobody approved. ` +
          `Approve the plan instead (${resolveRoute}) and Clockwork books the execute run for you.`,
        code: 'execute_half_stays_disabled',
        pairId: pair.pairId,
        pairStatus: pair.status,
      };
    }
    if (pair.status === 'approved' || pair.status === 'executed') return null;
    const because =
      pair.status === 'rejected'
        ? 'you rejected that plan'
        : pair.status === 'awaiting_approval'
          ? 'its plan is waiting for your approval'
          : 'its plan run has not produced a plan yet';
    return {
      error:
        `This task is the execute half of plan-then-execute pair ${pair.pairId}, and ${because}. ` +
        `Approve the plan (${resolveRoute}) and Clockwork books the execute run itself.`,
      code: 'plan_not_approved',
      pairId: pair.pairId,
      pairStatus: pair.status,
    };
  };
  let token = loadOrCreateToken(deps.dataDir);
  const sseClients = new Set<FastifyReply>();

  // serve the built UI when present (single-port product surface)
  const uiDist = path.resolve(import.meta.dirname, '../../ui/dist');
  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, prefix: '/' });
  }

  // Daemon-wide pause. This used to be `let paused = false` right here — a
  // local nothing but /health and the widget snapshot ever read, so the run
  // manager dequeued and started runs while the UI said the daemon had
  // stopped. The manager owns the flag now (run-manager.ts setPaused/isPaused),
  // because the manager is the only thing that can honour it, and it is
  // durable so a restart cannot silently un-pause.
  const isPaused = (): boolean => deps.runManager.isPaused();

  // ---- auth hook: bearer token on data routes; static UI + health open ----
  app.addHook('onRequest', async (req, reply) => {
    if (!requiresAuth(req.raw.url ?? '')) return; // /health + static UI assets carry no user data
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
  // Same escape hatch buildServer already uses for broadcast: the RunManager is
  // constructed in main.ts before buildServer, so F1 registers itself here.
  deps.runManager['deps'].planExecute = planExecute;

  // A durable pause has to survive the boot that follows it, and main.ts calls
  // `scheduler.start(30_000)` unconditionally after buildServer — so the flag
  // alone would be undone at every restart. Same escape hatch this file
  // already uses for `broadcast`, `planExecute` and `selfHealing`: wrap the
  // method here rather than teach main.ts about pause. Holding the scheduler
  // still (rather than letting it tick and pile up queued rows) makes a pause
  // behave like a sleeping machine, so resuming replays through the existing
  // missed-run coalescing (S-10/S-11) instead of a thundering herd.
  // /resume clears the flag BEFORE calling start(), so that call gets through.
  const startScheduler = deps.scheduler.start.bind(deps.scheduler);
  deps.scheduler.start = (tickMs?: number): void => {
    if (isPaused()) return;
    startScheduler(tickMs);
  };

  // F4 sentinel-worker: books the worker run through the same evaluatePolicy +
  // enqueueRunNow + pump() sequence the webhook handler uses.
  const sentinels = new Sentinels({
    db: deps.db,
    bookWorker: (taskId: string): string | null => {
      const taskRow = tasks.get(taskId);
      if (!taskRow) return null;
      const pv = evaluatePolicy((taskRow as any).engine ?? null, (taskRow as any).byok_id ?? null, Number(taskRow.budget_usd ?? 2));
      if (pv) return null;
      const runId = enqueueRunNow(deps.db, taskRow);
      audit('run.enqueue', 'run', runId, { taskId: taskRow.id, taskName: taskRow.name, via: 'sentinel' });
      deps.runManager.pump();
      return runId;
    },
  });
  // F4: wire the finalize hook onto the already-constructed RunManager's deps
  // (same technique as the broadcast wiring above). A sentinel fault must
  // never roll back the run's terminal state — evaluate() itself does not
  // swallow errors, so the try/catch belongs here, not inside sentinel.ts.
  (deps.runManager as any)['deps'].onSentinelFinalize = (runId: string, taskId: string, reportJson: string | null, now: number) => {
    try {
      sentinels.evaluate(runId, taskId, reportJson, now);
    } catch {
      /* F4 is best-effort side work: a sentinel fault must never roll back the run's terminal state */
    }
  };

  // F8 self-healing (spec §4 F8). Dynamic import so the static import block at
  // the top of this file stays untouched — twelve features appending imports is
  // twelve merge conflicts.
  const { SelfHealing } = await import('./self-healing.js');
  const selfHealing = new SelfHealing({
    db: deps.db,
    bookRun: (taskId, promptOverride) => {
      const taskRow = tasks.get(taskId);
      if (!taskRow) return null;
      // S-review: the two sibling auto-bookers gate on the policy engine before
      // enqueueing (F1 above, F4's bookWorker below); this one did not, so every
      // automatically booked diagnostic ran outside the engine allowlist, the
      // BYOK restriction and the budget ceiling. Refusing here is safe by F8's
      // own design: a null booking leaves `diagnostic_at` NULL, so the next
      // failure tries again instead of the streak going quiet
      // (self-healing.ts onRunFailed).
      const pv = evaluatePolicy((taskRow as any).engine ?? null, (taskRow as any).byok_id ?? null, Number(taskRow.budget_usd ?? 2));
      if (pv) {
        audit('self_heal.book_rejected', 'task', taskId, pv);
        return null;
      }
      // permission_mode 'plan' makes "propose, don't apply" a runner guarantee
      // rather than prompt wording. The shallow copy is deliberate: the
      // diagnostic prompt is never written back to tasks.prompt (spec §3).
      const runId = enqueueRunNow(deps.db, { ...taskRow, prompt: promptOverride, permission_mode: 'plan' });
      deps.runManager.pump();
      return runId;
    },
  });
  // Same precedent as the broadcast reassignment above: the manager is
  // constructed in main.ts before buildServer, so the finalize hook is handed
  // in here rather than at construction.
  deps.runManager['deps'].selfHealing = selfHealing;

  // ---- health (S-61 handshake) ----
  app.get('/health', async () => {
    const active = deps.runManager.countActive();
    const queued = (deps.db.prepare("SELECT COUNT(*) c FROM runs WHERE state='queued'").get() as any).c;
    // The predicate MUST match `Scheduler.tick`'s exactly. It used to filter on
    // `schedules.enabled` alone, which is a weaker condition than the tick's:
    // deleting or disabling a task leaves its schedule row `enabled=1` with a
    // materialized `next_fire`, and nothing ever advances that timestamp again
    // because the tick correctly refuses to fire it. So the header advertised a
    // "next run" that had already passed and could never move — a real report
    // read `next 22 Aug at 9:52 AM` on 7 Sep with nothing scheduled at all.
    const nextFire = (
      deps.db
        .prepare(
          `SELECT MIN(s.next_fire) nf FROM schedules s
           JOIN tasks t ON t.id = s.task_id
           WHERE s.enabled=1 AND t.enabled=1 AND t.deleted_at IS NULL AND s.next_fire IS NOT NULL`,
        )
        .get() as any
    ).nf;
    // Read per request and never cached: the point of the field is that this
    // process does not change while the file under it does. A throwing reader
    // is not allowed to be the thing that takes /health down.
    let installedVersion: string | null = null;
    try {
      installedVersion = deps.installedVersion?.() ?? null;
    } catch {
      installedVersion = null;
    }
    return {
      ok: true,
      apiVersion: API_VERSION,
      daemonVersion: deps.version,
      installedVersion,
      versionSkew: installedVersion !== null && installedVersion !== deps.version,
      paused: isPaused(),
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
      scheduling: { paused: isPaused() },
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
      // A large COUNT is the one expansion cost the anchor fix cannot touch.
      // `recurrence.ts` advances a DTSTART-less anchor by whole INTERVAL
      // periods, which is exact — but only while COUNT is absent, because
      // dropping early occurrences promotes later ones into the count and
      // un-exhausts an exhausted rule. That is what the gate's COUNT negative
      // control proves. So a COUNT rule keeps the 1970 anchor and pays the
      // replay, and the cost is linear in COUNT: measured on an Apple M4, one
      // next-fire over the save-time rung costs 34ms at COUNT=10,000, 277ms at
      // 100,000, 2.6s at 1,000,000 and 79 SECONDS at 40,000,000 — which blocks
      // this request and the scheduler tick that later touches the schedule.
      // A ceiling is the honest lever: a small COUNT is already cheap (COUNT=10
      // is 0.4ms, because iteration stops once satisfied), and 100,000 still
      // lets a per-minute rule fire for 69 days or a daily one for 274 years.
      const countMatch = /(?:^|;)\s*COUNT\s*=\s*(\d+)/i.exec(input.schedule.rrule ?? '');
      if (countMatch && Number(countMatch[1]) > MAX_RRULE_COUNT) {
        return {
          ok: false,
          error: `RRULE COUNT is too large: ${countMatch[1]} exceeds the ${MAX_RRULE_COUNT} limit. Expanding it would block the scheduler — drop COUNT and use UNTIL, or lower it.`,
        };
      }
      // Two hazards `nextFireForSave` below cannot survive, so they are refused
      // from the STRING before it reaches rrule: a rule whose BY parts are
      // unreachable from its own INTERVAL grid never terminates (verified out of
      // process with a watchdog — see schedule-guard.ts), and a DTSTART-less
      // sub-daily rule with a whole-day filter replays from 1970 and blocks this
      // request. The tick path is deliberately NOT guarded: a hazardous row saved
      // before this check exists would go from slow to throwing, and that is a
      // different change from refusing new ones.
      const hazard = guardSchedule(input.schedule.kind, input.schedule.rrule, MAX_RRULE_COUNT);
      if (!hazard.safe) {
        return { ok: false, error: `invalid recurrence (${hazard.reason}): ${hazard.detail}` };
      }
      try {
        nextFire = nextFireForSave(
          {
            kind: input.schedule.kind === 'rrule' ? 'rrule' : 'cron',
            rrule: input.schedule.rrule,
            cron: input.schedule.cron,
            tz: input.schedule.tz,
          },
          Date.now(),
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
    // F7 earned-autonomy: a task may not ask for more autonomy than its
    // profile has earned. Same fail-closed 403 { violation } shape as above.
    const av = autonomy.evaluate({ profileId: v.profileId, permissionMode: parsed.data.permissionMode });
    if (av) {
      const avio = { violation: `${av.code}: ${av.message}` };
      audit('task.create_rejected', 'task', undefined, { ...avio, name: parsed.data.name });
      return reply.code(403).send(avio);
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
    // S-review (high): both gates below used to run AFTER `tasks.patch` had
    // committed, so a 403 reported an escalation it had already persisted —
    // spec §F7 calls the autonomy ceiling fail-closed, and it was fail-open on
    // this path. They now decide on the PROSPECTIVE row: the patch's own value
    // wherever it supplies one, the stored value otherwise, which is exactly
    // what the write would produce. 404 and 409 stay ahead of them so the
    // refusal order is unchanged, and `tasks.patch` still owns the real CAS.
    const taskId = (req.params as any).id;
    const current = tasks.get(taskId);
    if (!current) return reply.code(404).send({ error: 'not_found' });
    const expectedVersion = (req.body as any)?.version;
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      return reply.code(409).send({ error: 'version_conflict' }); // S-82
    }
    // F1 (ADR-039): re-enabling the execute half re-arms the one-shot chain —
    // run-manager.ts:683 fires successors `WHERE chain_after = ? AND enabled = 1`
    // and the execute half does carry `chain_after` (plan-execute.ts:180), so a
    // later plan run would launch it with a plan nobody approved. Refused ahead
    // of the two content gates below because it turns on WHICH TASK this is,
    // not on what the patch asks for.
    if (parsed.data.enabled === true) {
      const peGate = planExecuteGate(current.id, 'enable');
      if (peGate) {
        audit('task.update_rejected', 'task', current.id, { code: peGate.code, pairId: peGate.pairId });
        return reply.code(409).send(peGate);
      }
    }
    // Policy gate on edits that change engine/byok/budget.
    const pvEdit = evaluatePolicy(
      parsed.data.engine ?? (current as unknown as { engine?: string }).engine ?? undefined,
      'byokId' in parsed.data ? ((parsed.data as unknown as { byokId?: string }).byokId ?? undefined) : undefined,
      parsed.data.budget?.maxUsd ?? current.budget_usd,
    );
    if (pvEdit) {
      audit('task.update_rejected', 'task', current.id, { ...pvEdit });
      return reply.code(403).send(pvEdit);
    }
    // F7 earned-autonomy, on the profile and mode the row WILL hold. `patch`
    // writes any key that is not `undefined`, so an explicit null profileId
    // detaches the profile — mirror that, do not coalesce it away.
    //
    // S-review (usability trap): judging the prospective row ALONE made a
    // grandfathered task — one stored above its profile's rung before that
    // profile was enrolled — unpatchable for every field, `{enabled:false}`
    // included. `evaluateEdit` compares the prospective row with the stored one
    // and refuses only a patch that RAISES autonomy, so the fail-closed
    // direction is unchanged and the escape hatch is reachable.
    const avEdit = autonomy.evaluateEdit(
      {
        profileId: current.profile_id,
        permissionMode: current.permission_mode as PermissionMode,
      },
      {
        profileId: parsed.data.profileId !== undefined ? parsed.data.profileId : current.profile_id,
        permissionMode: (parsed.data.permissionMode ?? current.permission_mode) as PermissionMode,
      },
    );
    if (avEdit) {
      const avio = { violation: `${avEdit.code}: ${avEdit.message}` };
      audit('task.update_rejected', 'task', current.id, { ...avio });
      return reply.code(403).send(avio);
    }
    const res = tasks.patch(taskId, parsed.data, expectedVersion, nextFire ?? null);
    if (res === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (res === 'version_conflict') return reply.code(409).send({ error: 'version_conflict' }); // S-82
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
    // F1 (ADR-039): the execute half of a pair a human has not approved is not
    // launchable by hand either. Ahead of the enqueue, so nothing is booked.
    const peGate = planExecuteGate(row.id, 'run');
    if (peGate) {
      audit('run.enqueue_rejected', 'task', row.id, { code: peGate.code, pairId: peGate.pairId, pairStatus: peGate.pairStatus });
      return reply.code(409).send(peGate);
    }
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
      const av = autonomy.evaluate({ profileId: taskRow.profile_id ?? null, permissionMode: taskRow.permission_mode as PermissionMode });
      if (av) return respond(403, { error: 'policy', violation: `${av.code}: ${av.message}` }, false, 'policy_violation');
      // F1 (ADR-039): a trigger bound to the execute half of an unapproved pair
      // is a third way to launch it unapproved — same refusal as run-now.
      const peGate = planExecuteGate(taskRow.id, 'run');
      if (peGate) return respond(409, peGate, false, peGate.code);

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

  // ---- workforce: sentinel-worker (F4) ----
  app.post('/workforce/sentinels', async (req, reply) => {
    const parsed = SentinelCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const result = sentinels.create(parsed.data);
    if ('error' in result) return reply.code(422).send({ error: result.error });
    audit('sentinel.create', 'sentinel', result.id, { sentinelTaskId: result.sentinelTaskId, triggerId: result.triggerId });
    broadcast({ type: 'workforce.sentinel_created', sentinelId: result.id, at: Date.now() });
    return reply.code(201).send(result);
  });

  app.get('/workforce/sentinels', async () => {
    return { sentinels: sentinels.list() };
  });

  app.delete('/workforce/sentinels/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const ok = sentinels.remove(id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    audit('sentinel.delete', 'sentinel', id, {});
    broadcast({ type: 'workforce.sentinel_deleted', sentinelId: id, at: Date.now() });
    return reply.code(204).send();
  });

  app.get('/workforce/sentinels/:id/trips', async (req, reply) => {
    const id = (req.params as any).id;
    const exists = deps.db.prepare('SELECT id FROM sentinels WHERE id=?').get(id);
    if (!exists) return reply.code(404).send({ error: 'not_found' });
    const limit = Math.min(200, Math.max(1, parseInt(String((req.query as any)?.limit ?? '50'), 10) || 50));
    return { trips: sentinels.trips(id, limit) };
  });

  // ---- templates (T-203) ----
  const { securityPreview, validateTemplateApply } = await import('./templates.js');

  /** S-74: preview WITHOUT importing — full prompt/permissions/budget diff vs defaults. */
  /**
   * Show the next few fires for a rule the user is still typing, without
   * creating anything (SCH-3). It exists because the composer used to offer
   * only shapes it could not get wrong; the interval and multi-day options are
   * ones a user CAN get wrong, and a rule that looks right and never fires is
   * the failure this endpoint is here to make visible before the task is saved.
   *
   * The guard runs FIRST, and that ordering is the whole safety property: this
   * route is reachable per keystroke, so an unreachable rule expanded here would
   * hang the daemon on a draft. It also mirrors save's COUNT ceiling, or preview
   * would be the weaker of the two doors into the same expander.
   */
  app.post('/schedule/preview', async (req, reply) => {
    const body = req.body as { kind?: string; rrule?: string | null; cron?: string | null; runAt?: number | null; tz?: string } | null;
    const kind = body?.kind;
    if (kind !== 'once' && kind !== 'rrule' && kind !== 'cron') {
      return reply.code(422).send({ error: 'kind must be once, rrule or cron' });
    }
    const tz = typeof body?.tz === 'string' && body.tz.trim() !== '' ? body.tz : 'UTC';

    const hazard = guardSchedule(kind, body?.rrule, MAX_RRULE_COUNT);
    if (!hazard.safe) {
      return reply.code(422).send({ error: hazard.detail, reason: hazard.reason });
    }

    const schedule: ScheduleLike = { kind, rrule: body?.rrule ?? null, cron: body?.cron ?? null, runAt: body?.runAt ?? null, tz };
    const { occurrencesBetween } = await import('./recurrence.js');
    const from = Date.now();
    try {
      // Same rung ladder save uses, and for the same reason: a dense rule is
      // answered in the 8-day window and never pays for the wide one, while a
      // monthly rule still finds its first fires.
      let runs: number[] = [];
      for (const horizonDays of SAVE_HORIZON_LADDER_DAYS) {
        runs = occurrencesBetween(schedule, from, from + horizonDays * 86_400_000, PREVIEW_RUN_COUNT);
        if (runs.length >= PREVIEW_RUN_COUNT) break;
      }
      return { runs, tz, count: runs.length };
    } catch (e) {
      return reply.code(422).send({ error: `invalid recurrence: ${String(e)}`, reason: 'unparseable' });
    }
  });

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

  // ---- workforce: repo-jobs (F5) ----
  const { RepoJobs } = await import('./repo-jobs.js');
  const repoJobs = new RepoJobs(deps.db);
  const REPO_JOB_STATUSES = ['offered', 'imported', 'dismissed'] as const;

  app.post('/workforce/repo-jobs/discover', async (req, reply) => {
    const body = z.object({ repoPath: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: 'validation', details: body.error.issues });
    const r = repoJobs.discover(body.data.repoPath);
    if (r.error) return reply.code(422).send({ error: r.error });
    broadcast({ type: 'workforce.repo_jobs_discovered', repoPath: body.data.repoPath, count: r.offers.length, at: Date.now() });
    audit('repo_jobs.discover', 'repo', body.data.repoPath, { count: r.offers.length });
    return { offers: r.offers };
  });

  app.get('/workforce/repo-jobs', async (req, reply) => {
    const q = req.query as { status?: string };
    if (q.status !== undefined && !REPO_JOB_STATUSES.includes(q.status as (typeof REPO_JOB_STATUSES)[number])) {
      return reply.code(422).send({ error: 'validation', details: `status must be one of ${REPO_JOB_STATUSES.join(', ')}` });
    }
    return { offers: repoJobs.list(q.status as (typeof REPO_JOB_STATUSES)[number] | undefined) };
  });

  app.post('/workforce/repo-jobs/:id/import', async (req, reply) => {
    const id = (req.params as any).id;
    const r = repoJobs.import(id);
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if ('error' in r) return reply.code(422).send({ error: r.error });
    broadcast({ type: 'task.changed', taskId: r.taskId, at: Date.now() }); // S-74 precedent — tray refresh
    broadcast({ type: 'workforce.repo_job_imported', id, taskId: r.taskId, at: Date.now() });
    audit('repo_job.import', 'repo_job', id, { taskId: r.taskId });
    return reply.code(201).send({ taskId: r.taskId });
  });

  app.post('/workforce/repo-jobs/:id/dismiss', async (req, reply) => {
    const id = (req.params as any).id;
    const dismissed = repoJobs.dismiss(id);
    if (!dismissed) return reply.code(404).send({ error: 'not_found' });
    broadcast({ type: 'workforce.repo_job_dismissed', id, at: Date.now() });
    audit('repo_job.dismiss', 'repo_job', id, {});
    return { dismissed: true };
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

  // ---- workforce: proposed-events (F9) — read-only view over runs.report_json; never writes to a calendar ----
  app.get('/workforce/runs/:runId/proposed-events', async (req, reply) => {
    const runId = (req.params as any).runId;
    const run = deps.db.prepare('SELECT id FROM runs WHERE id=?').get(runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    return { events: proposedEventsFor(deps.db, runId) };
  });

  app.get('/workforce/runs/:runId/proposed-events.ics', async (req, reply) => {
    const runId = (req.params as any).runId;
    const run = deps.db.prepare('SELECT id FROM runs WHERE id=?').get(runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    const events = proposedEventsFor(deps.db, runId);
    const ics = toIcs(events, { runId });
    return reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${icsFilenameFor(runId)}"`)
      .send(ics);
  });

  // ---- workforce: proof-of-work (F12) ----
  app.get('/workforce/runs/:runId/proof-of-work', async (req, reply) => {
    const runId = (req.params as any).runId;
    const q = req.query as Record<string, unknown>;
    // '1'/'true' -> true, '0'/'false' -> false, anything else/absent -> undefined
    // so ProofOfWorkOptions.parse applies its own zod default.
    const boolParam = (v: unknown): boolean | undefined => {
      if (v === undefined) return undefined;
      const s = String(v).toLowerCase();
      if (s === '1' || s === 'true') return true;
      if (s === '0' || s === 'false') return false;
      return undefined;
    };
    const includeTranscript = boolParam(q.includeTranscript);
    const includeDiffStat = boolParam(q.includeDiffStat);
    const redactPaths = boolParam(q.redactPaths);
    const html = proofOfWorkHtml(deps.db, runId, { includeTranscript, includeDiffStat, redactPaths });
    if (html === 'not_found') return reply.code(404).send({ error: 'not_found' });
    audit('run.export_proof', 'run', runId, { includeTranscript, includeDiffStat, redactPaths });
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${proofFilenameFor(runId)}"`)
      .send(html);
  });

  // ---- approvals (rows exist from M1 fail-safe; responses land M2 UI) ----
  app.get('/approvals', async () => {
    return deps.db.prepare('SELECT * FROM approvals WHERE responded_at IS NULL ORDER BY requested_at ASC').all();
  });

  app.post('/approvals/:id/respond', async (req, reply) => {
    const id = (req.params as any).id;
    const body = req.body as any;
    const decision: import('./run-manager.js').ApprovalDecision = body?.decision === 'approved' ? 'approved' : 'denied';
    // The workforce dispatches below need to know WHICH kind of approval this
    // row is, and respondToApproval does not report it — so the payload is read
    // before the CAS closes the row.
    const pendingRow = deps.db.prepare('SELECT payload_json FROM approvals WHERE id=?').get(id) as
      | { payload_json?: unknown }
      | undefined;
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
      case 'run_gone': {
        // F1 and F8 (spec §2.4): the inbox and the /workforce/ routes must land
        // in the same state. Each dispatch CASes on its own row, so whichever
        // path arrives second is a no-op rather than a second write.
        try {
          const payload =
            typeof pendingRow?.payload_json === 'string'
              ? JSON.parse(pendingRow.payload_json)
              : (pendingRow?.payload_json ?? {});
          const approved = decision === 'approved';
          if (payload?.pairId) planExecute.resolve(String(payload.pairId), approved ? 'approved' : 'rejected');
          if (payload?.proposalId) {
            if (approved) selfHealing.apply(String(payload.proposalId));
            else selfHealing.reject(String(payload.proposalId));
          }
        } catch {
          /* dispatch is best-effort; the approval record stands either way */
        }
        return { resolved: true, forwarded: result.forwarded };
      }
    }
  });

  // ---- workforce: plan-then-execute (F1, spec §F1) ----
  const PlanExecuteResolve = z.object({ decision: z.enum(['approved', 'rejected']) });

  app.post('/workforce/plan-execute', async (req, reply) => {
    const parsed = PlanExecuteCreate.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    const res = planExecute.createPair(parsed.data);
    if ('error' in res) return reply.code(422).send({ error: res.error });
    audit('plan_execute.create', 'task', parsed.data.taskId, {
      pairId: res.id,
      planTaskId: res.planTaskId,
      executeTaskId: res.executeTaskId,
    });
    broadcast({ type: 'workforce.plan_execute_created', pairId: res.id, taskId: parsed.data.taskId, at: Date.now() });
    return reply.code(201).send(res);
  });

  app.get('/workforce/plan-execute', async (req) => {
    const q = req.query as { status?: string };
    // an unknown status yields an empty list, matching GET /runs?state=
    return { pairs: planExecute.list(q.status ? (String(q.status) as PlanExecuteStatus) : undefined) };
  });

  app.get('/workforce/plan-execute/:id', async (req, reply) => {
    const pair = planExecute.get((req.params as any).id);
    if (!pair) return reply.code(404).send({ error: 'not_found' });
    return pair;
  });

  app.post('/workforce/plan-execute/:id/resolve', async (req, reply) => {
    const id = (req.params as any).id;
    const parsed = PlanExecuteResolve.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    const res = planExecute.resolve(id, parsed.data.decision);
    if (res === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (res === 'already_resolved') return reply.code(409).send({ error: 'already_resolved' });
    audit('plan_execute.resolve', 'plan_execute_pair', id, { decision: parsed.data.decision, executeRunId: res.executeRunId });
    broadcast({ type: 'workforce.plan_execute_resolved', pairId: id, decision: parsed.data.decision, at: Date.now() });
    return res;
  });

  // ---- workforce: self-healing (F8) ----
  {
    const { RemediationStatus } = await import('@clockwork/shared');

    app.get('/workforce/remediations', async (req, reply) => {
      const q = req.query as any;
      const parsed = q.status === undefined ? undefined : RemediationStatus.safeParse(String(q.status));
      if (parsed !== undefined && !parsed.success) {
        return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
      }
      const status = parsed !== undefined && parsed.success ? parsed.data : undefined;
      const limit = q.limit === undefined ? undefined : parseInt(String(q.limit), 10);
      if (limit !== undefined && !(Number.isFinite(limit) && limit > 0)) {
        return reply.code(422).send({ error: 'limit must be a positive integer' });
      }
      return { proposals: selfHealing.list(status, limit) };
    });

    app.get('/workforce/remediations/:id', async (req, reply) => {
      const p = selfHealing.get((req.params as any).id);
      if (!p) return reply.code(404).send({ error: 'not_found' });
      return p;
    });

    app.post('/workforce/remediations/:id/apply', async (req, reply) => {
      const id = (req.params as any).id;
      const r = selfHealing.apply(id);
      if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (r === 'already_resolved') return reply.code(409).send({ error: 'already_resolved' });
      broadcast({ type: 'workforce.remediation_applied', proposalId: r.id, taskId: r.taskId, at: Date.now() });
      audit('remediation.apply', 'task', r.taskId, { proposalId: r.id, target: r.target, runId: r.runId });
      return r;
    });

    app.post('/workforce/remediations/:id/reject', async (req, reply) => {
      const id = (req.params as any).id;
      const r = selfHealing.reject(id);
      if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (r === 'already_resolved') return reply.code(409).send({ error: 'already_resolved' });
      broadcast({ type: 'workforce.remediation_rejected', proposalId: r.id, taskId: r.taskId, at: Date.now() });
      audit('remediation.reject', 'task', r.taskId, { proposalId: r.id, target: r.target, runId: r.runId });
      return r;
    });
  }

  // ---- profiles ----
  app.get('/profiles', async () => profiles.list());

  // ---- calendar window: runs + expanded occurrences, either as events or
  //      folded to per-day counts (S-64) ----
  //
  // TWO MODES, ONE WINDOW.
  //   no `group`  — the event-level detail view. One row per run, which is what
  //                 the month grid, the week grid and the day panel draw.
  //   `group=day` — per-day COUNTS: one row per day that holds something, with
  //                 the outcome breakdown a month or year cell needs to colour
  //                 itself. No run rows at all. This is S-64: a year view over
  //                 5,000 runs ships ~300 day rows instead of 5,000 events.
  //
  // BOTH modes are bounded (`CALENDAR_ROW_LIMIT`) and both report the bound
  // they applied in `limits`, so a caller can always tell a complete answer
  // from a capped one.
  //
  // HONEST NOTE ON COST, REVISED 2026-09-07. This used to read "the fold is a
  // payload win, not a latency win", and that was a true description of the
  // code as it then stood: `recurrence.ts` anchored a DTSTART-less rule at
  // 1970, so `RRule.between()` replayed 56 years of occurrences per schedule
  // (~26ms per enabled daily one) and swamped everything else in the handler.
  // Both modes paid that identically, because both have to know which days hold
  // bookings — so folding the runs half changed nothing a caller could feel.
  //
  // That replay is gone (`advancedAnchorMs` in `recurrence.ts`), and the fold is
  // a latency win as well as a payload one now. It is not that the fold got
  // better; the saving it always made is simply no longer hidden behind the
  // replay. Measured 2026-09-07 on an Apple M4, three full runs of
  // `packages/daemon/test/calendar-aggregate-bench.test.ts` over 5,000 runs in a
  // 396-day window: 1.130MB of events against 51.4KB of day rows (22.5x, byte
  // identical in all three), and 27.11-29.29ms end to end against 8.15-13.21ms
  // — interleaved, so neither mode systematically follows the other and pays
  // for its GC. The runs half on its own is 18.11-19.27ms against 4.68-7.52ms;
  // that half is the only part the fold touches, and it is now most of the
  // request rather than ~3% of it.
  app.get('/calendar', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const to = q.to ? parseInt(String(q.to), 10) : Date.now() + 31 * 86_400_000;
    const from = q.from ? parseInt(String(q.from), 10) : to - 62 * 86_400_000;
    if (!(from > 0 && to > from)) return reply.code(422).send({ error: 'invalid range' });

    const group = q.group === undefined ? null : String(q.group);
    if (group !== null && group !== 'day') return reply.code(422).send({ error: 'invalid group' });

    // `?limit=` may only lower the ceiling. Anything that is not a positive
    // integer is refused rather than coerced: silently reading `limit=abc` as
    // "no limit" is how a caller ends up with a different bound than it asked
    // for and no way to know.
    let rowLimit = CALENDAR_ROW_LIMIT;
    if (q.limit !== undefined) {
      const raw = String(q.limit);
      if (!/^[0-9]+$/.test(raw)) return reply.code(422).send({ error: 'invalid limit' });
      const asked = parseInt(raw, 10);
      if (!(asked > 0)) return reply.code(422).send({ error: 'invalid limit' });
      rowLimit = Math.min(asked, CALENDAR_ROW_LIMIT);
    }

    const { occurrencesBetween } = await import('./recurrence.js');

    // A run belongs to the window if ANY of its three timestamps lands inside
    // it; it is FILED under the first one it has. Both modes use the same
    // predicate and the same coalesce, which is what lets the aggregate be
    // provably the detail view collapsed rather than a second opinion.
    const WINDOW = `(scheduled_for BETWEEN ? AND ?)
            OR (started_at BETWEEN ? AND ?)
            OR (ended_at BETWEEN ? AND ?)`;
    const windowArgs = [from, to, from, to, from, to] as const;
    const AT = `COALESCE(scheduled_for, started_at, ended_at)`;

    const emptyOutcomes = (): Record<CalendarOutcomeBucket, number> => ({
      completed: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
      needsYou: 0,
      other: 0,
    });
    interface DayRow {
      day: string;
      runs: number;
      bookings: number;
      humans: number;
      costUsd: number;
      outcomes: Record<CalendarOutcomeBucket, number>;
    }
    const dayRows = new Map<string, DayRow>();
    const dayRow = (key: string): DayRow => {
      let row = dayRows.get(key);
      if (row === undefined) {
        row = { day: key, runs: 0, bookings: 0, humans: 0, costUsd: 0, outcomes: emptyOutcomes() };
        dayRows.set(key, row);
      }
      return row;
    };

    // ---- runs ----
    let runRows: Array<Record<string, unknown>> = [];
    let runsReturned = 0;
    let runsTotal = 0;
    let runsTruncated = false;

    if (group === 'day') {
      // The fold happens in SQLite because that is the part that scales with
      // history: this never materializes 5,000 rows in JS, never parses 5,000
      // jobspec blobs for a name the aggregate does not use, and never
      // serializes them. It is no longer a rounding error either — with the
      // 1970 RRULE replay gone, the runs query is more than half of the year
      // view's 40.82-42.17ms median (three runs, 2026-09-07, Apple M4), where
      // it used to be ~12ms of ~355ms.
      //
      // `GROUP BY` emits a row only for a day that HAS runs, so the result is
      // bounded by the number of non-empty days — never by the window's span.
      // A `from=1` window therefore costs a handful of rows, not 20,000.
      const buckets = CALENDAR_BUCKET_KEYS.map(
        (key, i) =>
          `SUM(CASE WHEN state IN (${CALENDAR_OUTCOME_BUCKETS[key]
            .map((s) => `'${s}'`)
            .join(', ')}) THEN 1 ELSE 0 END) AS bucket_${i}`,
      ).join(',\n                ');
      const grouped = deps.db
        .prepare(
          `SELECT strftime('%Y-%m-%d', ${AT} / 1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS runs,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd,
                ${buckets}
         FROM runs
         WHERE ${WINDOW}
         GROUP BY day
         ORDER BY day ASC`,
        )
        .all(...windowArgs) as unknown as Array<Record<string, number | string>>;
      for (const g of grouped) {
        const row = dayRow(String(g.day));
        row.runs = Number(g.runs);
        // Rounded, because a REAL SUM prints as 12.340000000000002 otherwise.
        // Six places is far below a cent and well inside float precision for
        // the magnitudes involved.
        row.costUsd = Math.round(Number(g.cost_usd ?? 0) * 1e6) / 1e6;
        let named = 0;
        CALENDAR_BUCKET_KEYS.forEach((key, i) => {
          const n = Number(g[`bucket_${i}`] ?? 0);
          row.outcomes[key] = n;
          named += n;
        });
        // `other` is derived, so the buckets sum back to `runs` by
        // construction — a state nobody grouped cannot go missing.
        row.outcomes.other = row.runs - named;
      }
    } else {
      // NFR-3 ("windowed fetch") is why this projects `task_name` instead of
      // returning `jobspec_json`: the calendar reads exactly one key out of
      // that blob — the frozen S-5 snapshot name. Shipping the whole spec
      // (prompt, profile, skills, paths) made the year view a 10.16MB
      // response; projecting the one field it reads makes it 1.15MB. Measured
      // on the 5k corpus in packages/daemon/test/workforce-bench.test.ts. This
      // is a payload/memory win, and it was measured as one: when it landed it
      // moved no latency at all, because the request was dominated by the RRULE
      // replay. That replay is gone (see the HONEST NOTE above) and this is
      // still a payload win — dropping the blob is what keeps a 5,000-row
      // answer near 1.1MB instead of 10MB.
      // json_extract, NOT a join to tasks.name: the calendar must keep showing
      // the name the run was booked under, not the task's current name.
      //
      // `LIMIT rowLimit + 1` is the bound and its own detector: one row past
      // the ceiling proves there is more without a second query. The exact
      // total is only paid for when the answer really was cut, so the common
      // (uncapped) path costs nothing extra.
      const fetched = deps.db
        .prepare(
          `SELECT id, task_id, state, outcome_reason, scheduled_for, started_at, ended_at, cost_usd, turns,
                json_extract(jobspec_json, '$.taskName') AS task_name
         FROM runs
         WHERE ${WINDOW}
         ORDER BY ${AT} ASC
         LIMIT ?`,
        )
        .all(...windowArgs, rowLimit + 1) as unknown as Array<Record<string, unknown>>;
      runsTruncated = fetched.length > rowLimit;
      runRows = runsTruncated ? fetched.slice(0, rowLimit) : fetched;
      runsReturned = runRows.length;
      runsTotal = runsTruncated
        ? Number(
            (
              deps.db
                .prepare(`SELECT COUNT(*) AS n FROM runs WHERE ${WINDOW}`)
                .get(...windowArgs) as { n: number }
            ).n,
          )
        : runsReturned;
    }

    // Bookings: expand every enabled schedule into the visible window.
    const bookings: Array<{ taskId: string; name: string; at: number; kind: 'booking' }> = [];
    let bookingsTotal = 0;
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
          bookingsTotal++;
          dayRow(localDayKey(at)).bookings++;
          // Counted always, COLLECTED only up to the bound: the day fold needs
          // the count, the detail view needs the rows, and neither may grow
          // without limit.
          if (group === null && bookings.length < rowLimit) {
            bookings.push({ taskId: s.task_id, name: s.task_name, at, kind: 'booking' });
          }
        }
      } catch {
        /* one bad schedule must not break the calendar */
      }
    }
    bookings.sort((a, b) => a.at - b.at);

    // Human events from calendar sources (read-only; never written to). A
    // `url` source is re-fetched live; a `file` source is a frozen import —
    // it is re-parsed from the stored copy and MUST NOT trigger a fetch.
    const humans: Array<{ uid: string; name: string; at: number; allDay: boolean }> = [];
    let humansTotal = 0;
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
            humansTotal++;
            dayRow(localDayKey(ev.startMs)).humans++;
            if (group === null && humans.length < rowLimit) {
              humans.push({ uid: ev.uid, name: ev.summary, at: ev.startMs, allDay: ev.allDay });
            }
          }
        } catch {
          /* one bad feed/import must not break the calendar */
        }
      }
      humans.sort((a, b) => a.at - b.at);
    } catch {
      /* ICS overlay is best-effort */
    }

    const collection = (returned: number, total: number): CalendarCollectionLimit => ({
      returned,
      total,
      truncated: total > returned,
    });

    if (group === 'day') {
      const all = [...dayRows.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      const days = all.length > rowLimit ? all.slice(0, rowLimit) : all;
      const sum = (rows: DayRow[], pick: (r: DayRow) => number): number =>
        rows.reduce((acc, r) => acc + pick(r), 0);
      const limits = {
        rowLimit,
        truncated: all.length > rowLimit,
        days: collection(days.length, all.length),
        // Shipped-vs-existing per collection: when the day rows are capped,
        // the runs on the days that were cut are counted here and NOT in the
        // response body, which is exactly what a caller needs to know.
        runs: collection(sum(days, (r) => r.runs), sum(all, (r) => r.runs)),
        bookings: collection(sum(days, (r) => r.bookings), bookingsTotal),
        humans: collection(sum(days, (r) => r.humans), humansTotal),
      };
      return { from, to, group: 'day' as const, days, limits };
    }

    return {
      from,
      to,
      runs: runRows,
      bookings,
      humans,
      limits: {
        rowLimit,
        truncated:
          runsTruncated || bookings.length < bookingsTotal || humans.length < humansTotal,
        runs: { returned: runsReturned, total: runsTotal, truncated: runsTruncated },
        bookings: collection(bookings.length, bookingsTotal),
        humans: collection(humans.length, humansTotal),
      },
    };
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
      // upsert persists delivery_json; this merge never supplied one, so a
      // delivery-config edit was dropped one layer above the repo that stores it.
      delivery_json: d.delivery ? JSON.stringify(d.delivery) : existing.delivery_json,
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
      // Same tick-matching predicate as /health above: a soft-deleted or
      // disabled task must not supply the "next run" the tray reports.
      .prepare(
        `SELECT s.next_fire, t.name FROM schedules s
         JOIN tasks t ON t.id=s.task_id
         WHERE s.enabled=1 AND t.enabled=1 AND t.deleted_at IS NULL AND s.next_fire IS NOT NULL
         ORDER BY s.next_fire LIMIT 1`,
      )
      .get() as any;
    return { runsToday, needsYou, recentReports: unread, nextRun: next ?? null, paused: isPaused() };
  });

  // ---- pause-all / resume ----
  // Contract (SettingsView "Pause all scheduling"): "Queued and future runs
  // hold until resumed. Active runs finish." Nothing in flight is killed —
  // stopping a run mid-turn throws away work that is already paid for and can
  // leave a half-written worktree behind — but nothing new starts, on any
  // path, until /resume.
  app.post('/pause-all', async () => {
    deps.runManager.setPaused(true); // the gate the run manager's pump reads
    deps.scheduler.stop();
    audit('daemon.pause', undefined, undefined, { activeRuns: deps.runManager.countActive() });
    broadcast({ type: 'daemon.health', data: { paused: true }, at: Date.now() });
    return { paused: true };
  });

  app.post('/resume', async () => {
    // Clear the flag FIRST: the scheduler.start wrapper above no-ops while
    // paused, and setPaused(false) is what pumps the runs that were held.
    deps.runManager.setPaused(false);
    deps.scheduler.start();
    audit('daemon.resume', undefined, undefined);
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
      // 'paused' leads: while the daemon is paused nothing starts at all, so
      // "waiting for slot" — which used to win for anything past position 2 —
      // was telling the user their run was about to go.
      const reason =
        isPaused() ? 'paused'
        : repoBusy ? 'waiting for repo'
        : active + position > maxParallel ? 'waiting for slot'
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

  // ---- delivery credentials (Telegram bot token / webhook HMAC secret /
  //      Slack incoming-webhook URL / SMTP relay URL + From) ----
  app.get('/delivery-config', async () => readDeliveryConfigStatus(deps.dataDir));

  app.put('/delivery-config', async (req, reply) => {
    const DeliveryCredsSchema = z.object({
      telegramBotToken: z.union([z.string(), z.null()]).optional(),
      webhookSecret: z.union([z.string(), z.null()]).optional(),
      // The Slack incoming-webhook URL is itself the credential, so it is
      // stored like the bot token (0600 file / env) and never in a task row.
      slackWebhookUrl: z
        .union([z.string().url().startsWith('https://', 'slack webhook url must be https'), z.null()])
        .optional(),
      smtpUrl: z
        .union([
          z.string().refine((s) => {
            try {
              parseSmtpUrl(s);
              return true;
            } catch {
              return false;
            }
          }, 'expected smtp://user:pass@host:587 or smtps://…:465'),
          z.null(),
        ])
        .optional(),
      smtpFrom: z.union([z.string().email(), z.null()]).optional(),
    });
    const parsed = DeliveryCredsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'validation' });
    writeDeliveryCreds(deps.dataDir, parsed.data);
    // One entry per credential — 'set'/'cleared'/'unchanged', never a value.
    const credState = (k: keyof typeof parsed.data): string =>
      k in parsed.data ? (parsed.data[k] === null ? 'cleared' : 'set') : 'unchanged';
    audit('delivery-config.update', 'delivery-config', undefined, {
      telegramBotToken: credState('telegramBotToken'),
      webhookSecret: credState('webhookSecret'),
      slackWebhookUrl: credState('slackWebhookUrl'),
      smtpUrl: credState('smtpUrl'),
      smtpFrom: credState('smtpFrom'),
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

  // Same shape as test-telegram: the saved credential, one fixed message, no
  // retry. Slack needs no body — one incoming webhook posts to exactly one
  // channel, so the credential already names the destination.
  app.post('/delivery-config/test-slack', async (_req, reply) => {
    const creds = loadDeliveryCreds(deps.dataDir);
    if (!creds.slackWebhookUrl) return reply.send({ ok: false, error: 'no slack webhook url configured' });
    try {
      await new SlackChannel().sendTest(creds);
      return reply.send({ ok: true });
    } catch (e) {
      let msg = e instanceof SlackApiError ? (e.description ?? e.message) : e instanceof Error ? e.message : String(e);
      // The channel already redacts the URL; belt-and-braces for a transport
      // error that echoed it back through some other path.
      msg = msg.split(creds.slackWebhookUrl).join('[redacted]');
      return reply.send({ ok: false, error: msg.slice(0, 200) });
    }
  });

  app.post('/delivery-config/test-smtp', async (req, reply) => {
    const TestSchema = z.object({ to: z.string().email() });
    const parsed = TestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'validation' });
    const creds = loadDeliveryCreds(deps.dataDir);
    if (!creds.smtpUrl) return reply.send({ ok: false, error: 'no smtp url configured' });
    try {
      await new SmtpChannel().sendTest(parsed.data.to, creds);
      return reply.send({ ok: true });
    } catch (e) {
      // SmtpChannel.sendMail already scrubs the password out of its message.
      const msg = e instanceof Error ? e.message : String(e);
      return reply.send({ ok: false, error: msg.slice(0, 200) });
    }
  });

  // ---- cost & reliability analytics (ADR-029) ----
  //
  // An UNFINISHED run (queued / preparing / running / waiting_approval /
  // finalizing / awaiting_user) is the normal state of this product, so the
  // window predicate below deliberately admits one: `COALESCE(ended_at,
  // scheduled_for)` places it on the day it was scheduled for, matching
  // timesheets.ts:95 and performance.ts:67. How it is then COUNTED is the
  // careful part, and the rule is one line: a run with no end time is a real
  // run whose spend so far is real, but it is never counted as a FINISHED one.
  //   - counted in `runs`; reported separately as `inFlight`
  //   - its cost/turns so far count — that money is already gone
  //   - never `completed`, never `failed`
  //   - excluded from every rate's denominator (`successRate` divides by
  //     finished runs) and from `avgDurationMs` (no end time, no duration)
  // With no unfinished run in the window every number here is identical to
  // what it was before, so this changes only the case that used to 500.
  //
  // That 500 was this: the SELECT list omitted `scheduled_for` while the day
  // bucketing read it, so `Number(undefined)` -> NaN -> `new Date(NaN)
  // .toISOString()` threw RangeError('Invalid time value') and took the whole
  // Analytics tab down for as long as any run was in flight.
  app.get('/analytics', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const to = q.to ? parseInt(String(q.to), 10) : Date.now();
    const days = Math.min(180, Math.max(1, parseInt(String(q.days ?? '30'), 10)));
    const from = to - days * 86_400_000;

    const rows = deps.db
      .prepare(
        `SELECT task_id, state, outcome_reason, started_at, ended_at, scheduled_for, cost_usd, turns, jobspec_json
         FROM runs
         WHERE COALESCE(ended_at, scheduled_for) BETWEEN ? AND ?`,
      )
      .all(from, to) as unknown as Array<Record<string, unknown>>;

    /** `finished` = terminal runs, the denominator of every rate. `timedRuns` = runs that have both a start and an end. */
    type TaskAgg = { taskId: string; name: string; runs: number; finished: number; completed: number; failed: number; costUsd: number; turns: number; durationMs: number; timedRuns: number };
    const byTask = new Map<string, TaskAgg>();
    const byEngine = new Map<string, { engine: string; runs: number; finished: number; completed: number; failed: number; costUsd: number }>();
    let totalRuns = 0;
    let totalFinished = 0;
    let totalCompleted = 0;
    let totalFailed = 0;
    let totalCostUsd = 0;
    let totalTurns = 0;
    const daily = new Map<string, { day: string; runs: number; costUsd: number }>();

    for (const r of rows) {
      totalRuns += 1;
      const state = String(r.state);
      // An unknown state is treated as unfinished — better to under-claim a
      // finished run than to average an unfinished one in as though it ended.
      const finished = isTerminal(state as RunState);
      const isDone = state === 'completed';
      const isFail = state === 'failed' || state === 'timed_out';
      if (finished) totalFinished += 1;
      if (isDone) totalCompleted += 1;
      if (isFail) totalFailed += 1;
      const cost = Number(r.cost_usd ?? 0);
      totalCostUsd += cost;
      const turns = Number(r.turns ?? 0);
      totalTurns += turns;
      // A duration needs BOTH ends. An unfinished run has no end; a `missed`
      // or `cancelled` one never started. Neither is a 0 ms sample.
      const timed = r.started_at != null && r.ended_at != null;
      const dur = timed ? Number(r.ended_at) - Number(r.started_at) : 0;

      const spec = safeParseSpec(r.jobspec_json);
      const name = String(spec.taskName ?? 'unknown');
      const engFromSpec = String(spec.engine ?? 'cli');
      // Same COALESCE the WHERE clause uses, so every returned row has a day.
      // Still guarded: one unreadable timestamp loses its bar, not the tab.
      const bucketAt = Number(r.ended_at ?? r.scheduled_for ?? Number.NaN);
      const day = Number.isFinite(bucketAt) ? new Date(bucketAt).toISOString().slice(0, 10) : null;

      const t = byTask.get(String(r.task_id)) ?? { taskId: String(r.task_id), name, runs: 0, finished: 0, completed: 0, failed: 0, costUsd: 0, turns: 0, durationMs: 0, timedRuns: 0 };
      t.runs += 1; if (finished) t.finished += 1; if (isDone) t.completed += 1; if (isFail) t.failed += 1;
      t.costUsd += cost; t.turns += turns; t.durationMs += dur; if (timed) t.timedRuns += 1;
      byTask.set(String(r.task_id), t);

      const engKey = engFromSpec + (spec.byokId ? ':byok' : '');
      const e = byEngine.get(engKey) ?? { engine: engKey, runs: 0, finished: 0, completed: 0, failed: 0, costUsd: 0 };
      e.runs += 1; if (finished) e.finished += 1; if (isDone) e.completed += 1; if (isFail) e.failed += 1; e.costUsd += cost;
      byEngine.set(engKey, e);

      if (day !== null) {
        const d = daily.get(day) ?? { day, runs: 0, costUsd: 0 };
        d.runs += 1; d.costUsd += cost;
        daily.set(day, d);
      }
    }

    const tasksOut = [...byTask.values()]
      .sort((a, b) => b.costUsd - a.costUsd)
      .map((t) => ({
        taskId: t.taskId,
        name: t.name,
        runs: t.runs,
        completed: t.completed,
        failed: t.failed,
        inFlight: t.runs - t.finished,
        costUsd: round4(t.costUsd),
        turns: t.turns,
        durationMs: t.durationMs,
        successRate: t.finished ? Math.round((t.completed / t.finished) * 100) : 0,
        avgDurationMs: t.timedRuns ? Math.round(t.durationMs / t.timedRuns) : 0,
      }));
    const enginesOut = [...byEngine.values()].map((e) => ({
      engine: e.engine,
      runs: e.runs,
      completed: e.completed,
      failed: e.failed,
      inFlight: e.runs - e.finished,
      costUsd: round4(e.costUsd),
      successRate: e.finished ? Math.round((e.completed / e.finished) * 100) : 0,
    }));

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
      // `completed < finished` is "some finished run did not complete" — the
      // "and has failures" this line always meant. It is the same test as the
      // older `completed < runs` whenever nothing is in flight; a run that is
      // merely still going is not evidence of anything to fix.
      if (t.turns / Math.max(1, t.runs) > 40 && t.completed < t.finished) {
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
        /** Runs in this window that have not finished yet — counted in `runs`, in no rate. */
        inFlight: totalRuns - totalFinished,
        successRate: totalFinished ? Math.round((totalCompleted / totalFinished) * 100) : 0,
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

  // ---- workforce: earned autonomy (F7) — a rung is OFFERED, never granted ----
  app.get('/workforce/autonomy/offers', async (req, reply) => {
    const raw = (req.query as any)?.status;
    if (raw !== undefined && String(raw) !== '') {
      const parsed = AutonomyOfferStatus.safeParse(String(raw));
      if (!parsed.success) {
        return reply.code(422).send({ error: `unknown status "${String(raw)}" — expected offered, accepted or declined` });
      }
      return { offers: autonomy.listOffers(parsed.data) };
    }
    return { offers: autonomy.listOffers() };
  });

  app.post('/workforce/autonomy/offers/:id/respond', async (req, reply) => {
    const parsed = z.object({ decision: z.enum(['accepted', 'declined']) }).safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    const res = autonomy.respond(String((req.params as any).id), parsed.data.decision);
    if (res === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (res === 'already_resolved') return reply.code(409).send({ error: 'already_resolved' });
    broadcast({ type: 'workforce.autonomy_decided', offerId: res.id, profileId: res.profileId, decision: res.status, at: Date.now() });
    audit('autonomy.respond', 'profile', res.profileId, { offerId: res.id, decision: res.status, fromRung: res.fromRung, toRung: res.toRung });
    return res;
  });

  app.get('/workforce/autonomy/profiles/:profileId', async (req, reply) => {
    const state = autonomy.state(String((req.params as any).profileId));
    if (!state) return reply.code(404).send({ error: 'not_found' });
    return state;
  });

  app.post('/workforce/autonomy/profiles/:profileId/enroll', async (req, reply) => {
    const parsed = z.object({ rung: AutonomyRung }).safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    const profileId = String((req.params as any).profileId);
    const state = autonomy.enroll(profileId, parsed.data.rung);
    if (state === 'not_found') return reply.code(404).send({ error: 'not_found' });
    broadcast({ type: 'workforce.autonomy_enrolled', profileId, rung: state.rung, at: Date.now() });
    audit('autonomy.enroll', 'profile', profileId, { rung: state.rung });
    return state;
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

  // ---- workforce: office hours (F3) ----
  const officeHours = new OfficeHours(deps.db);

  app.get('/workforce/office-hours', async () => {
    return { enabled: officeHours.enabled(), windows: officeHours.list() };
  });

  app.post('/workforce/office-hours', async (req, reply) => {
    const parsed = OfficeHourCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    }
    if (!isKnownZone(parsed.data.tz)) {
      // A zone luxon cannot resolve stores a window that never opens, so it
      // would silently never shift anything. Refuse it at the door.
      return reply
        .code(422)
        .send({ error: `Unknown IANA time zone '${parsed.data.tz}' — use a name like 'America/New_York'.` });
    }
    const created = officeHours.create(parsed.data);
    broadcast({ type: 'workforce.office_hours_created', windowId: created.id, at: Date.now() });
    audit('office_hours.create', 'office_hour', created.id, {
      dow: created.dow,
      startMin: created.startMin,
      endMin: created.endMin,
      tz: created.tz,
    });
    return reply.code(201).send(created);
  });

  app.delete('/workforce/office-hours/:id', async (req, reply) => {
    const id = String((req.params as any).id);
    if (!officeHours.remove(id)) return reply.code(404).send({ error: 'not_found' });
    broadcast({ type: 'workforce.office_hours_removed', windowId: id, at: Date.now() });
    audit('office_hours.remove', 'office_hour', id, {});
    return reply.code(204).send();
  });

  app.put('/workforce/office-hours/enabled', async (req, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    }
    officeHours.setEnabled(parsed.data.enabled);
    broadcast({ type: 'workforce.office_hours_toggled', enabled: parsed.data.enabled, at: Date.now() });
    audit('office_hours.set_enabled', 'workforce_prefs', '1', { enabled: parsed.data.enabled });
    return { enabled: officeHours.enabled() };
  });

  // ---- workforce: accept-with-note (F6) ----
  app.post('/workforce/runs/:runId/outcome', async (req, reply) => {
    const parsed = RunOutcomeWrite.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const runId = (req.params as any).runId;
    const result = acceptance.record(runId, parsed.data, 'local');
    if (result === 'not_found') return reply.code(404).send({ error: 'not_found' });
    // F7 earned-autonomy: an acceptance may EARN the next rung. maybeOffer
    // writes an autonomy_offers row and nothing else — the profile is untouched
    // until a human accepts. Best-effort (§2.3): a failure here must never lose
    // the outcome the human just recorded.
    try {
      if (result.profileId) {
        const offer = autonomy.maybeOffer(result.profileId);
        if (offer) {
          broadcast({ type: 'workforce.autonomy_offered', offerId: offer.id, profileId: offer.profileId, toRung: offer.toRung, at: Date.now() });
          audit('autonomy.offer', 'profile', offer.profileId, { offerId: offer.id, fromRung: offer.fromRung, toRung: offer.toRung, streak: offer.streak });
        }
      }
    } catch { /* non-fatal: the recorded outcome stands either way */ }
    broadcast({ type: 'workforce.outcome_recorded', runId, taskId: result.taskId, decision: result.decision, at: Date.now() });
    audit('outcome.record', 'run', runId, { decision: result.decision });
    return result;
  });

  // "Nobody has decided yet" is the normal state of a fresh run, not an error.
  // Answering it with 404 put a red line in the browser console every time the
  // inbox opened an undecided run — console noise that trains people to ignore
  // the console. So the absence of a decision is an ordinary 200 carrying JSON
  // `null`, and 404 is kept for the one case that really is a caller mistake:
  // a runId that names no run. The two stay distinguishable.
  //
  // The body is a bare `null`, deliberately NOT an envelope like
  // `{ outcome: null }`: OutcomeControls.tsx:50 stores whatever this returns
  // and line 123 renders `outcome.decision` behind a bare truthiness check, so
  // a truthy envelope would crash the panel this change exists to keep quiet.
  app.get('/workforce/runs/:runId/outcome', async (req, reply) => {
    const runId = (req.params as any).runId;
    const rec = acceptance.get(runId); // a run_outcomes row implies the run exists (FK)
    if (rec) return rec;
    if (!deps.db.prepare('SELECT 1 FROM runs WHERE id=?').get(runId)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.send(null);
  });

  app.get('/workforce/tasks/:taskId/outcomes', async (req) => {
    const q = req.query as any;
    const limit = q.limit ? parseInt(String(q.limit), 10) : undefined;
    return { outcomes: acceptance.listForTask((req.params as any).taskId, limit) };
  });

  // ---- workforce: timesheets (F10) ----
  app.get('/workforce/timesheets', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const toMs = q.to !== undefined ? parseInt(String(q.to), 10) : Date.now();
    const fromMs = q.from !== undefined ? parseInt(String(q.from), 10) : toMs - 30 * 86_400_000;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      return reply.code(422).send({ error: 'to must be after from' });
    }
    const profileId = q.profileId ? String(q.profileId) : undefined;
    return timesheet(deps.db, { fromMs, toMs, profileId });
  });

  app.put('/workforce/prefs/hourly-rate', async (req, reply) => {
    // NOTE: a fresh literal schema, NOT WorkforcePrefs.shape.humanHourlyRateUsd —
    // that field carries `.default(null)`, so reusing it would make the body
    // key optional and a bare `PUT {}` would silently clear the rate.
    const HourlyRateBody = z.object({ humanHourlyRateUsd: z.number().nonnegative().nullable() });
    const parsed = HourlyRateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    setHumanHourlyRate(deps.db, parsed.data.humanHourlyRateUsd);
    broadcast({ type: 'workforce.hourly_rate_set', humanHourlyRateUsd: parsed.data.humanHourlyRateUsd, at: Date.now() });
    audit('workforce.hourly_rate_set', 'workforce_prefs', '1', { humanHourlyRateUsd: parsed.data.humanHourlyRateUsd });
    return { humanHourlyRateUsd: parsed.data.humanHourlyRateUsd };
  });

  // ---- workforce: performance reviews (F11) ----
  // review_period_days (workforce_prefs, singleton id=1) supplies the default
  // window when the caller omits ?from/&to — this is the one place this
  // feature reads that column; scorecard()/scorecards() always take an
  // explicit {fromMs,toMs} and never read prefs themselves (spec F11).
  // from/to are parsed leniently: missing or non-finite -> use the default,
  // matching the fail-open posture the other read-only analytics routes in
  // this file take (no 422 is named for these three routes in the spec,
  // unlike F10's timesheets route, which explicitly requires one).
  function resolvePerformanceWindow(query: unknown): { fromMs: number; toMs: number } {
    const q = (query ?? {}) as { from?: string; to?: string };
    const days = (
      deps.db.prepare('SELECT review_period_days FROM workforce_prefs WHERE id=1').get() as {
        review_period_days: number;
      }
    ).review_period_days;
    const toParsed = Number(q.to);
    const toMs = Number.isFinite(toParsed) ? toParsed : Date.now();
    const fromParsed = Number(q.from);
    const fromMs = Number.isFinite(fromParsed) ? fromParsed : toMs - days * 86_400_000;
    return { fromMs, toMs };
  }

  app.get('/workforce/performance', async (req) => {
    const window = resolvePerformanceWindow(req.query);
    return { cards: scorecards(deps.db, window) };
  });

  app.get('/workforce/performance/:profileId', async (req, reply) => {
    const profileId = (req.params as any).profileId as string;
    const window = resolvePerformanceWindow(req.query);
    const card = scorecard(deps.db, profileId, window);
    // 404 rule, chosen so the list (GET /workforce/performance) and this
    // detail route never disagree: performance.ts deliberately keeps a
    // deleted/unknown profile id ADDRESSABLE (falls back to the raw id as
    // profileName) rather than folding it into "Unassigned", and scorecards()
    // will list such a card if it has runs. So 404 only when BOTH the id
    // names no profiles row AND it produced zero runs in the window — a
    // truly unknown id with no history. A deleted profile that still has
    // runs in-window still resolves, matching the list.
    const profileRow = deps.db.prepare('SELECT id FROM profiles WHERE id=?').get(profileId);
    if (!profileRow && card.runs === 0) return reply.code(404).send({ error: 'not_found' });
    return card;
  });

  app.get('/workforce/performance/:profileId/review-prompt', async (req, reply) => {
    const profileId = (req.params as any).profileId as string;
    const window = resolvePerformanceWindow(req.query);
    const card = scorecard(deps.db, profileId, window);
    const profileRow = deps.db.prepare('SELECT id FROM profiles WHERE id=?').get(profileId);
    if (!profileRow && card.runs === 0) return reply.code(404).send({ error: 'not_found' });
    return { prompt: reviewPromptFor(card) };
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

  // ---- workforce: shift-handoff (F2) ----
  app.get('/workforce/handoff/:taskId', async (req) => {
    const taskId = (req.params as any).taskId as string;
    const rawLimit = (req.query as any)?.limit;
    const limit = rawLimit !== undefined ? Math.max(1, parseInt(String(rawLimit), 10) || 5) : undefined;
    return { memories: handoffMemory.latest(taskId, limit) };
  });

  app.post('/workforce/handoff/:taskId', async (req, reply) => {
    const taskId = (req.params as any).taskId as string;
    const parsed = AgentMemoryWrite.safeParse({ ...(req.body as Record<string, unknown>), taskId });
    if (!parsed.success) return reply.code(422).send({ error: 'validation', details: parsed.error.flatten() });
    // No 404 in this route's contract (spec §4 F2 routes table) — an unknown
    // task is a 422 semantic failure, caught here rather than surfacing as an
    // uncaught agent_memories.task_id FK throw (500).
    if (!tasks.get(taskId)) return reply.code(422).send({ error: 'unknown task' });
    const mem = handoffMemory.append(parsed.data);
    broadcast({ type: 'workforce.memory_appended', taskId, memoryId: mem.id, at: mem.createdAt });
    audit('memory.append', 'task', taskId, { memoryId: mem.id, author: mem.author, kind: mem.kind });
    return reply.code(201).send(mem);
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
 * status. Never returns a raw token/secret/URL — only the masked forms
 * (`botTokenMasked`, `webhookUrlMasked`, `endpointMasked`). `smtpFrom` is the
 * one value returned whole, because a From address is not a secret.
 */
export function readDeliveryConfigStatus(dataDir: string): {
  telegram: { configured: boolean; botTokenMasked: string | null };
  webhook: { configured: boolean };
  slack: { configured: boolean; webhookUrlMasked: string | null };
  smtp: { configured: boolean; endpointMasked: string | null; from: string | null };
} {
  const creds = loadDeliveryCreds(dataDir);
  return {
    telegram: {
      configured: Boolean(creds.telegramBotToken),
      botTokenMasked: creds.telegramBotToken ? maskBotToken(creds.telegramBotToken) : null,
    },
    webhook: { configured: Boolean(creds.webhookSecret) },
    slack: {
      configured: Boolean(creds.slackWebhookUrl),
      webhookUrlMasked: creds.slackWebhookUrl ? maskSlackWebhookUrl(creds.slackWebhookUrl) : null,
    },
    smtp: {
      configured: Boolean(creds.smtpUrl),
      // maskSmtpUrl keeps scheme/user/host:port and drops the password.
      endpointMasked: creds.smtpUrl ? maskSmtpUrl(creds.smtpUrl) : null,
      from: creds.smtpFrom ?? null,
    },
  };
}
