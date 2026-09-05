/**
 * Runner child process entry (arch: one child per run, own pgid).
 * Spawned by the daemon with argv: <jobspec.json> <nonce>. Executes the job
 * through the configured engine and streams protocol events on stdout.
 * Any daemon death leaves this child orphaned → identity-verified termination
 * by the next daemon's recovery sweep (ADR-011) — never unsupervised spend.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  ClaudeCliRunner,
  MockRunner,
  CodexRunner,
  OpenCodeRunner,
  HermesRunner,
  evaluateCommand,
  evaluatePathRead,
  buildSandboxSpec,
  escapeRegexLiteral,
  SANDBOX_PROFILE_VERSION,
  type SandboxSpec,
} from '@clockwork/runner';
import os from 'node:os';
import type { ChildToDaemon, DaemonToChild } from './runner-protocol.js';
import type { JobSpec, RunOutcome } from '@clockwork/shared';

const [, , specPath, nonce] = process.argv;
if (!specPath || !nonce) {
  console.error('usage: runner-child <jobspec.json> <nonce>');
  process.exit(2);
}

const job = JSON.parse(readFileSync(specPath, 'utf8')) as JobSpec;
const startedAtMs = Date.now();

// BYOK credential (ADR-027/028) arrives in THIS process's env only. Read it once
// and scrub it, so nothing this child spawns — the agent's own shell included —
// can `echo $CW_BYOK_KEY`. Before this scrub, it could.
const byokKey = process.env.CW_BYOK_KEY ?? '';
const byokBaseUrl = process.env.CW_BYOK_BASE_URL ?? '';
delete process.env.CW_BYOK_KEY;
delete process.env.CW_BYOK_BASE_URL;

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

  // Seatbelt containment for the engine process (FR-26). CW_SANDBOX=off is the
  // only way out, and it is logged here, journaled by the daemon, and stamped
  // on the report — never silent.
  const sandboxOff = process.env.CW_SANDBOX === 'off';
  let sandbox: SandboxSpec | null = null;
  if (sandboxOff) {
    send({ t: 'log', line: '[sandbox] DISABLED by CW_SANDBOX=off — writes and credential reads are NOT contained for this run' });
  } else {
    const home = os.homedir();
    sandbox = buildSandboxSpec({
      worktreePath: job.worktreePath,
      scratchPath: job.scratchPath,
      repoPath: job.repoPath,
      contextRoots: job.profile?.contextRoots ?? [],
      // Each engine keeps session state under $HOME; deny it and the engine
      // fails to start (opencode hangs without ~/.opencode — probed 2026-09-05).
      // Scoped to the engine actually running.
      engineStatePaths:
        job.engine === 'codex'
          ? [`${home}/.codex`]
          : job.engine === 'opencode'
            ? [`${home}/.opencode`, `${home}/.local/share/opencode`, `${home}/.config/opencode`, `${home}/.cache/opencode`]
            : job.engine === 'hermes'
              ? [`${home}/.hermes`]
              : [],
      // hermes's write_file stages through $HOME/.hermes-tmp.<pid> then moves it;
      // without this exact-name allow every file write fails (probed 2026-09-05).
      engineWriteRegexes: job.engine === 'hermes' ? [`^${escapeRegexLiteral(home)}/\\.hermes-tmp\\.[0-9]+$`] : [],
    });
  }
  send({ t: 'sandbox', enabled: !sandboxOff, profileVersion: sandboxOff ? null : SANDBOX_PROFILE_VERSION });

  const runner =
    process.env.CW_ENGINE === 'mock'
      ? new MockRunner(stepMs > 0 ? { steps: [{ delayMs: stepMs }] } : {})
      : job.engine === 'codex'
        ? new CodexRunner({ sandbox })
        : job.engine === 'opencode'
          ? new OpenCodeRunner({ sandbox })
          : job.engine === 'hermes'
            ? new HermesRunner({ sandbox })
            : new ClaudeCliRunner({ sandbox });

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
    onPolicyDeny: (p: { tool: string; command: string; reason: string }) =>
      send({ t: 'floor', tool: p.tool, command: p.command, reason: p.reason }),
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
        // Hold until a human answers or the run's own wall-clock budget ends.
        // The old fixed 120s window (ADR-020) existed because CLI 2.1.238 had no
        // way to wait; 2.1.261 does, so the run's timeout is the only bound.
        const remainingMs = Math.max(5_000, job.budget.timeoutSec * 1000 - (Date.now() - startedAtMs));
        setTimeout(() => {
          if (pendingPermissions.has(reqId)) {
            pendingPermissions.delete(reqId);
            resolve({ behavior: 'deny', message: "No human answered before the run's wall-clock budget ended (fail-safe deny)." });
          }
        }, remainingMs);
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
      if (!byokKey || !byokBaseUrl) {
        outcome = { state: 'failed', failureReason: 'auth', summary: 'BYOK credential not provided to runner', artifacts: [], costUsd: 0, turns: 0 };
      } else {
        const r = await runApiAgent({
          baseUrl: byokBaseUrl,
          apiKey: byokKey,
          model: job.model || 'default',
          systemPrompt: job.profile?.systemPromptExtra ?? 'You are a helpful autonomous agent working in a repository workspace.',
          prompt: effectiveJob.prompt,
          cwd: job.worktreePath || job.scratchPath || process.cwd(),
          maxTurns: job.budget.maxTurns,
          timeoutSec: job.budget.timeoutSec,
          sandbox,
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
