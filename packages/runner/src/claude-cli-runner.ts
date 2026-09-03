/**
 * ClaudeCliRunner — the DEFAULT engine (ADR-016): spawns headless Claude Code
 * `claude -p --output-format stream-json` riding the user's existing Claude
 * Code subscription login. No API key required.
 *
 * Supervision: own process group; identity-verified kill (pid+pgid+start-time,
 * never bare pids); SIGTERM -> 30s grace -> SIGKILL (S-13). Sanitized env
 * (arch §7.3). Optional Seatbelt wrap (T-111). On-disk progress journal so a
 * report survives process death (ADR-011).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentRunner,
  JobContext,
  JobSpecLike,
  RunOutcome,
} from '@clockwork/shared';
import { BudgetGuard } from './budget-guard.js';
import { fold, newAccumulator, parseStreamLine } from './stream-parser.js';
import { generateSeatbeltProfile, wrapWithSandbox, type SandboxSpec } from './sandbox.js';
import { buildRunEnv } from './run-env.js';

const GRACE_MS = 30_000;
const DEFAULT_DISK_FLOOR_BYTES = 2 * 1024 * 1024 * 1024; // S-88

export interface CliRunnerOptions {
  claudeBin?: string;
  /** when provided, spawn inside sandbox-exec with this spec */
  sandbox?: SandboxSpec | null;
  diskFloorBytes?: number;
  /** injectable clock for tests */
  now?: () => number;
  /** override SIGTERM→SIGKILL grace for tests (default 30s per S-13) */
  graceMs?: number;
}

interface LiveRun {
  child: ChildProcess;
  pid: number;
  pgid: number;
  startedAtMs: number;
  aborted: boolean;
  abortReason?: 'cancel' | 'timeout' | 'budget' | 'turns';
}

export class ClaudeCliRunner implements AgentRunner {
  readonly engine = 'cli' as const;
  private live: LiveRun | null = null;
  private readonly bin: string;
  private readonly graceMs: number;

  constructor(private readonly opts: CliRunnerOptions = {}) {
    this.bin = opts.claudeBin ?? 'claude';
    this.graceMs = opts.graceMs ?? GRACE_MS;
  }

