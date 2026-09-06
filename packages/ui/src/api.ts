/**
 * Daemon API client — pure client (arch §6). Errors propagate as ApiError so
 * views can render real error states; 401 clears the stored token and raises
 * the global unauthorized flag (fixes the silent-blank-page class of bug).
 */
const TOKEN_KEY = 'clockwork.token';
const UNAUTHORIZED_EVENT = 'clockwork:unauthorized';

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * One request, one error contract — auth header, 401 handling and the
 * ApiError mapping live here and nowhere else. Split out of `req` so a
 * non-JSON response (the proof-of-work HTML export) can reuse all of it and
 * only differ in how the body is read.
 */
async function send(method: string, path: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${getToken()}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'daemon unreachable — is clockworkd running?');
  }
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new ApiError(401, 'unauthorized — token invalid or rotated');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const msg = (err as any).error ?? `${res.status}`;
    // Entitlement gates (402) carry feature + plan so views can render an
    // honest, actionable upgrade explanation (gauntlet §12).
    if (res.status === 402 && typeof msg === 'string') {
      throw new ApiError(402, msg, { feature: (err as any).feature, requiresPlan: (err as any).requiresPlan });
    }
    const details = (err as any).details;
    throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg), details);
  }
  return res;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  // 204 No Content has no body, and `Response.json()` REJECTS on an empty one
  // — so without this guard a SUCCESSFUL delete throws a SyntaxError and the
  // caller's `.then(reload)` never runs. Every 204 route in the daemon lands
  // here: DELETE /triggers/:id, /byok/:id, /workforce/sentinels/:id and
  // /workforce/office-hours/:id.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface Health {
  ok: boolean;
  apiVersion: number;
  /** the version THIS PROCESS started with */
  daemonVersion: string;
  /** the version of the build on disk right now; null when it cannot be read */
  installedVersion: string | null;
  /** true only when both are known and they differ — never claim skew that cannot be proven */
  versionSkew: boolean;
  paused: boolean;
  activeRuns: number;
  queuedRuns: number;
  nextFire: number | null;
}

export interface TaskViewT {
  id: string;
  name: string;
  prompt: string;
  profileId: string | null;
  engine?: string | null;
  byokId?: string | null;
  chainAfter?: string | null;
  chainOn?: string | null;
  repoPath: string | null;
  permissionMode: string;
  budget: { maxUsd: number; maxTurns: number; timeoutSec: number };
  missedPolicy: string;
  overlapPolicy: string;
  enabled: boolean;
  version: number;
  nextFire: number | null;
}

export interface RunRowT {
  id: string;
  task_id: string;
  state: string;
  outcome_reason: string | null;
  cost_usd: number;
  turns: number;
  started_at: number | null;
  ended_at: number | null;
  scheduled_for: number | null;
  branch: string | null;
  worktree_path: string | null;
  report_json: string | null;
  jobspec_json: string;
}

/**
 * GET /calendar returns a WINDOWED PROJECTION of RunRowT, not the whole row
 * (NFR-3). A year view holds ~5,000 rows, so the route omits `jobspec_json`,
 * `report_json`, `branch` and `worktree_path` and projects the one field the
 * calendar reads — the frozen S-5 snapshot name — as `task_name`. Fetch the
 * full row from `/runs/:id` when a view needs more than a chip.
 */
export type CalendarRunRowT = Omit<RunRowT, 'jobspec_json' | 'report_json' | 'branch' | 'worktree_path'> & {
  task_name: string | null;
};

export interface CalendarEvent {
  kind: 'run' | 'booking' | 'human';
  id: string;
  taskId: string;
  name: string;
  at: number;
  state?: string;
  costUsd?: number;
  outcomeReason?: string | null;
  allDay?: boolean;
}

