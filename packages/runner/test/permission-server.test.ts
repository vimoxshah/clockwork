/**
 * The permission bridge speaks exactly the JSON-RPC-over-HTTP shape Claude Code
 * CLI 2.1.261 was observed sending (spike 2026-09-05): tools/call with
 * { tool_name, input, tool_use_id }, answered with text content holding the
 * decision JSON. These tests pin that contract and the two failure modes that
 * must never become an implicit allow: a throwing supervisor and an unknown tool.
 */
import http from 'node:http';
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

describe('permission bridge — concurrency bound (maxPending, forged-approval noise)', () => {
  let capServer: PermissionServer;
  let capUrl: string;
  let decideImpl: (req: PermissionRequestPayload) => Promise<PermissionDecision>;
  const logs: string[] = [];

  beforeAll(async () => {
    capServer = new PermissionServer({
      maxPending: 1,
      log: (l) => logs.push(l),
      decide: (req) => decideImpl(req),
    });
    ({ url: capUrl } = await capServer.start());
  });

  afterAll(async () => {
    await capServer.close();
  });

  async function callTool(id: number): Promise<any> {
    const res = await fetch(capUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'approve', arguments: { tool_name: 'Bash', input: {} } },
      }),
    });
    return JSON.parse(await res.text());
  }

  it('denies a second concurrent call past maxPending=1 while the first is held (logging the burst once), then accepts a fresh call once a slot frees', async () => {
    logs.length = 0;
    let holdRelease!: (d: PermissionDecision) => void;
    let calledResolve!: () => void;
    const called = new Promise<void>((r) => {
      calledResolve = r;
    });
    decideImpl = () => {
      calledResolve();
      return new Promise<PermissionDecision>((r) => {
        holdRelease = r;
      });
    };

    // Fire the first call and wait for decide() to actually be entered —
    // pendingCalls is now genuinely 1, so the second call below cannot race it.
    const first = callTool(200);
    await called;

    const second = await callTool(201);
    expect(JSON.parse(second.result.content[0].text)).toEqual({
      behavior: 'deny',
      message: 'permission bridge: too many concurrent requests',
    });

    // A third call while still over capacity must also deny, but the burst
    // must log only once, not once per denied request.
    const third = await callTool(202);
    expect(JSON.parse(third.result.content[0].text).behavior).toBe('deny');
    expect(logs.filter((l) => l.includes('too many concurrent'))).toHaveLength(1);

    // Release the held first call — it gets the real decision, not a denial.
    holdRelease({ behavior: 'allow', updatedInput: { command: 'ls' } });
    const firstJson = await first;
    expect(JSON.parse(firstJson.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });

    // A slot is free again: the next call is accepted (held), not denied outright.
    let secondHoldRelease!: (d: PermissionDecision) => void;
    let calledResolve2!: () => void;
    const called2 = new Promise<void>((r) => {
      calledResolve2 = r;
    });
    decideImpl = () => {
      calledResolve2();
      return new Promise<PermissionDecision>((r) => {
        secondHoldRelease = r;
      });
    };
    const fourth = callTool(203);
    await called2;
    secondHoldRelease({ behavior: 'deny', message: 'ordinary deny' });
    const fourthJson = await fourth;
    expect(JSON.parse(fourthJson.result.content[0].text)).toEqual({ behavior: 'deny', message: 'ordinary deny' });
  });
});

describe('permission bridge — oversize body bound (memory-DoS)', () => {
  // The bound is a Content-Length check made before any body bytes are read,
  // so the test only needs to declare an oversize length — it never has to
  // transmit 4 MiB+ of real data (avoiding a flaky race between a large
  // fetch write and the server's Connection: close on /mcp). node:http gives
  // us that low-level control; a plain fetch() cannot decouple the declared
  // length from the actual bytes sent.
  const OVERSIZE_LENGTH = 4 * 1024 * 1024 + 1;

  function postDeclaringLength(target: string, length: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
      const u = new URL(target);
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': String(length) },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      // /mcp closes the connection after replying (Connection: close); since
      // this client never sends the declared byte count, that can surface as
      // a socket error after the response is already fully read. The 'end'
      // listener above resolves first — swallow the error so it cannot fail
      // the test or crash the process via an unhandled 'error' event.
      req.on('error', () => undefined);
      req.end();
    });
  }

  it('/mcp rejects a Content-Length over 4 MiB with a JSON-RPC -32600, before reading the body', async () => {
    const { status, body } = await postDeclaringLength(url, OVERSIZE_LENGTH);
    expect(status).toBe(200);
    expect(JSON.parse(body).error.code).toBe(-32600);
  });

  it('/floor rejects the same oversize bound with a plain deny, not a JSON-RPC error', async () => {
    const floorUrl = url.replace(/\/mcp$/, '/floor');
    const { status, body } = await postDeclaringLength(floorUrl, OVERSIZE_LENGTH);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ decision: 'deny', reason: 'request too large' });
  });
});

