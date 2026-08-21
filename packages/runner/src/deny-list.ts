/**
 * Deny-list policy floor (FR-11 / ADR-008/ADR-012): ERGONOMIC policy layer,
 * explicitly NOT the security boundary (that's the OS sandbox). Global-only;
 * never per-task relaxable. Hits are journaled.
 */
export interface DenyVerdict {
  denied: boolean;
  reason?: string;
  /** true when the hit is a hard floor (never approvable) */
  floor: boolean;
}

const PROTECTED_BRANCHES = ['main', 'master', 'release', 'production'];
const CREDENTIAL_PATH_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)Library\/Keychains(\/|$)/,
  /id_rsa|id_ed25519/,
];

export function evaluateCommand(command: string): DenyVerdict {
  const c = command.trim().toLowerCase();
  // force-push to protected branches
  if (/git\s+push\s+.*--force/.test(c) || /\bgit\s+push\s+-f\b/.test(c)) {
    const m = c.match(/(?:origin\s+)?(\S+)\s*$/);
    const branch = m?.[1] ?? '';
    if (PROTECTED_BRANCHES.some((p) => branch === p || branch.startsWith(`${p}:`) || branch.endsWith(`:${p}`))) {
      return { denied: true, reason: `force-push to protected branch '${branch}' is blocked by global deny-list`, floor: true };
    }
    return { denied: true, reason: 'force-push requires approval (global policy)', floor: false };
  }
  // package publish
  if (/\bnpm\s+publish\b|\bbun\s+publish\b|\bpnpm\s+publish\b|\btwine\s+upload\b/.test(c)) {
    return { denied: true, reason: 'package publishing is blocked during unattended runs', floor: true };
  }
  // credential path reads via shell tools
  if (/(cat|head|tail|less|more|cp|mv|rm|chmod|chown|curl|wget|base64|xxd|strings)\s+.*(~\/\.ssh|~\/\.aws|\/library\/keychains)/.test(c)) {
    return { denied: true, reason: 'credential-path access is blocked by global deny-list', floor: true };
  }
  // destructive fs outside worktree
  if (/rm\s+-rf\s+\/(\s|$)/.test(c) || /mkfs/.test(c) || /dd\s+if=.*of=\/dev\//.test(c)) {
    return { denied: true, reason: 'destructive system command blocked by global deny-list', floor: true };
  }
  return { denied: false, floor: false };
}

export function evaluatePathRead(p: string): DenyVerdict {
  for (const re of CREDENTIAL_PATH_PATTERNS) {
    if (re.test(p)) return { denied: true, reason: `credential-path read denied: ${p}`, floor: true };
  }
  return { denied: false, floor: false };
}
