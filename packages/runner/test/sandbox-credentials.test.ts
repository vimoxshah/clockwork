/**
 * Break-it tests for the credential containment the product advertises
 * ("SSH keys unreadable"). These shell out to the real `sandbox-exec`, so they
 * assert what macOS enforces, not what the profile text says.
 *
 * The profile allows `file-read*` broadly — a documented macOS/dyld constraint
 * (ADR-023) — and relies on specific `(deny file-read* (subpath ...))` rules
 * beating it by specificity. That is the assumption under attack here.
 *
 * TWO EARLIER MISTAKES, both caught by deleting the deny rule and watching the
 * suite stay green — never by reading it:
 *   1. The victim was `readdirSync(SSH)[0]`, which on the author's machine is
 *      a DIRECTORY. `cat` on a directory fails with "Is a directory" whatever
 *      the sandbox does, so five of six tests asserted nothing.
 *   2. `skipIf(!hasSsh)` meant a machine with no credential paths skipped every
 *      vector and still reported green.
 * Hence: every victim is proven to be a readable regular file OUTSIDE the
 * sandbox first, and the suite FAILS if it finds nothing to attack.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSeatbeltProfile, wrapWithSandbox, CREDENTIAL_PATHS } from '../src/sandbox.js';

/**
 * Independently pinned expectation — NOT derived from CREDENTIAL_PATHS.
 *
 * The previous version enumerated targets from CREDENTIAL_PATHS itself, so
 * deleting an entry removed the deny rule AND the check for it: the suite
 * passed with ~/.aws silently unprotected. A guard that reads its expectations
 * from the thing it guards cannot detect a deletion. Caught by planting.
 *
 * Adding a path here is a deliberate act; removing one from the product now
 * fails this list.
 */
const MUST_BE_DENIED = [
  '.ssh', '.aws', '.gnupg', '.config/gcloud',
  'Library/Cookies', 'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
  '.zsh_history', '.zhistory', '.bash_history',
].map((p) => path.join(os.homedir(), p));

const onMac = process.platform === 'darwin';

interface Target { label: string; credPath: string; victim: string; isDir: boolean }

let dir: string;
let profilePath: string;
let allowedFile: string;
let targets: Target[] = [];
let synthesised: string | null = null;

/** A readable regular file at or inside a credential path, else null. */
function victimIn(credPath: string): { victim: string; isDir: boolean } | null {
  if (!existsSync(credPath)) return null;
  let st;
  try { st = statSync(credPath); } catch { return null; }
  if (st.isFile()) return st.size > 0 ? { victim: credPath, isDir: false } : null;
  if (!st.isDirectory()) return null;
  // macOS TCC makes some of these unreadable to US (~/Library/Cookies throws
  // EPERM on scandir). Those are not useful targets — if we cannot read it
  // outside the sandbox, a denial inside proves nothing — so skip them here
  // rather than letting the throw take down the whole suite.
  let entries: string[];
  try { entries = readdirSync(credPath); } catch { return null; }
  for (const f of entries) {
    const p = path.join(credPath, f);
    try {
      const s = statSync(p);
      if (s.isFile() && s.size > 0) {
        execFileSync('/bin/cat', [p], { stdio: 'ignore' }); // must be readable by us
        return { victim: p, isDir: true };
      }
    } catch { /* unreadable or vanished — try the next */ }
  }
  return null;
}

