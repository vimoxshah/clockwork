# T-007 re-run — engine contract matrix, Claude Code CLI 2.1.261

- Date: 2026-09-05
- Trigger: ADR-020 consequence line ("re-run matrix on every observed CLI version change"). Last run: 2.1.238 on 2026-08-21.
- Method: real binary, real runs. Every row below was observed, not read from `--help`. Raw MCP request/response logs: `scratchpad/permspike/rpc.log`, `scratchpad/combined2/rpc.log` (session-local).

## Verdict

**Keep-alive HITL is now possible on the CLI engine.** The two load-bearing absences that produced ADR-020 no longer hold. Clockwork wires both in this commit.

| Assumption (ADR-020, 2.1.238) | 2.1.261 | Evidence |
|---|---|---|
| `--permission-prompt-tool` absent → fail-safe auto-deny after 120s | **Present and working.** CLI calls the named MCP tool and waits for the answer. | `claude -p … --permission-prompt-tool mcp__cwperm__approve --mcp-config <http server>`; `tools/call` received with `{tool_name:"Bash", input:{command:…}, tool_use_id}`; deny message echoed by the model verbatim; gated file never created. |
| `--max-turns` absent | Not in `--help`, but **accepted** (run proceeds, no unknown-flag error). BudgetGuard remains the enforcement point; the flag is belt-and-braces. | `claude -p "…" --max-turns 3 --output-format stream-json` → stream started normally. |
| Hold duration | HTTP MCP requests time out at **60s by default**. Raised by per-server `timeout` in `--mcp-config` and `MCP_TOOL_TIMEOUT`. With both set, a decision held **100.0s** was honoured (npm install ran after the wait). | `combined2/rpc.log`: call #1 in at 78.06s, answered at +100.0s, subsequent Bash executed. Without the raise: call #2 arrived exactly 60.3s after call #1 (CLI gave up). |
| Prompt tool visible to the model | **Not exposed.** The model's tool list omits `mcp__cwperm__*`; it cannot approve itself. | `system.init` event: `mcp_servers:[{name:"cwperm",status:"connected"}]`, no matching tool name in `tools[]`. |
| `acceptEdits` and Bash | Bash prompts **do** fire under `acceptEdits` (3 requests in one run). An in-cwd `touch` did **not** prompt — acceptEdits auto-approves it. The Seatbelt sandbox is what contains those. | `combined2/stream.jsonl` |

## Sandbox interaction (new since T-008)

T-008 proved `claude -p` *prints* inside the profile. It never exercised the model's Bash tool. Two write targets the Bash tool needs were outside the allowlist:

| Path | Effect when denied | Fix (profile v2) |
|---|---|---|
| `/tmp/claude-<uid>/<cwd with "/"→"-">` | `EPERM: operation not permitted, mkdir …` — **no shell ever starts**; every command fails. | Pre-create from runner-child, allowlist as `subpath`. `cliWorkDirFor()` in `sandbox.ts`. |
| `/tmp/claude-<hex>-cwd` | Commands run, but shell exits 1 → agent reads every command as failed. | `(allow file-write* (regex #"^/private/tmp/claude-[0-9a-f]+-cwd$"))` — proven to reject `…-cwdx`, `/tmp/other-cwd`, `/tmp/x`. |

With both fixed, inside the sandbox on 2.1.261: `touch` in worktree ✅ created · `npm install left-pad` ✅ installed (cache redirected via `npm_config_cache`) · `touch /tmp/probe-escape.txt` ❌ `Operation not permitted` · `head ~/.zsh_history` ❌ `Operation not permitted`.

## Other engines inside the same profile (first time probed)

| Engine | Result | Notes |
|---|---|---|
| OpenCode | ✅ writes `ok.txt` in worktree, `/tmp` escape denied, 14s | Needs `~/.opencode` writable in addition to `~/.local/share`, `~/.config`, `~/.cache` opencode dirs; hung 180s without it. stdin must be closed (runners use `'ignore'`). |
| Hermes 0.21.0 | ✅ writes `ok.txt` in worktree, `/tmp` escape denied, history read denied, usage file written, 37s | Root cause of the earlier `$HOME` writes: hermes's oneshot (`-z`) path never applies `--in` (skips `_apply_in_dir`). It does honour `TERMINAL_CWD`; `HermesRunner` now sets it to the worktree (flag kept). Staging file `$HOME/.hermes-tmp.<pid>` admitted via exact-name regex. |
| Codex 0.142.4 | ✅ writes `ok.txt` in worktree, `/tmp` escape denied, `~/.zsh_history` read denied, 27s | Two findings. (1) The machine's `~/.codex/config.toml` had tables the installed codex rejects (`[agents]`, two unknown keys in `features.multi_agent_v2`); fixed locally, backup kept. (2) **Seatbelt does not nest:** codex's own `workspace-write` profile fails with `sandbox_apply: Operation not permitted` inside any `(deny default)` outer profile — bisected every allow, none unblocks it; only an `(allow default)` outer works. `CodexRunner` now passes `-s danger-full-access` when Clockwork's profile is on (ours is the containment) and keeps `workspace-write` only under `CW_SANDBOX=off`. Trade-off: codex's inner sandbox also blocked shell-command network; under Clockwork's profile network is allowed, same as every other engine. |

## Wiring landed (see ADR-0xx superseding ADR-020)

- `packages/runner/src/permission-server.ts` — loopback HTTP MCP server hosted in runner-child (zero deps).
- `claude-cli-runner.ts` — `--permission-prompts host --permission-prompt-tool mcp__clockwork__approve --mcp-config <tmp>`; `MCP_TOOL_TIMEOUT` = run wall-clock; per-server `timeout` = same.
- `runner-child.ts` / `run-manager.ts` — approval hold bounded by the run's remaining wall-clock (was fixed 120s).
- `sandbox.ts` — profile v2, `buildSandboxSpec`, `applySandbox`; all five runners (incl. BYOK bash) route through it; `runner-child` constructs the spec. Guarded by `runner-env-wiring.test.ts` "sandbox wiring".

## Production-path E2E (runner-child dist, real daemon protocol)

| Run | Observed |
|---|---|
| deny | `sandbox enabled=true v2` at 0.1s → `permission Bash npm view left-pad version` at 40s → held 12s → deny → model reported the exact deny text, command never ran → `completed`, exit 0. |
| allow | same → held 8s → allow → `npm view` executed inside the production-built profile (cache root + engine paths merged) and returned stdout. |
| **floor bypass** | in the allow run, step 2 `git push --force origin main` **executed without any permission request** (`permission_denials: []`; git failed only because the probe repo had no commits). `evaluateCommand` returns `floor:true` for it — the floor was never consulted. Developer settings had no matching allow rule. `acceptEdits` on 2.1.261 does not prompt for this command. |

## Not decided here (surfaced for the maker)

- **Policy-floor coverage under `acceptEdits`** (row above). Options: unattended tasks in `default` mode (the bridge makes that viable now); inject deny-list patterns as CLI `permissions.deny` via `--settings`; or both.

- **Settings leak.** The run inherits `HOME`, so the CLI loads `~/.claude/settings.json`. Any `permissions.allow` rule there pre-empts the prompt tool. `--setting-sources` (user,project,local) exists in 2.1.261 and can pin what an unattended run loads. Whether interactive allow rules should apply unattended is a product decision.
- `--strict-mcp-config` was **not** added: it would drop the repo's own `.mcp.json` servers, a behaviour change for existing tasks.
