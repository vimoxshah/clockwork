/**
 * Permission bridge: a loopback MCP server the Claude CLI consults before every
 * gated tool call (`--permission-prompt-tool`).
 *
 * Why HTTP and not stdio: the CLI spawns stdio MCP servers itself, so a stdio
 * bridge would run INSIDE the Seatbelt sandbox with its stdio owned by the CLI,
 * and would need a second channel back to the supervisor. An HTTP server hosted
 * here — in the unsandboxed runner-child process — is reached by the CLI over
 * loopback (the profile allows network*), and requests land directly where the
 * pending-approval map already lives. No extra process, no side channel.
 *
 * Verified against Claude Code CLI 2.1.261 on 2026-09-05 (spike: sandboxed
 * claude, this server outside, one decision held 100s and then honoured):
 *   - tools/call arguments: { tool_name, input, tool_use_id }
 *   - response: text content whose body is JSON
 *       { behavior: 'allow', updatedInput } | { behavior: 'deny', message }
 *   - HTTP MCP requests time out at 60s by default; the per-server `timeout`
 *     in --mcp-config and MCP_TOOL_TIMEOUT both raise it. Both are set by the
 *     CLI runner to the run's wall-clock budget.
 *   - The tool is NOT exposed to the model, so the agent cannot approve itself.
 *
 * Zero dependencies on purpose: this package is the published security
 * boundary and stays auditable without a lockfile.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string };

export interface PermissionRequestPayload {
  toolName: string;
  input: unknown;
  toolUseId: string | null;
}

export interface PermissionServerOptions {
  /** Resolves when a human (or the policy floor) has decided. May take as long as the run allows. */
  decide: (req: PermissionRequestPayload) => Promise<PermissionDecision>;
  /** MCP server name; becomes the `mcp__<server>__<tool>` prefix. */
  serverName?: string;
  toolName?: string;
  log?: (line: string) => void;
  /**
   * The deny-list policy floor (FR-11/T-114), consulted over `POST /floor` by
   * the PreToolUse hook (floor-hook.ts) for EVERY Bash call, in every
   * `--permission-mode` — unlike `decide` above, which acceptEdits mode skips
   * for Bash entirely. Synchronous and wrapped in try/catch here: a throwing
   * or missing floor callback must deny, never implicitly allow.
   */
  floor?: (req: { toolName: string; input: unknown }) => { denied: boolean; reason?: string };
}

/** The `/floor` route's response body. */
export interface FloorDecision {
  decision: 'deny' | 'allow';
  reason?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_FALLBACK = '2025-03-26';

export class PermissionServer {
  private server: http.Server | null = null;
  private boundUrl: string | null = null;
  private boundOrigin: string | null = null;
  private readonly serverName: string;
  private readonly toolName: string;

  constructor(private readonly opts: PermissionServerOptions) {
    this.serverName = opts.serverName ?? 'clockwork';
    this.toolName = opts.toolName ?? 'approve';
  }

  /** The exact value the CLI expects for --permission-prompt-tool. */
  get toolFlag(): string {
    return `mcp__${this.serverName}__${this.toolName}`;
  }

  get url(): string | null {
    return this.boundUrl;
  }

  /** The `/floor` route's URL — the address the PreToolUse hook posts to. */
  get floorUrl(): string | null {
    return this.boundOrigin ? `${this.boundOrigin}/floor` : null;
  }

  /**
   * Document for --mcp-config. `timeoutMs` must exceed the longest hold the run
   * may need — the CLI's HTTP default is 60s and a slow human is the whole point.
   */
  mcpConfig(timeoutMs: number): { mcpServers: Record<string, { type: 'http'; url: string; timeout: number }> } {
    if (!this.boundUrl) throw new Error('PermissionServer.mcpConfig called before start()');
    return { mcpServers: { [this.serverName]: { type: 'http', url: this.boundUrl, timeout: Math.max(60_000, timeoutMs) } } };
  }

