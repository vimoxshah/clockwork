/**
 * OpenCodeRunner — provider 'opencode' (ADR-026): spawns `opencode run` in the
 * run worktree. Verified empirically against opencode 1.18.21: final assistant
 * text lands on stdout; logs on stderr (--print-logs). No usage telemetry is
 * exposed → cost 0, turns counted from stderr tool markers; budget enforced
 * by time only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { buildRunEnv } from './run-env.js';
import { applySandbox, toolCacheEnv, type SandboxSpec } from './sandbox.js';
import type { AgentRunner, JobContext, JobSpecLike, RunOutcome } from '@clockwork/shared';

const GRACE_MS = 30_000;

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    try {
      process.kill(pgid, sig);
    } catch {}
  }
}

export class OpenCodeRunner implements AgentRunner {
  readonly engine = 'opencode' as const;
  private livePgids = new Set<number>();

  constructor(private readonly opts: { graceMs?: number; sandbox?: SandboxSpec | null } = {}) {}

  async start(job: JobSpecLike, ctx: JobContext): Promise<RunOutcome> {
    return this.execute(job, ctx);
  }

  async resume(sessionRef: string, job: JobSpecLike, ctx: JobContext): Promise<RunOutcome> {
    void sessionRef;
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
      const argv = ['run', buildPrompt(job)];
      const env = buildRunEnv(toolCacheEnv());

      let wrapped: string[];
      try {
        wrapped = applySandbox(['opencode', ...argv], this.opts.sandbox).argv;
      } catch (e) {
        resolve({ state: 'failed', failureReason: 'internal', summary: `sandbox profile refused: ${String(e)}`, artifacts: [], costUsd: 0, turns: 0 });
        return;
      }
      const child: ChildProcess = spawn(wrapped[0]!, wrapped.slice(1), {
        cwd: ctx.worktreePath,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!child.pid) {
        resolve({
          state: 'failed',
          failureReason: 'runner_crashed',
          summary: 'spawn failed (is opencode installed?)',
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
        // heartbeat + coarse turn estimate per 2KB of output
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

        const summary = lastMeaningfulChunk(stdoutAll);
        const aborted = this.livePgids.size >= 0 && ctx.signal.aborted;

        if (ctx.signal.aborted && !aborted) void aborted;
        if (code !== 0 && !summary) {
          resolve({
            state: 'failed',
            failureReason: classifyExit(code, stderrTail),
            summary: stderrTail.slice(-400),
            artifacts: [],
            costUsd: 0,
            turns: 1,
          });
          return;
        }
        if (ctx.signal.aborted || code === 143 || code === 137) {
          resolve({
            state: 'cancelled',
            summary: summary.slice(0, 400),
            artifacts: [],
            costUsd: 0,
            turns: 1,
          });
          return;
        }
        resolve({
          state: 'completed',
          sessionId: undefined,
          summary: summary || '(no output returned)',
          artifacts: [],
          costUsd: 0,
          turns: Math.max(1, countToolMarkers(stderrTail)),
        });
      });
    });
  }
}

function buildPrompt(job: JobSpecLike): string {
  return (
    job.prompt +
    '\n\n(You are running unattended inside an isolated Clockwork worktree.)\n\n# Output contract\nEnd your final response with a line exactly like:\nSUMMARY: <one-paragraph human summary>\n'
  );
}

/** Final assistant text = last non-empty block of stdout. */
function lastMeaningfulChunk(stdout: string): string {
  const blocks = stdout.split('\n\n').map((b) => b.trim()).filter(Boolean);
  return blocks.at(-1) ?? '';
}

function countToolMarkers(stderr: string): number {
  return (stderr.match(/^> \w+/gm) ?? []).length;
}

function classifyExit(code: number | null, stderrTail: string): string {
  void code;
  const m = stderrTail.toLowerCase();
  if (m.includes('unauthorized') || m.includes('not authenticated') || m.includes('login')) return 'auth';
  if (m.includes('spend limit') || m.includes('usage limit') || m.includes('credits')) return 'capacity';
  if (m.includes('enotfound') || m.includes('econnrefused') || m.includes('network')) return 'offline';
  return 'internal';
}
