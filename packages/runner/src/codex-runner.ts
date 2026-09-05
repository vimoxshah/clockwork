/**
 * CodexRunner — provider 'codex' (ADR-026): spawns `codex exec --json` in the
 * run worktree. Stream shape verified empirically against codex-cli 0.147.0:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"item.completed","item":{type:"agent_message",text:"..."|...}}
 *   {"type":"turn.completed"} / {"type":"token_count","info":{...}}
 *   {"type":"turn.failed","error":{"message":"..."}}
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { BudgetGuard } from './budget-guard.js';
import { classifyError } from './stream-parser.js';
import { buildRunEnv } from './run-env.js';
import { applySandbox, toolCacheEnv, type SandboxSpec } from './sandbox.js';
import type {
  AgentRunner,
  JobContext,
  JobSpecLike,
  RunOutcome,
} from '@clockwork/shared';

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

export class CodexRunner implements AgentRunner {
  readonly engine = 'codex' as const;
  private livePgids = new Set<number>();

  constructor(private readonly opts: { graceMs?: number; sandbox?: SandboxSpec | null } = {}) {}

  async start(job: JobSpecLike, ctx: JobContext): Promise<RunOutcome> {
    return this.execute(job, ctx);
  }

  /** Fresh-session fallback (same semantics as CLI resume). */
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
      const startedAtMs = Date.now();
      const guard = new BudgetGuard(
        { maxUsd: job.budget.maxUsd, maxTurns: job.budget.maxTurns },
        { onLog: (l) => ctx.io.onLog(l) },
      );

      // Exactly one Seatbelt layer. macOS refuses to apply codex's own
      // `workspace-write` profile inside Clockwork's deny-default profile
      // (`sandbox_apply: Operation not permitted`, probed 2026-09-05), so when
      // ours is on, codex's is off and ours is the containment. Only with
      // CW_SANDBOX=off does codex fall back to its own sandbox.
      const innerSandbox = this.opts.sandbox ? 'danger-full-access' : 'workspace-write';
      const argv = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-s',
        innerSandbox,
        ...(job.model ? ['-c', `model="${job.model}"`] : []),
        buildPrompt(job),
      ];
      const env = buildRunEnv(toolCacheEnv());

      let wrapped: string[];
      try {
        wrapped = applySandbox(['codex', ...argv], this.opts.sandbox).argv;
      } catch (e) {
        resolve({ state: 'failed', failureReason: 'internal', summary: `sandbox profile refused: ${String(e)}`, artifacts: [], costUsd: 0, turns: 0 });
        return;
      }
      const child: ChildProcess = spawn(wrapped[0]!, wrapped.slice(1), {
        cwd: path.join(ctx.worktreePath),
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!child.pid) {
        resolve({
          state: 'failed',
          failureReason: 'runner_crashed',
          summary: 'spawn failed (is codex installed?)',
          artifacts: [],
          costUsd: 0,
          turns: 0,
        });
        return;
      }
      const pgid = child.pid;
      this.livePgids.add(pgid);
      ctx.io.onHeartbeat();

      const stopFor = (reason: 'timeout' | 'budget' | 'cancel'): void => {
        killGroup(pgid, 'SIGTERM');
        setTimeout(() => killGroup(pgid, 'SIGKILL'), this.opts.graceMs ?? GRACE_MS);
        void reason;
      };
      const timeoutTimer = setTimeout(() => stopFor('timeout'), job.budget.timeoutSec * 1000);
      const onAbort = (): void => stopFor('cancel');
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      let buf = '';
      let sessionId: string | undefined;
      let summary = '';
      let lastError: { cls: string; message: string } | null = null;
      let turns = 0;
      let stoppedByGuard: false | 'budget_exceeded' | 'max_turns' = false;

      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        ctx.io.onLog(line.slice(0, 300));
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        switch (o.type) {
          case 'thread.started':
            sessionId = o.thread_id ?? undefined;
            break;
          case 'item.completed': {
            const item = o.item ?? {};
            if (item.type === 'agent_message' && typeof item.text === 'string') {
              summary = item.text;
              turns++;
            }
            break;
          }
          case 'token_count':
          case 'turn.completed':
          case 'item.updated': {
            turns++;
            const usage = o.usage ?? o.info ?? {};
            const cost =
              typeof usage.total_cost_usd === 'number'
                ? usage.total_cost_usd
                : typeof usage.cost_usd === 'number'
                  ? usage.cost_usd
                  : guard.snapshot.costUsd;
            ctx.io.onUsage({ costUsd: cost, turns });
            ctx.io.onHeartbeat();
            if (!stoppedByGuard && guard.observe(cost, turns)) {
              stoppedByGuard = guard.snapshot.stopped || 'budget_exceeded';
              stopFor('budget');
            }
            break;
          }
          case 'turn.failed':
          case 'error': {
            const message = String(o.error?.message ?? o.message ?? 'codex error');
            lastError = { cls: classifyError(message) ?? 'other', message };
            break;
          }
        }
      };

      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (c: string) => ctx.io.onLog(c.slice(-300)));

      const heartbeat = setInterval(() => ctx.io.onHeartbeat(), 15_000);

      child.on('close', () => {
        clearInterval(heartbeat);
        clearTimeout(timeoutTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        this.livePgids.delete(pgid);

        const base = {
          sessionId,
          artifacts: [] as string[],
        };
        if (stoppedByGuard === 'max_turns') {
          resolve({ ...base, state: 'failed', failureReason: 'max_turns', summary, costUsd: guard.snapshot.costUsd, turns: guard.snapshot.turns });
          return;
        }
        if (stoppedByGuard === 'budget_exceeded') {
          resolve({ ...base, state: 'budget_exceeded', failureReason: undefined as unknown as string, summary, costUsd: guard.snapshot.costUsd, turns: guard.snapshot.turns } as RunOutcome);
          return;
        }
        if (lastError) {
          resolve({
            ...base,
            state: 'failed',
            failureReason: lastError.cls === 'other' ? 'internal' : lastError.cls,
            summary: `${summary}\n\n${lastError.message}`.trim(),
            costUsd: guard.snapshot.costUsd,
            turns,
          });
          return;
        }
        resolve({
          ...base,
          state: 'completed',
          summary: summary || '(no structured summary returned)',
          costUsd: guard.snapshot.costUsd,
          turns,
        });
        void startedAtMs;
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
