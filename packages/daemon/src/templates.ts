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
 * The exact TaskCreate a template import builds (P6 shares it for packs):
 * IMPORT_GRANT budgets, queue/no-schedule until reviewed, collapsed
 * permission mode, user re-picks repo/profile at apply. One builder so a
 * pack can never grant what a file cannot — extracted verbatim from the
 * `/templates/import` route, which now calls this.
 */
export function buildImportTaskInput(tpl: { name?: unknown; prompt?: unknown; permissionMode?: unknown }): {
  name: string;
  prompt: string;
  profileId: undefined;
  repoPath: undefined;
  permissionMode: 'plan' | 'acceptEdits';
  budget: { maxUsd: number; maxTurns: number; timeoutSec: number };
  schedule: { kind: 'queue'; tz: string };
  missedPolicy: string;
  missedWindowSec: number;
  overlapPolicy: string;
  retryOnTransient: boolean;
  context: { files: never[] };
  delivery: { osNotify: boolean };
} {
  return {
    name: String((tpl as any).name ?? 'Imported template').slice(0, 120),
    prompt: String((tpl as any).prompt ?? ''),
    profileId: undefined,
    repoPath: undefined, // S-75: user re-picks at apply
    permissionMode: collapseImportPermissionMode((tpl as any).permissionMode),
    budget: { ...IMPORT_GRANT.budget },
    schedule: { ...IMPORT_GRANT.schedule }, // imported = not scheduled until reviewed
    missedPolicy: IMPORT_GRANT.missedPolicy,
    missedWindowSec: 21_600,
    overlapPolicy: IMPORT_GRANT.overlapPolicy,
    retryOnTransient: false,
    context: { files: [] },
    delivery: { ...IMPORT_GRANT.delivery },
  };
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
  // Union walk from chainAfter: follow ALL parent links (column + edges).
  // HOLE1 was here — the old walk saw only chain_after, so an edge A→B plus
  // PATCH B.chain_after=A admitted a cycle neither check refused. Reaching
  // taskId through any mixture of links is a cycle. The depth cap refuses
  // rather than passes: a chain too deep to verify is not verified.
  {
    // Seed EMPTY: pre-seeding taskId would mark the very node we are looking
    // for as already visited, and the pop-time check would never fire — every
    // real cycle would pass as acyclic.
    const seenU = new Set<string>();
    const stack = [chainAfter];
    for (let i = 0; i < 10000 && stack.length > 0; i++) {
      const c = stack.pop()!;
      if (c === taskId) return 'chain cycle detected';
      if (seenU.has(c)) continue;
      seenU.add(c);
      const r = db.prepare('SELECT chain_after FROM tasks WHERE id=?').get(c) as any;
      if (!r) return 'predecessor task not found or deleted';
      for (const p of chainParents(db, c)) {
        if (!seenU.has(p.parentId)) stack.push(p.parentId);
      }
    }
    if (stack.length > 0) return 'chain graph too deep to verify — refusing rather than passing';
  }
  return null;
}

export type ChainEdgeOn = 'completed' | 'any_terminal';

/** Normalize the chain_on vocabulary drift: legacy rows carry 'success'
 *  (the pre-zod default); the firing rule treats it as 'completed'. One
 *  place, so the route, the firer and the viz can never disagree. */
export function normalizeChainOn(v: unknown): ChainEdgeOn {
  return v === 'any_terminal' ? 'any_terminal' : 'completed';
}

