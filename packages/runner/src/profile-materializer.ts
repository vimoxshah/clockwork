/**
 * Profile materializer (FR-28 / T-009): writes the booked profile's skills,
 * subagents, and system-prompt extra into the run worktree's `.claude/` so
 * they load for exactly that run — no global config mutation.
 */
import { mkdirSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

export interface SkillRef {
  name: string;
  version: string;
}

export interface MaterializeInput {
  worktreePath: string;
  skills: SkillRef[];
  /** bundled skill pack resolver: name@version -> absolute dir */
  resolveSkill: (ref: SkillRef) => string | null;
  systemPromptExtra?: string | null;
}

export interface MaterializeResult {
  claudeDir: string;
  materializedSkills: string[];
  missingSkills: string[];
}

/**
 * Layout written into the worktree:
 *   .claude/skills/<name>/SKILL.md        (copied from pack at pinned version)
 *   .claude/CLAUDE.local.md               (profile system-prompt extra)
 * A manifest records what was pinned for the report/audit trail.
 */
export function materializeProfile(input: MaterializeInput): MaterializeResult {
  const claudeDir = path.join(input.worktreePath, '.claude');
  rmSync(claudeDir, { recursive: true, force: true });
  mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });

  const materialized: string[] = [];
  const missing: string[] = [];

  for (const ref of input.skills) {
    const src = input.resolveSkill(ref);
    if (!src || !existsSync(src)) {
      missing.push(`${ref.name}@${ref.version}`);
      continue;
    }
    const dest = path.join(claudeDir, 'skills', ref.name);
    try {
      cpSync(src, dest, { recursive: true });
      // Guard: a skill must not smuggle config that escapes the run scope.
      rmSync(path.join(dest, 'settings.json'), { force: true });
      materialized.push(`${ref.name}@${ref.version}`);
    } catch {
      missing.push(`${ref.name}@${ref.version}`);
    }
  }

  if (input.systemPromptExtra && input.systemPromptExtra.trim().length > 0) {
    writeFileSync(
      path.join(claudeDir, 'CLAUDE.local.md'),
      `# Clockwork profile instructions\n\n${input.systemPromptExtra}\n`,
      'utf8',
    );
  }

  writeFileSync(
    path.join(claudeDir, 'clockwork-manifest.json'),
    JSON.stringify({ materialized, missing, at: Date.now() }, null, 2),
    'utf8',
  );

  return { claudeDir, materializedSkills: materialized, missingSkills: missing };
}
