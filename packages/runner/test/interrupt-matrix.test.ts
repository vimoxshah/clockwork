/**
 * T-002 — Interruption matrix (S-13/S-44/S-45 + zombie supervision):
 * SIGTERM/cancel, timeout enforcement, budget stop, turn stop. Runs against a
 * fake `claude` binary that streams usage events and never exits on its own,
 * so every path is deterministic with zero API spend.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCliRunner } from '../src/claude-cli-runner.js';
import type { JobContext, JobSpecLike, RunnerIO } from '@clockwork/shared';

const FAKE_BIN = `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"fake-session"}'
i=0
while [ $i -lt 100000 ]; do
  echo '{"type":"assistant","message":{"usage":{"input_tokens":1000,"output_tokens":500}}}'
  sleep 0.2
  i=$((i+1))
done
`;

describe('T-002 interruption matrix', () => {
  let dir: string;
  let worktree: string;
  let binPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-t002-'));
    worktree = path.join(dir, 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, '.keep'), '');
    binPath = path.join(dir, 'fake-claude');
    writeFileSync(binPath, FAKE_BIN);
    chmodSync(binPath, 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function makeJob(over: Partial<JobSpecLike['budget']> = {}): JobSpecLike {
    return {
      runId: `t002-${Math.random().toString(36).slice(2, 8)}`,
      prompt: 'test',
      model: null,
      permissionMode: 'acceptEdits',
      budget: { maxUsd: 10, maxTurns: 1000, timeoutSec: 60, ...over },
      profile: null,
    };
  }

  function makeCtx(): { ctx: JobContext; io: RunnerIO; signal: AbortSignal } {
    const controller = new AbortController();
    const ctx: JobContext = {
      worktreePath: worktree,
      scratchPath: null,
      signal: controller.signal,
      io: {
        onUsage: () => {},
        onPermissionRequest: async () => ({ behavior: 'deny', message: 'n/a' }),
        onHeartbeat: () => {},
        onArtifact: () => {},
        onLog: () => {},
      },
    };
    return { ctx, signal: controller.signal, io: ctx.io };
  }

  it('cancel(): SIGTERM to pgid stops the run, state=cancelled, no zombies', async () => {
    const runner = new ClaudeCliRunner({ claudeBin: binPath, graceMs: 300 });
    const { ctx, signal } = makeCtx();
    const p = runner.start(makeJob(), ctx);
    await new Promise((r) => setTimeout(r, 700)); // let it emit some events
    // find the live process via journal? simpler: ps for fake-claude
    const before = spawnSync('/bin/ps', ['-eo', 'pid,command'], { encoding: 'utf8' }).stdout;
    expect(before).toContain('fake-claude');
    await runner.cancel(undefined);
    const outcome = await p;
    expect(outcome.state).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 600)); // allow SIGKILL escalation
    const after = spawnSync('/bin/ps', ['-eo', 'pid,command'], { encoding: 'utf8' }).stdout;
    expect(after).not.toContain('fake-claude'); // no zombies (identity: full command match)
    void signal;
  });

  it('timeout: wall-clock cap fires SIGTERM→SIGKILL, state=timed_out, no zombies', async () => {
    const runner = new ClaudeCliRunner({ claudeBin: binPath, graceMs: 200 });
    const { ctx } = makeCtx();
    const outcome = await runner.start(makeJob({ timeoutSec: 1 }), ctx);
    expect(outcome.state).toBe('timed_out'); // S-13
    await new Promise((r) => setTimeout(r, 500));
    const after = spawnSync('/bin/ps', ['-eo', 'pid,command'], { encoding: 'utf8' }).stdout;
    expect(after).not.toContain('fake-claude');
  });

  it('budget soft-cap: stops when cumulative estimate crosses maxUsd → budget_exceeded', async () => {
    // estimateUsd: (in*3 + out*15)/1e6 = (3000+7500)/1e6 = $0.0105/event
    const runner = new ClaudeCliRunner({ claudeBin: binPath, graceMs: 200 });
    const { ctx } = makeCtx();
    const outcome = await runner.start(makeJob({ maxUsd: 0.02 }), ctx);
    expect(outcome.state).toBe('budget_exceeded');
    expect(outcome.costUsd).toBeGreaterThanOrEqual(0.02);
  }, 20_000);

  it('max turns: hard stop at the turn bound → failed/max_turns', async () => {
    const runner = new ClaudeCliRunner({ claudeBin: binPath, graceMs: 200 });
    const { ctx } = makeCtx();
    const outcome = await runner.start(makeJob({ maxTurns: 3 }), ctx);
    expect(outcome.state).toBe('failed');
    expect(outcome.failureReason).toBe('max_turns');
    expect(outcome.turns).toBe(3);
  }, 20_000);

  it('clean completion: engine exits 0 with result event → completed + summary', async () => {
    const doneBin = path.join(dir, 'done-claude');
    writeFileSync(
      doneBin,
      `#!/bin/sh\necho '{"type":"system","subtype":"init","session_id":"done-sess"}'\necho '{"type":"result","subtype":"success","is_error":false,"result":"ALL DONE","num_turns":4,"total_cost_usd":0.05}'\n`,
    );
    chmodSync(doneBin, 0o755);
    const runner = new ClaudeCliRunner({ claudeBin: doneBin });
    const { ctx } = makeCtx();
    const outcome = await runner.start(makeJob(), ctx);
    expect(outcome.state).toBe('completed');
    expect(outcome.summary).toBe('ALL DONE');
    expect(outcome.sessionId).toBe('done-sess');
    expect(outcome.turns).toBe(4);
    expect(outcome.costUsd).toBeCloseTo(0.05);
  });

  it('engine crash: nonzero exit without result → failed/runner_crashed', async () => {
    const crashBin = path.join(dir, 'crash-claude');
    writeFileSync(crashBin, '#!/bin/sh\nexit 3\n');
    chmodSync(crashBin, 0o755);
    const runner = new ClaudeCliRunner({ claudeBin: crashBin });
    const { ctx } = makeCtx();
    const outcome = await runner.start(makeJob(), ctx);
    expect(outcome.state).toBe('failed');
    expect(outcome.failureReason).toBe('runner_crashed');
  });

  it('auth failure taxonomy (T-004): authentication_failed error maps to failed/auth', async () => {
    const authBin = path.join(dir, 'authfail-claude');
    writeFileSync(
      authBin,
      `#!/bin/sh\necho '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Not logged in · Please run /login","error":"authentication_failed"}'\n`,
    );
    chmodSync(authBin, 0o755);
    const runner = new ClaudeCliRunner({ claudeBin: authBin });
    const { ctx } = makeCtx();
    const outcome = await runner.start(makeJob(), ctx);
    expect(outcome.state).toBe('failed');
    expect(outcome.failureReason).toBe('auth');
  });

  it('group kill leaves no orphaned children (pgid-level supervision)', async () => {
    const childBin = path.join(dir, 'spawny-claude');
    // spawns a grandchild that would outlive a naive pid kill
    writeFileSync(
      childBin,
      `#!/bin/sh
sleep 300 &
echo $! > ${dir}/grandchild.pid
while true; do sleep 0.2; done
`,
    );
    chmodSync(childBin, 0o755);
    const runner = new ClaudeCliRunner({ claudeBin: childBin, graceMs: 150 });
    const { ctx } = makeCtx();
    const p = runner.start(makeJob(), ctx);
    await new Promise((r) => setTimeout(r, 600));
    const gcPid = parseInt(readFileSyncSafe(path.join(dir, 'grandchild.pid')).trim(), 10);
    await runner.cancel(undefined);
    await p;
    await new Promise((r) => setTimeout(r, 400));
    const alive = spawnSync('/bin/kill', ['-0', String(gcPid)], { encoding: 'utf8' });
    expect(alive.status).not.toBe(0); // grandchild dead → whole group supervised
  });
});

function readFileSyncSafe(p: string): string {
  try {
    return readUtf8(p);
  } catch {
    return '';
  }
}

import { readFileSync } from 'node:fs';
function readUtf8(p: string): string {
  return readFileSync(p, 'utf8');
}
