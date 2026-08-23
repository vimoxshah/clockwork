/**
 * HermesRunner — provider 'hermes' (ADR-026 extension): spawns Nous Research's
 * Hermes Agent one-shot mode `hermes -z <prompt>` in the run worktree.
 *
 * Interfaces verified empirically against hermes 0.20.5 (2026.8):
 *  - `hermes -z "<prompt>"` → final assistant text ONLY on stdout (pure one-shot;
 *    no banner/spinner/session line). `--cli` forces CLI toolsets in TUI-less contexts.
 *  - `--usage-file <path>` → JSON report after the run: estimated_cost_usd,
 *    total_tokens, api_calls, model, provider, completed/failed booleans.
 *  - `--model` / `--provider` per-run overrides exist but Clockwork uses the
 *    user's configured default (their login/config — same no-API-key philosophy).
 *  - Session cwd restore: without `--no-restore-cwd`, hermes may chdir back to a
 *    previous session's directory — we always pass it so `cwd:` sticks.
 *  - No interactive approvals exist in one-shot mode → unattended fail-safe is
 *    inherent; Clockwork's deny-list floor applies via prompt contract instead.
 *
 * Supervision mirrors OpenCodeRunner: own process group, SIGTERM→grace→SIGKILL,
 * wall-clock timeout, abort-signal cancellation.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { augmentedPath } from './service-path.js';
import type { AgentRunner, JobContext, JobSpecLike, RunOutcome } from '@clockwork/shared';

const GRACE_MS = 30_000;

interface HermesUsage {
  estimated_cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  api_calls?: number;
  model?: string;
  provider?: string;
  session_id?: string;
  completed?: boolean;
  failed?: boolean;
}

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    try {
      process.kill(pgid, sig);
    } catch {}
  }
}

export class HermesRunner implements AgentRunner {
  readonly engine = 'hermes' as const;
  private livePgids = new Set<number>();

  constructor(
    private readonly opts: { graceMs?: number; hermesBin?: string } = {},
  ) {}

  async start(job: JobSpecLike, ctx: JobContext): Promise<RunOutcome> {
    return this.execute(job, ctx);
  }

  async resume(sessionRef: string, job: JobSpecLike, ctx: JobContext): Promise<RunOutcome> {
    void sessionRef; // one-shot mode has no resumable session artifact
    return this.execute(job, ctx);
  }

  async cancel(): Promise<void> {
    for (const pgid of this.livePgids) {
      killGroup(pgid, 'SIGTERM');
      setTimeout(() => killGroup(pgid, 'SIGKILL'), this.opts.graceMs ?? GRACE_MS);
    }
  }

  private execute(job: JobSpecLike, ctx: JobContext): Promise<RunOutcome> {
    return new Promise<RunOutcome>((resolve) => {
      const usagePath = path.join(mkdtempSync(path.join(os.tmpdir(), 'cw-hermes-')), 'usage.json');
      const argv = [
        '-z',
        buildPrompt(job),
        '--cli',
        '--no-restore-cwd',
        '--usage-file',
        usagePath,
      ];
      if (job.profile?.systemPromptExtra) {
        // Hermes has no append-system-prompt equivalent; prepend as operating instructions.
        argv[1] = `${job.profile.systemPromptExtra}\n\n---\n\n${argv[1]}`;
      }
      const bin = this.opts.hermesBin ?? 'hermes';
      const child: ChildProcess = spawn(bin, argv, {
        cwd: ctx.worktreePath,
        env: {
          PATH: augmentedPath(process.env.PATH),
          HOME: process.env.HOME ?? os.homedir(),
          TERM: 'dumb',
          NO_COLOR: '1',
          LANG: process.env.LANG ?? 'en_US.UTF-8',
          HERMES_NONINTERACTIVE: '1',
          ...(process.env.USER ? { USER: process.env.USER } : {}),
          ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!child.pid) {
        cleanup();
        resolve({
          state: 'failed',
          failureReason: 'runner_crashed',
          summary: 'spawn failed (is hermes installed?)',
          artifacts: [],
          costUsd: 0,
          turns: 0,
        });
        return;
      }
      const pgid = child.pid;
      this.livePgids.add(pgid);
      ctx.io.onHeartbeat();

      const stopFor = (): void => {
        killGroup(pgid, 'SIGTERM');
        setTimeout(() => killGroup(pgid, 'SIGKILL'), this.opts.graceMs ?? GRACE_MS);
      };
      const timeoutTimer = setTimeout(() => stopFor(), job.budget.timeoutSec * 1000);
      const onAbort = (): void => stopFor();
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      let stdoutAll = '';
      let stderrTail = '';

      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (c: string) => {
        stdoutAll += c;
        if (stdoutAll.length % 2048 < c.length) ctx.io.onHeartbeat();
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (c: string) => {
        stderrTail = (stderrTail + c).slice(-4000);
        ctx.io.onHeartbeat();
      });

      child.on('close', (code) => {
        clearTimeout(timeoutTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        this.livePgids.delete(pgid);

        let usage: HermesUsage | null = null;
        try {
          usage = JSON.parse(readFileSync(usagePath, 'utf8')) as HermesUsage;
        } catch {}
        cleanup();

        const summary = stdoutAll.trim();
        const cancelled = ctx.signal.aborted || code === 143 || code === 137;

        if (cancelled) {
          resolve({
            state: 'cancelled',
            summary: summary.slice(0, 400),
            artifacts: [],
            costUsd: usage?.estimated_cost_usd ?? 0,
            turns: Math.max(1, usage?.api_calls ?? 1),
          });
          return;
        }
        if ((code !== 0 && !summary) || usage?.failed === true) {
          resolve({
            state: 'failed',
            failureReason: classifyExit(code, stderrTail, summary),
            summary: (summary || stderrTail).slice(-400),
            artifacts: [],
            costUsd: usage?.estimated_cost_usd ?? 0,
            turns: Math.max(1, usage?.api_calls ?? 1),
          });
          return;
        }
        resolve({
          state: 'completed',
          sessionId: usage?.session_id ? String(usage.session_id) : undefined,
          summary: summary || '(no output returned)',
          artifacts: [],
          costUsd: usage?.estimated_cost_usd ?? 0,
          turns: Math.max(1, usage?.api_calls ?? 1),
        });
      });

      function cleanup(): void {
        try {
          rmSync(path.dirname(usagePath), { recursive: true, force: true });
        } catch {}
      }
    });
  }
}

function buildPrompt(job: JobSpecLike): string {
  return (
    job.prompt +
    '\n\n(You are running unattended inside an isolated Clockwork worktree.)\n\n# Output contract\nEnd your final response with a line exactly like:\nSUMMARY: <one-paragraph human summary>\n'
  );
}

function classifyExit(code: number | null, stderrTail: string, stdout: string): string {
  void code;
  const m = `${stderrTail}\n${stdout}`.toLowerCase();
  if (m.includes('unauthorized') || m.includes('not authenticated') || m.includes('login required')) return 'auth';
  if (m.includes('spend limit') || m.includes('usage limit') || m.includes('rate limit') || m.includes('quota')) return 'capacity';
  if (m.includes('enotfound') || m.includes('econnrefused') || m.includes('network')) return 'offline';
  return 'internal';
}
