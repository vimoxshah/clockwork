#!/usr/bin/env node
/**
 * `clockwork` terminal CLI (P5): a thin, scriptable reader over the loopback
 * API the GUI already uses. No new routes, no new auth: the same 0600
 * api-token file, the same bearer header, the same refusal codes — so
 * anything this CLI can do, the app can do, and vice versa.
 *
 * Scriptability contract: `--json` prints exactly one JSON value to stdout
 * (errors go to stderr); exit codes are stable (see HELP). Human tables go
 * to stdout too, but only without --json — never mix the two.
 */
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_UNREACHABLE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_REFUSED = 4;

export interface CliTransport {
  fetchJson(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>;
  out(s: string): void;
  err(s: string): void;
}

export function dataDir(): string {
  return process.env.CLOCKWORK_HOME ?? path.join(os.homedir(), '.clockwork');
}

export function readToken(dir: string = dataDir()): string | null {
  try {
    const p = path.join(dir, 'api-token');
    if (!existsSync(p)) return null;
    const t = readFileSync(p, 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

export function baseUrl(port?: number): string {
  const p = port ?? Number(process.env.CLOCKWORK_PORT ?? 4747);
  return `http://127.0.0.1:${p}`;
}

function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Full id when short, visibly truncated when not — copy-paste never silently breaks. */
function shortId(s: string): string {
  return s.length <= 12 ? s : `${s.slice(0, 8)}…`;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

export const HELP = `clockwork — Clockwork on the terminal (reads the local daemon on 127.0.0.1).

Usage: clockwork [--port N] [--json] <command> [args]

Commands:
  status                 daemon version, pause state, active/queued counts, next fire
  runs [--limit N]       recent runs: id, task, state, cost, age
  show <run-id>          one run's report: summary, branch, cost/turns
  tasks                  tasks: name, state, next fire
  queue                  queued work with wait reasons
  agents                 agent profiles: name, engine
  approvals              approvals waiting for a decision
  approve <id> [--deny] [--note TEXT]   answer an approval (default: approve; TEXT is one shell word — quote it)
  run <task-id>          queue a run now
  open <run-id>          print the branch checkout (text only — never launches anything)
  workers                paired workers: name, status, heartbeat

Exit codes: 0 ok · 1 usage/validation · 2 daemon unreachable or not logged in ·
3 not found · 4 refused (gate, conflict) or daemon error (HTTP 5xx, named in
the message). Errors always go to stderr; --json affects command output only
(never --help, never errors) — scripts key on the exit code plus stdout JSON.

Auth: reads ${'~/.clockwork/api-token'} (0600, yours). The token never prints,
even with --json. Port: --port or CLOCKWORK_PORT (default 4747).`;

export async function runCommand(argv: string[], t: CliTransport, port?: number): Promise<number> {
  let json = false;
  let args = [...argv];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--port') {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v <= 0) {
        t.err('error: --port needs a positive integer');
        return EXIT_USAGE;
      }
      port = v;
    } else if (args[i] === '--help' || args[i] === '-h') {
      t.out(HELP);
      return EXIT_OK;
    } else {
      rest.push(args[i]!);
    }
  }
  const emit = (value: unknown, human: string): number => {
    t.out(json ? JSON.stringify(value) : human);
    return EXIT_OK;
  };
  const fail = (status: number, body: any, what: string): number => {
    if (status === 0) {
      t.err(`error: daemon unreachable at ${baseUrl(port)} — is clockworkd running?`);
      return EXIT_UNREACHABLE;
    }
    if (status === 401 || status === 403) {
      t.err('error: daemon refused credentials — re-pair the token (Settings → Security → Rotate access token).');
      return EXIT_UNREACHABLE;
    }
    if (status === 404) {
      t.err(`error: not found (${what})`);
      return EXIT_NOT_FOUND;
    }
    if (status >= 500) {
      const msg = typeof body?.message === 'string' ? body.message : (body?.error ?? 'unknown error');
      t.err(`error: daemon errored (HTTP ${status}): ${msg}`);
      return EXIT_REFUSED;
    }
    const msg = typeof body?.message === 'string' ? body.message : (body?.error ?? `HTTP ${status}`);
    t.err(`error: refused: ${msg}`);
    return EXIT_REFUSED;
  };
  const call = async (method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> => {
    try {
      return await t.fetchJson(method, p, body);
    } catch {
      return { status: 0, json: null };
    }
  };

  const [cmd, ...rest2] = rest;
  switch (cmd) {
    case undefined:
    case 'help': {
      t.out(HELP);
      return EXIT_OK;
    }
    case 'status': {
      const { status, json: h } = await call('GET', '/health');
      if (status !== 200) return fail(status, h, 'health');
      return emit(h, [`clockworkd ${h.daemonVersion ?? '?'}${h.versionSkew ? ' (RESTART NEEDED — build moved ahead)' : ''}`, `paused: ${h.paused ? 'yes' : 'no'} · active: ${h.activeRuns ?? 0} · queued: ${h.queuedRuns ?? 0}`, `next: ${h.nextFire ? fmtTime(h.nextFire) : '—'}`].join('\n'));
    }
    case 'runs': {
      let limit = 20;
      const li = rest2.indexOf('--limit');
      if (li >= 0) {
        limit = Number(rest2[li + 1]);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          t.err('error: --limit needs an integer 1–500');
          return EXIT_USAGE;
        }
      }
      const { status, json: runs } = await call('GET', `/runs?limit=${limit}`);
      if (status !== 200) return fail(status, runs, 'runs');
      const rows = (runs as any[]).map((r) => [shortId(String(r.id)), String(r.state ?? '?'), String(r.task_name ?? r.task_id ?? '?').slice(0, 32), `$${Number(r.cost_usd ?? 0).toFixed(2)}`, fmtTime(r.started_at ?? r.scheduled_for)]);
      return emit(runs, rows.length ? table([['RUN', 'STATUS', 'TASK', 'COST', 'WHEN'], ...rows]) : 'no runs yet');
    }
    case 'show': {
      const id = rest2[0];
      if (!id) {
        t.err('usage: clockwork show <run-id>');
        return EXIT_USAGE;
      }
      const { status, json: rep } = await call('GET', `/runs/${encodeURIComponent(id)}/report`);
      if (status !== 200) return fail(status, rep, `run ${id}`);
      const r = rep.report ?? {};
      return emit(rep, [`${r.taskName ?? id} — ${r.state ?? '?' }`, ``, `${r.summary ?? '(no summary)' }`, ``, `branch: ${r.branch ?? '—'} · cost: $${Number(r.costUsd ?? 0).toFixed(2)} · turns: ${r.turns ?? 0}`].join('\n'));
    }
    case 'tasks': {
      const { status, json: tasks } = await call('GET', '/tasks');
      if (status !== 200) return fail(status, tasks, 'tasks');
      const rows = (tasks as any[]).map((x) => [String(x.name ?? x.id).slice(0, 32), x.enabled ? 'active' : 'paused', x.enabled ? fmtTime(x.nextFire) : '—']);
      return emit(tasks, rows.length ? table([['TASK', 'STATE', 'NEXT'], ...rows]) : 'no tasks yet — book one in the app or a template pack');
    }
    case 'queue': {
      const { status, json: q } = await call('GET', '/queue');
      if (status !== 200) return fail(status, q, 'queue');
      const items = (q as any)?.items ?? q;
      const rows = (Array.isArray(items) ? items : []).map((x: any) => [shortId(String(x.runId ?? x.id ?? '?')), String(x.reason ?? x.waitReason ?? 'waiting').slice(0, 48)]);
      return emit(q, rows.length ? table([['RUN', 'WAITING (reason)'], ...rows]) : 'queue empty');
    }
    case 'agents': {
      const { status, json: profiles } = await call('GET', '/profiles');
      if (status !== 200) return fail(status, profiles, 'profiles');
      const rows = (profiles as any[]).map((p) => [String(p.name ?? p.slug ?? p.id).slice(0, 30), String(p.engine ?? 'cli')]);
      return emit(profiles, rows.length ? table([['AGENT', 'ENGINE'], ...rows]) : 'no profiles');
    }
    case 'approvals': {
      const { status, json: list } = await call('GET', '/approvals');
      if (status !== 200) return fail(status, list, 'approvals');
      const rows = (list as any[]).map((a) => [shortId(String(a.id)), String(a.kind ?? '?'), String(a.run_id ?? '').slice(0, 8), fmtTime(a.requested_at)]);
      return emit(list, rows.length ? table([['ID', 'KIND', 'RUN', 'WAITING SINCE'], ...rows]) : 'nothing waiting — the inbox agrees');
    }
    case 'approve': {
      const id = rest2[0];
      if (!id) {
        t.err('usage: clockwork approve <approval-id> [--deny] [--note TEXT]');
        return EXIT_USAGE;
      }
      const deny = rest2.includes('--deny');
      const ni = rest2.indexOf('--note');
      // Exactly one shell word: a trailing flag after --note is almost
      // certainly a misplaced --deny, not prose — swallowing it would both
      // deny AND record "--deny" as the note.
      let note: string | undefined;
      if (ni >= 0) {
        if (ni + 1 >= rest2.length || rest2[ni + 1]!.startsWith('--')) {
          t.err('usage: clockwork approve <approval-id> [--deny] [--note TEXT] — --note needs a value (quote it)');
          return EXIT_USAGE;
        }
        note = rest2[ni + 1];
      }
      const { status, json: r } = await call('POST', `/approvals/${encodeURIComponent(id)}/respond`, { decision: deny ? 'denied' : 'approved', ...(note ? { note } : {}) });
      if (status !== 200) return fail(status, r, `approval ${id}`);
      return emit(r, deny ? `✗ Denied ${id}` : `✓ Approved ${id}`);
    }
    case 'run': {
      const id = rest2[0];
      if (!id) {
        t.err('usage: clockwork run <task-id>');
        return EXIT_USAGE;
      }
      const { status, json: r } = await call('POST', `/tasks/${encodeURIComponent(id)}/run-now`, {});
      if (status !== 200 && status !== 202) return fail(status, r, `task ${id}`);
      return emit(r, `✓ Run queued${(r as any)?.runId ? ` (${String((r as any).runId).slice(0, 8)})` : ''} — watch the inbox`);
    }
    case 'open': {
      const id = rest2[0];
      if (!id) {
        t.err('usage: clockwork open <run-id>');
        return EXIT_USAGE;
      }
      const { status, json: rep } = await call('GET', `/runs/${encodeURIComponent(id)}/report`);
      if (status !== 200) return fail(status, rep, `run ${id}`);
      const r = rep.report ?? {};
      if (!r.branch) {
        t.err('note: this run left no branch (analysis-only or pruned).');
        return EXIT_NOT_FOUND;
      }
      return emit(rep, [`branch: ${r.branch}`, `worktree: ${r.worktreeState?.path ?? '(pruned — branch survives in the repo)'}`, ``, `git fetch origin && git checkout ${r.branch}`].join('\n'));
    }
    case 'workers': {
      const { status, json: w } = await call('GET', '/workers');
      if (status !== 200) return fail(status, w, 'workers');
      const rows = ((w as any)?.workers ?? []).map((x: any) => [String(x.name).slice(0, 28), x.status === 'paired' ? (x.onlineComputed ? 'online' : 'silent') : String(x.status)]);
      return emit(w, rows.length ? table([['WORKER', 'STATE'], ...rows]) : 'no workers paired — Settings › Workers');
    }
    default: {
      t.err(`unknown command: ${cmd}\n\n${HELP}`);
      return EXIT_USAGE;
    }
  }
}

function realTransport(port?: number): CliTransport & { token: string } {
  const dir = dataDir();
  const token = readToken(dir);
  return {
    token: token ?? '',
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    fetchJson: async (method, p, body) => {
      const res = await fetch(`${baseUrl(port)}${p}`, {
        method,
        headers: {
          authorization: `Bearer ${readToken(dir) ?? ''}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
  };
}

/** Entry: --port is stripped here and passed down, so runCommand never sees
 *  two spellings to disagree on (first-vs-last-wins divergence). */
export async function main(argv: string[]): Promise<number> {
  let port: number | undefined;
  const clean: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      const v = Number(argv[i + 1]);
      if (!Number.isInteger(v) || v <= 0) {
        process.stderr.write('error: --port needs a positive integer\n');
        return EXIT_USAGE;
      }
      port = v;
      i++;
    } else {
      clean.push(argv[i]!);
    }
  }
  if (!readToken()) {
    process.stderr.write(`error: no api token — is clockworkd installed? looked in ${dataDir()}/api-token\n`);
    return EXIT_UNREACHABLE;
  }
  return runCommand(clean, realTransport(port), port);
}

if (process.argv[1] && process.argv[1].endsWith('clockwork-cli.js')) {
  void main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