  /** R-2: record CLI version per run for the contract matrix trail. */
  cliVersion(): string | null {
    try {
      return execFileSync(this.bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
    } catch {
      return null;
    }
  }

  async start(job: JobSpecLike, ctx: JobContext): Promise<RunOutcome> {
    return this.execute(job, ctx);
  }

  async resume(sessionRef: string, job: JobSpecLike, ctx: JobContext): Promise<RunOutcome> {
    // Fallback-only path (ADR-014): restarts a turn with the session ref.
    return this.execute(job, ctx, sessionRef);
  }

  private async execute(job: JobSpecLike, ctx: JobContext, resumeSession?: string): Promise<RunOutcome> {
    const now = this.opts.now ?? (() => Date.now());
    const startedAtMs = now();
    const guard = new BudgetGuard(
      { maxUsd: job.budget.maxUsd, maxTurns: job.budget.maxTurns },
      { onLog: (l) => ctx.io.onLog(l) },
    );

    const journalPath = path.join(os.tmpdir(), `cw-journal-${job.runId}.jsonl`);
    writeJournal(journalPath, { at: now(), kind: 'start', runId: job.runId });

    const argv = [
      '-p',
      buildPrompt(job),
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      mapPermissionMode(job.permissionMode),
    ];
    if (job.model) argv.push('--model', job.model);
    if (resumeSession) argv.push('--resume', resumeSession);
    if (job.profile?.systemPromptExtra) {
      argv.push('--append-system-prompt', job.profile.systemPromptExtra);
    }
    if (typeof job.budget.maxTurns === 'number' && job.budget.maxTurns > 0) {
      // belt-and-braces: let the CLI enforce turns too
      argv.push('--max-turns', String(job.budget.maxTurns));
    }

    let fullArgv = [this.bin, ...argv];
    let sandboxProfilePath: string | null = null;
    if (this.opts.sandbox) {
      try {
        const { profile } = generateSeatbeltProfile(this.opts.sandbox);
        sandboxProfilePath = path.join(mkdtempSync(path.join(os.tmpdir(), 'cw-sb-')), 'profile.sb');
        writeFileSync(sandboxProfilePath, profile, 'utf8');
        fullArgv = wrapWithSandbox(fullArgv, sandboxProfilePath);
      } catch (e) {
        ctx.io.onLog(`[sandbox] profile generation failed: ${String(e)}`);
        return fail('failed', 'internal', now() - startedAtMs, journalPath, String(e));
      }
    }

    // Sanitized env: only what Node + the CLI genuinely need (arch §7.3).
    // The allowlist itself lives in run-env.ts — see that file for why this is
    // a security boundary and not a convenience.
    const env = buildRunEnv({ SHELL: '/bin/zsh' });

    const child = spawn(fullArgv[0]!, fullArgv.slice(1), {
      cwd: ctx.worktreePath,
      env,
      detached: true, // own pgid — identity-verified group kill (S-13/S-31)
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child.pid) {
      return fail('failed', 'runner_crashed', now() - startedAtMs, journalPath, 'spawn failed');
    }
    const pgid = child.pid; // detached => pgid == child pid
    this.live = { child, pid: child.pid, pgid, startedAtMs, aborted: false };
    ctx.io.onHeartbeat();
    writeJournal(journalPath, { at: now(), kind: 'spawned', pid: child.pid, pgid });

    const acc = newAccumulator();
    const stdoutStream = createWriteStream(`${journalPath}.stdout`, { flags: 'a' });
    let stderrTail = '';
    let diskFullStop = false;

    const diskTimer = setInterval(() => {
      try {
        const s = statfsSync(ctx.worktreePath);
        if (s.bavail * s.bsize < (this.opts.diskFloorBytes ?? DEFAULT_DISK_FLOOR_BYTES)) {
          diskFullStop = true;
          writeJournal(journalPath, { at: now(), kind: 'disk_floor_hit' });
          killGroup(pgid, 'SIGTERM'); // graceful stop; S-88
        }
      } catch {
        /* transient stat failure is not fatal */
      }
    }, 15_000);

    const timeoutTimer = setTimeout(() => {
      if (this.live && !this.live.aborted) {
        this.live.aborted = true;
        this.live.abortReason = 'timeout';
        writeJournal(journalPath, { at: now(), kind: 'timeout_sigterm' });
        killGroup(pgid, 'SIGTERM');
        setTimeout(() => {
          if (this.live?.aborted) killGroup(pgid, 'SIGKILL');
        }, this.graceMs);
      }
    }, job.budget.timeoutSec * 1000);

    ctx.signal.addEventListener(
      'abort',
      () => {
        if (this.live) {
          this.live.aborted = true;
          this.live.abortReason = 'cancel';
          killGroup(pgid, 'SIGTERM');
          setTimeout(() => {
            if (this.live?.aborted) killGroup(pgid, 'SIGKILL');
          }, this.graceMs);
        }
      },
      { once: true },
    );

    const outcome = await new Promise<RunOutcome>((resolve) => {
      let lineBuf = '';
      const handleLine = (line: string) => {
        stdoutStream.write(line + '\n');
        appendFileSync(journalPath, JSON.stringify({ at: now(), kind: 'line', line: line.slice(0, 2000) }) + '\n');
        const ev = parseStreamLine(line);
        if (!ev) return;
        if (ev.rateLimitInfo) ctx.io.onRateLimit?.(ev.rateLimitInfo);
        const usageDelta = fold(acc, ev);
        if (usageDelta) {
          ctx.io.onUsage(usageDelta);
          ctx.io.onHeartbeat();
          if (guard.observe(usageDelta.costUsd, usageDelta.turns) && this.live && !this.live.aborted) {
            this.live.aborted = true;
            this.live.abortReason =
              guard.snapshot.stopped === 'max_turns' ? 'turns' : 'budget';
            killGroup(pgid, 'SIGTERM');
            setTimeout(() => {
              if (this.live?.aborted) killGroup(pgid, 'SIGKILL');
            }, this.graceMs);
          }
        }
      };

      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        lineBuf += chunk;
        let idx: number;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          handleLine(line);
        }
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-4000);
      });

      const heartbeat = setInterval(() => ctx.io.onHeartbeat(), 15_000);

      child.on('error', (err) => {
        clearInterval(heartbeat);
        clearInterval(diskTimer);
        clearTimeout(timeoutTimer);
        resolve(fail('failed', 'runner_crashed', now() - startedAtMs, journalPath, String(err)));
      });

      child.on('close', (code, signal) => {
        clearInterval(heartbeat);
        clearInterval(diskTimer);
        clearTimeout(timeoutTimer);
        guard.finalize(acc.totalCostUsd);

        const base = {
          sessionId: acc.sessionId,
          summary: acc.lastResult ?? '',
          transcriptPath: `${journalPath}.stdout`,
          artifacts: [] as string[],
        };

        if (diskFullStop) {
          resolve({ ...base, state: 'failed', failureReason: 'disk_full', costUsd: acc.totalCostUsd, turns: acc.turns });
          return;
        }
        if (this.live?.aborted && this.live.abortReason === 'timeout') {
          resolve({ ...base, state: 'timed_out', costUsd: acc.totalCostUsd, turns: acc.turns }); // S-13
          return;
        }
        if (guard.snapshot.stopped === 'max_turns') {
          // guard counts = enforcement point; trailing grace-window events excluded
          resolve({ ...base, state: 'failed', failureReason: 'max_turns', costUsd: guard.snapshot.costUsd, turns: guard.snapshot.turns });
          return;
        }
        if (guard.snapshot.stopped === 'budget_exceeded') {
          resolve({ ...base, state: 'budget_exceeded', costUsd: acc.totalCostUsd /* incl. overshoot */, turns: guard.snapshot.turns });
          return;
        }
        if ((this.live?.aborted && this.live.abortReason === 'cancel') || signal) {
          resolve({ ...base, state: 'cancelled', costUsd: acc.totalCostUsd, turns: acc.turns });
          return;
        }
        if (acc.lastError) {
          resolve({
            ...base,
            state: 'failed',
            failureReason: acc.lastError.class === 'other' ? 'internal' : acc.lastError.class,
            costUsd: acc.totalCostUsd,
            turns: acc.turns,
          });
          return;
        }
        if (code !== 0) {
          resolve({ ...base, state: 'failed', failureReason: 'runner_crashed', costUsd: acc.totalCostUsd, turns: acc.turns });
          return;
        }
        writeJournal(journalPath, { at: now(), kind: 'done' });
        resolve({
          state: 'completed',
          sessionId: acc.sessionId,
          summary: acc.lastResult ?? '(no structured summary returned)',
          transcriptPath: `${journalPath}.stdout`,
          artifacts: [],
          costUsd: acc.totalCostUsd,
          turns: acc.turns,
        });
        void stderrTail; // surfaced by daemon from journal/transcript on failure paths
      });
    });

    void stdoutStream.end();
    this.live = null;
    return outcome;
  }

  async cancel(sessionRef: string | undefined): Promise<void> {
    void sessionRef;
    if (this.live) {
      this.live.aborted = true;
      this.live.abortReason = 'cancel';
      killGroup(this.live.pgid, 'SIGTERM');
      setTimeout(() => {
        if (this.live?.aborted) killGroup(this.live.pgid, 'SIGKILL');
      }, this.graceMs);
    }
  }
}

function buildPrompt(job: JobSpecLike): string {
  const parts: string[] = [job.prompt];
  if (job.profile?.skills.length) {
    parts.push(
      `\n\n(Clockwork: the skills ${job.profile.skills.map((s) => `${s.name}@${s.version}`).join(', ')} are materialized in .claude/skills/ for this run.)`,
    );
  }
  return parts.join('');
}

function mapPermissionMode(mode: string): string {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'default':
      return 'default';
    case 'acceptEdits':
    default:
      return 'acceptEdits';
  }
}

/** POSIX group kill; identity verified upstream via (pid, pgid, proc_started_at). */
function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    try {
      process.kill(pgid, sig);
    } catch {
      /* already dead */
    }
  }
}

function fail(state: RunOutcome['state'], reason: string, _ms: number, journalPath: string, message: string): RunOutcome {
  return {
    state,
    failureReason: reason,
    summary: message,
    transcriptPath: journalPath,
    artifacts: [],
    costUsd: 0,
    turns: 0,
  };
}

function writeJournal(p: string, obj: unknown): void {
  try {
    appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
  } catch {
    /* never crash the runner on journal IO */
  }
}
