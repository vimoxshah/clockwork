/**
 * F5 repo-shipped-jobs (plan/AGENT-WORKFORCE-SPEC.md §4 F5).
 *
 * A `.clockwork/jobs.json` (or `.yaml` / `.yml`) inside a target repo declares
 * recommended jobs. Clockwork DISCOVERS and OFFERS them; it never imports one
 * on its own, and an accepted offer arrives DISABLED with a security preview,
 * exactly like template import (S-74, `templates.ts` `securityPreview()`).
 *
 * SECURITY: the jobs file is untrusted input from a repository.
 * `RepoJobSpec` (shared/workforce.ts) deliberately carries no
 * `permissionMode`, `engine`, `byokId` or `budget` — a repo cannot choose how
 * much power or money its job gets. Those come from the importing user, and
 * this module hardcodes the same conservative defaults `/templates/import`
 * uses (`acceptEdits`, `{maxUsd:2, maxTurns:50, timeoutSec:3600}`,
 * `schedule: {kind:'queue'}`) rather than trusting anything the repo file
 * says about how the job should run. zod already strips any such field if a
 * hostile file includes one; this module never reads it even if present.
 *
 * NO NEW DEPENDENCY: the workspace has no YAML parser. `.clockwork/jobs.json`
 * is fully supported; `.clockwork/jobs.yaml`/`.yml` goes through a RESTRICTED
 * parser written here.
 *
 * DO NOT RESTATE THE GRAMMAR IN THIS COMMENT. The version that stood here
 * claimed anchors, aliases, multi-document files, block scalars and nested
 * sequences were "each rejected with a named error rather than guessed at",
 * and two of the five were false: a multi-document file whose first document
 * has no leading `---` is merged, and mapping nesting has no depth bound at
 * all. A second copy of the list is a second thing to get wrong. The one
 * authoritative list — what is accepted, what is rejected BY NAME, and what is
 * NOT rejected — is `docs/agent-workforce.md` §F5, and
 * `packages/daemon/test/claims-honesty.test.ts` checks that list against this
 * parser in both directions, so neither can drift from the other in silence.
 *
 * Every scalar parses to a string; the fields `RepoJobSpec` declares are all
 * strings, so no number/boolean coercion is needed and none is attempted.
 * `RepoJobsFile.safeParse` is the single validator both formats converge on.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { newId } from '@clockwork/shared';
import type { RepoJobOffer, RepoJobStatus, TaskCreate } from '@clockwork/shared';
import { RepoJobSpec, RepoJobsFile } from '@clockwork/shared';
import type { DB } from './db.js';
import { TaskRepo } from './repo.js';
import { securityPreview } from './templates.js';

// ---------------------------------------------------------------------------
// Restricted YAML — internal, not exported. See module header for the
// supported subset and the rationale for keeping every scalar a string.
// ---------------------------------------------------------------------------

/**
 * How deeply the restricted parser will descend before it refuses.
 *
 * The two parse functions call each other, so an untrusted file could drive
 * them to `RangeError: Maximum call stack size exceeded` — a THROW, which
 * `parseJobsFile` rethrows and `discover()` does not catch. A real jobs file
 * nests four levels, so this bound is far above anything legitimate and far
 * below the stack.
 */
export const MAX_YAML_DEPTH = 32;

/**
 * The largest jobs file we will read. The file comes from a repository the
 * user pointed us at, and `readFileSync` with no cap will happily pull a
 * multi-gigabyte file into the daemon's heap.
 */
export const MAX_JOBS_FILE_BYTES = 64 * 1024;

class YamlError extends Error {
  constructor(lineNo: number, message: string) {
    super(`line ${lineNo}: ${message}`);
  }
}

/** Internal signal that a CAS update lost a race inside a transaction (never a YAML concern). */
class AlreadyResolvedError extends Error {}

interface Line {
  indent: number;
  content: string;
  lineNo: number;
}

