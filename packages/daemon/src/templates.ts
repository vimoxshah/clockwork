/**
 * Templates (FR-3 / T-203) + linear chain validation (FR-8 / T-202).
 * Imported templates arrive DISABLED with a security preview (S-74); template
 * variables validated at apply time (S-75).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';

export interface TemplateFile {
  schema: 'clockwork.template.v1';
  name: string;
  prompt: string;
  repoPath?: string | null;
  baseBranch?: string | null;
  profileSlug?: string | null;
  permissionMode: string;
  budget: { maxUsd: number; maxTurns: number; timeoutSec: number };
  schedule?: unknown;
  missedPolicy?: string;
  overlapPolicy?: string;
  /** Declarative only — `/templates/import` (api.ts) hardcodes `{ osNotify: true }` regardless, same posture as budget/schedule below. */
  delivery?: { osNotify: boolean };
}

/**
 * Five canonical, bookable job definitions (T-207 / T4-7) shipped as JSON
 * under resources/templates/ — same bundled-resource shape `makeSkillResolver`
 * (profiles.ts) uses for resources/skill-pack, resolved the same way
 * (main.ts:242) relative to the daemon's own compiled location.
 *
 * A file that is not valid JSON or not `schema: 'clockwork.template.v1'` is
 * skipped rather than crashing daemon startup on one bad bundled file —
 * `packages/daemon/test/templates-library.test.ts` pins that every shipped
 * file DOES parse, so this is a safety net, not a silently-accepted defect.
 * Sorted by filename for a deterministic list (`readdirSync` order is not
 * guaranteed across platforms).
 *
 * STAGED, NOT WIRED: as of T4-7 this function has NO production caller —
 * `grep -rn loadBundledTemplates packages/*\/src` finds only this
 * definition. Nothing in the running daemon reads resources/templates/ yet;
 * `api.ts` (owned by a later wave this task may not touch) has no route that
 * serves a bundled template to a client. T4-8 ("Export a template, share a
 * job") is the named consumer — it already owns both `templates.ts` and
 * `api.ts` and is the natural place to add a `GET /templates` (or similar)
 * route backed by this function. Until that wave lands, the five JSON files
 * are reachable only by this loader and by the composer's separate,
 * hand-mirrored `COMPOSER_TEMPLATES` copy (ComposerView.tsx) — the two are
 * kept honest against each other by
 * `packages/daemon/test/templates-composer-sync.test.ts`, which is the thing
 * actually standing between "shipped" and "staged and silently drifting" for
 * as long as this loader has no caller.
 */
export function loadBundledTemplates(dir: string): TemplateFile[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out: TemplateFile[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      if (raw && raw.schema === 'clockwork.template.v1') out.push(raw as TemplateFile);
    } catch {
      // malformed bundled file — skip, see doc comment above
    }
  }
  return out;
}

