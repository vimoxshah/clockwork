/**
 * floor-hook.ts is the actual security-closing piece (T-114): the CLI runs
 * this PreToolUse hook for EVERY Bash call, in every --permission-mode —
 * unlike the MCP permission-prompt-tool path, which acceptEdits mode skips
 * for Bash entirely (verified live on CLI 2.1.261, 2026-09-05: an unasked
 * `git push --force origin main` under acceptEdits). This test spawns the
 * REAL generated .mjs file against a REAL PermissionServer — no mocks — and
 * pins the fail-closed contract: bridge down (or hung) => exit 2, never 0.
 *
 * Uses async `spawn`, not `spawnSync`: this test process itself hosts the
 * PermissionServer being called, and `spawnSync` blocks the whole event loop
 * until the child exits — starving the very server the child is trying to
 * reach and turning every case into a false "unreachable" timeout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionServer } from '../src/permission-server.js';
import { evaluateCommand } from '../src/deny-list.js';
import { writeFloorHook, floorHookSettings } from '../src/floor-hook.js';

let server: PermissionServer;
let dir: string;
let hookPath: string;

function runHook(hook: string, command: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', hook], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, stderr }));
    child.stdin!.end(
      JSON.stringify({
        session_id: 's1',
        cwd: '/tmp',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      }),
    );
  });
}

beforeAll(async () => {
  server = new PermissionServer({
    decide: async () => ({ behavior: 'deny', message: 'n/a — /floor path only, this test never uses /mcp' }),
    // Same wiring claude-cli-runner.ts uses: only a genuine FLOOR hit denies.
    floor: ({ input }) => {
      const record = (input ?? {}) as Record<string, unknown>;
      if (typeof record.command !== 'string') return { denied: false };
      const v = evaluateCommand(record.command);
      return { denied: v.floor, reason: v.reason };
    },
  });
  await server.start();
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-floor-hook-test-'));
  hookPath = writeFloorHook(dir, server.floorUrl!);
});

afterAll(async () => {
  await server.close(); // idempotent — safe even if an earlier test already closed it
  rmSync(dir, { recursive: true, force: true });
});

describe('floor-hook.mjs — PreToolUse fail-closed hook', () => {
  it('imports nothing but node:http — it runs inside the packaged CLI\'s sandbox and must resolve no dist/ path', () => {
    const src = readFileSync(hookPath, 'utf8');
    const importLines = src.split('\n').filter((l) => /^\s*(import|export)\b/.test(l) || /\brequire\(/.test(l));
    expect(importLines.length).toBeGreaterThan(0); // sanity: the http import really is there
    for (const l of importLines) expect(l).toContain('node:http');
  });

  it('denies a floor-hit command with exit 2 and the reason on stderr', async () => {
    const r = await runHook(hookPath, 'git push --force origin main');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/force-push to protected branch 'main' is blocked by global deny-list/);
  });

  it('allows a benign command with exit 0 and no stderr', async () => {
    const r = await runHook(hookPath, 'ls');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('fails closed on a request that times out — never exit 0 while waiting', async () => {
    // A server that accepts the connection but never answers: the hook's own
    // POST_TIMEOUT_MS must fire and deny, distinct from the ECONNREFUSED path below.
    const hung = http.createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const port = (hung.address() as { port: number }).port;
    const hungDir = mkdtempSync(path.join(os.tmpdir(), 'cw-floor-hook-hung-'));
    const hungHookPath = writeFloorHook(hungDir, `http://127.0.0.1:${port}/floor`);
    try {
      const r = await runHook(hungHookPath, 'ls');
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/Clockwork policy floor unreachable/);
      expect(r.stderr).toMatch(/timed out/);
    } finally {
      await new Promise<void>((resolve) => hung.close(() => resolve()));
      rmSync(hungDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('fails closed when the bridge is unreachable — never exit 0 on error', async () => {
    await server.close();
    const r = await runHook(hookPath, 'ls');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Clockwork policy floor unreachable/);
  });
});

describe('floorHookSettings pins the hook switch', () => {
  it('sets disableAllHooks:false so a repo .claude/settings.json cannot turn the floor off', () => {
    const parsed = JSON.parse(floorHookSettings("'/usr/bin/true'")) as { disableAllHooks?: unknown; hooks?: unknown };
    // Probed on CLI 2.1.261 (2026-09-06): without this key, `{"disableAllHooks": true}`
    // committed in the repo silently disables the PreToolUse hook and the gated
    // command runs unasked. CLI-flag settings outrank project settings.
    expect(parsed.disableAllHooks).toBe(false);
    expect(parsed.hooks).toBeDefined();
  });
});
