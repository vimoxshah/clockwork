/**
 * Round5-B. Linux containment argv builder (additive, pure function).
 *
 * macOS Seatbelt stays the boundary on Darwin (sandbox.ts). On Linux the
 * equivalent is bubblewrap + systemd-run caps. This module builds the argv
 * only — no spawn — so CI on macOS can still prove the deny shape.
 * Fails closed: any credential bind attempt throws.
 */
export interface LinuxSandboxInput {
  worktree: string;
  command: string[];
}

const BLOCKED_BINDS = ['/.ssh', '/.aws', '/run/docker.sock', '/.gnupg'];
const BLOCKED_ENV = [
  'SSH_AUTH_SOCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'DOCKER_HOST',
];

export function buildLinuxSandboxArgv(input: LinuxSandboxInput): { argv: string[]; envBlocklist: string[] } {
  for (const b of BLOCKED_BINDS) {
    if (input.worktree.includes(b)) throw new Error(`Refusing credential bind: ${b}`);
  }
  const argv = [
    'systemd-run',
    '--scope',
    '-p',
    'MemoryMax=2G',
    '-p',
    'CPUQuota=200%',
    '-p',
    'TasksMax=128',
    '-p',
    'NoNewPrivileges=yes',
    'bwrap',
    '--ro-bind',
    '/usr',
    '/usr',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '$HOME',
    '--bind',
    input.worktree,
    '/workspace',
    '--unshare-all',
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
    '--seccomp',
    '11',
    'mount,umount2,ptrace,kexec_load,init_module',
    '--',
    ...input.command,
  ];
  return { argv, envBlocklist: [...BLOCKED_ENV] };
}

export function envAfterBlocklist(env: Record<string, string>, blocklist: string[] = BLOCKED_ENV): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!blocklist.includes(k)) out[k] = v;
  }
  return out;
}
