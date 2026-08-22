/**
 * PATH augmentation for service-context execution (T-108 follow-up):
 * a launchd LaunchAgent starts with the minimal system PATH (/usr/bin:/bin),
 * so user-installed toolchains (`claude` in ~/.local/bin, Homebrew, nvm node)
 * are invisible. The daemon must find them anyway — runs depend on it.
 */
import { homedir } from 'node:os';

const WELL_KNOWN_USER_BINS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  `${homedir()}/.local/bin`,
  `${homedir()}/.opencode/bin`,
  `${homedir()}/bin`,
];

export function augmentedPath(currentPath?: string): string {
  const parts = (currentPath ?? '').split(':').filter(Boolean);
  const seen = new Set(parts);
  for (const dir of WELL_KNOWN_USER_BINS) {
    if (!seen.has(dir)) parts.push(dir);
  }
  return parts.join(':');
}

/** Resolve a binary against the augmented PATH; absolute path when found. */
export function resolveOnAugmentedPath(bin: string): string | null {
  if (bin.includes('/')) return bin;
  for (const dir of augmentedPath(process.env.PATH).split(':')) {
    try {
      const p = `${dir}/${bin}`;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = requireFs();
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

import { accessSync, constants } from 'node:fs';
function requireFs(): typeof import('node:fs') {
  return { accessSync, constants } as unknown as typeof import('node:fs');
}