/** S-74 security preview: what differs from safe defaults; bypassPermissions flagged red. */
export function securityPreview(tpl: TemplateFile): { flags: Array<{ level: 'red' | 'yellow' | 'info'; text: string }>; arrivesDisabled: true } {
  const flags: Array<{ level: 'red' | 'yellow' | 'info'; text: string }> = [];
  if ((tpl.permissionMode as string) === 'bypassPermissions') {
    flags.push({ level: 'red', text: 'bypassPermissions is banned in H1 — import will be rejected.' });
  }
  if (/curl|wget|fetch\(/i.test(tpl.prompt)) {
    flags.push({ level: 'yellow', text: 'prompt references network fetches — verify the source.' });
  }
  if (tpl.repoPath && tpl.repoPath.startsWith('/')) {
    flags.push({ level: 'info', text: `absolute repo path '${tpl.repoPath}' will be re-picked on apply.` });
  }
  for (const m of tpl.prompt.matchAll(/\{\{\s*(\w[\w.]*)\s*\}\}/g)) {
    flags.push({ level: 'info', text: `template variable {{${m[1]}}} must be filled at apply.` });
  }
  flags.push({ level: 'info', text: 'Imported templates arrive DISABLED — review then enable.' });
  return { flags, arrivesDisabled: true };
}

/** S-75: validate assumed paths exist at apply time. */
export function validateTemplateApply(
  tpl: TemplateFile,
  vars: Record<string, string>,
): { ok: boolean; error?: string } {
  const missing = [...tpl.prompt.matchAll(/\{\{\s*(\w[\w.]*)\s*\}\}/g)]
    .map((m) => m[1]!)
    .filter((v) => !(v in vars));
  if (missing.length > 0) return { ok: false, error: `unfilled variables: ${missing.join(', ')}` };
  return { ok: true };
}

// ---------- chaining (H1: LINEAR only, FR-8) ----------

/**
 * S-72: cycles rejected at save; single parent enforced (fan-in/fan-out is
 * H2 scope, S-76). Returns error string or null.
 */
export function validateChain(db: DB, taskId: string, chainAfter: string | null): string | null {
  if (!chainAfter) return null;
  if (chainAfter === taskId) return 'a task cannot chain to itself';
  // at most one successor per task (linear chains): the predecessor must not
  // already have another enabled child waiting on it.
  const existingChild = db
    .prepare('SELECT id FROM tasks WHERE chain_after=? AND deleted_at IS NULL AND id != ?')
    .get(chainAfter, taskId);
  if (existingChild) {
    return `task "${chainAfter}" already has a chained successor (${(existingChild as any).id}); a task can have only one`;
  }
  // walk up from chainAfter; cycle => reject
  let cur = chainAfter;
  const seen = new Set<string>([taskId]);
  for (let i = 0; i < 1000; i++) {
    if (seen.has(cur)) return 'chain cycle detected';
    seen.add(cur);
    const row = db.prepare('SELECT chain_after FROM tasks WHERE id=?').get(cur) as any;
    if (!row) return 'predecessor task not found or deleted';
    if (!row.chain_after) break;
    cur = row.chain_after;
  }
  return null;
}

/** S-73: bind {{previous.report}} with truncation to summary + artifact refs. */
export function renderChainPrompt(
  promptTemplate: string,
  previousRun: { report_json: string | null } | undefined,
  budgetChars = 12_000,
): string {
  if (!promptTemplate.includes('{{previous')) return promptTemplate;
  let block = '(no previous run output available)';
  if (previousRun?.report_json) {
    try {
      const r = JSON.parse(previousRun.report_json);
      block = r.summary ?? '';
      const artifacts = r.artifacts ?? [];
      if (artifacts.length) block += `\nArtifacts: ${artifacts.join(', ')}`;
      if (block.length > budgetChars) {
        block = `${block.slice(0, budgetChars)}… [truncated to fit context budget]`;
      }
    } catch {}
  }
  return promptTemplate.replace(/\{\{previous\.report\}\}/g, block).replace(/\{\{previous\.artifacts\}\}/g, () => {
    try {
      const r = previousRun?.report_json ? JSON.parse(previousRun.report_json) : { artifacts: [] };
      return (r.artifacts ?? []).join(', ') || '(none)';
    } catch {
      return '(none)';
    }
  });
}

/**
 * Event placeholders (goal #27): render {{event.<dot.path>}} from the inbound
 * trigger event stashed on the run spec. Unknown paths resolve to '(missing)'
 * so a malformed filter never silently corrupts a prompt. Non-object payloads
 * are wrapped so {{event.value}} still works for scalar bodies.
 */
export function renderEventPrompt(prompt: string, event: { source: string; payload: unknown; at: number } | null | undefined): string {
  if (!prompt.includes('{{event')) return prompt;
  const root = event && typeof event === 'object' ? (event.payload as Record<string, unknown>) : {};
  const resolve = (path: string): string => {
    const val = path
      .split('.')
      .reduce<unknown>((acc, key) => (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)
        ? (acc as Record<string, unknown>)[key]
        : undefined), root);
    if (val === undefined || val === null) return '(missing)';
    return typeof val === 'string' ? val : JSON.stringify(val);
  };
  return prompt.replace(/\{\{event\.([a-zA-Z0-9_.]+)\}\}/g, (_m, path: string) => resolve(path));
}

/** Path existence probe used by composer/preflight (shared by template apply). */
export function pathExists(p: string | null | undefined): boolean {
  if (!p) return false;
  try {
    return statSync(p).isDirectory() || existsSync(p);
  } catch {
    return false;
  }
}
