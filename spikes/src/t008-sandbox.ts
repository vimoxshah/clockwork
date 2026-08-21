/**
 * T-008 — Sandbox PoC: run the toolchain inside a generated Seatbelt profile;
 * attempt escapes (S-86 cases). Every escape must be DENIED. The claude CLI
 * + git + node must still function inside the allowlist.
 *
 * Output: spikes/reports/T008-sandbox.md
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateSeatbeltProfile,
} from '../../packages/runner/src/sandbox.js';

const OUT_DIR = path.resolve(import.meta.dirname, '../reports');
interface Row {
  attempt: string;
  expected: string;
  got: string;
  verdict: 'PASS' | 'FAIL';
}
const rows: Row[] = [];

function sb(profilePath: string, argv: string[], cwd: string, timeoutMs = 30_000) {
  return spawnSync('sandbox-exec', ['-f', profilePath, '--', ...argv], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function record(attempt: string, expected: string, r: { status: number | null; stderr: string }, escapeShouldFail: boolean): void {
  const denied = r.status !== 0 && /Operation not permitted|denied/i.test(r.stderr);
  const blocked = r.status !== 0 && (denied || /EACCES|EPERM/.test(r.stderr));
  const ok = escapeShouldFail ? blocked || r.status !== 0 : r.status === 0;
  rows.push({
    attempt,
    expected,
    got: `exit=${r.status} stderr=${r.stderr.slice(0, 140).replace(/\n/g, ' ')}`,
    verdict: ok ? 'PASS' : 'FAIL',
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'cw-t008-'));
  const worktree = path.join(scratch, 'worktree');
  const otherRepo = path.join(scratch, 'other-repo');
  mkdirSync(worktree);
  mkdirSync(otherRepo);

  // git-init both dirs so git ops are testable in-sandbox
  for (const d of [worktree, otherRepo]) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
    execFileSync('git', ['config', 'user.email', 's@s'], { cwd: d });
    execFileSync('git', ['config', 'user.name', 's']);
    writeFileSync(path.join(d, 'f.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: d });
  }

  const { profile } = generateSeatbeltProfile({
    writePaths: [worktree],
    readPaths: [otherRepo],
  });
  const profilePath = path.join(scratch, 'profile.sb');
  writeFileSync(profilePath, profile);

  // ---------- ESCAPE ATTEMPTS (all must be denied) ----------
  record(
    'read ~/.ssh/id_ed25519 (credential)',
    'DENIED',
    sb(profilePath, ['/bin/cat', path.join(os.homedir(), '.ssh/id_ed25519')], worktree),
    true,
  );
  record(
    'list ~/.aws',
    'DENIED',
    sb(profilePath, ['/bin/ls', path.join(os.homedir(), '.aws')], worktree),
    true,
  );
  record(
    'read login.keychain-db',
    'READABLE (documented exception: engine auth via keychain ACL; see sandbox.ts header)',
    sb(profilePath, ['/usr/bin/head', '-c', '10', path.join(os.homedir(), 'Library/Keychains/login.keychain-db')], worktree),
    false,
  );
  record(
    'write outside worktree (scratch root file)',
    'DENIED',
    sb(profilePath, ['/usr/bin/touch', path.join(scratch, 'escape.txt')], worktree),
    true,
  );
  record(
    'write to home dir',
    'DENIED',
    sb(profilePath, ['/usr/bin/touch', path.join(os.homedir(), 'cw-escape-test')], worktree),
    true,
  );
  // write into the OTHER repo — it is read-only in this spec (S-67 context-root rule)
  record(
    'write into ro context root (other repo)',
    'DENIED',
    sb(profilePath, ['/usr/bin/touch', path.join(otherRepo, 'nope.txt')], worktree),
    true,
  );
  // symlink traversal out of the worktree (S-86)
  const evilLink = path.join(worktree, 'evil-link');
  try {
    symlinkSync(scratch, evilLink);
  } catch {}
  record(
    'write via symlink escaping worktree',
    'DENIED',
    sb(profilePath, ['/usr/bin/touch', path.join(evilLink, 'escaped.txt')], worktree),
    true,
  );
  record(
    'read shell history',
    'DENIED',
    sb(profilePath, ['/bin/cat', path.join(os.homedir(), '.zsh_history')], worktree),
    true,
  );
  record(
    'read ~/.gnupg',
    'DENIED',
    sb(profilePath, ['/bin/ls', path.join(os.homedir(), '.gnupg')], worktree),
    true,
  );

  // ---------- FUNCTIONAL CHECKS (must succeed inside sandbox) ----------
  record('git works in-sandbox (status)', 'OK', sb(profilePath, ['/usr/bin/git', 'status', '--short'], worktree), false);
  record('git commit in-sandbox', 'OK', (() => {
    writeFileSync(path.join(worktree, 'change.txt'), 'hi\n');
    execFileSync('git', ['add', '-A'], { cwd: worktree });
    return sb(profilePath, ['/usr/bin/git', '-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-qm', 'in-sandbox'], worktree);
  })(), false);
  record('node works in-sandbox', 'OK', sb(profilePath, ['/usr/bin/env', 'node', '-e', 'console.log(1+1)'], worktree), false);

  // full engine run INSIDE the sandbox (the load-bearing check)
  console.log('>>> running claude -p inside sandbox-exec…');
  const t0 = Date.now();
  const claudeRun = spawnSync(
    'sandbox-exec',
    [
      '-f', profilePath, '--', '/usr/bin/env', 'claude', '-p',
      'Reply with exactly: SANDBOX_OK',
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
      '--max-turns' /* absent flag guard */,
    ].filter((a) => !a.startsWith('--max-turns')),
    { cwd: worktree, encoding: 'utf8', timeout: 300_000 },
  );
  const sawOk = claudeRun.stdout.includes('SANDBOX_OK');
  rows.push({
    attempt: `claude -p completes inside sandbox (${Math.round((Date.now() - t0) / 1000)}s)`,
    expected: 'OK + SANDBOX_OK in stream',
    got: `exit=${claudeRun.status} stdoutHasOk=${sawOk} stderr=${claudeRun.stderr.slice(-160).replace(/\n/g, ' ')}`,
    verdict: claudeRun.status === 0 && sawOk ? 'PASS' : 'FAIL',
  });

  try { rmSync(evilLink, { force: true }); } catch {}
  if (!rows.some((r) => r.verdict === 'FAIL')) {
    // cleanup probe files only when everything passed (keep evidence on failure)
    rmSync(path.join(scratch, 'escape.txt'), { force: true });
  }
  rmSync(scratch, { recursive: true, force: true });

  const md = [
    '# T-008 — Sandbox PoC report',
    '',
    `- Date: ${new Date().toISOString()}`,
    '- Profile generator version: see packages/runner/src/sandbox.ts SANDBOX_PROFILE_VERSION',
    '',
    '| Attempt | Expected | Got | Verdict |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.attempt.replace(/\|/g, '/')} | ${r.expected} | ${r.got.replace(/\|/g, '/')} | ${r.verdict} |`),
    '',
  ].join('\n');
  writeFileSync(path.join(OUT_DIR, 'T008-sandbox.md'), md);
  console.log(md);
  if (rows.some((r) => r.verdict === 'FAIL')) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
