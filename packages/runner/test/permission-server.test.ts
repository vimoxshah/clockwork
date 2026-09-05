/**
 * The permission bridge speaks exactly the JSON-RPC-over-HTTP shape Claude Code
 * CLI 2.1.261 was observed sending (spike 2026-09-05): tools/call with
 * { tool_name, input, tool_use_id }, answered with text content holding the
 * decision JSON. These tests pin that contract and the two failure modes that
 * must never become an implicit allow: a throwing supervisor and an unknown tool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PermissionServer, type PermissionDecision, type PermissionRequestPayload } from '../src/permission-server.js';

let server: PermissionServer;
let url: string;
let nextDecision: (req: PermissionRequestPayload) => Promise<PermissionDecision>;
const seen: PermissionRequestPayload[] = [];

async function rpc(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  nextDecision = async () => ({ behavior: 'deny', message: 'default' });
  server = new PermissionServer({
    decide: (req) => {
      seen.push(req);
      return nextDecision(req);
    },
  });
  ({ url } = await server.start());
});

afterAll(async () => {
  await server.close();
});

describe('permission bridge — MCP contract', () => {
  it('names the tool the way --permission-prompt-tool expects', () => {
    expect(server.toolFlag).toBe('mcp__clockwork__approve');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('mcp-config floors the per-server timeout at the CLI HTTP default and otherwise passes the run budget through', () => {
    expect(server.mcpConfig(1_000).mcpServers.clockwork).toEqual({ type: 'http', url, timeout: 60_000 });
    expect(server.mcpConfig(300_000).mcpServers.clockwork.timeout).toBe(300_000);
  });

  it('initialize echoes the requested protocol version and advertises tools', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    expect(status).toBe(200);
    expect(json.result.protocolVersion).toBe('2025-11-25');
    expect(json.result.capabilities).toEqual({ tools: {} });
    expect(json.result.serverInfo.name).toBe('clockwork');
  });

  it('notifications get 202 and no body', async () => {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('tools/list exposes exactly one tool with the observed input shape', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(json.result.tools).toHaveLength(1);
    expect(json.result.tools[0].name).toBe('approve');
    expect(json.result.tools[0].inputSchema.required).toEqual(['tool_name', 'input']);
  });

  it('tools/call forwards the request and returns the decision as JSON text — after a genuine hold', async () => {
    nextDecision = () => new Promise((r) => setTimeout(() => r({ behavior: 'allow', updatedInput: { command: 'ls' } }), 150));
    const t0 = Date.now();
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_x' } },
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(seen.at(-1)).toEqual({ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_x' });
    expect(json.result.content[0].type).toBe('text');
    expect(JSON.parse(json.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  it('a deny carries its message verbatim', async () => {
    nextDecision = async () => ({ behavior: 'deny', message: 'policy floor: git push --force' });
    const { json } = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: {} } } });
    expect(JSON.parse(json.result.content[0].text)).toEqual({ behavior: 'deny', message: 'policy floor: git push --force' });
  });

  it('a throwing supervisor is a deny, never an allow', async () => {
    nextDecision = async () => {
      throw new Error('daemon gone');
    };
    const { json } = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Write', input: {} } } });
    const d = JSON.parse(json.result.content[0].text);
    expect(d.behavior).toBe('deny');
    expect(d.message).toContain('daemon gone');
  });

  it('rejects unknown tools and unknown methods with JSON-RPC errors', async () => {
    const tool = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'other', arguments: {} } });
    expect(tool.json.error.code).toBe(-32602);
    const method = await rpc({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
    expect(method.json.error.code).toBe(-32601);
  });

  it('refuses non-POST and malformed bodies', async () => {
    expect((await fetch(url)).status).toBe(405);
    const bad = await fetch(url, { method: 'POST', body: '{not json' });
    expect((await bad.json()).error.code).toBe(-32700);
  });

  it('404s an unknown path — /mcp above never falls back to a catch-all', async () => {
    const base = url.replace(/\/mcp$/, '');
    const res = await fetch(`${base}/nope`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('/floor denies with no floor callback configured — fail-closed default, this server never set one', async () => {
    const floorUrl = url.replace(/\/mcp$/, '/floor');
    const res = await fetch(floorUrl, { method: 'POST', body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }) });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ decision: 'deny', reason: 'no policy floor configured' });
  });
});

describe('permission bridge — /floor policy hook (T-114)', () => {
  let floorServer: PermissionServer;
  let floorUrl: string;
  let nextFloor: (req: { toolName: string; input: unknown }) => { denied: boolean; reason?: string };

  beforeAll(async () => {
    nextFloor = () => ({ denied: false });
    floorServer = new PermissionServer({
      decide: async () => ({ behavior: 'deny', message: 'n/a' }),
      floor: (req) => nextFloor(req),
    });
    await floorServer.start();
    floorUrl = floorServer.floorUrl!;
  });

  afterAll(async () => {
    await floorServer.close();
  });

  async function floorRpc(body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(floorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  it('exposes /floor next to /mcp on the same bound origin', () => {
    expect(floorUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/floor$/);
  });

  it('denies when the floor callback says so, reason verbatim', async () => {
    nextFloor = () => ({ denied: true, reason: "force-push to protected branch 'main' is blocked by global deny-list" });
    const { status, json } = await floorRpc({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
    expect(status).toBe(200);
    expect(json).toEqual({ decision: 'deny', reason: "force-push to protected branch 'main' is blocked by global deny-list" });
  });

  it('allows when the floor callback says so', async () => {
    nextFloor = () => ({ denied: false });
    const { status, json } = await floorRpc({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(status).toBe(200);
    expect(json).toEqual({ decision: 'allow' });
  });

  it('a malformed body denies, never allows', async () => {
    const { status, json } = await floorRpc('{not json');
    expect(status).toBe(200);
    expect(json.decision).toBe('deny');
    expect(json.reason).toMatch(/malformed/i);
  });

  it('a throwing floor callback denies, never allows', async () => {
    nextFloor = () => {
      throw new Error('deny-list evaluation crashed');
    };
    const { status, json } = await floorRpc({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(status).toBe(200);
    expect(json.decision).toBe('deny');
    expect(json.reason).toContain('deny-list evaluation crashed');
  });

  it('rejects non-POST with 405', async () => {
    const res = await fetch(floorUrl);
    expect(res.status).toBe(405);
  });

  it('404s an unknown path on this server too', async () => {
    const base = floorUrl.replace(/\/floor$/, '');
    const res = await fetch(`${base}/nope`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
