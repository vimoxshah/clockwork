/**
 * The Claude Code `PreToolUse` hook that closes the gap the MCP permission
 * bridge cannot: under `--permission-mode acceptEdits`, the CLI executes Bash
 * WITHOUT ever calling `--permission-prompt-tool` (verified live on CLI
 * 2.1.261, 2026-09-05 — `git push --force origin main` ran unasked). A
 * PreToolUse hook, by contrast, is invoked by the CLI for every Bash call in
 * every permission mode, so this is where the deny-list floor (FR-11,
 * deny-list.ts `evaluateCommand`) actually gets consulted for every command.
 *
 * Shared by the runner (writes+wires this per run) and its test (spawns the
 * exact file the runner would spawn) so the two can never silently drift.
 *
 * FAIL-CLOSED STANCE, spelled out because it is the entire point of this
 * file: Claude Code's PreToolUse contract is exit 0 = continue, exit 2 =
 * deny — but ANY OTHER outcome (a non-2/0 exit code, an uncaught exception, a
 * hang past the CLI's own hook timeout) is FAIL-OPEN: the tool call proceeds
 * as if nothing had answered. A future CLI format change (a different stdin
 * shape, different exit-code semantics) must therefore break every run
 * LOUDLY — every Bash call denied with "policy floor unreachable" — never
 * silently stop protecting them. Every code path below converges on exit(2)
 * with a reason on stderr; nothing exits 0 except the one explicit allow.
 *
 * NO imports beyond node:http in the generated file: it runs inside the
 * Seatbelt sandbox, spawned by the packaged Claude Code CLI, and must never
 * resolve a `dist/` (or any other) path from this package.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** POST timeout to the bridge — generous for a loopback call, short enough
 *  that a wedged bridge is caught well inside the CLI's own hook timeout. */
const POST_TIMEOUT_MS = 5_000;

/** Self-watchdog: fires before the CLI's default 60s hook timeout could ever
 *  let a hang fail open, and comfortably outlasts POST_TIMEOUT_MS plus
 *  process startup. */
const WATCHDOG_MS = 7_000;

/**
 * The hook's own source, templated with the bridge's `/floor` URL so the
 * generated file needs no environment variables at all.
 */
export function floorHookSource(floorUrl: string): string {
  return `// Clockwork policy-floor PreToolUse hook — generated per run, do not edit.
//
// FAIL-CLOSED: exit 0 = continue, exit 2 = deny (Claude Code PreToolUse
// contract). Anything else — a different exit code, an uncaught exception, a
// hang — is FAIL-OPEN on the CLI side, so every path here ends in exit(2)
// unless the bridge explicitly allowed the call.
import http from 'node:http';

const FLOOR_URL = ${JSON.stringify(floorUrl)};
const POST_TIMEOUT_MS = ${POST_TIMEOUT_MS};
const WATCHDOG_MS = ${WATCHDOG_MS};

function deny(reason) {
  // On macOS a pipe-backed stderr write is asynchronous, so exiting right
  // after write() can truncate the reason the model reads. Exit from the
  // write callback; the ref'd fallback still guarantees exit(2) if the
  // callback never fires (stderr closed). Either way the exit code is 2.
  setTimeout(() => process.exit(2), 1000);
  process.stderr.write(String(reason) + '\\n', () => process.exit(2));
}

// A hang anywhere below (stdin never closes, a socket wedges past its own
// timeout) must not silently fail open just because this process never
// reaches its own exit() call. Deliberately left REF'd (not .unref()'d): an
// unref'd timer means "don't keep the process alive for this" — exactly the
// fail-OPEN this file exists to prevent if some unforeseen path leaves the
// process idle without ever reaching exit(). The allow path clearTimeout()s
// it explicitly; every other path calls process.exit() before it would fire.
const watchdog = setTimeout(() => {
  deny('Clockwork policy floor unreachable: hook watchdog expired');
}, WATCHDOG_MS);

process.on('uncaughtException', (e) => {
  deny('Clockwork policy floor unreachable: ' + (e && e.message ? e.message : String(e)));
});
process.on('unhandledRejection', (e) => {
  deny('Clockwork policy floor unreachable: ' + (e && e.message ? e.message : String(e)));
});

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('error', (e) => {
  deny('Clockwork policy floor unreachable: stdin error: ' + e.message);
});
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    deny('Clockwork policy floor unreachable: malformed hook input (' + e.message + ')');
    return;
  }
  const toolName = input && typeof input.tool_name === 'string' ? input.tool_name : 'unknown';
  const toolInput = input ? input.tool_input : undefined;
  const body = JSON.stringify({ tool_name: toolName, tool_input: toolInput });

  let settled = false;
  const req = http.request(
    FLOOR_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: POST_TIMEOUT_MS,
    },
    (res) => {
      let resBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        resBody += chunk;
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        if (res.statusCode !== 200) {
          deny('Clockwork policy floor unreachable: HTTP ' + res.statusCode);
          return;
        }
        let decision;
        try {
          decision = JSON.parse(resBody);
        } catch (e) {
          deny('Clockwork policy floor unreachable: malformed response body (' + e.message + ')');
          return;
        }
        if (decision && decision.decision === 'allow') {
          clearTimeout(watchdog);
          process.exit(0);
          return;
        }
        if (decision && decision.decision === 'deny') {
          deny(decision.reason || 'Clockwork policy floor: denied');
          return;
        }
        deny('Clockwork policy floor unreachable: unexpected response body');
      });
    },
  );
  req.on('timeout', () => {
    if (settled) return;
    settled = true;
    req.destroy();
    deny('Clockwork policy floor unreachable: request timed out');
  });
  req.on('error', (e) => {
    if (settled) return;
    settled = true;
    deny('Clockwork policy floor unreachable: ' + e.message);
  });
  req.end(body);
});
`;
}

/** Write the hook file into `dir` (the same `cw-mcp-*` temp dir the run's
 *  MCP config lives in) and return its absolute path. */
export function writeFloorHook(dir: string, floorUrl: string): string {
  const hookPath = path.join(dir, 'floor-hook.mjs');
  writeFileSync(hookPath, floorHookSource(floorUrl), 'utf8');
  return hookPath;
}

/** Shell-quote a path for embedding in the hook's `command` string. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command Claude Code invokes for the hook. Uses `process.execPath`
 * (absolute path to the running Node binary) rather than `node` off PATH —
 * the sandboxed CLI's PATH is not guaranteed to resolve one — and
 * `--no-warnings` so a stray Node runtime warning can never land in the
 * stderr the model reads as the deny reason.
 */
export function floorHookCommand(execPath: string, hookPath: string): string {
  return `${shellQuote(execPath)} --no-warnings ${shellQuote(hookPath)}`;
}

/** The `--settings` JSON payload wiring `command` in as a Bash PreToolUse hook. */
export function floorHookSettings(command: string): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }],
    },
  });
}