/** Cuts a trailing `#` comment, but never one inside a quoted scalar. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      if (inDouble && line[i - 1] === '\\') {
        let backslashes = 0;
        let j = i - 1;
        while (j >= 0 && line[j] === '\\') {
          backslashes++;
          j--;
        }
        if (backslashes % 2 === 1) continue; // escaped quote — stays inside the string
      }
      inDouble = !inDouble;
    } else if (c === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1]!)) return line.slice(0, i);
    }
  }
  return line;
}

/** Splits into indent/content pairs; validates tabs and the multi-doc rule up front. */
function preprocess(text: string): Line[] {
  const rawLines = text.split(/\r\n|\n/);
  let docSeen = false;
  const lines: Line[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const stripped = stripComment(rawLines[i]!);
    if (stripped.trim() === '') continue;
    const leadingWs = /^[ \t]*/.exec(stripped)![0]!;
    if (leadingWs.includes('\t')) throw new YamlError(lineNo, 'tab indentation is not supported');
    if (/^---\s*$/.test(stripped)) {
      if (docSeen) throw new YamlError(lineNo, 'multi-document files are not supported');
      docSeen = true;
      continue;
    }
    lines.push({ indent: leadingWs.length, content: stripped.slice(leadingWs.length), lineNo });
  }
  return lines;
}

function matchKeyValue(content: string): { key: string; value: string } | null {
  const idx = content.indexOf(':');
  if (idx === -1) return null;
  const key = content.slice(0, idx).trim();
  if (!/^[A-Za-z_][\w.-]*$/.test(key)) return null;
  const rest = content.slice(idx + 1);
  if (rest.length > 0 && !/^\s/.test(rest)) return null; // "http://x" is not "key: value"
  return { key, value: rest.trim() };
}

function parseDoubleQuoted(value: string, lineNo: number): string {
  let i = 1;
  let out = '';
  while (i < value.length) {
    const c = value[i]!;
    if (c === '\\') {
      const next = value[i + 1];
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        default:
          // S-review: the offending character is a byte of an untrusted file. Name
          // the fault and its line; never echo what was read.
          throw new YamlError(lineNo, 'unsupported escape sequence');
      }
      i += 2;
      continue;
    }
    if (c === '"') {
      if (i !== value.length - 1) throw new YamlError(lineNo, 'unexpected content after closing quote');
      return out;
    }
    out += c;
    i++;
  }
  throw new YamlError(lineNo, 'unterminated double-quoted string');
}

