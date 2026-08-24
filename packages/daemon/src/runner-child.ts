/**
 * Runner child process entry (arch: one child per run, own pgid).
 * Spawned by the daemon with argv: <jobspec.json> <nonce>. Executes the job
 * through the configured engine and streams protocol events on stdout.
 * Any daemon death leaves this child orphaned → identity-verified termination
 * by the next daemon's recovery sweep (ADR-011) — never unsupervised spend.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ClaudeCliRunner, MockRunner, CodexRunner, OpenCodeRunner, HermesRunner, evaluateCommand, evaluatePathRead } from '@clockwork/runner';
import type { ChildToDaemon, DaemonToChild } from './runner-protocol.js';
import type { JobSpec, RunOutcome } from '@clockwork/shared';

const [, , specPath, nonce] = process.argv;
if (!specPath || !nonce) {
  console.error('usage: runner-child <jobspec.json> <nonce>');
  process.exit(2);
}

const job = JSON.parse(readFileSync(specPath, 'utf8')) as JobSpec;

function send(msg: ChildToDaemon): void {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch {
    /* daemon gone — keep running; recovery sweep will reap us */
  }
}

send({ t: 'ready', nonce });

const pendingPermissions = new Map<string, (d: { behavior: 'allow' } | { behavior: 'deny'; message: string }) => void>();

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg: DaemonToChild;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.t === 'decision') {
    const resolve = pendingPermissions.get(msg.reqId);
    if (resolve) {
      pendingPermissions.delete(msg.reqId);
      resolve(msg.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: msg.message });
    }
  }
});

const abortController = new AbortController();
process.on('SIGTERM', () => abortController.abort());

async function main(): Promise<void> {
  // CW_MOCK_STEP_MS makes the deterministic mock observable on fast machines
  // (full-loop tests sample intermediate states).
  const stepMs = Number(process.env.CW_MOCK_STEP_MS ?? '0');
  const runner =
    process.env.CW_ENGINE === 'mock'
      ? new MockRunner(stepMs > 0 ? { steps: [{ delayMs: stepMs }] } : {})
      : job.engine === 'codex'
        ? new CodexRunner()
        : job.engine === 'opencode'
          ? new OpenCodeRunner()
          : job.engine === 'hermes'
            ? new HermesRunner()
            : new ClaudeCliRunner();

  // FR-2a: live-reference file attachments resolved at execution time.
  let effectiveJob: JobSpec = job;
  if (job.contextFiles?.length) {
    const { assembleContext } = await import('@clockwork/runner');
    const ctxResult = assembleContext(job.contextFiles);
    if (ctxResult.refused.length > 0) {
      send({ t: 'log', line: `[context] refused attachments: ${ctxResult.refused.join('; ')}` });
    }
    if (ctxResult.included.length > 0) {
      effectiveJob = { ...job, prompt: `${job.prompt}\n${ctxResult.block}` };
      send({ t: 'log', line: `[context] attached ${ctxResult.included.length} file(s)` });
    }
  }

  const io = {
    onUsage: (u: { costUsd: number; turns: number }) => send({ t: 'usage', costUsd: u.costUsd, turns: u.turns }),
    onRateLimit: (info: Record<string, unknown>) => send({ t: 'rateLimit', info }),
    onHeartbeat: () => send({ t: 'heartbeat' }),
    onLog: (line: string) => send({ t: 'log', line }),
    onArtifact: (path: string) => send({ t: 'artifact', path }),
    onPermissionRequest: async (p: { tool: string; input: unknown }) => {
      // deny-list floor FIRST (policy layer, FR-11); floor hits are never approvable
      const input = (p.input ?? {}) as Record<string, unknown>;
      let verdict: { denied: boolean; floor: boolean; reason?: string } = { denied: false, floor: false };
      if (typeof input.command === 'string') {
        verdict = evaluateCommand(input.command);
      } else if (p.tool.startsWith('Read') && typeof input.file_path === 'string') {
        verdict = evaluatePathRead(input.file_path);
      }
      if (verdict.floor) {
        return { behavior: 'deny' as const, message: `Clockwork global policy floor: ${verdict.reason}` };
      }
      const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      send({ t: 'permission', reqId, tool: p.tool, input: p.input });
      return new Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }>((resolve) => {
        pendingPermissions.set(reqId, resolve);
        // M1 fail-safe (ADR-020): CLI engine cannot hold approvals — auto-deny after grace.
        setTimeout(() => {
          if (pendingPermissions.has(reqId)) {
            pendingPermissions.delete(reqId);
            resolve({ behavior: 'deny', message: 'No human reachable in unattended mode (M1 fail-safe).' });
          }
        }, 120_000);
      });
    },
  };

  const ctx = {
    worktreePath: job.worktreePath,
    scratchPath: job.scratchPath,
    signal: abortController.signal,
    io,
  };

  let outcome: RunOutcome;
  try {
    if ((job as any).byokId) {
      // ADR-028: BYOK API-agent execution. Credential arrives via env
      // (CW_BYOK_KEY / CW_BYOK_BASE_URL), injected by the daemon at spawn time;
      // it is never written to the jobspec file or logs.
      const { runApiAgent } = await import('@clockwork/runner');
      const apiKey = process.env.CW_BYOK_KEY ?? '';
      const baseUrl = process.env.CW_BYOK_BASE_URL ?? '';
      if (!apiKey || !baseUrl) {
        outcome = { state: 'failed', failureReason: 'auth', summary: 'BYOK credential not provided to runner', artifacts: [], costUsd: 0, turns: 0 };
      } else {
        const r = await runApiAgent({
          baseUrl,
          apiKey,
          model: job.model || 'default',
          systemPrompt: job.profile?.systemPromptExtra ?? 'You are a helpful autonomous agent working in a repository workspace.',
          prompt: effectiveJob.prompt,
          cwd: job.worktreePath || job.scratchPath || process.cwd(),
          maxTurns: job.budget.maxTurns,
          timeoutSec: job.budget.timeoutSec,
          onLog: (line: string) => send({ t: 'log', line }),
        });
        // Stream usage as it lands (same channel CLI engines use).
        send({ t: 'usage', costUsd: Number(((r.promptTokens * 3 + r.completionTokens * 15) / 1_000_000).toFixed(6)), turns: r.turns });
        outcome = {
          state: r.ok ? 'completed' : ('failed' as never),
          failureReason: r.ok ? undefined : ((r.error as never) ?? 'provider_error'),
          summary: r.output,
          artifacts: [],
          // Rough cost model until per-provider pricing lands: $3/M in + $15/M out blended.
          costUsd: Number(((r.promptTokens * 3 + r.completionTokens * 15) / 1_000_000).toFixed(6)),
          turns: r.turns,
        } as RunOutcome;
      }
    } else {
      outcome = await runner.start(effectiveJob as any, ctx as any);
    }
  } catch (e) {
    outcome = {
      state: 'failed',
      failureReason: 'runner_crashed',
      summary: String(e),
      artifacts: [],
      costUsd: 0,
      turns: 0,
    };
  }
  send({ t: 'outcome', outcome });
  process.exit(0);
}

void main();
