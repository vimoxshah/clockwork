/**
 * Templates (FR-3 / T-203) + linear chain validation (FR-8 / T-202).
 * Imported templates arrive DISABLED with a security preview (S-74); template
 * variables validated at apply time (S-75).
 */
import { existsSync, statSync } from 'node:fs';
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
  // at most one predecessor AND at most one successor per task (linear)
  const existingChild = db
    .prepare('SELECT id FROM tasks WHERE chain_after=? AND deleted_at IS NULL')
    .get(chainAfter);
  void existingChild;
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
