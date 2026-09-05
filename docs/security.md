# Clockwork — Security Model

> Honest layering. We describe what each boundary does and does not do.
> Anything marketed beyond this document would be a trust violation.

## The three layers (and what each one actually is)

### 1. OS sandbox = THE containment boundary

Every run executes inside a per-run macOS Seatbelt profile
(`packages/runner/src/sandbox.ts`, versioned in source). Every engine spawn —
Claude, Codex, OpenCode, Hermes, and the BYOK agent's shell — is wrapped by
`applySandbox()`; `runner-child` builds the spec. A source-reading test
(`packages/runner/test/runner-env-wiring.test.ts`, "sandbox wiring") fails the
build if any runner stops calling it.

> **Correction (2026-09-05, ADR-034).** Before this date the profile and its
> escape tests existed but no production run was inside one — the runner was
> constructed without a spec. If you installed an earlier build, your runs
> were contained by the run-env allowlist and worktree isolation only. This
> document now describes what ships.

**Enforced:**
- **Writes are default-denied.** A run may write only to:
  - its own worktree or scratch directory,
  - `/dev/null` (git requires it),
  - Clockwork-managed tool caches under `~/.clockwork/cache/` (npm, pnpm,
    yarn, pip, XDG, cargo, go, gem/bundler, uv, poetry, gradle, composer,
    nuget) — redirected there by env so package managers work without
    opening `$HOME`,
  - the Claude CLI's per-run work dir `/tmp/claude-<uid>/<cwd-slug>` and its
    cwd-tracking file `/tmp/claude-<hex>-cwd` (exact-name regex; without these
    the CLI's Bash tool cannot start a shell),
  - scoped engine-state subpaths: `~/.claude/{projects,statsig,shell-snapshots,logs}`,
    and for the engine actually running: `~/.codex`, `~/.opencode` + opencode's
    share/config/cache dirs, or `~/.hermes` (+ hermes's `$HOME/.hermes-tmp.<pid>`
    staging file by exact-name regex).
  A run **cannot** modify global Claude config that future runs would load, cannot
  write to your home directory, other repos, or system locations.
- **Escape hatch is loud, never silent.** `CW_SANDBOX=off` disables the wrap
  for a run; it is logged in the run's live log, written to the safety journal
  as `sandbox_disabled`, and stamped on the report as `sandboxed: false`.
- **Credential paths are explicitly unreadable:** `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config/gcloud`, browser profiles, cookies, shell histories.
  Symlinks are resolved at profile-generation time; a context root pointing into
  a credential path is refused outright (S-86).
- **Process supervision:** every run gets its own process group; termination is
  identity-verified (pid + pgid) group kills, never bare-pid kills.

**Verified exceptions (documented, not hidden):**
- *Keychain file reads remain possible.* Claude Code sources its OAuth via the
  login keychain even headless; denying keychain files breaks authentication
  entirely. Other applications' keychain items remain protected by their own
  per-item ACLs, which fail closed for headless processes. Net exposure equals
  what an interactive `claude` session already has on the same machine.
- *File reads are same-user-broad.* On macOS 26, read-restricted Seatbelt
  profiles make dyld abort before `main()` for every toolchain binary (verified;
  crash reports in ADR-023). Reads therefore match an interactive agent session.
  This is why worktree isolation is called "accident isolation" and NOT a
  security claim.

The full escape matrix lives in `spikes/reports/T008-sandbox.md`: SSH keys,
AWS creds, GnuPG, shell history, out-of-scope writes, symlink traversal, and
writes into read-only context roots are all OS-denied; git, node, and the
`claude` engine itself function inside the profile.

### 2. Worktrees = accident isolation (NOT a security claim)

Repo runs execute in `~/.clockwork/worktrees/<task>/<run-id>` on branch
`clockwork/<task>/<run-id>`. Your working tree is untouched by construction.
This bounds *mistakes*, not adversaries.

### 3. Deny-list + permission modes = policy UX

A global-only deny-list blocks force-pushes to protected branches, package
publishing, and credential-path access attempts, and journals every hit
(FR-27). On the Claude engine its **floor** entries (force-push to a protected
branch, package publishing) are enforced for every Bash call through the
`PreToolUse` hook described below; non-floor entries still only apply to calls
the CLI chooses to prompt for. Other engines have no per-command hook and rely
on the sandbox. It shapes normal behavior; it does NOT stop a determined adversarial
prompt from routing around patterns. The sandbox above is what bounds damage.

`bypassPermissions` is not offered in H1. Permission modes are `plan`
(dry-run) and `acceptEdits`.

## Prompt injection: documented, not solved

Attached files and URLs are untrusted input. Our stance (ADR-010): bound the
damage (sandbox + budgets + branch-isolation), surface intent (policy events in
reports), never claim immunity. `plan` mode exists exactly for untrusted-source
jobs. Imported templates/profiles arrive disabled with a security preview.

## Secrets & credentials

- Clockwork stores **no Anthropic credentials** — runs ride your existing
  Claude Code login (pointer only).
- Delivery credentials live outside the daemon DB (keychain at packaging; env/
  file bridge for CLI installs) and are **never visible to runner processes** —
  runners get sanitized envs and stdio IPC only.
- BYOK provider keys travel to the runner over the daemon⇄child **stdin
  channel, never the environment**. A process's exec-time environment stays
  readable through `sysctl` (`KERN_PROCARGS2`) by any same-user process,
  sandboxed or not, so an env var that is "read then deleted" is not a boundary
  (found in review 2026-09-06; the transport is the fix, the profile cannot be).
- The local API is loopback-only with a bearer token stored `0600`.

## Engine capability honesty

The Claude engine (headless `claude -p`) asks Clockwork before each gated tool
call through `--permission-prompt-tool`, served by a loopback HTTP MCP server in
the runner (verified on CLI 2.1.261, ADR-034 — this replaces ADR-020's "no hook
as of 2.1.238"). A request **holds until a human answers or the run's wall-clock
budget ends**, then fail-safe denies; both outcomes are recorded. The tool is not
visible to the model, so the agent cannot approve itself.

Codex, OpenCode and Hermes expose no permission hook; for them the sandbox and
budgets are the containment, and the UI hides approval affordances. There is no
"SDK engine". Two engine specifics (ADR-035): **Codex runs with its own
`workspace-write` sandbox off while Clockwork's is on** — macOS refuses to apply a
second Seatbelt inside a `(deny default)` profile (`sandbox_apply: Operation not
permitted`, every allow bisected), so exactly one layer applies and it is ours;
only `CW_SANDBOX=off` falls back to codex's. Codex's inner sandbox also blocked
shell-command network; under Clockwork's profile network is allowed, as for every
engine. **Hermes 0.21.0's oneshot path ignores `--in`**, so `HermesRunner` sets
`TERMINAL_CWD` to the worktree; before this its file writes landed in `$HOME`.

**Closed 2026-09-06 — the policy floor now sees every Bash call (ADR-035).**
Probed 2026-09-05 through the production runner on CLI 2.1.261 under
`acceptEdits`: `npm view left-pad version` was sent to the prompt tool, but
**`git push --force origin main` executed with no prompt at all** — the CLI's own
`acceptEdits` behaviour, not a settings leak. The deny-list would have refused it
and was never consulted.

The fix: every run injects a Claude Code `PreToolUse` hook (matcher `Bash`)
through `--settings`. The hook (`packages/runner/src/floor-hook.ts`, generated
per run next to the MCP config, no imports beyond `node:http`) posts the command
to the bridge's `/floor` route, where the supervisor runs `evaluateCommand`; a
floor hit exits 2 and the CLI refuses the call with the reason. It is
**fail-closed**: bridge unreachable, malformed input, timeout — every error path
also exits 2, so a CLI format change breaks runs loudly instead of silently
un-protecting them. Hooks fire in every permission mode, so coverage no longer
depends on what the CLI chooses to prompt for. The payload also pins
`disableAllHooks: false`: the CLI honours that switch from a repo's own
`.claude/settings.json`, and without the pin one committed key turned the floor
off while the report still said `sandboxed: true` (probed 2026-09-06; CLI-flag
settings outrank project settings, so the pin wins). Cost per Bash call: about
60 ms (Node start plus one loopback round trip, median of ten).

Verified 2026-09-06 through the production `runner-child`: `npm view …` still
prompted (bridge intact), `git push --force origin main` came back as
"force-push to protected branch 'main' is blocked by global deny-list" and never
ran; recorded as a `policy_deny` event and a `deny_list_hit` journal entry.

**Still open, surfaced not hidden:** the run inherits `HOME`, so
`permissions.allow` rules in `~/.claude/settings.json` and the developer's own
`SessionStart`/`SessionEnd` hooks apply to unattended runs. The floor hook holds
regardless (deny beats allow in the CLI's hook precedence); pinning
`--setting-sources` is a product decision left open. The hook matches the
`Bash` tool only: an MCP server the repo declares in `.mcp.json` (kept on
purpose — `--strict-mcp-config` would drop it) that runs shell on the agent's
behalf is not matched, so the floor does not see those calls; the sandbox still
bounds them. The permission bridge listens on loopback without a bearer token, so
a sandboxed agent that reads the port from its own argv could post fake approval
prompts into the inbox (noise, not an escalation — decisions route back by
request id); a per-run header is the planned fix.

## Reporting a security issue

See `CONTRIBUTING.md` for responsible disclosure. Confirmed containment escapes
are stop-ship events with public post-mortems.
