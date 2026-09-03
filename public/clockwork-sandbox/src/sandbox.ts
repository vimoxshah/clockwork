/**
 * macOS Seatbelt sandbox profile generation (FR-26 / T-111 / ADR-012).
 *
 * THE security boundary. FS allowlist = worktree/scratch (rw) + repo (ro)
 * + toolchain + configured context-roots (ro). Credential paths are excluded.
 * Profile is versioned and auditable; violations land in the safety journal
 * (the OS writes deny reasons to stderr of denied syscalls; the runner also
 * records every (profile-version, run) pair).
 *
 * HONEST EXCEPTION (T-008 verified): the engine process must read its OWN
 * Claude Code OAuth material (~/.claude/.credentials.json) because the
 * keychain is denied inside the sandbox — identical exposure to interactive
 * `claude` use by the same user. The sandbox cannot un-see that one file;
 * what it bounds is filesystem/process damage beyond the allowlist. This is
 * documented in docs/security.md, never marketed away.
 */
import { realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SANDBOX_PROFILE_VERSION = 1;

/**
 * Credential paths always excluded — cannot be relaxed per task (NFR-2).
 *
 * VERIFIED EXCEPTIONS (T-008, 2026-08-21):
 * - Library/Keychains must remain READABLE: Claude Code 2.x sources OAuth via
 *   the login keychain even headless; denying the file breaks auth entirely.
 *   Other items are protected by per-item ACLs which fail closed headless
 *   (no UI to approve). Documented in docs/security.md.
 * - ~/.claude is writable ONLY in scoped subpaths (projects/statsig/
 *   shell-snapshots/logs) so a run cannot tamper global config that future
 *   runs would load.
 */
/**
 * Clockwork's OWN control-plane secrets.
 *
 * S-audit (iteration 13): these were unprotected, and that was a sandbox
 * escape — verified end to end, not theorised. A run could `cat`
 * ~/.clockwork/api-token, then reach the daemon on loopback with it (the
 * profile allows network*) and read every task through the authenticated API.
 * From there it could book a task with any repo path and prompt, escaping the
 * write restrictions of the run it started in.
 *
 * Deliberately NARROW. A blanket deny on ~/.clockwork would break every run:
 * worktrees live under ~/.clockwork/worktrees and journals under
 * ~/.clockwork/runs, so the agent must still read its own workspace. Only the
 * token and the database are denied — an agent has no legitimate reason to
 * read either.
 */
const dataDir = process.env.CLOCKWORK_HOME ?? `${os.homedir()}/.clockwork`;
export const CONTROL_PLANE_PATHS = [
  `${dataDir}/api-token`,
  `${dataDir}/clockwork.sqlite`,
  `${dataDir}/clockwork.sqlite-wal`,
  `${dataDir}/clockwork.sqlite-shm`,
];

export const CREDENTIAL_PATHS = [
  ...CONTROL_PLANE_PATHS,
  `${os.homedir()}/.ssh`,
  `${os.homedir()}/.aws`,
  `${os.homedir()}/.gnupg`,
  `${os.homedir()}/.config/gcloud`,
  `${os.homedir()}/Library/Cookies`,
  `${os.homedir()}/Library/Application Support/Google/Chrome`,
  `${os.homedir()}/Library/Application Support/Firefox`,
  `${os.homedir()}/.zsh_history`,
  `${os.homedir()}/.zhistory`,
  `${os.homedir()}/.bash_history`,
];

/** Subpaths of ~/.claude the ENGINE may write (never global config). */
export const CLAUDE_STATE_WRITE_SUBPATHS = ['projects', 'statsig', 'shell-snapshots', 'logs'];

export interface SandboxSpec {
  /** rw locations: the run worktree or scratch dir */
  writePaths: string[];
  /** ro locations: repo root, context roots */
  readPaths: string[];
}

/**
 * Resolve symlinks BEFORE allowlisting (S-86): a context root pointing at
 * ~/.ssh must be caught here, at profile generation, not by pattern matching
 * inside the sandbox.
 */
export function resolveReal(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return existsSync(p) ? p : null;
  }
}

export function escapeForSeatbelt(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function generateSeatbeltProfile(spec: SandboxSpec): { profile: string; version: number } {
  const writeReal = [...new Set(spec.writePaths.map(resolveReal).filter((p): p is string => !!p))];
  // Context roots are audited for credential collisions even though reads are
  // platform-broad (ADR-023): a context root that IS a credential path is a
  // misconfiguration worth refusing loudly.
  const readReal = [...new Set(spec.readPaths.map(resolveReal).filter((p): p is string => !!p))];
  for (const r of readReal) {
    for (const c of CREDENTIAL_PATHS) {
      if (r === c || r.startsWith(c + path.sep)) {
        throw new Error(`Refusing context root that resolves into a credential path: ${r}`);
      }
    }
  }

  // A write path that resolves into a credential path is refused outright.
  for (const w of writeReal) {
    for (const c of CREDENTIAL_PATHS) {
      if (w === c || w.startsWith(c + path.sep)) {
        throw new Error(`Refusing to allowlist credential path as writable: ${w}`);
      }
    }
  }

  const denyLines = CREDENTIAL_PATHS.map(
    (p) => `  (deny file-read* (subpath "${escapeForSeatbelt(p)}"))`,
  ).join('\n');

  const writeLines = writeReal
    .map((p) => `(allow file-write* (subpath "${escapeForSeatbelt(p)}"))`)
    .map((l) => `  ${l}`)
    .join('\n');
  // Engine state subpaths + /dev/null (git needs it; verified T-008).
  const engineWriteLines = [
    '  (allow file-write* (literal "/dev/null"))',
    ...CLAUDE_STATE_WRITE_SUBPATHS.map(
      (s) => `  (allow file-write* (subpath "${escapeForSeatbelt(`${os.homedir()}/.claude/${s}`)}"))`,
    ),
  ].join('\n');

  // PLATFORM CONSTRAINT (verified 2026-08-21, macOS 26.6): dyld4 aborts
  // before main() under read-restricted profiles; only an unqualified
  // file-read* allow produces functioning toolchain binaries. The enforced
  // boundary is therefore: WRITES are default-denied (allowlisted to the run
  // scope only) and credential paths carry SPECIFIC read-denies that beat the
  // broad read allow by rule specificity. Reads remain same-user-broad,
  // exactly like an interactive `claude` session. Recorded in DECISIONS
  // ADR-023; revisit if Apple fixes dyld or we move to entitlement helpers.
  const profile = `;; Clockwork per-run containment profile v${SANDBOX_PROFILE_VERSION}
;; Generated per run. Auditable. Writes default-deny; credentials unreadable.
(version 1)
(deny default)
(allow process-exec*)
(allow process-fork)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow ipc-posix-sem)
(allow iokit-get-properties)
(allow file-read-metadata)
(allow file-read*)          ;; platform-constrained: see ADR-023

;; --- credential exclusions: SPECIFIC denies override the broad allow ---
${denyLines}

;; --- filesystem writes: ONLY the run scope + engine state subpaths ---
(deny file-write*)
${writeLines}
${engineWriteLines}

;; --- network egress permitted (agent needs Anthropic + registries), FR-26 ---
(allow network*)
(allow system-socket)
(allow network-bind (local ip "localhost:*"))
`;
  return { profile, version: SANDBOX_PROFILE_VERSION };
}

/** Command builder: wraps argv in `sandbox-exec -f <profile> --`. */
export function wrapWithSandbox(argv: string[], profilePath: string): string[] {
  return ['sandbox-exec', '-f', profilePath, '--', ...argv];
}
