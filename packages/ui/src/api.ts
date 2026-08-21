/**
 * Daemon API client — pure client (arch §6): everything goes through
 * REST + SSE with the bearer token. No direct DB writes for run state.
 */
const TOKEN_KEY = 'clockwork.token';

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${getToken()}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as any).error ?? `${res.status}`);
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

export const api = {
  health: () => req<Health>('GET', '/health'),
  tasks: () => req<TaskViewT[]>('GET', '/tasks'),
  createTask: (t: unknown) => req<TaskViewT>('POST', '/tasks', t),
  patchTask: (id: string, p: unknown) => req<TaskViewT>('PATCH', `/tasks/${id}`, p),
  deleteTask: (id: string) => req<{ deleted: boolean }>('DELETE', `/tasks/${id}`),
  runNow: (id: string) => req<{ runId: string }>('POST', `/tasks/${id}/run-now`),
  runs: (filter: { state?: string; taskId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (filter.state) qs.set('state', filter.state);
    if (filter.taskId) qs.set('taskId', filter.taskId);
    if (filter.limit) qs.set('limit', String(filter.limit));
    return req<RunRowT[]>('GET', `/runs?${qs}`);
  },
  report: (runId: string) =>
    req<{ run: RunRowT; report: any }>('GET', `/runs/${runId}/report`),
  cancelRun: (id: string) => req<unknown>('POST', `/runs/${id}/cancel`),
  profiles: () => req<any[]>('GET', '/profiles'),
  search: (q: string, kind?: string) =>
    req<Array<{ kind: string; ref_id: string; title: string; snip: string }>>(
      'GET',
      `/search?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ''}`,
    ),
  snapshot: () => req<any>('GET', '/widget/snapshot'),
  pauseAll: () => req<{ paused: boolean }>('POST', '/pause-all'),
  resume: () => req<{ paused: boolean }>('POST', '/resume'),
};

export function openEventStream(onEvent: (e: any) => void): EventSource {
  const es = new EventSource(`/events?token=${encodeURIComponent(getToken())}`);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {}
  };
  return es;
}