/** Parents of a task through BOTH mechanisms: legacy column + edge rows. */
export function chainParents(db: DB, childId: string): Array<{ parentId: string; on: ChainEdgeOn; via: 'column' | 'edge' }> {
  const out: Array<{ parentId: string; on: ChainEdgeOn; via: 'column' | 'edge' }> = [];
  const seen = new Set<string>();
  const alive = (id: string): boolean =>
    !!(db.prepare('SELECT id FROM tasks WHERE id=? AND deleted_at IS NULL').get(id) as any);
  // Deletes are soft (deleted_at), so edge rows outlive their tasks unless
  // filtered here — an unfiltered deleted parent would block fan-in forever
  // and pollute the pipeline graph with a task that no longer exists.
  const col = db.prepare('SELECT chain_after, chain_on FROM tasks WHERE id=? AND deleted_at IS NULL').get(childId) as any;
  if (col?.chain_after && alive(col.chain_after)) {
    seen.add(col.chain_after);
    out.push({ parentId: col.chain_after, on: normalizeChainOn(col.chain_on), via: 'column' });
  }
  const rows = db.prepare('SELECT parent_task_id, on_state FROM chain_edges WHERE child_task_id=?').all(childId) as any[];
  for (const r of rows) {
    if (seen.has(r.parent_task_id) || !alive(r.parent_task_id)) continue;
    seen.add(r.parent_task_id);
    out.push({ parentId: r.parent_task_id, on: normalizeChainOn(r.on_state), via: 'edge' });
  }
  return out;
}

/** Children of a task through BOTH mechanisms. */
export function chainChildren(db: DB, parentId: string): Array<{ childId: string; on: ChainEdgeOn; via: 'column' | 'edge' }> {
  const out: Array<{ childId: string; on: ChainEdgeOn; via: 'column' | 'edge' }> = [];
  const seen = new Set<string>();
  const cols = db.prepare('SELECT id, chain_on FROM tasks WHERE chain_after=? AND deleted_at IS NULL').all(parentId) as any[];
  for (const c of cols) {
    seen.add(c.id);
    out.push({ childId: c.id, on: normalizeChainOn(c.chain_on), via: 'column' });
  }
  const rows = db
    .prepare(
      `SELECT e.child_task_id, e.on_state FROM chain_edges e
       JOIN tasks t ON t.id = e.child_task_id AND t.deleted_at IS NULL
       WHERE e.parent_task_id = ?`,
    )
    .all(parentId) as any[];
  for (const r of rows) {
    if (seen.has(r.child_task_id)) continue;
    seen.add(r.child_task_id);
    out.push({ childId: r.child_task_id, on: normalizeChainOn(r.on_state), via: 'edge' });
  }
  return out;
}

/**
 * P3: validate one DAG edge. The union graph (chain_after links + edge rows)
 * must stay acyclic: the edge parent→child is refused when child can already
 * reach parent. Linear validateChain above is unchanged for the column.
 *
 * `forRaceRecheck` runs the SAME checks minus the duplicate probes: after
 * our own INSERT the row exists by construction, so a dup hit would be our
 * own reflection. Only the cycle walk can still fail — which is exactly the
 * concurrent-writer case the recheck exists for.
 */
export function validateEdge(db: DB, parentId: string, childId: string, on: unknown, opts?: { forRaceRecheck?: boolean }): string | null {
  if (parentId === childId) return 'a task cannot depend on itself';
  if (on !== 'completed' && on !== 'any_terminal') return "on must be 'completed' or 'any_terminal'";
  const alive = (id: string): boolean =>
    !!(db.prepare('SELECT id FROM tasks WHERE id=? AND deleted_at IS NULL').get(id) as any);
  if (!alive(parentId)) return 'parent task not found or deleted';
  if (!alive(childId)) return 'child task not found or deleted';
  const dup = !opts?.forRaceRecheck
    ? (db.prepare('SELECT 1 FROM chain_edges WHERE parent_task_id=? AND child_task_id=?').get(parentId, childId) as any)
    : null;
  if (dup) return 'that dependency already exists';
  const col = !opts?.forRaceRecheck
    ? (db.prepare('SELECT chain_after FROM tasks WHERE id=?').get(childId) as any)
    : null;
  if (col?.chain_after === parentId) return 'that dependency already exists as the chained successor';
  // Reachability downstream from the child through the union graph: adding
  // parent→child closes a cycle exactly when the parent is already reachable
  // from the child (child → … → parent). Walking parents here would answer
  // the wrong question and admit every real cycle.
  const seen = new Set<string>();
  const stack = [childId];
  for (let i = 0; i < 10000 && stack.length > 0; i++) {
    const cur = stack.pop()!;
    if (cur === parentId) return 'that dependency would close a chain cycle';
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const c of chainChildren(db, cur)) {
      if (!seen.has(c.childId)) stack.push(c.childId);
    }
  }
  // Fail closed like validateChain: exhaustion is unverified, not acyclic.
  if (stack.length > 0) return 'chain graph too deep to verify — refusing rather than passing';
  return null;
}