function inSandbox(argv: string[]): { ok: boolean; out: string } {
  const w = wrapWithSandbox(argv, profilePath);
  try {
    const out = execFileSync(w[0]!, w.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
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

  for (const c of MUST_BE_DENIED) {
    const v = victimIn(c);
    if (v) targets.push({ label: c.replace(os.homedir(), '~'), credPath: c, victim: v.victim, isDir: v.isDir });
  }

  // Never skip. A machine with no credential paths gets a synthetic one so the
  // vectors still run, and it is removed again in afterAll.
  if (targets.length === 0) {
    const ssh = path.join(os.homedir(), '.ssh');
    if (!existsSync(ssh)) mkdirSync(ssh, { mode: 0o700 });
    synthesised = path.join(ssh, 'clockwork-test-key');
    writeFileSync(synthesised, 'SYNTHETIC KEY FOR SANDBOX TEST\n', { mode: 0o600 });
    targets.push({ label: '~/.ssh (synthesised)', credPath: ssh, victim: synthesised, isDir: true });
  }
});

afterAll(() => {
  if (synthesised) rmSync(synthesised, { force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!onMac)('sandbox credential containment', () => {
  // Without this the denials below prove nothing: a broken sandbox-exec would
  // fail every command and the suite would look green.
  it('control: a non-credential file IS readable inside the sandbox', () => {
    const r = inSandbox(['/bin/cat', allowedFile]);
    expect(r.ok, `sandbox denied an allowed read, so nothing below is meaningful: ${r.out}`).toBe(true);
    expect(r.out).toContain('readable-by-design');
  });

  it('found something to attack — never silently skips', () => {
    expect(targets.length, 'no credential path was exercised; this suite would have proved nothing').toBeGreaterThan(0);
  });

  // COVERAGE vs EFFECTIVENESS — deliberately two different checks.
  //
  // This one is STATIC: it proves a deny rule exists for every pinned path,
  // including ones no dynamic vector can reach. ~/Library/Cookies is
  // TCC-protected and unreadable even outside the sandbox, so it can never be
  // a live target — but deleting it from CREDENTIAL_PATHS still fails HERE.
  // Verified by planting that exact deletion.
  //
  // The per-path vectors below are the EFFECTIVENESS half: they prove the rule
  // actually stops a read. A path skipped there is still covered here, so the
  // skip is not a silent pass.
  it('denies every path on the pinned list, whatever CREDENTIAL_PATHS says', () => {
    const { profile } = generateSeatbeltProfile({ writePaths: [dir], readPaths: [dir] });
    const missing = MUST_BE_DENIED.filter((c) => !profile.includes(`(deny file-read* (subpath "${c}"))`));
    expect(missing, `credential paths lost their deny rule: ${missing.map((m) => m.replace(os.homedir(), '~')).join(', ')}`).toEqual([]);
  });

  // The pinned list guards against DELETION. This guards the other direction:
  // a path added to the product but never added here would be protected by the
  // sandbox yet attacked by no test — silently outside coverage. Recorded as a
  // known limit in iteration 10; closed here.
  it('every CREDENTIAL_PATHS entry is on the pinned list', () => {
    const unpinned = CREDENTIAL_PATHS.filter((c) => !MUST_BE_DENIED.includes(c));
    expect(
      unpinned,
      `added to the product but not to MUST_BE_DENIED, so nothing tests them: ${unpinned.map((m) => m.replace(os.homedir(), '~')).join(', ')}`,
    ).toEqual([]);
  });

  it('CREDENTIAL_PATHS has not quietly shrunk below the pinned list', () => {
    const gone = MUST_BE_DENIED.filter((c) => !CREDENTIAL_PATHS.includes(c));
    expect(gone, `removed from CREDENTIAL_PATHS: ${gone.map((m) => m.replace(os.homedir(), '~')).join(', ')}`).toEqual([]);
  });

  describe('per credential path', () => {
    it('runs the vectors against each path that exists', () => {
      const failures: string[] = [];
      for (const t of targets) {
        // Control per target: it must be readable OUTSIDE the sandbox, or a
        // denial inside is meaningless.
        try {
          execFileSync('/bin/cat', [t.victim], { stdio: 'ignore' });
        } catch {
          failures.push(`${t.label}: victim not readable outside the sandbox — test is void`);
          continue;
        }
        if (inSandbox(['/bin/cat', t.victim]).ok) failures.push(`${t.label}: cat READ it`);
        if (inSandbox(['/bin/sh', '-c', `cat ${JSON.stringify(t.victim)}`]).ok) failures.push(`${t.label}: shell READ it`);
        if (inSandbox(['/bin/sh', '-c', `cp ${JSON.stringify(t.victim)} ${JSON.stringify(path.join(dir, 'stolen'))}`]).ok) {
          failures.push(`${t.label}: copied out`);
        }
        if (t.isDir && inSandbox(['/bin/ls', t.credPath]).ok) failures.push(`${t.label}: listed the directory`);
      }
      expect(failures, `credential containment broke:\n${failures.join('\n')}`).toEqual([]);
    });
  });

  // Bypasses an agent would actually reach for, against the primary target.
  it('cannot reach a credential through a relative path from $HOME', () => {
    const t = targets[0]!;
    const rel = path.relative(os.homedir(), t.victim);
    const r = inSandbox(['/bin/sh', '-c', `cd ${JSON.stringify(os.homedir())} && cat ${JSON.stringify(rel)}`]);
    expect(r.ok, `relative path READ ${t.label}`).toBe(false);
  });

  it('cannot reach a credential through a symlink planted in the run scope', () => {
    const t = targets[0]!;
    const link = path.join(dir, 'link');
    try { symlinkSync(t.credPath, link); } catch { /* already exists */ }
    const inner = t.isDir ? path.join(link, path.basename(t.victim)) : link;
    const r = inSandbox(['/bin/sh', '-c', `cat ${JSON.stringify(inner)}`]);
    expect(r.ok, `symlink READ ${t.label}`).toBe(false);
  });
});
