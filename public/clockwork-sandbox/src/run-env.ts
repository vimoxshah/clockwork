/**
 * The environment an agent run receives.
 *
 * This is a SECURITY BOUNDARY, not a convenience helper. Clockwork publishes
 * the claim that a run cannot reach your ssh-agent, cloud credentials, or
 * provider tokens. That claim is NOT enforced by the Seatbelt sandbox — the
 * profile permits `system-socket`, and the agent socket lives outside every
 * credential deny path. It is true only because the child process env is
 * built here, as an ALLOWLIST, and SSH_AUTH_SOCK never reaches the process.
 *
 * An earlier audit of this very claim reached the WRONG conclusion by probing
 * the sandbox with the developer's own shell environment instead of the one a
 * run actually receives. Hence `source` is a parameter: the test passes a
 * hostile env and asserts what survives, rather than trusting ambient state.
 *
 * Every engine runner (claude, codex, opencode, hermes) builds its env from
 * this one function. Before extraction the allowlist was duplicated four times
 * and only the Claude copy was tested, so a variable added to any other runner
 * would have silently falsified a published claim.
 */
import os from 'node:os';
import { augmentedPath } from './service-path.js';

/**
 * The only variables a run may inherit. Everything else is dropped.
 *
 * USER/LOGNAME are required by macOS keychain ACL identification — verified
 * empirically: without them the engine cannot read its own OAuth item
 * ("Not logged in"); with them auth succeeds.
 */
export const RUN_ENV_ALLOWLIST = ['PATH', 'HOME', 'TERM', 'NO_COLOR', 'LANG', 'SHELL', 'USER', 'LOGNAME'] as const;

/** Fallback when the parent has no PATH — a LaunchAgent often does not. */
const MINIMAL_PATH = '/usr/bin:/bin:/usr/local/bin';

/**
 * Build the child env for an agent run.
 *
 * @param extra Engine-specific additions (e.g. HERMES_NONINTERACTIVE). These
 *   are trusted literals from the runner, never inherited from the parent.
 * @param source Environment to inherit from. Injectable so tests can supply a
 *   hostile env; defaults to the real process env.
 */
export function buildRunEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: augmentedPath(source.PATH ?? MINIMAL_PATH),
    HOME: source.HOME ?? os.homedir(),
    TERM: 'dumb',
    NO_COLOR: '1',
    LANG: source.LANG ?? 'en_US.UTF-8',
  };
  // Only forwarded when present — an empty USER is worse than none for the
  // keychain ACL check above.
  if (source.USER) env.USER = source.USER;
  if (source.LOGNAME) env.LOGNAME = source.LOGNAME;
  return { ...env, ...extra };
}
