/**
 * Built-in profiles (FR-28 / T-112) + bundled skill pack resolver.
 * Skills are pinned name@version — an app update never silently changes a
 * scheduled run's behavior; the user accepts bumps explicitly.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProfileRepo, ProfileRow } from './repo.js';
import { newId } from '@clockwork/shared';
import { EXTRA_PROFILES } from './profile-library.js';

export interface BundledProfile {
  slug: string;
  name: string;
  color: string;
  glyph: string;
  skills: Array<{ name: string; version: string }>;
  systemPromptExtra: string;
}

export const BUNDLED_PROFILES: BundledProfile[] = [
  {
    slug: 'generalist',
    name: 'Generalist',
    color: '#9BA1B6',
    glyph: '◦',
    skills: [],
    systemPromptExtra:
      'You are running unattended on a schedule. Work only inside the current repository scope. Finish with a crisp summary of what you did, what you skipped, and why.',
  },
  {
    slug: 'dep-surgeon',
    name: 'Dep Surgeon',
    color: '#7FD8C8',
    glyph: '✚',
    skills: [{ name: 'dependency-triage', version: '1.0.0' }],
    systemPromptExtra:
      'You are the Dep Surgeon: conservative dependency hygiene. Patch/minor bumps only when tests prove them; majors get triage notes, never blind upgrades. Never push or publish.',
  },
  {
    slug: 'docs-scribe',
    name: 'Docs Scribe',
    color: '#B9A7F2',
    glyph: '✎',
    skills: [{ name: 'docs-writer', version: '1.0.0' }],
    systemPromptExtra:
      'You are the Docs Scribe: documentation hygiene from evidence in the repo. Fix drift, keep voice, never invent features.',
  },
];

export function seedBuiltinProfiles(repo: ProfileRepo): void {
  for (const bp of [...BUNDLED_PROFILES, ...EXTRA_PROFILES]) {
    if (repo.bySlug(bp.slug)) continue; // never clobber (possibly edited) rows
    const row: ProfileRow = {
      id: newId(),
      slug: bp.slug,
      name: bp.name,
      color: bp.color,
      avatar: bp.glyph,
      engine: 'cli',
      model: null,
      permission_mode: 'acceptEdits',
      budget_usd: 2.0,
      max_turns: 50,
      timeout_sec: 3600,
      skills_json: JSON.stringify(bp.skills),
      mcp_allow_json: '[]',
      context_roots_json: '[]',
      system_prompt_extra: bp.systemPromptExtra,
      delivery_json: JSON.stringify({ osNotify: true }),
      builtin: 1,
    };
    repo.upsert(row);
  }
}

/**
 * Resolve a bundled skill ref against resources/skill-pack/. Also accepts
 * user-level (~/.claude/skills) and repo (.claude/skills) locations per FR-28.
 */
export function makeSkillResolver(bundledPackDir: string) {
  return (ref: { name: string; version: string }): string | null => {
    // 1. bundled pack (version-pinned)
    const bundled = path.join(bundledPackDir, `${ref.name}@${ref.version}`);
    if (existsSync(bundled)) return bundled;
    // 2. bundled by name only (latest shipped version wins for loose refs)
    try {
      const entries = readdirNames(bundledPackDir).filter((e) => e.startsWith(`${ref.name}@`));
      if (entries.length > 0) {
        return path.join(bundledPackDir, entries.sort().at(-1)!);
      }
    } catch {}
    // 3. user-level skills (unpinned — resolved live, documented behavior)
    const userSkill = path.join(process.env.HOME ?? '', '.claude', 'skills', ref.name);
    if (existsSync(userSkill)) return userSkill;
    return null;
  };
}

function readdirNames(dir: string): string[] {
  try {
    return readdirSyncSafe(dir);
  } catch {
    return [];
  }
}

import { readdirSync as readdirSyncRaw, statSync } from 'node:fs';
function readdirSyncSafe(dir: string): string[] {
  return readdirSyncRaw(dir).filter((e) => statSync(path.join(dir, e)).isDirectory());
}
