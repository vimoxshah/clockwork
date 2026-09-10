/**
 * Templates (FR-3 / T-203) + linear chain validation (FR-8 / T-202).
 * Imported templates arrive DISABLED with a security preview (S-74); template
 * variables validated at apply time (S-75).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { maskSecrets } from '@clockwork/runner';
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
  /** Declarative only — `/templates/import` (api.ts) hardcodes `{ osNotify: true }` regardless, same posture as budget/schedule below. T4-8: that hardcoded grant is now `IMPORT_GRANT.delivery` below, the single source both directions read from. */
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
 * WIRED (T4-8): `GET /templates/bundled` (api.ts) now calls this function on
 * every request (no caching — five small files), so the five JSON files are
 * reachable over the daemon's own HTTP API, not merely by this loader and a
 * test. `packages/daemon/test/templates-bundled-route.test.ts` proves the
 * route itself, over `app.inject`, the same way `templates-library.test.ts`
 * proves `/templates/preview` + `/templates/import`.
 *
 * ComposerView.tsx's quick-fill list is UNCHANGED by this: T4-8's touch scope
 * was `templates.ts` / `api.ts` / `TasksView.tsx`, not `ComposerView.tsx`, so
 * the composer still carries its own hand-mirrored `COMPOSER_TEMPLATES`
 * constant rather than fetching this route. That means
 * `packages/daemon/test/templates-composer-sync.test.ts` is NOT made
 * redundant by this route — it remains the only thing standing between
 * "shipped" and "silently drifting" for the composer's copy. A future task
 * that points ComposerView at `GET /templates/bundled` instead of its own
 * constant is what would finally retire that sync test.
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

/**
 * T4-8: the "hardcoded power" `/templates/import` (api.ts) grants an
 * imported task, regardless of what the template file itself declares for
 * these fields. Single source of truth for BOTH directions — the import
 * route applies exactly this, and `exportTaskTemplate` below declares
 * exactly this, so the two can never drift apart and a template can never
 * end up claiming more than import will actually honour (a file that says
 * "$50 budget" and silently becomes "$2" the moment it is imported). Values
 * mirror what the route already hardcoded before this constant existed:
 * `TaskCreate`'s own safe defaults (shared/schemas.ts) for budget, a
 * queue/no-schedule for "not scheduled until reviewed", and `run-late`/
 * `skip`/`osNotify: true` as the least-surprising defaults for a task
 * nobody has reviewed yet.
 */
export const IMPORT_GRANT = {
  budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
  schedule: { kind: 'queue', tz: 'UTC' },
  missedPolicy: 'run-late',
  overlapPolicy: 'skip',
  delivery: { osNotify: true },
} as const;

/**
 * `/templates/import`'s own permission-mode collapse, pulled out so export
 * and import can never disagree about what a given mode becomes: `'plan'`
 * passes through, every other value (including the schema-legal but
 * UI-unreachable `'default'`, and any invented string a hand-edited or
 * stranger's file might carry) becomes `'acceptEdits'`. `bypassPermissions`
 * is not a case here — `permissionModes` (shared/schemas.ts) does not offer
 * it in H1 at all, and `securityPreview` below independently red-flags it if
 * a file claims it anyway.
 */
export function collapseImportPermissionMode(mode: unknown): 'plan' | 'acceptEdits' {
  return mode === 'plan' ? 'plan' : 'acceptEdits';
}

/**
 * T4-8: build a shareable template from a task row. The prompt is masked
 * with the same `maskSecrets` proof-of-work.ts uses for run reports — an
 * exported file is something the user hands to someone else, same posture:
 * masking is not optional and has no flag.
 *
 * Every "hardcoded power" field (budget/schedule/missedPolicy/overlapPolicy/
 * delivery) is declared from `IMPORT_GRANT` above, NEVER the task's live
 * values — see that constant's doc comment for why declaring the task's
 * real budget would be a lie the moment anyone imports the file back.
 * `permissionMode` goes through the same `collapseImportPermissionMode`
 * import itself applies, so what the file declares is always exactly what
 * re-importing it would produce, for every legal value.
 *
 * `repoPath`/`baseBranch`/`profileSlug` are omitted on purpose:
 * `/templates/import` discards all three unconditionally (S-75 — repoPath is
 * re-picked, no profile is ever granted on import), repoPath/baseBranch are
 * the EXPORTING user's own filesystem detail with no meaning to a recipient,
 * and profileSlug — even though this runs server-side and could resolve one
 * from `row.profile_id` — would assert a capability import throws away
 * anyway and that the recipient's install may not even ship. That is
 * deliberately different from the five curated files under
 * resources/templates/, which DO declare profileSlug: those are the
 * profile's own canonical advertisement, not a live user task.
 */
export function exportTaskTemplate(task: { name: string; prompt: string; permission_mode: string }): TemplateFile {
  return {
    schema: 'clockwork.template.v1',
    name: task.name,
    prompt: maskSecrets(task.prompt),
    permissionMode: collapseImportPermissionMode(task.permission_mode),
    budget: { ...IMPORT_GRANT.budget },
    schedule: { ...IMPORT_GRANT.schedule },
    missedPolicy: IMPORT_GRANT.missedPolicy,
    overlapPolicy: IMPORT_GRANT.overlapPolicy,
    delivery: { ...IMPORT_GRANT.delivery },
  };
}

/** Deterministic download filename for a task's template export (T4-8) — same idiom as proofFilenameFor/icsFilenameFor. */
export function templateExportFilenameFor(taskId: string): string {
  return `clockwork-template-${taskId}.json`;
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