/** S-73: bind {{previous.report}} with truncation to summary + artifact refs. */
export function renderChainPrompt(
  promptTemplate: string,
  previousRun: { report_json: string | null } | undefined,
  budgetChars = 12_000,
  upstreamByTask?: Map<string, { report_json: string | null } | undefined>,
): string {
  let out = promptTemplate;
  if (out.includes('{{previous')) {
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
    out = out.replace(/\{\{previous\.report\}\}/g, block).replace(/\{\{previous\.artifacts\}\}/g, () => {
      try {
        const r = previousRun?.report_json ? JSON.parse(previousRun.report_json) : { artifacts: [] };
        return (r.artifacts ?? []).join(', ') || '(none)';
      } catch {
        return '(none)';
      }
    });
  }
  // P3: explicit upstream binding {{runs.<taskId>.report}} /
  // {{runs.<taskId>.artifacts}}. Each id resolves against the firing-time
  // snapshot the caller passes — the LATEST run of that parent task, so a
  // retried parent re-binds instead of replaying stale output (the ambiguity
  // audit risk in latest-run-per-task lookups). Unknown ids and parents with
  // no runs yet render as named-missing, never empty: the caller refuses the
  // firing when a REQUIRED reference is missing (see fireChainedTasks).
  if (upstreamByTask && /\{\{runs\./.test(out)) {
    // Shared budget across ALL {{runs.*}} bindings (HOLE8 was N×12k: a
    // 50-parent fan-in would inject ~600k chars). Each binding truncates
    // against the remainder, so the total stays bounded whatever the fan-in.
    let remaining = 24_000;
    const take = (s: string): string => {
      if (remaining <= 0) return '… [context budget exhausted — earlier parents took it]';
      const piece = s.length > remaining ? `${s.slice(0, remaining)}… [truncated to fit context budget]` : s;
      remaining -= piece.length;
      return piece;
    };
    const summarize = (reportJson: string | null | undefined): string => {
      if (!reportJson) return '';
      try {
        const r = JSON.parse(reportJson);
        let b = r.summary ?? '';
        const artifacts = r.artifacts ?? [];
        if (artifacts.length) b += `\nArtifacts: ${artifacts.join(', ')}`;
        if (b.length > budgetChars) b = `${b.slice(0, budgetChars)}… [truncated to fit context budget]`;
        return take(b);
      } catch {
        return '';
      }
    };
    out = out.replace(/\{\{runs\.([A-Za-z0-9_-]+)\.report\}\}/g, (_m, id: string) => {
      if (!upstreamByTask.has(id)) return `(unknown upstream task ${id})`;
      const s = summarize(upstreamByTask.get(id)?.report_json);
      return s || `(task ${id} has no runs yet)`;
    });
    out = out.replace(/\{\{runs\.([A-Za-z0-9_-]+)\.artifacts\}\}/g, (_m, id: string) => {
      if (!upstreamByTask.has(id)) return `(unknown upstream task ${id})`;
      try {
        const r = upstreamByTask.get(id)?.report_json ? JSON.parse(upstreamByTask.get(id)!.report_json!) : { artifacts: [] };
        const list = (r.artifacts ?? []).join(', ') || `(task ${id} has no artifacts yet)`;
        return take(list);
      } catch {
        return `(task ${id} has no artifacts yet)`;
      }
    });
  }
  return out;
}

/** Task ids referenced via {{runs.<id>.*}} — validated before execution. */
export function upstreamRefs(prompt: string): string[] {
  const ids = new Set<string>();
  for (const m of prompt.matchAll(/\{\{runs\.([A-Za-z0-9_-]+)\.(report|artifacts)\}\}/g)) ids.add(m[1]!);
  return [...ids];
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