export interface AnalyticsT {
  range: { from: number; to: number; days: number };
  totals: { runs: number; completed: number; failed: number; successRate: number; costUsd: number; turns: number; avgCostPerRun: number };
  byTask: Array<{ taskId: string; name: string; runs: number; completed: number; failed: number; costUsd: number; successRate: number; avgDurationMs: number }>;
  byProvider: Array<{ engine: string; runs: number; completed: number; failed: number; costUsd: number; successRate: number }>;
  daily: Array<{ day: string; runs: number; costUsd: number }>;
}

/**
 * F8 self-healing proposal (GET /workforce/remediations/:id). The approvals
 * payload carries only `target` + `proposedValue`; `currentValue` and
 * `rationale` live on the proposal row, and the inbox card needs both to show
 * a human what the change would actually replace.
 */
export interface RemediationProposalT {
  id: string;
  taskId: string;
  runId: string | null;
  approvalId: string | null;
  target: 'prompt' | 'profile';
  currentValue: string | null;
  proposedValue: string;
  rationale: string | null;
  status: 'proposed' | 'applied' | 'rejected';
  createdAt: number;
  decidedAt: number | null;
}

// ---------------------------------------------------------------------------
// Agent workforce (plan/AGENT-WORKFORCE-SPEC.md, migration 0008).
//
// These mirror packages/shared/src/workforce.ts BY HAND. Nothing under
// packages/ui/src imports @clockwork/shared — the UI is a pure wire client —
// so every cross-package shape is re-declared here with this file's `T`
// suffix, exactly as TaskViewT/RunRowT/RemediationProposalT already are. The
// compiler cannot catch drift between the two: if a shape moves in
// workforce.ts or in a daemon route, move it here in the same change.
// ---------------------------------------------------------------------------

/** F1 plan-then-execute. */
export type PlanExecuteStatusT = 'awaiting_plan' | 'awaiting_approval' | 'approved' | 'rejected' | 'executed';