describe('permission bridge — chunked body with no Content-Length (memory-DoS bypass)', () => {
  // A chunked request declares no Content-Length at all, so the fast
  // precheck above never sees it — this only exercises the server counting
  // real bytes as they arrive and cutting the connection once the cap is
  // crossed, mid-stream, without ever buffering the whole oversize body.
  const OVER_CAP_BYTES = 4 * 1024 * 1024 + 64 * 1024;
  const CHUNK = Buffer.alloc(64 * 1024, 'a');

  function chunkedPost(target: string, totalBytes: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
      const u = new URL(target);
      let stopped = false;
      const clientReq = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }, // no Content-Length — Node sends Transfer-Encoding: chunked
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      // The server destroys the socket once its response has flushed, which
      // can surface here as a write-after-close error on the client side once
      // we stop being able to push more chunks — expected, not a test failure.
      clientReq.on('error', () => {
        stopped = true;
      });
      clientReq.on('close', () => {
        stopped = true;
      });
      let written = 0;
      function writeMore() {
        if (stopped) return;
        let ok = true;
        while (!stopped && written < totalBytes && ok) {
          written += CHUNK.length;
          try {
            ok = clientReq.write(CHUNK);
          } catch {
            stopped = true;
            return;
          }
        }
        if (stopped) return;
        if (written >= totalBytes) {
          try {
            clientReq.end();
          } catch {
            /* socket already gone — the response is what we're waiting on */
          }
        } else {
          clientReq.once('drain', writeMore);
        }
      }
      writeMore();
    });
  }

  // Both tests below stream OVER 4 MiB through a chunked POST, so they are
  // I/O-bound rather than logic-bound and their wall time is a property of the
  // machine. Under vitest's 5s default one went red at 5,008ms on a loaded
  // laptop while passing in isolation three times running — a red build that
  // meant "your machine was busy". The bound is explicit and generous; what is
  // asserted is unchanged.
  const OVERFLOW_TEST_TIMEOUT_MS = 30_000;

  it('/mcp refuses a chunked body once it crosses 4 MiB with a JSON-RPC -32600, and the server stays healthy for a following normal request', async () => {
    const { status, body } = await chunkedPost(url, OVER_CAP_BYTES);
    expect(status).toBe(200);
    expect(JSON.parse(body).error.code).toBe(-32600);
    const { json } = await rpc({ jsonrpc: '2.0', id: 950, method: 'ping' });
    expect(json).toEqual({ jsonrpc: '2.0', id: 950, result: {} });
  }, OVERFLOW_TEST_TIMEOUT_MS);

  it('/floor refuses the same chunked overflow with a plain deny, and the server stays healthy for a following normal request', async () => {
    const floorUrl = url.replace(/\/mcp$/, '/floor');
    const { status, body } = await chunkedPost(floorUrl, OVER_CAP_BYTES);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ decision: 'deny', reason: 'request too large' });
    const res = await fetch(floorUrl, {
      method: 'POST',
      body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
  }, OVERFLOW_TEST_TIMEOUT_MS);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ decision: 'deny', reason: 'no policy floor configured' });
  });
});

describe('permission bridge — pending slot release on client disconnect', () => {
  let dcServer: PermissionServer;
  let dcUrl: string;
  let decideImpl: (req: PermissionRequestPayload) => Promise<PermissionDecision>;

  beforeAll(async () => {
    decideImpl = async () => ({ behavior: 'deny', message: 'unused default' });
    dcServer = new PermissionServer({ maxPending: 1, decide: (req) => decideImpl(req) });
    ({ url: dcUrl } = await dcServer.start());
  });

  afterAll(async () => {
    await dcServer.close();
  });

  async function dcRpc(body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(dcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  it('frees the slot immediately when the client disconnects mid-hold, and a late-resolving decision becomes a no-op', async () => {
    let holdRelease!: (d: PermissionDecision) => void;
    let calledResolve!: () => void;
    const called = new Promise<void>((r) => {
      calledResolve = r;
    });
    decideImpl = () => {
      calledResolve();
      return new Promise<PermissionDecision>((r) => {
        holdRelease = r;
      });
    };

    const u = new URL(dcUrl);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 900,
      method: 'tools/call',
      params: { name: 'approve', arguments: { tool_name: 'Bash', input: {} } },
    });
    const clientReq = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    clientReq.on('error', () => undefined); // destroying our own request surfaces here — expected
    clientReq.end(body);

    await called; // decide() has genuinely been entered — the slot is held (pendingCalls === 1)

    clientReq.destroy(); // simulate the client (killed CLI, dropped network) going away
    // Give the server's req/res 'close' handlers a moment to run.
    await new Promise((r) => setTimeout(r, 150));

    // A fresh call now reaches decide() rather than being denied for
    // capacity — proof the slot was released even though the first
    // decide() call above never resolved.
    let secondEntered = false;
    decideImpl = async () => {
      secondEntered = true;
      return { behavior: 'allow', updatedInput: {} };
    };
    const second = await dcRpc({
      jsonrpc: '2.0',
      id: 901,
      method: 'tools/call',
      params: { name: 'approve', arguments: { tool_name: 'Bash', input: {} } },
    });
    expect(secondEntered).toBe(true);
    expect(JSON.parse(second.json.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: {} });

    // The original decide() can still resolve late (a human clicking after
    // the CLI already died) — it must not throw, and there is nothing left
    // to respond to since the client is long gone.
    expect(() => holdRelease({ behavior: 'deny', message: 'late, discarded' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    // The server itself stays healthy for ordinary traffic afterward.
    const third = await dcRpc({ jsonrpc: '2.0', id: 902, method: 'ping' });
    expect(third.json).toEqual({ jsonrpc: '2.0', id: 902, result: {} });
  });
});