  async start(): Promise<{ port: number; url: string }> {
    if (this.server) throw new Error('PermissionServer already started');
    const server = http.createServer((req, res) => void this.handle(req, res));
    // A held decision is a legitimately slow response; never let the socket idle-timeout kill it.
    server.timeout = 0;
    server.keepAliveTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    this.server = server;
    this.boundOrigin = `http://127.0.0.1:${port}`;
    this.boundUrl = `${this.boundOrigin}/mcp`;
    return { port, url: this.boundUrl };
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.boundUrl = null;
    this.boundOrigin = null;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      // Held requests keep sockets open; drop them so close() cannot hang a finalize.
      s.closeAllConnections?.();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Route on pathname only; every previous behaviour on /mcp is unchanged.
    const pathname = new URL(req.url ?? '/', 'http://internal').pathname;
    if (pathname === '/mcp') {
      await this.handleMcp(req, res);
      return;
    }
    if (pathname === '/floor') {
      await this.handleFloor(req, res);
      return;
    }
    res.writeHead(404).end();
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(body) as JsonRpcRequest;
    } catch {
      this.reply(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const { id, method, params } = msg;

    // Notifications carry no id and expect no body.
    if (id === undefined || id === null || (method ?? '').startsWith('notifications/')) {
      res.writeHead(202).end();
      return;
    }

    switch (method) {
      case 'initialize': {
        const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_FALLBACK;
        this.reply(res, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: requested,
            capabilities: { tools: {} },
            serverInfo: { name: this.serverName, version: '1' },
          },
        });
        return;
      }
      case 'ping':
        this.reply(res, { jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        this.reply(res, {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: this.toolName,
                description: 'Clockwork permission gate: asks the supervising human before a gated tool call runs.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    tool_name: { type: 'string' },
                    input: { type: 'object' },
                    tool_use_id: { type: 'string' },
                  },
                  required: ['tool_name', 'input'],
                },
              },
            ],
          },
        });
        return;
      case 'tools/call': {
        const name = typeof params?.name === 'string' ? params.name : '';
        if (name !== this.toolName) {
          this.reply(res, { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } });
          return;
        }
        const args = (params?.arguments ?? {}) as { tool_name?: unknown; input?: unknown; tool_use_id?: unknown };
        const payload: PermissionRequestPayload = {
          toolName: typeof args.tool_name === 'string' ? args.tool_name : 'unknown',
          input: args.input ?? {},
          toolUseId: typeof args.tool_use_id === 'string' ? args.tool_use_id : null,
        };
        let decision: PermissionDecision;
        try {
          decision = await this.opts.decide(payload);
        } catch (e) {
          // A broken supervisor must never become an implicit allow.
          decision = { behavior: 'deny', message: `Clockwork permission bridge error: ${String(e)}` };
        }
        this.opts.log?.(`[permission] ${payload.toolName} -> ${decision.behavior}`);
        this.reply(res, {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(decision) }] },
        });
        return;
      }
      default:
        this.reply(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }

  /**
   * The policy-floor route the PreToolUse hook posts to. Deliberately
   * fail-closed: a malformed body, a missing `floor` callback, or a callback
   * that throws all resolve to `deny` — never an implicit allow. Always
   * answers 200 (the decision itself is the payload); only the HTTP method is
   * validated before that.
   */
  private async handleFloor(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed: { tool_name?: unknown; tool_input?: unknown };
    try {
      parsed = JSON.parse(body) as { tool_name?: unknown; tool_input?: unknown };
    } catch (e) {
      this.replyFloor(res, { decision: 'deny', reason: `malformed /floor request body: ${String(e)}` });
      return;
    }
    const toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : 'unknown';
    const input = parsed.tool_input;
    if (!this.opts.floor) {
      this.replyFloor(res, { decision: 'deny', reason: 'no policy floor configured' });
      return;
    }
    let verdict: { denied: boolean; reason?: string };
    try {
      verdict = this.opts.floor({ toolName, input });
    } catch (e) {
      // A broken deny-list evaluation must never become an implicit allow.
      verdict = { denied: true, reason: `policy floor callback threw: ${String(e)}` };
    }
    // Only the deny path is worth a log line — this route is hit for EVERY
    // Bash call under acceptEdits, so logging every allow would flood the
    // run's live log with routine chatter. claude-cli-runner.ts's floor
    // callback logs its own deny separately (with the deny-list reason); this
    // one also covers the malformed-body / no-callback / threw cases above.
    if (verdict.denied) this.opts.log?.(`[floor] ${toolName} -> deny`);
    this.replyFloor(res, verdict.denied ? { decision: 'deny', reason: verdict.reason } : { decision: 'allow' });
  }

  private replyFloor(res: http.ServerResponse, payload: FloorDecision): void {
    const text = JSON.stringify(payload);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }).end(text);
  }

  private reply(res: http.ServerResponse, payload: unknown): void {
    const text = JSON.stringify(payload);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }).end(text);
  }
}
