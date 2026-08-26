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

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    const details = (err as any).details;
    throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg), details);
  }
  return res.json() as Promise<T>;
}

export interface Health {
  ok: boolean;
  apiVersion: number;
  daemonVersion: string;
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
    req<{ from: number; to: number; runs: RunRowT[]; bookings: Array<{ taskId: string; name: string; at: number; kind: 'booking' }>; humans?: Array<{ uid: string; name: string; at: number; allDay: boolean }> }>(
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
    }>('GET', '/onboarding/status'),
  runs: (filter: { state?: string; taskId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (filter.state) qs.set('state', filter.state);
    if (filter.taskId) qs.set('taskId', filter.taskId);
    if (filter.limit) qs.set('limit', String(filter.limit));
    return req<RunRowT[]>('GET', `/runs?${qs}`);
  },
  report: (runId: string) => req<{ run: RunRowT; report: any }>('GET', `/runs/${runId}/report`),
  transcript: (runId: string) =>
    req<{ available: boolean; totalLines?: number; lines: string[] }>(
      'GET',
      `/runs/${runId}/transcript`,
    ),
  cancelRun: (id: string) => req<unknown>('POST', `/runs/${id}/cancel`),
  approvals: () => req<any[]>('GET', '/approvals'),
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
};

export function openEventStream(onEvent: (e: any) => void): EventSource {
  const es = new EventSource(`/events?token=${encodeURIComponent(getToken())}`);
  es.onmessage = (m) => {
    try {
      const parsed = JSON.parse(m.data);
      // fan-out for any component that needs SSE without prop drilling
      window.dispatchEvent(new CustomEvent('clockwork:sse', { detail: parsed }));
      onEvent(parsed);
    } catch {}
  };
  return es;
}
