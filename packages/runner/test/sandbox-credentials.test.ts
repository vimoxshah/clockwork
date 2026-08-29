/**
 * Break-it test for a claim the landing page and README both make in absolute
 * terms: "SSH keys unreadable".
 *
 * That is a security guarantee, and until now it rested on the PRESENCE of
 * deny rules rather than on anything trying to defeat them. The profile allows
 * `file-read*` broadly — a documented macOS/dyld constraint (ADR-023) — and
 * relies on specific `(deny file-read* (subpath ...))` rules winning by rule
 * specificity. That is exactly the kind of assumption worth attacking.
 *
 * These tests shell out to the real `sandbox-exec`, so they assert what macOS
 * actually enforces, not what the profile text says.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSeatbeltProfile, wrapWithSandbox, CREDENTIAL_PATHS } from '../src/sandbox.js';

const SSH = path.join(os.homedir(), '.ssh');

/**
 * A real, readable, regular FILE inside ~/.ssh.
 *
 * The first version of this used readdirSync(SSH)[0], which on this machine is
 * a DIRECTORY (`conductor_config.d`). `cat` on a directory fails with "Is a
 * directory" whether or not the sandbox denies anything, so five of these
 * tests passed with ~/.ssh REMOVED from CREDENTIAL_PATHS — they were asserting
 * nothing. Caught by deleting the deny rule and watching them stay green.
 */
function victimKey(): string | null {
  if (!existsSync(SSH)) return null;
  const preferred = ['id_ed25519', 'id_rsa', 'known_hosts', 'config'];
  const files = readdirSync(SSH).filter((f) => {
    try { return statSync(path.join(SSH, f)).isFile(); } catch { return false; }
  });
  const pick = preferred.find((p) => files.includes(p)) ?? files[0];
  return pick ? path.join(SSH, pick) : null;
}
const VICTIM = victimKey();
const hasSsh = VICTIM !== null;
const onMac = process.platform === 'darwin';

let dir: string;
let profilePath: string;
let allowedFile: string;

/** Run argv inside the sandbox; return {ok, out}. Never throws. */
function inSandbox(argv: string[]): { ok: boolean; out: string } {
  const wrapped = wrapWithSandbox(argv, profilePath);
  try {
    const out = execFileSync(wrapped[0]!, wrapped.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-sbx-'));
  allowedFile = path.join(dir, 'allowed.txt');
  writeFileSync(allowedFile, 'readable-by-design\n');
  const { profile } = generateSeatbeltProfile({ writePaths: [dir], readPaths: [dir] });
  profilePath = path.join(dir, 'profile.sb');
  writeFileSync(profilePath, profile);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!onMac)('sandbox credential containment', () => {
  // CONTROL. Without this, "cannot read ~/.ssh" proves nothing — a broken
  // sandbox-exec would fail every command and the suite would look green.
  it('control: a non-credential file IS readable inside the sandbox', () => {
    const r = inSandbox(['/bin/cat', allowedFile]);
    expect(r.ok, `sandbox denied an allowed read, so the denials below prove nothing: ${r.out}`).toBe(true);
    expect(r.out).toContain('readable-by-design');
  });

  it('~/.ssh is in the credential deny list at all', () => {
    expect(CREDENTIAL_PATHS).toContain(SSH);
  });

  it.skipIf(!hasSsh)('the victim really is a readable regular file OUTSIDE the sandbox', () => {
    // Without this, a denial inside the sandbox proves nothing — the file
    // might simply be unreadable, or not a file at all.
    const raw = execFileSync('/bin/cat', [VICTIM!], { encoding: 'utf8' });
    expect(raw.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasSsh)('cannot read a real key file with cat', () => {
    const r = inSandbox(['/bin/cat', VICTIM!]);
    expect(r.ok, `SSH key was READABLE inside the sandbox: ${VICTIM}`).toBe(false);
  });

  it.skipIf(!hasSsh)('cannot list the directory', () => {
    expect(inSandbox(['/bin/ls', SSH]).ok).toBe(false);
  });

  // The bypasses an agent would actually reach for.
  it.skipIf(!hasSsh)('cannot read it through a shell subprocess', () => {
    const r = inSandbox(['/bin/sh', '-c', `cat ${JSON.stringify(VICTIM!)}`]);
    expect(r.ok, `shell subprocess READ the key: ${r.out.slice(0, 120)}`).toBe(false);
  });

  it.skipIf(!hasSsh)('cannot reach it through a relative path from home', () => {
    const r = inSandbox(['/bin/sh', '-c', `cd ${JSON.stringify(os.homedir())} && cat .ssh/${path.basename(VICTIM!)}`]);
    expect(r.ok, `relative path READ the key: ${r.out.slice(0, 120)}`).toBe(false);
  });

  it.skipIf(!hasSsh)('cannot reach it through a symlink created inside the run scope', () => {
    const link = path.join(dir, 'link-to-ssh');
    try { symlinkSync(SSH, link); } catch { /* already there */ }
    const r = inSandbox(['/bin/sh', '-c', `cat ${JSON.stringify(path.join(link, path.basename(VICTIM!)))}`]);
    expect(r.ok, `symlink into the run scope READ the key: ${r.out.slice(0, 120)}`).toBe(false);
  });

  it.skipIf(!hasSsh)('cannot copy it into the writable run scope', () => {
    const r = inSandbox(['/bin/sh', '-c', `cp ${JSON.stringify(VICTIM!)} ${JSON.stringify(path.join(dir, 'stolen'))}`]);
    expect(r.ok, 'exfiltration into the run scope succeeded').toBe(false);
    expect(existsSync(path.join(dir, 'stolen'))).toBe(false);
  });
});
