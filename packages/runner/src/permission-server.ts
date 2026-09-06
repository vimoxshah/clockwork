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
  /**
   * Bounds the noise a sandboxed agent can generate by reading the bridge's
   * own port from its argv and forging `tools/call` approvals into the human's
   * inbox — never an escalation (decisions route back by `tool_use_id` to the
   * caller that asked), but unbounded concurrent holds would still be a DoS on
   * the supervisor. Requests beyond this many concurrent in-flight
   * `tools/call`s are denied immediately, never queued. Default 16 — high
   * enough that a legitimate CLI batch of parallel gated calls is never
   * denied outright; no observed batch has come close to this many
   * concurrent holds, and a sandboxed agent's forged-approval noise is still
   * bounded well below the point of tying up the supervisor.
   */
  maxPending?: number;
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

/**
 * Memory-DoS bound on both routes: refuse a body bigger than this — checked
 * fast via Content-Length when the client declares one (`isTooLarge`), and by
 * counting bytes as they arrive otherwise (`readBoundedBody`), since a
 * chunked request with no Content-Length would bypass a Content-Length-only
 * check entirely and grow `body` unbounded. 4 MiB, not the previous 256 KiB:
 * a legitimate `Write` tool permission request carries the whole file being
 * written in `arguments.input`, and 256 KiB was small enough to turn a real
 * request into a spurious error.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BODY_LABEL = '4 MiB';

export class PermissionServer {
  private server: http.Server | null = null;
  private boundUrl: string | null = null;
  private boundOrigin: string | null = null;
  private readonly serverName: string;
  private readonly toolName: string;
  private readonly maxPending: number;
  /** Count of `tools/call` requests whose `decide()` has not yet resolved. */
  private pendingCalls = 0;
  /** True while the current over-capacity burst has already logged once. */
  private burstLogged = false;

  constructor(private readonly opts: PermissionServerOptions) {
    this.serverName = opts.serverName ?? 'clockwork';
    this.toolName = opts.toolName ?? 'approve';
    this.maxPending = opts.maxPending ?? 16;
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
    // Fast path: checked before the body is ever read into memory, when the
    // client declares a Content-Length at all. A chunked request with no
    // Content-Length header is NOT covered by this check — that gap is closed
    // below by readBoundedBody, which counts bytes as they actually arrive.
    if (this.isTooLarge(req)) {
      this.replyTooLargeMcp(req, res);
      return;
    }
    const body = await this.readBoundedBody(req, () => this.replyTooLargeMcp(req, res));
    if (body === null) return; // already responded and the socket is being torn down
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
        // Noise bound: a sandboxed agent that reads this port from its own
        // argv could flood /mcp with forged approvals. Never an escalation —
        // decisions still route back to the real caller by tool_use_id — but
        // unbounded concurrent holds would still tie up the supervisor. Deny
        // immediately past the cap, never queue, and log the burst once.
        if (this.pendingCalls >= this.maxPending) {
          if (!this.burstLogged) {
            this.burstLogged = true;
            this.opts.log?.(`[permission] too many concurrent requests (>= ${this.maxPending} pending) — denying until one clears`);
          }
          const overCapacity: PermissionDecision = { behavior: 'deny', message: 'permission bridge: too many concurrent requests' };
          this.reply(res, {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(overCapacity) }] },
          });
          return;
        }
        const args = (params?.arguments ?? {}) as { tool_name?: unknown; input?: unknown; tool_use_id?: unknown };
        const payload: PermissionRequestPayload = {
          toolName: typeof args.tool_name === 'string' ? args.tool_name : 'unknown',
          input: args.input ?? {},
          toolUseId: typeof args.tool_use_id === 'string' ? args.tool_use_id : null,
        };
        this.pendingCalls++;
        let slotReleased = false;
        const releaseSlot = () => {
          if (slotReleased) return;
          slotReleased = true;
          this.pendingCalls--;
          // A slot just freed up; the next time capacity fills is a new burst.
          this.burstLogged = false;
        };
        // A client that goes away mid-hold (killed CLI, dropped connection)
        // must free its slot immediately — decide() may still be minutes from
        // resolving (a human hasn't clicked yet), and this run must not keep
        // counting a call nobody is waiting on anymore against maxPending.
        // Removed again below before the normal reply path, so this can never
        // fire on our own response completing the request successfully.
        let clientGone = false;
        const onClientGone = () => {
          clientGone = true;
          releaseSlot();
        };
        req.once('close', onClientGone);
        res.once('close', onClientGone);
        let decision: PermissionDecision;
        try {
          decision = await this.opts.decide(payload);
        } catch (e) {
          // A broken supervisor must never become an implicit allow.
          decision = { behavior: 'deny', message: `Clockwork permission bridge error: ${String(e)}` };
        } finally {
          req.removeListener('close', onClientGone);
          res.removeListener('close', onClientGone);
          releaseSlot();
        }
        this.opts.log?.(`[permission] ${payload.toolName} -> ${decision.behavior}${clientGone ? ' (client disconnected, discarding)' : ''}`);
        if (clientGone) {
          // Nothing to reply to — the decision (possibly a real human choice)
          // simply has nowhere to go now. Writing to res here would throw or
          // be silently dropped; either way this resolver is a no-op.
          return;
        }
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
    // Same memory-DoS bound as /mcp: fast Content-Length precheck, then a
    // byte-counted read that also catches a chunked request declaring none.
    if (this.isTooLarge(req)) {
      this.replyTooLargeFloor(req, res);
      return;
    }
    const body = await this.readBoundedBody(req, () => this.replyTooLargeFloor(req, res));
    if (body === null) return; // already responded and the socket is being torn down
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

  /**
   * Fast path only: Content-Length declared and over the cap. A request with
   * no declared length (or a lying one) is not covered here — that's what
   * readBoundedBody is for, applied unconditionally after this precheck.
   */
  private isTooLarge(req: http.IncomingMessage): boolean {
    const header = req.headers['content-length'];
    if (!header) return false;
    const n = Number(header);
    return Number.isFinite(n) && n > MAX_BODY_BYTES;
  }

  /**
   * Reads a request body while enforcing MAX_BODY_BYTES by counting bytes as
   * they actually arrive, not trusting Content-Length alone — a chunked
   * request omits that header entirely, and without this, `body += chunk`
   * would grow unbounded on both /mcp and /floor. Deliberately uses raw
   * `'data'`/`'end'` listeners rather than `for await…of req`: breaking out
   * of an async-iterator loop early destroys the stream synchronously, which
   * can race ahead of (and truncate) the oversize response `onOverflow` is
   * about to send. Here the response is written first; `onOverflow` itself
   * destroys the socket only once that response has finished flushing.
   *
   * Returns the accumulated body, or `null` if `onOverflow` fired (the caller
   * must stop processing immediately — the response and socket teardown are
   * already handled) or the request ended abnormally (client abort/error).
   */
  private readBoundedBody(req: http.IncomingMessage, onOverflow: () => void): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let body = '';
      let bytes = 0;
      let settled = false;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('close', onClose);
        req.removeListener('error', onError);
        resolve(result);
      };
      const onData = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          // Stop accumulating and stop reading immediately; req.pause()
          // halts the flow without the auto-destroy a for-await break would
          // trigger, so onOverflow's response can still go out cleanly.
          req.pause();
          onOverflow();
          finish(null);
          return;
        }
        body += chunk;
      };
      const onEnd = () => finish(body);
      // A client that disconnects or errors mid-body must resolve too — a
      // hung promise here would otherwise leak the handler forever.
      const onClose = () => finish(null);
      const onError = () => finish(null);
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('close', onClose);
      req.on('error', onError);
    });
  }

  private replyTooLargeMcp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const text = JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: `request too large: exceeds ${MAX_BODY_LABEL}` },
    });
    // Connection: close — refuse to keep the socket around for another try.
    // The destroy happens in the `end()` callback (fired on 'finish', once
    // the write has actually gone out) rather than immediately — destroying
    // first can race the response bytes off the wire.
    res
      .writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Connection: 'close' })
      .end(text, () => {
        if (!req.destroyed) req.destroy();
      });
  }

  private replyTooLargeFloor(req: http.IncomingMessage, res: http.ServerResponse): void {
    const text = JSON.stringify({ decision: 'deny', reason: 'request too large' } satisfies FloorDecision);
    res
      .writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Connection: 'close' })
      .end(text, () => {
        if (!req.destroyed) req.destroy();
      });
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
