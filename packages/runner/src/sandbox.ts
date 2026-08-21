/**
 * macOS Seatbelt sandbox profile generation (FR-26 / T-111 / ADR-012).
 *
 * THE security boundary. FS allowlist = worktree/scratch (rw) + repo (ro)
 * + toolchain + configured context-roots (ro). Credential paths are excluded.
 * Profile is versioned and auditable; violations land in the safety journal
 * (the OS writes deny reasons to stderr of denied syscalls; the runner also
 * records every (profile-version, run) pair).
 */
import { realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SANDBOX_PROFILE_VERSION = 1;

/** Credential paths always excluded — cannot be relaxed per task (NFR-2). */
export const CREDENTIAL_PATHS = [
  `${os.homedir()}/.ssh`,
  `${os.homedir()}/.aws`,
  `${os.homedir()}/.gnupg`,
  `${os.homedir()}/.config/gcloud`,
  `${os.homedir()}/Library/Keychains`,
  `${os.homedir()}/Library/Cookies`,
  `${os.homedir()}/Library/Application Support/Google/Chrome`,
  `${os.homedir()}/Library/Application Support/Firefox`,
];

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
  const readReal = [...new Set(spec.readPaths.map(resolveReal).filter((p): p is string => !!p))];

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
  const readLines = readReal
    .map((p) => `(allow file-read* (subpath "${escapeForSeatbelt(p)}"))`)
    .map((l) => `  ${l}`)
    .join('\n');

  const profile = `;; Clockwork per-run containment profile v${SANDBOX_PROFILE_VERSION}
;; Generated per run. Auditable. The boundary is THIS file, not patterns.
(version 1)
(deny default)
(deny file-write*)          ;; default-deny writes; explicit subpaths below
${denyLines}

;; --- process basics ---
(allow process-exec*)
(allow process-fork)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow ipc-posix-sem)

;; --- filesystem reads: system + toolchain + user home (minus credentials above) ---
(allow file-read*
  (subpath "/usr/bin")
  (subpath "/bin")
  (subpath "/usr/lib")
  (subpath "/usr/local")
  (subpath "/opt/homebrew")
  (subpath "/private/var/db/timezone")
  (subpath "/System/Library/CoreServices/SystemVersion.plist")
  (subpath "${escapeForSeatbelt(os.tmpdir())}")
  (subpath "${escapeForSeatbelt(os.homedir())}/.claude")
  (subpath "${escapeForSeatbelt(os.homedir())}/.npm")
  (literal "/etc/passwd")
  (literal "/etc/hosts")
  (subpath "/dev/fd"))
${readLines}

;; --- filesystem writes: ONLY the run scope ---
${writeLines}

;; --- network egress permitted (agent needs Anthropic + registries), FR-26 ---
(allow network*)
(allow system-socket)
(allow network-bind (local ip "localhost:*"))

;; --- metadata operations needed by git/node ---
(allow file-ioctl)
(allow file-read-metadata)
`;
  return { profile, version: SANDBOX_PROFILE_VERSION };
}

/** Command builder: wraps argv in `sandbox-exec -f <profile> --`. */
export function wrapWithSandbox(argv: string[], profilePath: string): string[] {
  return ['sandbox-exec', '-f', profilePath, '--', ...argv];
}
