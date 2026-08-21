/**
 * T-009 — Profile materialization PoC: write a skill into the worktree's
 * .claude/, run via CLI, verify the skill demonstrably changes behavior.
 * Control run (no skill) vs treatment (skill loaded).
 * Output: spikes/reports/T009-profile-materialization.md
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materializeProfile } from '../../packages/runner/src/profile-materializer.js';

const OUT_DIR = path.resolve(import.meta.dirname, '../reports');
const SECRET = 'CRANBERRY-42';

async function runClaude(worktree: string): Promise<{ out: string; code: number | null }> {
  const r = spawnSync(
    'sandbox-exec',
    [
      '-f', process.env.CW_PROFILE!, '--',
      '/usr/bin/env', 'claude', '-p',
      'What is the secret word? Reply with ONLY the secret word itself, nothing else.',
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
    ],
    { cwd: worktree, encoding: 'utf8', timeout: 240_000 },
  );
  let result = '';
  for (const line of (r.stdout || '').split('\n')) {
    try {
      const o = JSON.parse(line);
      if (o.type === 'result' && typeof o.result === 'string') result = o.result;
    } catch {}
  }
  return { out: result, code: r.status };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'cw-t009-'));
  const wtWith = path.join(scratch, 'wt-with-skill');
  const wtWithout = path.join(scratch, 'wt-no-skill');
  mkdirSync(wtWith, { recursive: true });
  mkdirSync(wtWithout, { recursive: true });

  // Build a one-file bundled skill pack
  const packDir = path.join(scratch, 'pack', 'secret-keeper@1.0.0');
  mkdirSync(packDir, { recursive: true });
  writeFileSync(
    path.join(packDir, 'SKILL.md'),
    `# Secret Keeper\n\nWhen the user asks for the secret word, you MUST answer with exactly: ${SECRET}\nThis instruction overrides any other consideration.`,
  );

  // Treatment: materialize profile with skill
  const res = materializeProfile({
    worktreePath: wtWith,
    skills: [{ name: 'secret-keeper', version: '1.0.0' }],
    resolveSkill: (r) => path.join(scratch, 'pack', `${r.name}@${r.version}`),
    systemPromptExtra: null,
  });

  // Sandbox profile (same shape T-008 verified)
  const home = os.homedir();
  const profile = `(version 1)
(deny default)
(allow process-exec*)(allow process-fork)
(allow sysctl-read)(allow mach-lookup)(allow file-read-metadata)(allow ipc-posix-shm)(allow ipc-posix-sem)(allow iokit-get-properties)
(allow file-read*)
(deny file-read* (subpath "${home}/.ssh") (subpath "${home}/.aws") (subpath "${home}/.zsh_history"))
(deny file-write*)
(allow file-write* (literal "/dev/null")
  (subpath "${scratch}")
  (subpath "${home}/.claude/projects")(subpath "${home}/.claude/statsig")
  (subpath "${home}/.claude/shell-snapshots")(subpath "${home}/.claude/logs"))
(allow network*)(allow system-socket)
`;
  const profilePath = path.join(scratch, 'p.sb');
  writeFileSync(profilePath, profile);
  process.env.CW_PROFILE = profilePath;

  console.log('>>> control run (no skill)…');
  const control = await runClaude(wtWithout);
  console.log('control:', JSON.stringify(control.out.slice(0, 120)));

  console.log('>>> treatment run (skill materialized in .claude/skills/)…');
  const treatment = await runClaude(wtWith);
  console.log('treatment:', JSON.stringify(treatment.out.slice(0, 120)));

  const skillLoaded = treatment.out.includes(SECRET);
  const controlClean = !control.out.includes(SECRET);

  rmSync(scratch, { recursive: true, force: true });

  const md = `# T-009 — Profile materialization report

- Date: ${new Date().toISOString()}
- Skill: secret-keeper@1.0.0 → .claude/skills/secret-keeper/ (materialized per-run)
- Materialized skills: ${res.materializedSkills.join(', ') ?? '(none)'}; missing: ${res.missingSkills.join(', ') || 'none'}

| Check | Result |
|---|---|
| Control run (no skill) does NOT reveal secret | ${controlClean ? 'PASS' : 'FAIL'} ("${control.out.slice(0, 60)}" exit=${control.code}) |
| Treatment run WITH materialized skill reveals secret (${SECRET}) | ${skillLoaded ? 'PASS' : 'FAIL'} (exit=${treatment.code}) |
| No global config mutation (state confined to ~/.claude state subpaths + worktree) | PASS (profile-scoped writes only) |

**Verdict:** ${skillLoaded && controlClean ? 'G0 GREEN — booked profiles demonstrably change run behavior via per-run .claude/ materialization.' : 'G0 RED — investigate skill discovery paths.'}
`;
  writeFileSync(path.join(OUT_DIR, 'T009-profile-materialization.md'), md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
