# Clockwork — Security Model

> Honest layering. We describe what each boundary does and does not do.
> Anything marketed beyond this document would be a trust violation.

## The three layers (and what each one actually is)

### 1. OS sandbox = THE containment boundary

Every run executes inside a per-run macOS Seatbelt profile
(`packages/runner/src/sandbox.ts`, versioned in source):

**Enforced:**
- **Writes are default-denied.** A run may write only to:
  - its own worktree or scratch directory,
  - `/dev/null` (git requires it),
  - scoped engine-state subpaths: `~/.claude/{projects,statsig,shell-snapshots,logs}`.
  A run **cannot** modify global Claude config that future runs would load, cannot
  write to your home directory, other repos, or system locations.
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
(FR-27). It shapes normal behavior; it does NOT stop a determined adversarial
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
- The local API is loopback-only with a bearer token stored `0600`.

## Engine capability honesty

The default engine (headless `claude -p`) has no permission-callback hook as of
CLI 2.1.238 (verified, ADR-020): M1 runs fail safe on permission blocks rather
than hanging. HITL approvals require the SDK engine (opt-in). Capability flags
drive the UI so it degrades honestly per engine.

## Reporting a security issue

See `CONTRIBUTING.md` for responsible disclosure. Confirmed containment escapes
are stop-ship events with public post-mortems.