export interface PlanExecutePairT {
  id: string;
  planTaskId: string;
  executeTaskId: string;
  planRunId: string | null;
  approvalId: string | null;
  executeRunId: string | null;
  status: PlanExecuteStatusT;
  decidedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** F2 shift-handoff (also F6's note sink). */
export type MemoryAuthorT = 'agent' | 'human';
export type MemoryKindT = 'handoff' | 'note';

export interface AgentMemoryT {
  id: string;
  taskId: string;
  runId: string | null;
  author: MemoryAuthorT;
  kind: MemoryKindT;
  tried: string | null;
  blocked: string | null;
  nextCheck: string | null;
  body: string | null;
  createdAt: number;
}

/**
 * Body of POST /workforce/handoff/:taskId. `taskId` is deliberately absent:
 * the route merges it in from the path before validating, so a taskId in the
 * body is ignored (api.ts:2352).
 */
export interface AgentMemoryWriteT {
  runId?: string | null;
  /** defaults to 'agent' server-side */
  author?: MemoryAuthorT;
  /** defaults to 'handoff' server-side */
  kind?: MemoryKindT;
  tried?: string | null;
  blocked?: string | null;
  nextCheck?: string | null;
  body?: string | null;
}

/** F3 office-hours. A window never crosses midnight — that is two rows. */
export interface OfficeHourWindowT {
  id: string;
  label: string | null;
  /** 0 = Sunday .. 6 = Saturday */
  dow: number;
  startMin: number;
  endMin: number;
  tz: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OfficeHourCreateT {
  label?: string;
  dow: number;
  startMin: number;
  endMin: number;
  /** IANA zone; the daemon 422s a name luxon cannot resolve */
  tz: string;
  /** defaults to true server-side */
  enabled?: boolean;
}

/** F4 sentinel-worker. */
export interface SentinelT {
  id: string;
  name: string;
  sentinelTaskId: string;
  triggerId: string;
  tripExpr: string;
  cooldownSec: number;
  lastTrippedAt: number | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SentinelCreateT {
  name: string;
  sentinelTaskId: string;
  triggerId: string;
  /** case-insensitive substring the sentinel run's report summary must contain */
  tripExpr: string;
  /** defaults to 3600 server-side */
  cooldownSec?: number;
  /** defaults to true server-side */
  enabled?: boolean;
}

export interface SentinelTripT {
  id: string;
  sentinelId: string;
  runId: string | null;
  workerRunId: string | null;
  tripped: boolean;
  reason: string | null;
  at: number;
}

/** F5 repo-shipped jobs. */
export type RepoJobStatusT = 'offered' | 'imported' | 'dismissed';

export interface RepoJobSpecT {
  key: string;
  name: string;
  prompt: string;
  schedule?: { kind: 'cron' | 'rrule'; cron?: string; rrule?: string; tz: string };
  description?: string;
}

export interface RepoJobOfferT {
  id: string;
  repoPath: string;
  sourcePath: string;
  jobKey: string;
  name: string;
  spec: RepoJobSpecT;
  digest: string;
  /** same flag shape as the template security preview (S-74) */
  preview: { flags: Array<{ level: 'red' | 'yellow' | 'info'; text: string }>; arrivesDisabled: true } | null;
  status: RepoJobStatusT;
  taskId: string | null;
  discoveredAt: number;
  decidedAt: number | null;
}

/** F7 earned-autonomy. */
export type AutonomyRungT = 'plan' | 'acceptEdits' | 'unattended';
export type AutonomyOfferStatusT = 'offered' | 'accepted' | 'declined';

export interface AutonomyOfferT {
  id: string;
  profileId: string;
  fromRung: AutonomyRungT;
  toRung: AutonomyRungT;
  streak: number;
  status: AutonomyOfferStatusT;
  offeredAt: number;
  decidedAt: number | null;
}

export interface AutonomyStateT {
  profileId: string;
  /** null = not enrolled */
  rung: AutonomyRungT | null;
  streakRequired: number;
  streak: number;
  eligible: boolean;
}

/**
 * A profile row projected down to its autonomy columns. GET /profiles is a
 * `SELECT *`, so it already carries the two columns migration 0008 added —
 * hence snake_case here, matching the wire rather than pretending otherwise.
 */
export interface AutonomyEnrolledProfileT {
  id: string;
  slug: string;
  name: string;
  autonomy_rung: AutonomyRungT;
  /** per-profile override; null = use the workforce_prefs default */
  autonomy_streak_required: number | null;
}

/** F10 timesheets. */
export interface TimesheetRowT {
  profileId: string | null;
  profileSlug: string | null;
  profileName: string;
  runs: number;
  hoursWorked: number;
  dollarsSpent: number;
  outcomesAccepted: number;
  outcomesRejected: number;
  /** dollarsSpent / hoursWorked; null when the agent logged no time */
  effectiveHourlyRateUsd: number | null;
}

export interface TimesheetT {
  fromMs: number;
  toMs: number;
  humanHourlyRateUsd: number | null;
  rows: TimesheetRowT[];
}

/** F11 performance reviews. */
export interface PerformanceScorecardT {
  profileId: string | null;
  profileSlug: string | null;
  profileName: string;
  fromMs: number;
  toMs: number;
  runs: number;
  /** accepted / decided; null when nothing was decided in the window */
  acceptanceRate: number | null;
  /** failed+timed_out / runs; null when there were no runs */
  failureRate: number | null;
  costUsd: number;
  /** mean cost per run this window minus the previous window; null if no prior window */
  costTrendUsd: number | null;
  decided: number;
}

/** F12 proof-of-work. Secret masking always runs; it is not an option. */
export interface ProofOfWorkOptionsT {
  /** default false */
  includeTranscript?: boolean;
  /** default true */
  includeDiffStat?: boolean;
  /** strip repo paths and branch names as well as secrets; default false */
  redactPaths?: boolean;
}

/** Epoch-ms window shared by the timesheet and scorecard routes. Both sides optional — the daemon supplies its own defaults. */
export interface WindowQueryT {
  from?: number;
  to?: number;
}

/**
 * Query string for the optional params above: absent keys are LEFT OUT rather
 * than sent empty, so the daemon's own zod defaults apply. Booleans go over
 * the wire as '1'/'0', which is what the proof-of-work route parses.
 */
function query(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    qs.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/**
 * Shared by `api.proofOfWorkUrl` (the address) and `api.proofOfWork` (the
 * bytes) so the two can never disagree about the options they encode.
 */
function proofOfWorkPath(runId: string, opts?: ProofOfWorkOptionsT): string {
  return `/workforce/runs/${encodeURIComponent(runId)}/proof-of-work${query({
    includeTranscript: opts?.includeTranscript,
    includeDiffStat: opts?.includeDiffStat,
    redactPaths: opts?.redactPaths,
  })}`;
}

export const api = {
  health: () => req<Health>('GET', '/health'),
  byok: () => req<{ configs: unknown[]; meta: unknown }>('GET', '/byok'),
  byokCreate: (b: unknown) => req<unknown>('POST', '/byok', b),
  byokRotate: (id: string, secret: string) => req<{ ok: boolean; hint?: string }>('POST', `/byok/${id}/rotate`, { secret }),
  byokTest: (id: string) => req<{ ok: boolean; error: string | null }>('POST', `/byok/${id}/test`),
  byokValidate: (b: { kind: string; base_url?: string; secret?: string }) => req<{ ok: boolean; error: string | null }>('POST', '/byok/validate', b),
  byokDelete: (id: string) => req<unknown>('DELETE', `/byok/${id}`),
  byokSetDefault: (id: string) => req<{ ok: boolean }>('POST', `/byok/${id}/default`),
  capabilities: () => req<{ tier: string; features: Array<{ key: string; label: string; category: string; enabled: boolean; limit?: string; status: string }>; entitlement: { tier: string; state: string; plan?: string; expiresAt?: number; graceEndsAt?: number; subject?: string } }>('GET', '/capabilities'),
  supportBundle: () => req<Record<string, unknown>>('GET', '/support/bundle'),
  rotateToken: () => req<{ token: string }>('POST', '/auth/rotate'),
  licenseActivate: (token: string) => req<{ ok: boolean; entitlement: unknown }>('POST', '/license/activate', { token }),
  licenseDeactivate: () => req<{ ok: boolean }>('POST', '/license/deactivate'),
  analytics: (days: number) => req<AnalyticsT>('GET', `/analytics?days=${days}`),
  triggers: () => req<Array<{ id: string; name: string; source: string; filter: Record<string, unknown> | null; hasSecret: boolean; taskId: string; enabled: boolean }>>('GET', '/triggers'),
  createTrigger: (body: { name: string; source: string; taskId: string; secret?: string; filter?: Record<string, unknown> }) =>
    req<{ id: string; secret?: string; webhookPath: string }>('POST', '/triggers', body),
  toggleTrigger: (id: string, enabled: boolean) => req<{ ok: true }>('PATCH', `/triggers/${id}`, { enabled }),
  deleteTrigger: (id: string) => req<void>('DELETE', `/triggers/${id}`),
  tasks: () => req<TaskViewT[]>('GET', '/tasks'),
  createTask: (t: unknown) => req<TaskViewT>('POST', '/tasks', t),
  patchTask: (id: string, p: unknown) => req<TaskViewT>('PATCH', `/tasks/${id}`, p),
  deleteTask: (id: string) => req<{ deleted: boolean }>('DELETE', `/tasks/${id}`),
  runNow: (id: string) => req<{ runId: string }>('POST', `/tasks/${id}/run-now`),
  calendar: (from: number, to: number) =>
    req<{ from: number; to: number; runs: CalendarRunRowT[]; bookings: Array<{ taskId: string; name: string; at: number; kind: 'booking' }>; humans?: Array<{ uid: string; name: string; at: number; allDay: boolean }> }>(
      'GET',
      `/calendar?from=${from}&to=${to}`,
    ),
  icsSources: () => req<Array<{ id: string; url: string; label: string }>>('GET', '/calendars/ics'),
  addIcsSource: (url: string, label: string) =>
    req<{ id: string; label: string; events: number }>('POST', '/calendars/ics', { url, label }),
  removeIcsSource: (id: string) => req<{ removed: string }>('DELETE', `/calendars/ics/${id}`),
  queue: () =>
    req<Array<{ runId: string; taskId: string; name: string; position: number; reason: string }>>(
      'GET',
      '/queue',
    ),
  onboardingStatus: () =>
    req<{
      claudeInstalled: boolean;
      claudeAuthed: boolean;
      gitInstalled: boolean;
      mcpDetected: boolean;
      hasTasks: boolean;
      readyToBook: boolean;
      hasProvider: boolean;
      byokCount: number;
    }>('GET', '/onboarding/status'),
  runs: (filter: { state?: string; taskId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (filter.state) qs.set('state', filter.state);
    if (filter.taskId) qs.set('taskId', filter.taskId);
    if (filter.limit) qs.set('limit', String(filter.limit));
    return req<RunRowT[]>('GET', `/runs?${qs}`);
  },
  report: (runId: string) => req<{ run: RunRowT; report: any }>('GET', `/runs/${runId}/report`),
  proposedEvents: (runId: string) =>
    req<{ events: Array<{ key: string; title: string; notes: string | null; durationMin: number; suggestedAt: number | null }> }>(
      'GET',
      `/workforce/runs/${runId}/proposed-events`,
    ),
  transcript: (runId: string) =>
    req<{ available: boolean; totalLines?: number; lines: string[] }>(
      'GET',
      `/runs/${runId}/transcript`,
    ),
  cancelRun: (id: string) => req<unknown>('POST', `/runs/${id}/cancel`),
  approvals: () => req<any[]>('GET', '/approvals'),
  remediation: (id: string) =>
    req<RemediationProposalT>('GET', `/workforce/remediations/${encodeURIComponent(id)}`),
  respondApproval: (id: string, decision: 'approved' | 'denied') =>
    req<{ resolved: boolean }>('POST', `/approvals/${id}/respond`, { decision }),
  profiles: () => req<any[]>('GET', '/profiles'),
  search: (q: string, kind?: string) =>
    req<Array<{ kind: string; ref_id: string; title: string; snip: string }>>(
      'GET',
      `/search?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ''}`,
    ),
  snapshot: () => req<any>('GET', '/widget/snapshot'),
  pauseAll: () => req<{ paused: boolean }>('POST', '/pause-all'),
  resume: () => req<{ paused: boolean }>('POST', '/resume'),
  providers: () =>
    req<Array<{ id: string; label: string; bin: string; detected: boolean; version: string | null }>>(
      'GET',
      '/providers',
    ),
  browseFs: (path: string) =>
    req<{ path: string; parent: string | null; entries: Array<{ name: string; type: 'dir' | 'file'; isGit: boolean }> }>(
      'GET',
      `/fs/browse?path=${encodeURIComponent(path)}`,
    ),
  cloneRepo: (url: string) =>
    req<{ ok: true; alreadyCloned?: boolean; path: string; slug: string }>(
      'POST',
      '/repos/clone',
      { url },
    ),
  usageStatus: () =>
    req<{ windows: Array<{ kind: string; at: number; usedPct: number | null; source: string; resetsAt: number | null }> }>(
      'GET',
      '/usage/status',
    ),
  getPrefs: () => req<{ soundMode: 'chime' | 'system' | 'none'; volumePct: number }>('GET', '/prefs'),
  putPrefs: (p: { soundMode: string; volumePct: number }) => req<unknown>('PUT', '/prefs', p),
  recordOutcome: (runId: string, body: { decision: 'accepted' | 'accepted_with_note' | 'rejected'; note?: string }) =>
    req<{ runId: string; taskId: string; profileId: string | null; decision: string; note: string | null; memoryId: string | null; actor: string; decidedAt: number }>(
      'POST',
      `/workforce/runs/${runId}/outcome`,
      body,
    ),

  // ---- workforce: plan-then-execute (F1) ----
  /** One booking, two runs. The execute half stays disabled until a human approves THAT plan. */
  planExecuteCreate: (body: { taskId: string; planHour?: number; tz?: string }) =>
    req<PlanExecutePairT>('POST', '/workforce/plan-execute', body),
  /** An unknown status yields an empty list, matching GET /runs?state=. */
  planExecuteList: (status?: PlanExecuteStatusT) =>
    req<{ pairs: PlanExecutePairT[] }>('GET', `/workforce/plan-execute${query({ status })}`),
  planExecuteGet: (id: string) =>
    req<PlanExecutePairT>('GET', `/workforce/plan-execute/${encodeURIComponent(id)}`),
  /** Approving books the execute run itself; a second verdict is a 409. */
  planExecuteResolve: (id: string, decision: 'approved' | 'rejected') =>
    req<PlanExecutePairT>('POST', `/workforce/plan-execute/${encodeURIComponent(id)}/resolve`, { decision }),

  // ---- workforce: shift-handoff (F2) ----
  /** What the last shift left for the next one, newest first. */
  handoff: (taskId: string, limit?: number) =>
    req<{ memories: AgentMemoryT[] }>('GET', `/workforce/handoff/${encodeURIComponent(taskId)}${query({ limit })}`),
  /** Append-only: a memory is never edited, only followed by a newer one. */
  handoffAppend: (taskId: string, body: AgentMemoryWriteT) =>
    req<AgentMemoryT>('POST', `/workforce/handoff/${encodeURIComponent(taskId)}`, body),

  // ---- workforce: office hours (F3) ----
  /** Both halves in one read: the master switch and every window. */
  officeHours: () => req<{ enabled: boolean; windows: OfficeHourWindowT[] }>('GET', '/workforce/office-hours'),
  officeHoursCreate: (w: OfficeHourCreateT) => req<OfficeHourWindowT>('POST', '/workforce/office-hours', w),
  officeHoursDelete: (id: string) =>
    req<void>('DELETE', `/workforce/office-hours/${encodeURIComponent(id)}`),
  /** Off means no next_fire is ever shifted — the windows stay, they just stop applying. */
  officeHoursSetEnabled: (enabled: boolean) =>
    req<{ enabled: boolean }>('PUT', '/workforce/office-hours/enabled', { enabled }),

  // ---- workforce: sentinels (F4) ----
  // There is no update helper because there is no route to call: the daemon
  // exposes create/list/delete/trips only (daemon api.ts:944-975) and
  // `Sentinels` has no update method either — even though the row carries
  // `enabled` and `updatedAt`, which is exactly what an editor would write.
  // Changing a sentinel today means delete + create; a real edit needs
  // PATCH /workforce/sentinels/:id in the daemon first.
  sentinels: () => req<{ sentinels: SentinelT[] }>('GET', '/workforce/sentinels'),
  sentinelCreate: (s: SentinelCreateT) => req<SentinelT>('POST', '/workforce/sentinels', s),
  sentinelDelete: (id: string) => req<void>('DELETE', `/workforce/sentinels/${encodeURIComponent(id)}`),
  /** Every evaluation, tripped or not — the reason column is why it did nothing. */
  sentinelTrips: (id: string, limit?: number) =>
    req<{ trips: SentinelTripT[] }>('GET', `/workforce/sentinels/${encodeURIComponent(id)}/trips${query({ limit })}`),

  // ---- workforce: repo-shipped jobs (F5) ----
  /** Re-reading a repo is idempotent: an offer's identity is repo + job key. */
  repoJobsDiscover: (repoPath: string) =>
    req<{ offers: RepoJobOfferT[] }>('POST', '/workforce/repo-jobs/discover', { repoPath }),
  repoJobs: (status?: RepoJobStatusT) =>
    req<{ offers: RepoJobOfferT[] }>('GET', `/workforce/repo-jobs${query({ status })}`),
  /** The imported task arrives DISABLED — a repo cannot schedule itself onto your machine. */
  repoJobImport: (id: string) =>
    req<{ taskId: string }>('POST', `/workforce/repo-jobs/${encodeURIComponent(id)}/import`),
  repoJobDismiss: (id: string) =>
    req<{ dismissed: boolean }>('POST', `/workforce/repo-jobs/${encodeURIComponent(id)}/dismiss`),

  // ---- workforce: earned autonomy (F7) ----
  autonomyOffers: (status?: AutonomyOfferStatusT) =>
    req<{ offers: AutonomyOfferT[] }>('GET', `/workforce/autonomy/offers${query({ status })}`),
  /** The only promotion path. A second answer is a 409, not a second promotion. */
  autonomyRespond: (id: string, decision: 'accepted' | 'declined') =>
    req<AutonomyOfferT>('POST', `/workforce/autonomy/offers/${encodeURIComponent(id)}/respond`, { decision }),
  /** Live rung, streak and eligibility for one profile. */
  autonomyProfile: (profileId: string) =>
    req<AutonomyStateT>('GET', `/workforce/autonomy/profiles/${encodeURIComponent(profileId)}`),
  /** Enrolling is a human act, not a promotion: it applies that rung's profile settings and reads no streak. */
  autonomyEnroll: (profileId: string, rung: AutonomyRungT) =>
    req<AutonomyStateT>('POST', `/workforce/autonomy/profiles/${encodeURIComponent(profileId)}/enroll`, { rung }),
  /**
   * Every profile currently ENROLLED in the ladder.
   *
   * The daemon has no list route for this — autonomy state is per profile
   * (GET /workforce/autonomy/profiles/:profileId). GET /profiles is a
   * `SELECT *`, so it already carries migration 0008's `autonomy_rung`, and a
   * null rung is exactly "not enrolled" (autonomy-policy.ts:10). Filtering
   * that one response beats fanning out a request per profile; call
   * `autonomyProfile(id)` for the streak of a specific one.
   */
  autonomyEnrolledProfiles: async (): Promise<AutonomyEnrolledProfileT[]> => {
    const rows = await req<Array<Omit<AutonomyEnrolledProfileT, 'autonomy_rung'> & { autonomy_rung: AutonomyRungT | null }>>(
      'GET',
      '/profiles',
    );
    return rows.filter((p): p is AutonomyEnrolledProfileT => p.autonomy_rung !== null);
  },

  // ---- workforce: timesheets (F10) ----
  /** Defaults to the last 30 days. `to` must be after `from` or the daemon 422s. */
  timesheet: (range: WindowQueryT & { profileId?: string } = {}) =>
    req<TimesheetT>('GET', `/workforce/timesheets${query({ from: range.from, to: range.to, profileId: range.profileId })}`),
  /** The human rate an agent's effective hourly rate is compared against. null clears it. */
  setHumanHourlyRate: (humanHourlyRateUsd: number | null) =>
    req<{ humanHourlyRateUsd: number | null }>('PUT', '/workforce/prefs/hourly-rate', { humanHourlyRateUsd }),

  // ---- workforce: performance reviews (F11) ----
  /** Omit the window and the daemon uses workforce_prefs.review_period_days. */
  performanceCards: (range: WindowQueryT = {}) =>
    req<{ cards: PerformanceScorecardT[] }>('GET', `/workforce/performance${query({ from: range.from, to: range.to })}`),
  performanceCard: (profileId: string, range: WindowQueryT = {}) =>
    req<PerformanceScorecardT>(
      'GET',
      `/workforce/performance/${encodeURIComponent(profileId)}${query({ from: range.from, to: range.to })}`,
    ),
  /** The numbers, rendered as the prompt a reviewer agent is given. */
  performanceReviewPrompt: (profileId: string, range: WindowQueryT = {}) =>
    req<{ prompt: string }>(
      'GET',
      `/workforce/performance/${encodeURIComponent(profileId)}/review-prompt${query({ from: range.from, to: range.to })}`,
    ),

  // ---- workforce: proof-of-work (F12) ----
  /**
   * Address of a run's redacted single-file HTML export.
   *
   * NOT usable as an `<a href>` or an `<iframe src>`: every data route needs
   * the bearer header and the `?token=` path was removed in the S-audit, so a
   * bare link 401s. Use it to show the user where the bytes come from, and
   * fetch them with `proofOfWork()` below.
   */
  proofOfWorkUrl: (runId: string, opts?: ProofOfWorkOptionsT): string => proofOfWorkPath(runId, opts),
  /**
   * The export itself, as a Blob — `text/html`, which the JSON `req` helper
   * cannot carry. Same auth and same ApiError surface as every other call
   * (both go through `send`); the caller decides whether to preview it or
   * hand it to a download link, as ProposedEvents does for its .ics.
   */
  proofOfWork: async (runId: string, opts?: ProofOfWorkOptionsT): Promise<Blob> =>
    (await send('GET', proofOfWorkPath(runId, opts))).blob(),
};

export interface EventStream {
  close(): void;
  onerror: ((e: unknown) => void) | null;
}

/**
 * Live daemon events.
 *
 * S-audit: this used `EventSource`, which cannot set headers, so the bearer
 * token rode in the query string — where it reaches proxy logs, browser
 * history and Referer headers. Streaming the response body via `fetch`
 * carries a real Authorization header instead, at the cost of reimplementing
 * the reconnect that EventSource gave for free (below, with backoff).
 */
export function openEventStream(onEvent: (e: any) => void): EventStream {
  let closed = false;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let connecting = false;
  const handle: EventStream = {
    close() {
      closed = true;
      if (timer) clearTimeout(timer); // S-review: don't leave a live timer behind
      timer = null;
      ctrl?.abort();
    },
    onerror: null,
  };

  const retry = (delay: number): void => {
    if (closed) return;
    if (timer) clearTimeout(timer); // S-review: never schedule two reconnects
    timer = setTimeout(() => void connect(delay), delay);
  };

  const emit = (raw: string): void => {
    try {
      const parsed = JSON.parse(raw);
      // fan-out for any component that needs SSE without prop drilling
      window.dispatchEvent(new CustomEvent('clockwork:sse', { detail: parsed }));
      onEvent(parsed);
    } catch {}
  };

  const connect = async (backoff: number): Promise<void> => {
    if (closed || connecting) return; // S-review: no overlapping streams
    connecting = true;
    ctrl = new AbortController();
    try {
      const used = getToken();
      const res = await fetch('/events', {
        headers: { Authorization: `Bearer ${used}` },
        signal: ctrl.signal,
      });
      // S-review: a rejected credential is not a transient fault. Retrying it
      // forever would hammer the daemon and hide the real problem from the
      // user, who needs to re-enter a token — so stop and surface it.
      if (res.status === 401 || res.status === 403) {
        // A rotation in ANOTHER window writes the new token to shared
        // localStorage. getToken() re-reads per call, so if it has changed
        // since this request was sent, reconnect once with the fresh
        // credential rather than stranding this tab's stream.
        if (getToken() !== used) {
          connecting = false;
          void connect(1000);
          return;
        }
        handle.onerror?.(new Error(`events unauthorized (${res.status})`));
        return;
      }
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // S-review: the stream is up, so the next failure starts from 1s again
      // rather than inheriting an escalated delay forever after one blip.
      backoff = 1000;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // S-review: normalise CRLF — our daemon writes \n, but a proxy or a
        // different server may not, and \r\n\r\n contains no \n\n to split on.
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        // SSE frames are separated by a blank line; a frame may carry several
        // `data:` lines, and a chunk may split mid-frame — hence the buffer.
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) emit(line.slice(5).trim());
          }
          sep = buf.indexOf('\n\n');
        }
      }
      // Server closed a healthy stream — reconnect promptly.
      retry(1000);
    } catch (e) {
      if (closed) return; // abort() during close is not an error
      handle.onerror?.(e);
      retry(Math.min(backoff * 2, 30_000));
    } finally {
      connecting = false;
    }
  };

  void connect(1000);
  return handle;
}