function parseSingleQuoted(value: string, lineNo: number): string {
  let i = 1;
  let out = '';
  while (i < value.length) {
    const c = value[i]!;
    if (c === "'") {
      if (value[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      if (i !== value.length - 1) throw new YamlError(lineNo, 'unexpected content after closing quote');
      return out;
    }
    out += c;
    i++;
  }
  throw new YamlError(lineNo, 'unterminated single-quoted string');
}

function parseScalar(rawValue: string, lineNo: number): string {
  const v = rawValue.trim();
  if (v.startsWith('"')) return parseDoubleQuoted(v, lineNo);
  if (v.startsWith("'")) return parseSingleQuoted(v, lineNo);
  if (v.startsWith('&')) throw new YamlError(lineNo, 'anchors are not supported');
  if (v.startsWith('*')) throw new YamlError(lineNo, 'aliases are not supported');
  if (/^[|>][+\-0-9]*$/.test(v)) throw new YamlError(lineNo, 'block scalars are not supported');
  if (v.startsWith('[') || v.startsWith('{')) throw new YamlError(lineNo, 'flow collections are not supported');
  return v;
}

/** Parses the mapping starting at `startIdx` (all sibling entries share `indent`). */
function parseMappingEntries(
  lines: Line[],
  indent: number,
  startIdx: number,
  firstEntry?: { content: string; lineNo: number; afterIdx: number },
  depth = 1,
): [Record<string, unknown>, number] {
  if (depth > MAX_YAML_DEPTH) {
    throw new YamlError(lines[startIdx]?.lineNo ?? lines[lines.length - 1]?.lineNo ?? 1, 'nesting is too deep');
  }
  const obj: Record<string, unknown> = {};
  const seenKeys = new Set<string>();
  let idx = startIdx;
  let pending = firstEntry ?? null;
  for (;;) {
    let content: string;
    let lineNo: number;
    let afterIdx: number;
    if (pending) {
      ({ content, lineNo, afterIdx } = pending);
      pending = null;
    } else {
      if (idx >= lines.length) break;
      const line = lines[idx]!;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError(line.lineNo, 'unexpected indentation');
      if (line.content === '-' || line.content.startsWith('- ')) break;
      content = line.content;
      lineNo = line.lineNo;
      afterIdx = idx + 1;
    }
    const kv = matchKeyValue(content);
    // S-review (disclosure oracle): this used to quote `content` verbatim, and
    // the route hands the message straight to the caller. The line number says
    // WHERE without saying WHAT.
    if (!kv) throw new YamlError(lineNo, 'cannot parse mapping entry');
    if (seenKeys.has(kv.key)) throw new YamlError(lineNo, 'duplicate key');
    seenKeys.add(kv.key);
    if (kv.value === '') {
      if (afterIdx < lines.length && lines[afterIdx]!.indent > indent) {
        const childIndent = lines[afterIdx]!.indent;
        const isSeq = lines[afterIdx]!.content === '-' || lines[afterIdx]!.content.startsWith('- ');
        const [val, nextIdx] = isSeq
          ? parseSequence(lines, childIndent, afterIdx, depth + 1)
          : parseMappingEntries(lines, childIndent, afterIdx, undefined, depth + 1);
        obj[kv.key] = val;
        idx = nextIdx;
      } else {
        obj[kv.key] = null;
        idx = afterIdx;
      }
    } else {
      obj[kv.key] = parseScalar(kv.value, lineNo);
      idx = afterIdx;
    }
  }
  return [obj, idx];
}

function parseSequence(lines: Line[], indent: number, startIdx: number, depth = 1): [unknown[], number] {
  if (depth > MAX_YAML_DEPTH) {
    throw new YamlError(lines[startIdx]?.lineNo ?? lines[lines.length - 1]?.lineNo ?? 1, 'nesting is too deep');
  }
  const arr: unknown[] = [];
  let idx = startIdx;
  while (idx < lines.length && lines[idx]!.indent === indent && (lines[idx]!.content === '-' || lines[idx]!.content.startsWith('- '))) {
    const line = lines[idx]!;
    const rest = line.content === '-' ? '' : line.content.slice(2);
    const afterIdx = idx + 1;
    if (rest.trim() === '') {
      if (afterIdx < lines.length && lines[afterIdx]!.indent > indent) {
        const childIndent = lines[afterIdx]!.indent;
        if (lines[afterIdx]!.content === '-' || lines[afterIdx]!.content.startsWith('- ')) {
          throw new YamlError(lines[afterIdx]!.lineNo, 'nested sequences are not supported');
        }
        const [val, nextIdx] = parseMappingEntries(lines, childIndent, afterIdx, undefined, depth + 1);
        arr.push(val);
        idx = nextIdx;
      } else {
        arr.push(null);
        idx = afterIdx;
      }
    } else if (rest === '-' || rest.startsWith('- ')) {
      throw new YamlError(line.lineNo, 'nested sequences are not supported');
    } else {
      const kv = matchKeyValue(rest);
      if (kv) {
        const itemIndent = indent + 2;
        const [obj, nextIdx] = parseMappingEntries(lines, itemIndent, afterIdx, { content: rest, lineNo: line.lineNo, afterIdx }, depth + 1);
        arr.push(obj);
        idx = nextIdx;
      } else {
        arr.push(parseScalar(rest, line.lineNo));
        idx = afterIdx;
      }
    }
  }
  return [arr, idx];
}

/** Parses the restricted subset into a plain JS value; throws `YamlError`. */
function parseRestrictedYaml(text: string): unknown {
  const lines = preprocess(text);
  if (lines.length === 0) return {};
  const first = lines[0]!;
  if (first.content === '-' || first.content.startsWith('- ')) {
    throw new YamlError(first.lineNo, 'top-level document must be a mapping, not a sequence');
  }
  const [obj, endIdx] = parseMappingEntries(lines, first.indent, 0);
  if (endIdx !== lines.length) throw new YamlError(lines[endIdx]!.lineNo, 'unexpected indentation');
  return obj;
}

// ---------------------------------------------------------------------------
// Canonical JSON (recursive sorted keys) — spec_json and digest are the same
// bytes: "digest is the sha256 of spec_json" (migration 0008 comment).
// ---------------------------------------------------------------------------
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Public module surface
// ---------------------------------------------------------------------------

/**
 * Searches `<repoPath>/.clockwork/` for jobs.json, then jobs.yaml, then jobs.yml.
 *
 * SECURITY (S-review — arbitrary-file disclosure): `repoPath` is caller-supplied
 * (POST /workforce/repo-jobs/discover), and `existsSync`/`statSync` FOLLOW
 * symlinks. `.clockwork/jobs.yaml -> /any/file`, or a symlinked `.clockwork`
 * directory, therefore handed the reader a file outside the repo — which the
 * parse error then quoted back to the caller. Two checks close it: `lstatSync`
 * refuses a symlinked leaf outright, and the candidate's realpath must resolve
 * INSIDE the repo's realpath, which is what catches a symlink among the parent
 * components. The path RETURNED is the unresolved one, so `repo_jobs.source_path`
 * still reads as the user wrote it.
 */
export function findJobsFile(repoPath: string): { path: string; format: 'yaml' | 'json' } | null {
  const candidates: Array<{ file: string; format: 'yaml' | 'json' }> = [
    { file: 'jobs.json', format: 'json' },
    { file: 'jobs.yaml', format: 'yaml' },
    { file: 'jobs.yml', format: 'yaml' },
  ];
  let repoReal: string;
  try {
    repoReal = realpathSync(repoPath);
  } catch {
    return null; // unreadable or absent repo — the same answer as "no jobs file"
  }
  for (const c of candidates) {
    const p = path.join(repoPath, '.clockwork', c.file);
    try {
      const st = lstatSync(p);
      if (!st.isFile()) continue; // a symlink is not a file to lstat
      // A HARD link defeats both checks below: lstat calls it a file, and
      // realpath returns the in-repo path itself, so a link to a file outside
      // the repo used to read straight through. The link COUNT is what tells
      // them apart, and an ordinary jobs file has exactly one.
      if (st.nlink > 1) continue;
      const real = realpathSync(p);
      if (real !== repoReal && !real.startsWith(repoReal + path.sep)) continue; // escaped the repo
      return { path: p, format: c.format };
    } catch {
      continue; // absent candidate, broken link, or a link loop
    }
  }
  return null;
}

/** Parses + validates a jobs file's text; both formats converge on `RepoJobsFile.safeParse`. */
export function parseJobsFile(text: string, format: 'yaml' | 'json'): RepoJobsFile | { error: string } {
  let raw: unknown;
  if (format === 'json') {
    try {
      raw = JSON.parse(text);
    } catch (e) {
      // S-review: Node's SyntaxError quotes a ~20-character window of the
      // source text. A byte offset locates the fault without disclosing it.
      const at = /position (\d+)/.exec((e as Error).message);
      return { error: at ? `invalid JSON at position ${at[1]}` : 'invalid JSON' };
    }
  } else {
    try {
      raw = parseRestrictedYaml(text);
    } catch (e) {
      if (e instanceof YamlError) return { error: e.message };
      throw e;
    }
  }
  const result = RepoJobsFile.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    // S-review: `issue.message` embeds the REJECTED VALUE for several zod codes
    // (`invalid_enum_value` renders "…received 'x'"). The path and the code are
    // derived from our own schema, so they carry no file content.
    return { error: `invalid jobs file: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.code}` : 'does not match clockwork.jobs.v1'}` };
  }
  const seen = new Set<string>();
  for (const [i, job] of result.data.jobs.entries()) {
    // S-review: the key is repo-authored text. The index is ours.
    if (seen.has(job.key)) return { error: `duplicate job key at jobs.${i}` };
    seen.add(job.key);
  }
  return result.data;
}

/** sha256 hex of the canonical (recursively key-sorted) JSON of one job spec. */
export function digestOf(spec: RepoJobSpec): string {
  return createHash('sha256').update(canonicalJson(spec), 'utf8').digest('hex');
}

interface RepoJobRow {
  id: string;
  repo_path: string;
  source_path: string;
  job_key: string;
  name: string;
  spec_json: string;
  digest: string;
  preview_json: string | null;
  status: RepoJobStatus;
  task_id: string | null;
  discovered_at: number;
  decided_at: number | null;
}

type SecurityPreviewResult = ReturnType<typeof securityPreview>;

function rowToOffer(row: RepoJobRow): RepoJobOffer {
  return {
    id: row.id,
    repoPath: row.repo_path,
    sourcePath: row.source_path,
    jobKey: row.job_key,
    name: row.name,
    spec: RepoJobSpec.parse(JSON.parse(row.spec_json)),
    digest: row.digest,
    preview: row.preview_json ? (JSON.parse(row.preview_json) as SecurityPreviewResult) : null,
    status: row.status,
    taskId: row.task_id,
    discoveredAt: row.discovered_at,
    decidedAt: row.decided_at,
  };
}

/** Adapts a repo-declared job into the S-74 preview shape without trusting any repo-chosen power/budget field. */
function previewForJob(job: RepoJobSpec, repoPath: string): SecurityPreviewResult {
  return securityPreview({
    schema: 'clockwork.template.v1',
    name: job.name,
    prompt: job.prompt,
    repoPath,
    permissionMode: 'acceptEdits',
    budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
  });
}

export class RepoJobs {
  constructor(private readonly db: DB) {}

  /**
   * Reads the repo, upserts offers. A changed digest re-offers (status back
   * to 'offered', decided_at cleared) rather than silently updating a row the
   * human already decided; an unchanged digest leaves status/decided_at/
   * preview alone. Missing file -> `{ offers: [] }`, not an error.
   */
  discover(repoPath: string, now = Date.now()): { offers: RepoJobOffer[]; error?: string } {
    const found = findJobsFile(repoPath);
    if (!found) return { offers: [] };
    let text: string;
    try {
      // Cap BEFORE reading: the file belongs to a repo the caller named, and
      // an uncapped readFileSync pulls whatever size it is into the heap.
      const size = lstatSync(found.path).size;
      if (size > MAX_JOBS_FILE_BYTES) {
        return { offers: [], error: `jobs file is too large: ${size} bytes exceeds the ${MAX_JOBS_FILE_BYTES}-byte limit` };
      }
      text = readFileSync(found.path, 'utf8');
    } catch (e) {
      // Structural, like every other error site here: the errno code is Node's
      // own vocabulary and the candidate filename is one of our three. The
      // absolute path is the caller's own input echoed back, so it stays out.
      const code = (e as NodeJS.ErrnoException).code ?? 'unknown error';
      return { offers: [], error: `could not read ${path.basename(found.path)}: ${code}` };
    }
    const parsed = parseJobsFile(text, found.format);
    if ('error' in parsed) return { offers: [], error: parsed.error };

    const tx = this.db.transaction((): RepoJobOffer[] => {
      const result: RepoJobOffer[] = [];
      for (const job of parsed.jobs) {
        const canonical = canonicalJson(job);
        const digest = digestOf(job);
        const preview = previewForJob(job, repoPath);
        const existing = this.db
          .prepare('SELECT * FROM repo_jobs WHERE repo_path=? AND job_key=?')
          .get(repoPath, job.key) as unknown as RepoJobRow | undefined;
        if (!existing) {
          const id = newId();
          this.db
            .prepare(
              `INSERT INTO repo_jobs (id, repo_path, source_path, job_key, name, spec_json, digest, preview_json, status, task_id, discovered_at, decided_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'offered', NULL, ?, NULL)`,
            )
            .run(id, repoPath, found.path, job.key, job.name, canonical, digest, JSON.stringify(preview), now);
          result.push(rowToOffer(this.getRow(id)!));
        } else if (existing.digest === digest) {
          result.push(rowToOffer(existing));
        } else {
          this.db
            .prepare(
              `UPDATE repo_jobs SET source_path=?, name=?, spec_json=?, digest=?, preview_json=?, status='offered', decided_at=NULL, discovered_at=?
               WHERE id=?`,
            )
            .run(found.path, job.name, canonical, digest, JSON.stringify(preview), now, existing.id);
          result.push(rowToOffer(this.getRow(existing.id)!));
        }
      }
      return result;
    });
    return { offers: tx() };
  }

  private getRow(id: string): RepoJobRow | undefined {
    return this.db.prepare('SELECT * FROM repo_jobs WHERE id=?').get(id) as unknown as RepoJobRow | undefined;
  }

  list(status?: RepoJobStatus): RepoJobOffer[] {
    const rows = status
      ? (this.db.prepare('SELECT * FROM repo_jobs WHERE status=? ORDER BY discovered_at DESC').all(status) as unknown as RepoJobRow[])
      : (this.db.prepare('SELECT * FROM repo_jobs ORDER BY discovered_at DESC').all() as unknown as RepoJobRow[]);
    return rows.map(rowToOffer);
  }

  get(id: string): RepoJobOffer | undefined {
    const row = this.getRow(id);
    return row ? rowToOffer(row) : undefined;
  }

  /**
   * Creates the task DISABLED. Never trusts the repo file for permission
   * mode, budget or schedule — those are the same conservative defaults
   * `/templates/import` uses (S-74 precedent, api.ts:552-574): 'acceptEdits',
   * `{maxUsd:2, maxTurns:50, timeoutSec:3600}`, `schedule:{kind:'queue'}`.
   * The repo's suggested schedule stays informational in spec_json; the user
   * reviews and schedules it themselves once the task is enabled.
   * CAS-guarded: a row that is not 'offered' refuses (F5's route table has no
   * 409, so this returns `{ error }` for a route-level 422, not
   * 'already_resolved').
   */
  import(id: string, now = Date.now()): { taskId: string } | 'not_found' | { error: string } {
    const row = this.getRow(id);
    if (!row) return 'not_found';
    if (row.status !== 'offered') return { error: 'this job offer has already been decided' };
    // Spec §F5 requires this refusal, and it stays. But it is NOT a defence
    // against a hostile jobs file and must not be advertised as one: `discover`
    // is the only writer of `preview_json`, it goes through `previewForJob`,
    // which hardcodes `permissionMode: 'acceptEdits'`, and the sole red-level
    // flag `securityPreview` raises is the `bypassPermissions` one. So no
    // repo-shipped offer can reach this branch, whatever the file says — what
    // actually keeps a repo from choosing its own power is `RepoJobSpec` having
    // no such field plus the hardcoded defaults below. This is live only for a
    // `repo_jobs` row planted directly in the table (repo-jobs.test.ts pins
    // that), so it is defence in depth against a future writer, not a gate the
    // discovery path exercises. docs/agent-workforce.md §F5 says the same.
    const preview = row.preview_json ? (JSON.parse(row.preview_json) as SecurityPreviewResult) : null;
    if (preview && preview.flags.some((f) => f.level === 'red')) {
      return { error: 'job rejected by security preview' };
    }
    const spec = RepoJobSpec.parse(JSON.parse(row.spec_json));
    const taskRepo = new TaskRepo(this.db);

    let taskId: string | null = null;
    const tx = this.db.transaction((): void => {
      const created = taskRepo.create(
        {
          name: spec.name,
          prompt: spec.prompt,
          repoPath: row.repo_path,
          permissionMode: 'acceptEdits',
          budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
          schedule: { kind: 'queue', tz: 'UTC' },
          overlapPolicy: 'skip',
          missedPolicy: 'run-late',
          missedWindowSec: 21_600,
          retryOnTransient: false,
          context: { files: [] },
          delivery: { osNotify: true },
        } as TaskCreate,
        null,
        null,
      );
      this.db.prepare('UPDATE tasks SET enabled=0 WHERE id=?').run(created.id);
      const cas = this.db
        .prepare(`UPDATE repo_jobs SET status='imported', task_id=?, decided_at=? WHERE id=? AND status='offered'`)
        .run(created.id, now, id);
      if (cas.changes === 0) {
        // lost a race with another decision on this row — roll back the task
        throw new AlreadyResolvedError();
      }
      taskId = created.id;
    });
    try {
      tx();
    } catch (e) {
      if (e instanceof AlreadyResolvedError) {
        return { error: 'this job offer has already been decided' };
      }
      throw e;
    }
    return { taskId: taskId! };
  }

  /** CAS dismiss: only an 'offered' row moves to 'dismissed'. */
  dismiss(id: string, now = Date.now()): boolean {
    const res = this.db.prepare(`UPDATE repo_jobs SET status='dismissed', decided_at=? WHERE id=? AND status='offered'`).run(now, id);
    return res.changes > 0;
  }
}
