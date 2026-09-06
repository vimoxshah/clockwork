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
import { realpathSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** v2 (2026-09-05): allow the CLI's per-shell cwd-tracking file; see CLI_CWD_FILE_REGEX. */
export const SANDBOX_PROFILE_VERSION = 2;

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

/**
 * Claude Code 2.1.x's Bash tool writes one cwd-tracking file per shell
 * invocation at /tmp/claude-<hex>-cwd (verified 2026-09-05 on 2.1.261). With
 * it denied, every command still runs but the shell exits 1, which the agent
 * reads as failure. This regex admits exactly that filename and nothing else
 * under /tmp — tested against /tmp/claude-<hex>-cwdx and /tmp/other-cwd.
 */
export const CLI_CWD_FILE_REGEX = '^/private/tmp/claude-[0-9a-f]+-cwd$';

export interface SandboxSpec {
  /** rw locations: the run worktree or scratch dir */
  writePaths: string[];
  /** ro locations: repo root, context roots */
  readPaths: string[];
  /**
   * Exact-filename allows (Seatbelt `regex`) for engines that stage a file
   * outside the run scope — e.g. hermes writes $HOME/.hermes-tmp.<pid> before
   * moving it into the worktree. Anchored patterns only; never a directory.
   */
  writeRegexes?: string[];
}

/** Escape a literal path for use inside a Seatbelt regex. */
export function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
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
    `  (allow file-write* (regex #"${CLI_CWD_FILE_REGEX}"))`,
    ...(spec.writeRegexes ?? []).map((r) => `  (allow file-write* (regex #"${r}"))`),
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

// ---------------------------------------------------------------------------
// Production wiring. Everything above proves a PROFILE contains a process;
// everything below is how a run actually ends up inside one. Until 2026-09-05
// nothing called it — `new ClaudeCliRunner()` passed no spec and the other
// engines had no hook — while docs said every run was sandboxed.
// ---------------------------------------------------------------------------

/**
 * Claude Code's Bash tool needs a per-cwd work directory at
 * /tmp/claude-<uid>/<cwd with every "/" replaced by "-"> (observed 2.1.261).
 * Outside the write allowlist the shell never starts (EPERM on mkdir), so the
 * runner pre-creates it and allowlists exactly that directory.
 */
export function cliWorkDirFor(cwd: string): string {
  const real = resolveReal(cwd) ?? cwd;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `/tmp/claude-${uid}/${real.replace(/\//g, '-')}`;
}

/**
 * Package-manager caches live outside the worktree (~/.npm, ~/.cargo, ~/.cache,
 * …) and would be denied. Redirect the common ones — npm/pnpm/yarn, pip,
 * cargo, go, gem/bundler, uv/poetry, gradle, composer, nuget — into one
 * Clockwork-owned root so nightly runs keep a warm cache without widening the
 * boundary to $HOME. The framing in docs is "worktree plus Clockwork-managed
 * tool caches".
 */
export const TOOL_CACHE_ROOT = `${dataDir}/cache`;

export function toolCacheEnv(root: string = TOOL_CACHE_ROOT): Record<string, string> {
  return {
    npm_config_cache: path.join(root, 'npm'),
    // pnpm ≤10 reads npm_config_* for its own settings; pnpm 11+ switched to
    // pnpm_config_* only. Set both to the same path so the store redirect
    // works either way — npm itself will warn "Unknown env config store-dir"
    // on every invocation since store-dir isn't an npm key; that warning is
    // cosmetic and known, not a sign the redirect failed.
    npm_config_store_dir: path.join(root, 'pnpm-store'),
    pnpm_config_store_dir: path.join(root, 'pnpm-store'),
    YARN_CACHE_FOLDER: path.join(root, 'yarn'),
    PIP_CACHE_DIR: path.join(root, 'pip'),
    XDG_CACHE_HOME: path.join(root, 'xdg'),
    CARGO_HOME: path.join(root, 'cargo'),
    GOMODCACHE: path.join(root, 'go-mod'),
    GOCACHE: path.join(root, 'go-build'),
    GEM_HOME: path.join(root, 'gem'),
    BUNDLE_PATH: path.join(root, 'bundle'),
    UV_CACHE_DIR: path.join(root, 'uv'),
    POETRY_CACHE_DIR: path.join(root, 'poetry'),
    GRADLE_USER_HOME: path.join(root, 'gradle'),
    COMPOSER_CACHE_DIR: path.join(root, 'composer'),
    NUGET_PACKAGES: path.join(root, 'nuget'),
  };
}

export interface SandboxSpecInput {
  /** The run's cwd: the git worktree, or the scratch dir for repo-less tasks. */
  worktreePath: string;
  scratchPath: string | null;
  repoPath: string | null;
  contextRoots: string[];
  /** Extra writable roots an engine needs for its own state (e.g. ~/.codex). */
  engineStatePaths?: string[];
  /** Exact-filename allows for engine staging files; see SandboxSpec.writeRegexes. */
  engineWriteRegexes?: string[];
  cacheRoot?: string;
}

/**
 * Build the per-run spec and create the directories it names. Reads stay
 * platform-broad (ADR-023); writes are the worktree, the CLI work dir, the
 * tool-cache root, and any engine state paths — nothing else.
 */
export function buildSandboxSpec(input: SandboxSpecInput): SandboxSpec {
  const cacheRoot = input.cacheRoot ?? TOOL_CACHE_ROOT;
  const cliWork = cliWorkDirFor(input.worktreePath);
  mkdirSync(cliWork, { recursive: true, mode: 0o700 });
  for (const v of Object.values(toolCacheEnv(cacheRoot))) mkdirSync(v, { recursive: true });
  for (const p of input.engineStatePaths ?? []) mkdirSync(p, { recursive: true, mode: 0o700 });
  const writePaths = [input.worktreePath, input.scratchPath, cliWork, cacheRoot, ...(input.engineStatePaths ?? [])].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  const readPaths = [input.repoPath, ...input.contextRoots].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return { writePaths, readPaths, writeRegexes: input.engineWriteRegexes ?? [] };
}

export interface ApplySandboxOptions {
  /** Per-spawn additions (a usage-file dir, a journal dir) that are not part of the run spec. */
  extraWritePaths?: string[];
}

/**
 * Wrap an argv in sandbox-exec with a freshly generated profile. Every engine
 * runner routes its spawn through here; the wiring test asserts it by reading
 * the sources. A null spec is the explicit CW_SANDBOX=off escape hatch and is
 * logged and stamped on the report by the caller — never silent.
 *
 * Throws when the spec would allowlist a credential path. Callers must FAIL the
 * run on that, never fall back to an unsandboxed spawn.
 */
export function applySandbox(
  argv: string[],
  spec: SandboxSpec | null | undefined,
  opts: ApplySandboxOptions = {},
): { argv: string[]; profilePath: string | null; version: number | null } {
  if (!spec) return { argv, profilePath: null, version: null };
  const merged: SandboxSpec = {
    writePaths: [...spec.writePaths, ...(opts.extraWritePaths ?? [])],
    readPaths: spec.readPaths,
    writeRegexes: spec.writeRegexes,
  };
  const { profile, version } = generateSeatbeltProfile(merged);
  const profilePath = path.join(mkdtempSync(path.join(os.tmpdir(), 'cw-sb-')), 'profile.sb');
  writeFileSync(profilePath, profile, 'utf8');
  return { argv: wrapWithSandbox(argv, profilePath), profilePath, version };
}
