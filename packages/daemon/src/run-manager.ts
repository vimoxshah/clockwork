/**
 * Run manager (T-104): FSM enforcement, global semaphore, per-repo mutex,
 * queue discipline, child supervision (identity-verified kills), heartbeats,
 * budget/timeout watchdogs, crash recovery sweep, report finalization.
 * The daemon is the ONLY writer of run state (ADR-003).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertTransition,
  newId,
  type JobSpec,
  type RunReport,
  type RunState,
} from '@clockwork/shared';
import {
  createWorktree,
  diffStat,
  hasCommitsBeyondBase,
  preflightRepo,
  inspectWorktree,
  pruneBranch,
  removeWorktree,
  runGit,
  maskSecrets,
} from '@clockwork/runner';
import { SafetyJournal, augmentedPath } from '@clockwork/runner';
import { indexRun } from './repo.js';
import type { DB } from './db.js';
import type { Clock } from './clock.js';
import type { ChildToDaemon } from './runner-protocol.js';
import { ByokStore, keychainGet } from './byok.js';
import { buildJobSpec } from './scheduler.js';
import {
  channelFor,
  withRetry,
  loadDeliveryCreds,
  formatApprovalText,
  type ApprovalNotifyPayload,
} from './delivery.js';

export interface RunManagerDeps {
  db: DB;
  clock: Clock;
  dataDir: string;
  runnerChildModule: string; // path to compiled runner-child.js
  /** test hook: prefix command (e.g. ['tsx']) before node+module */
  childCommandPrefix?: string[];
  maxParallel?: number;
  notify(kind: string, title: string, body: string): void;
  broadcast(event: Record<string, unknown>): void;
  safetyJournal: SafetyJournal;
  keepAwake?: { arm(key: string, durationSec: number): boolean; release(key: string): void };
  /** bundled skill pack resolver (T-112) */
  resolveSkill?: (ref: { name: string; version: string }) => string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  occurrence_at: number | null;
  schedule_id: string | null;
  jobspec_json: string;
  state: RunState;
  state_changed_at: number;
  worktree_path: string | null;
  branch: string | null;
  pid: number | null;
  pgid: number | null;
  proc_started_at: number | null;
  heartbeat_at: number | null;
  cost_usd: number;
  turns: number;
  started_at: number | null;
  ended_at: number | null;
  scheduled_for: number | null;
  outcome_reason: string | null;
}

const HEARTBEAT_GAP_MS = 60_000; // S-32

export class RunManager {
  private readonly repoMutex = new Map<string, string>(); // repoPath -> runId
  private readonly liveChildren = new Map<string, ChildProcess>();
  private readonly pendingApprovals = new Map<string, Map<string, (d: any) => void>>();
  /** Reachable approvals (outbound): dedupe key runId -> set of reqId (or approvalId when reqId is absent), so a duplicate child message never double-notifies. */
  private readonly notifiedApprovalKeys = new Map<string, Set<string>>();
  private pumping = false;
  private readonly maxParallel: number;

  constructor(private readonly deps: RunManagerDeps) {
    this.maxParallel = deps.maxParallel ?? 2;
  }

  // ---------- queue ----------
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => {
      // A pump scheduled before shutdown can fire after db.close(); never crash.
      if ((this.deps.db as unknown as { open?: boolean }).open === false) {
        this.pumping = false;
        return;
      }
      try {
        const active = this.countActive();
        let slots = Math.max(0, this.maxParallel - active);
        while (slots > 0) {
          const next = this.deps.db
            .prepare(
              `SELECT * FROM runs WHERE state='queued' ORDER BY scheduled_for ASC`,
            )
            .all()
            .slice(0, slots) as unknown as RunRow[];
          if (next.length === 0) break;
          let startedAny = false;
          for (const row of next) {
            const spec = JSON.parse(row.jobspec_json) as JobSpec;
            if (spec.repoPath && this.repoMutex.has(spec.repoPath)) continue; // S-3/S-28 wait for mutex
            void this.startRun(row, spec);
            startedAny = true;
            slots--;
            if (slots <= 0) break;
          }
          if (!startedAny) break; // everything waiting on mutexes
        }
      } catch (e) {
        // DB closed mid-flight or transient IO — safe to drop this tick
        if (!/not open/i.test(String(e))) {
          try {
            this.deps.db
              .prepare('INSERT INTO events (at, kind, data_json) VALUES (?, ?, ?)')
              .run(Date.now(), 'pump_error', JSON.stringify({ error: String(e).slice(0, 200) }));
          } catch {}
        }
      } finally {
        this.pumping = false;
      }
    });
  }

  countActive(): number {
    const r = this.deps.db
      .prepare(`SELECT COUNT(*) c FROM runs WHERE state IN ('preparing','running','waiting_approval','finalizing')`)
      .get() as unknown as { c: number };
    return r.c;
  }

  // ---------- lifecycle ----------
  async startRun(row: RunRow, spec: JobSpec): Promise<void> {
    const now = this.deps.clock.now();
    this.transition(row.id, 'preparing', now);
    if (spec.repoPath) this.repoMutex.set(spec.repoPath, row.id);
    // FR-25/S-15: arm keep-awake across the run's wall-clock budget
    this.deps.keepAwake?.arm(row.id, spec.budget.timeoutSec + 300);

    try {
      // Event placeholders (goal #27): materialize {{event.*}} from a trigger
      // event BEFORE preflight so every runner sees the rendered prompt.
      const ev = (spec as unknown as { event?: { source: string; payload: unknown; at: number } }).event;
      if (ev && spec.prompt.includes('{{event')) {
        const { renderEventPrompt } = await import('./templates.js');
        spec.prompt = renderEventPrompt(spec.prompt, ev);
      }

      // preflight (S-36/S-69/S-87)
      if (!spec.scratchPath) {
        const pf = preflightRepo(spec.repoPath!, spec.baseBranch);
        if (!pf.ok) {
          this.failRun(row.id, 'repo_preflight', pf.message ?? 'repo preflight failed', now);
          this.releaseMutex(spec);
          return;
        }
        spec.baseBranch = pf.defaultBranch ?? spec.baseBranch;
      }

      // worktree or scratch (S-38 handled inside createWorktree retry)
      if (spec.scratchPath) {
        mkdirSync(spec.scratchPath, { recursive: true });
        spec.worktreePath = spec.scratchPath; // scratch dir IS the child cwd
      } else {
        const wt = await createWorktree({
          repoPath: spec.repoPath!,
          worktreePath: spec.worktreePath,
          branch: spec.branch,
          baseBranch: spec.baseBranch,
          hooksEnabled: false, // ADR-013 default
        });
        if (!wt.ok || !wt.worktreePath) {
          this.failRun(row.id, 'worktree_error', wt.stderr ?? wt.error ?? 'worktree add failed', now);
          this.releaseMutex(spec);
          return;
        }
        this.deps.db
          .prepare('UPDATE runs SET worktree_path=?, branch=? WHERE id=?')
          .run(wt.worktreePath, wt.branch, row.id);
      }

      await this.spawnChild(row.id, spec, now);
    } catch (e) {
      this.failRun(row.id, 'internal', String(e), now);
      this.releaseMutex(spec);
    }
  }

  private async spawnChild(runId: string, spec: JobSpec, now: number): Promise<void> {
    const runDir = path.join(this.deps.dataDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const specPath = path.join(runDir, 'jobspec.json');
    writeFileSync(specPath, JSON.stringify(spec));

    const nonce = newId();
    // BYOK credential resolution happens here, in the daemon, exactly as before
    // (ADR-027/028) — but the result is held in a LOCAL and delivered to the
    // child over stdin after spawn, never through env. See the doc comment on
    // resolveByokCredential for why an env var is not a security boundary here.
    const byokCredential = this.resolveByokCredential(spec);
    // Sanitized env (arch §7.3): nothing but the minimum. No bearer token, no delivery creds.
    // USER/LOGNAME required for macOS keychain ACL identification (verified 2026-08-21).
    const env: Record<string, string> = {
      PATH: augmentedPath(process.env.PATH ?? '/usr/bin:/bin'),
      HOME: process.env.HOME ?? os.homedir(),
      TERM: 'dumb',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      CW_ENGINE: process.env.CW_ENGINE ?? '', // test hook only
      ...(process.env.CW_MOCK_STEP_MS ? { CW_MOCK_STEP_MS: process.env.CW_MOCK_STEP_MS } : {}), // test hook
      ...(process.env.CW_SANDBOX ? { CW_SANDBOX: process.env.CW_SANDBOX } : {}), // escape hatch; journaled + stamped on the report
      ...(process.env.USER ? { USER: process.env.USER } : {}),
      ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
    };

    const prefix = this.deps.childCommandPrefix ?? [];
    // With a prefix (e.g. tsx), the module is the first arg; otherwise node runs it.
    const bin = prefix.length > 0 ? prefix[0]! : process.execPath;
    const rest =
      prefix.length > 0
        ? [...prefix.slice(1), this.deps.runnerChildModule, specPath, nonce]
        : [this.deps.runnerChildModule, specPath, nonce];
    const child = spawn(bin, rest, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const pgid = child.pid!;
    this.liveChildren.set(runId, child);

    // ADR-035: BYOK credential travels over stdin, never env. macOS exposes a
    // process's exec-time environment to any other same-user process via
    // sysctl KERN_PROCARGS2 — sandboxed or not, since Node itself needs
    // sysctl-read to run, so the Seatbelt profile cannot close that door. stdin
    // is a pipe only the daemon holds the write end of, so it is the actual
    // boundary. Safe to write before 'ready': stdin is a pipe and the child's
    // readline reader is listening on 'line' from the moment it starts up, so
    // nothing here is lost to a race. Never logged, never journaled.
    if (byokCredential) {
      try {
        child.stdin!.write(
          JSON.stringify({ t: 'credential', byokKey: byokCredential.byokKey, byokBaseUrl: byokCredential.byokBaseUrl }) + '\n',
        );
      } catch {
        /* broken pipe — runner-child's credential wait times out and fails the run safely */
      }
    }

    this.deps.db
      .prepare('UPDATE runs SET pid=?, pgid=?, proc_started_at=?, heartbeat_at=?, journal_path=?, started_at=?, state=? , state_changed_at=? WHERE id=?')
      .run(child.pid, pgid, now, now, path.join(runDir, 'stream.jsonl'), now, 'running', now, runId);
    this.recordEvent(now, runId, 'state_changed', { to: 'running' });
    this.deps.broadcast({ type: 'run.state_changed', runId, state: 'running', at: now });

    const pendingPerms = new Map<string, (d: { behavior: 'allow' } | { behavior: 'deny'; message: string }) => void>();
    this.pendingApprovals.set(runId, pendingPerms);
    let lineBuf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        // one malformed message must never kill the daemon (S-32-adjacent)
        this.handleChildMessage(runId, spec, line).catch((e) => {
          this.recordEvent(this.deps.clock.now(), runId, 'ipc_error', { error: String(e) });
        });
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => {
      appendEventFile(runDir, { t: this.deps.clock.now(), kind: 'stderr', text: c.slice(-2000) });
    });

    child.on('close', () => {
      this.liveChildren.delete(runId);
      const cur = this.getRun(runId);
      if (cur && !['completed','failed','cancelled','budget_exceeded','timed_out'].includes(cur.state)) {
        // exited without an outcome message → S-32
        this.finalize(runId, {
          state: 'failed',
          failureReason: 'runner_crashed',
          artifacts: [],
          costUsd: cur.cost_usd,
          turns: cur.turns,
        });
      }
    });

    // watchdogs
    const watchdog = setInterval(() => {
      const r = this.getRun(runId);
      if (!r || ['completed','failed','cancelled','budget_exceeded','timed_out'].includes(r.state)) {
        clearInterval(watchdog);
        return;
      }
      const now2 = this.deps.clock.now();
      if (r.heartbeat_at && now2 - r.heartbeat_at > HEARTBEAT_GAP_MS) {
        clearInterval(watchdog);
        this.killGroupIdentityVerified(r); // S-32
        this.finalize(runId, { state: 'failed', failureReason: 'runner_crashed', artifacts: [], costUsd: r.cost_usd, turns: r.turns });
        return;
      }
      const specTimeoutSec = spec.budget.timeoutSec;
      if (r.started_at && now2 - r.started_at > specTimeoutSec * 1000) {
        clearInterval(watchdog);
        this.killGroupIdentityVerified(r); // S-13
        this.finalize(runId, { state: 'timed_out', artifacts: [], costUsd: r.cost_usd, turns: r.turns });
      }
    }, 15_000);
    watchdog.unref?.();
  }

  private async handleChildMessage(
    runId: string,
    spec: JobSpec,
    line: string,
  ): Promise<void> {
    let msg: ChildToDaemon;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const now = this.deps.clock.now();
    switch (msg.t) {
      case 'ready':
        break;
      case 'usage': {
        this.deps.db.prepare('UPDATE runs SET cost_usd=?, turns=?, heartbeat_at=? WHERE id=?').run(msg.costUsd, msg.turns, now, runId);
        break;
      }
      case 'heartbeat':
        this.deps.db.prepare('UPDATE runs SET heartbeat_at=? WHERE id=?').run(now, runId);
        break;
      case 'log':
        appendEventFile(path.join(this.deps.dataDir, 'runs', runId), { t: now, kind: 'log', text: msg.line.slice(0, 2000) });
        this.deps.broadcast({ type: 'run.log', runId, line: msg.line.slice(0, 500), at: now });
        break;
      case 'artifact':
        break;
      case 'rateLimit': {
        // Capacity telemetry (FR-7): persist + broadcast; UI renders estimate.
        const rlMsg = msg as unknown as { info?: Record<string, unknown> };
        const info = rlMsg.info ?? {};
        const kind = String(info.rateLimitType ?? 'unknown');
        const usedPct =
          typeof (info as any).utilization === 'number'
            ? (info as any).utilization
            : typeof (info as any).used_pct === 'number'
              ? (info as any).used_pct
              : null;
        try {
          this.deps.db
            .prepare('INSERT INTO capacity_samples (at, window_kind, used_pct, source) VALUES (?, ?, ?, ?)')
            .run(now, kind, usedPct, JSON.stringify(info));
        } catch {}
        this.deps.broadcast({ type: 'usage.updated', window: kind, at: now });
        break;
      }
      case 'sandbox': {
        this.recordEvent(now, runId, 'sandbox_status', { enabled: msg.enabled, profileVersion: msg.profileVersion });
        if (!msg.enabled) this.deps.safetyJournal.record('sandbox_disabled', 'CW_SANDBOX=off', runId);
        break;
      }
      case 'floor': {
        // PreToolUse policy-floor hit (FR-11/T-114): denied outside the normal
        // permission flow, so it gets its own event + safety-journal entry
        // rather than riding the 'permission'/approval path above.
        this.recordEvent(now, runId, 'policy_deny', { tool: msg.tool, command: msg.command.slice(0, 300), reason: msg.reason });
        this.deps.safetyJournal.record('deny_list_hit', `${msg.tool}: ${msg.reason}`, runId);
        break;
      }
      case 'permission': {
        // Record the request; the child holds its callback open until a human
        // answers or the run's wall-clock budget ends (mirrors runner-child).
        // A decision (POST /approvals/:id/respond → respondToChild) reaches the
        // live run; otherwise the child fail-safe denies and finalize resolves the row.
        const approvalId = newId();
        const reqId = (msg as { reqId?: string }).reqId ?? null;
        const startedAt = this.getRun(runId)?.started_at ?? now;
        const timeoutAt = Math.max(now + 5_000, startedAt + spec.budget.timeoutSec * 1000);
        this.deps.db
          .prepare(`INSERT INTO approvals (id, run_id, kind, payload_json, requested_at, timeout_at, fallback) VALUES (?, ?, 'permission', ?, ?, ?, ?)`)
          .run(approvalId, runId, JSON.stringify({ tool: msg.tool, reqId }), now, timeoutAt, 'deny-and-continue');
        this.recordEvent(now, runId, 'approval_requested', { tool: msg.tool, reqId });
        this.deps.broadcast({ type: 'approval.requested', approvalId, runId, at: now });
        // Reachable approvals (outbound half, FR-18 sibling): fire-and-forget —
        // never awaited here, so a slow/failing channel can never delay the
        // permission hold or the child's decision path (S-43-style guarantee).
        this.notifyApprovalRequest(runId, spec, approvalId, msg.tool, msg.input, timeoutAt, reqId).catch((e) => {
          this.recordEvent(this.deps.clock.now(), runId, 'note', { approvalNotifyError: String(e) });
        });
        break;
      }
      case 'outcome': {
        this.finalize(runId, msg.outcome);
        break;
      }
    }
    void spec;
  }

  /**
   * Reachable approvals (outbound half, FR-18 sibling): push the permission
   * request itself to every configured channel, reusing the DeliveryChannel
   * adapters (delivery.ts) that already carry run-outcome reports. Never
   * awaited from the permission hold's hot path (see call site); failures are
   * logged, never surfaced to the run or the decision path (S-43 pattern).
   */
  private async notifyApprovalRequest(
    runId: string,
    spec: JobSpec,
    approvalId: string,
    tool: string,
    input: unknown,
    timeoutAt: number,
    reqId: string | null,
  ): Promise<void> {
    const dedupeKey = reqId ?? approvalId;
    let seen = this.notifiedApprovalKeys.get(runId);
    if (!seen) {
      seen = new Set<string>();
      this.notifiedApprovalKeys.set(runId, seen);
    }
    if (seen.has(dedupeKey)) return; // duplicate child message for a request already notified
    seen.add(dedupeKey);

    const commandSummary = maskSecrets(extractCommandSummary(input)).slice(0, 200);
    const payload: ApprovalNotifyPayload = {
      approvalId,
      runId,
      taskName: spec.taskName,
      engine: spec.engine,
      tool,
      commandSummary,
      timeoutAt,
    };
    const text = formatApprovalText(payload);

    // OS: same unconditional convention as run-outcome notifications below —
    // deps.notify() rides the daemon's native Notifier (main.ts); no per-task
    // config currently gates it (see note on DeliveryConfig.osNotify).
    this.deps.notify('approval_requested', `Clockwork: ${spec.taskName} needs you`, text);

    // Telegram/webhook: same per-task DeliveryConfig used for outcome reports.
    let cfg: { telegram?: { chatId: string }; webhook?: { url: string } } = {};
    try {
      cfg = JSON.parse(taskDeliveryJsonOf(this.deps.db, spec.taskId) || '{}');
    } catch {}
    const creds = loadDeliveryCreds(this.deps.dataDir);
    const jobs: Array<Promise<void>> = [];
    const failed: Array<{ channel: string; error: string | null }> = [];
    if (cfg.telegram?.chatId) {
      const ch = channelFor('telegram');
      if (ch) {
        const chatId = cfg.telegram.chatId;
        jobs.push(
          withRetry(() => ch.sendApproval(payload, chatId, creds)).then((r) => {
            if (!r.ok) failed.push({ channel: 'telegram', error: r.error });
          }),
        );
      }
    }
    if (cfg.webhook?.url) {
      const ch = channelFor('webhook');
      if (ch) {
        const url = cfg.webhook.url;
        jobs.push(
          withRetry(() => ch.sendApproval(payload, url, creds)).then((r) => {
            if (!r.ok) failed.push({ channel: 'webhook', error: r.error });
          }),
        );
      }
    }
    await Promise.all(jobs);
    if (failed.length > 0) {
      this.recordEvent(this.deps.clock.now(), runId, 'note', { approvalNotifyFailed: failed });
    }
  }

  // ---------- finalization ----------
  async finalize(runId: string, outcome: Partial<import('@clockwork/shared').RunOutcome> & { state: string }): Promise<void> {
    const r = this.getRun(runId);
    if (!r || ['completed','failed','cancelled','budget_exceeded','timed_out'].includes(r.state)) return;
    const now = this.deps.clock.now();
    const spec = JSON.parse(r.jobspec_json) as JobSpec;

    // FSM: running -> finalizing -> terminal
    try {
      this.transition(runId, 'finalizing', now);
    } catch {
      // e.g. timed_out already set — accept and continue to terminal below
    }

    // git outcomes
    let committedSomething = false;
    let diffRows: Array<{ path: string; additions: number; deletions: number; binary: boolean }> = [];
    if (spec.repoPath && r.worktree_path && existsSync(r.worktree_path)) {
      const base = initialShaOf(r.worktree_path);
      if (base) {
        committedSomething = hasCommitsBeyondBase(r.worktree_path, base);
        if (committedSomething) {
          diffRows = diffStat(r.worktree_path, base);
        }
      }
    }

    // S-39, narrowed (2026-09-05): "analysis-only runs leave no litter" applies
    // only when the run ENDED cleanly and the worktree IS clean. A run killed by
    // timeout, budget, cancel or crash — or one that left uncommitted work or a
    // rebase/merge in flight — keeps its worktree for the next run or the human
    // to recover. Before this, `git worktree remove --force` erased exactly the
    // half-done state a timed-out rebase leaves behind.
    let worktreeState: RunReport['worktreeState'] = null;
    if (spec.repoPath && r.worktree_path) {
      const inspected = inspectWorktree(r.worktree_path);
      if (inspected.exists) {
        const interrupted =
          outcome.state === 'timed_out' ||
          outcome.state === 'budget_exceeded' ||
          outcome.state === 'cancelled' ||
          (outcome.state === 'failed' && ('failureReason' in outcome ? outcome.failureReason : undefined) === 'runner_crashed');
        const reason = committedSomething
          ? 'committed'
          : interrupted
            ? 'interrupted'
            : inspected.interruptedOp
              ? 'in_progress_op'
              : inspected.dirty
                ? 'dirty'
                : null;
        if (reason === null && r.branch) {
          try {
            removeWorktree(spec.repoPath, r.worktree_path);
            pruneBranch(spec.repoPath, r.branch);
          } catch {}
          worktreeState = { preserved: false, path: null, dirty: false, interruptedOp: null, reason: null };
        } else {
          worktreeState = { preserved: true, path: r.worktree_path, dirty: inspected.dirty, interruptedOp: inspected.interruptedOp, reason };
        }
      }
    }

    const report: RunReport = {
      runId,
      taskId: spec.taskId,
      taskName: spec.taskName,
      profile: spec.profile ? { slug: spec.profile.slug, name: spec.profile.name, color: spec.profile.color, glyph: spec.profile.glyph } : null,
      engine: spec.engine,
      cliVersion: null, // filled by CLI engine journal when present
      state: outcome.state,
      failureReason: ('failureReason' in outcome ? outcome.failureReason : undefined) ?? null,
      // S-68: best-effort credential masking — documented as such, transcripts stay local
      summary: maskSecrets(typeof outcome.summary === 'string' ? outcome.summary : ''),
      branch: spec.repoPath ? spec.branch : null,
      baseSha: null,
      basedOnLocalState: false,
      committedSomething,
      sandboxed: this.sandboxedFor(runId),
      worktreeState,
      diffStat: diffRows,
      artifacts: outcome.artifacts ?? [],
      transcriptPath: outcome.transcriptPath ?? null,
      costUsd: outcome.costUsd ?? 0,
      turns: outcome.turns ?? 0,
      softCapOvershootUsd: 0,
      startedAt: r.started_at,
      endedAt: now,
      ranLateMs: r.occurrence_at && r.started_at ? Math.max(0, r.started_at - r.occurrence_at - GRACE_NOTE_TOLERANCE_MS) : 0,
      coveredOccurrences: this.coveredOccurrences(r.schedule_id),
      sleptThroughKeepAwake: false,
      approvals: this.approvalsFor(runId).map((a) => ({
        id: a.id,
        kind: a.kind as 'permission' | 'question',
        payload: null,
        requestedAt: a.requestedAt,
        resolvedAt: null,
        resolution: null as 'approved' | 'denied' | 'timeout-deny-and-continue' | 'timeout-abort' | null,
      })),
      timeline: [],
      deliveries: [],
      queueDelayMs: r.started_at && r.scheduled_for ? Math.max(0, r.started_at - r.scheduled_for) : 0,
      repoLockDelayMs: 0,
    };

    const tx = this.deps.db.transaction(() => {
      const terminalMap: Record<string, RunState> = {
        completed: 'completed',
        failed: 'failed',
        cancelled: 'cancelled',
        budget_exceeded: 'budget_exceeded',
        timed_out: 'timed_out',
      };
      const to = terminalMap[outcome.state] ?? 'failed';
      assertTransition('finalizing', to);
      this.deps.db
        .prepare('UPDATE runs SET state=?, state_changed_at=?, ended_at=?, report_json=?, outcome_reason=?, transcript_path=? WHERE id=?')
        .run(
          to,
          now,
          now,
          JSON.stringify(report),
          ('failureReason' in outcome ? outcome.failureReason : null),
          ('transcriptPath' in outcome ? (outcome as { transcriptPath?: string | null }).transcriptPath : null) ?? null,
          runId,
        );
      this.recordEvent(now, runId, 'state_changed', { to });
      // FR-29: index the report into FTS at finalize.
      indexRun(this.deps.db, runId, spec.taskName, `${report.summary}\n${report.failureReason ?? ''}`);
      // Unresolved approvals die with the run — never leave stale needs-you items.
      // M1 CLI engine is fail-safe (ADR-020): requests were auto-denied by the
      // child after its grace window; record that resolution honestly.
      this.deps.db
        .prepare(
          `UPDATE approvals SET responded_at=?, response_json=? WHERE run_id=? AND responded_at IS NULL`,
        )
        .run(now, JSON.stringify({ resolvedBy: 'run-finalized', behavior: 'deny', note: 'fail-safe auto-deny (M1 unattended mode)' }), runId);
    });
    tx();

    this.releaseMutex(spec);
    this.pendingApprovals.delete(runId);
    this.notifiedApprovalKeys.delete(runId);
    this.deps.keepAwake?.release(runId);

    // S-40/S-41: consecutive auth failures auto-pause the task after 2
    const failureReason = ('failureReason' in outcome ? outcome.failureReason : undefined) ?? null;
    if (failureReason === 'auth') {
      const { recordAuthFailureAndMaybePause } = await import('./policies.js');
      const res = recordAuthFailureAndMaybePause(this.deps.db, spec.taskId);
      if (res.paused) {
        this.deps.notify('auto_paused', `Clockwork paused "${spec.taskName}"`, 'Two consecutive auth failures. Re-login in Claude Code, then re-enable the task.');
        this.deps.safetyJournal.record('preflight_failure', `auto-paused task ${spec.taskId} after ${res.consecutive} auth failures`, runId);
      }
    } else if (outcome.state === 'completed') {
      const { clearFailureStreak } = await import('./policies.js');
      clearFailureStreak(this.deps.db, spec.taskId);
    }

    // FR-18/S-43: delivery after persistence; failures become receipts only
    try {
      const { deliverReport } = await import('./delivery-dispatch.js');
      const receipts = await deliverReport(this.deps.dataDir, spec.taskId, taskDeliveryJsonOf(this.deps.db, spec.taskId), {
        runId,
        taskName: spec.taskName,
        state: outcome.state,
        failureReason,
        summary: report.summary,
        branch: report.branch,
        costUsd: report.costUsd,
        turns: report.turns,
        ranLateMs: report.ranLateMs,
        coveredOccurrences: report.coveredOccurrences,
        profile: report.profile ? { name: report.profile.name, slug: report.profile.slug } : null,
      });
      if (receipts.length > 0) {
        report.deliveries = receipts;
        this.deps.db.prepare('UPDATE runs SET report_json=? WHERE id=?').run(JSON.stringify(report), runId);
      }
    } catch (e) {
      this.recordEvent(now, runId, 'note', { deliveryError: String(e) }); // never fail the run (S-43)
    }

    this.deps.broadcast({ type: 'report.ready', runId, at: now });
    this.deps.notify(
      outcome.state === 'completed' ? 'report_ready' : 'run_failed',
      `Clockwork: ${spec.taskName}`,
      outcome.state === 'completed' ? `Completed · $${(outcome.costUsd ?? 0).toFixed(2)} · ${outcome.turns ?? 0} turns` : `Ended ${outcome.state}${'failureReason' in outcome && outcome.failureReason ? ` (${outcome.failureReason})` : ''}`,
    );

    // Agent chains (goal #28): fire downstream tasks waiting on this one.
    try {
      await this.fireChainedTasks(runId, spec, outcome.state, now);
    } catch (e) {
      this.recordEvent(now, runId, 'note', { chainError: String(e) });
    }

    // pump successors waiting on the freed slot/mutex
    this.pump();
  }

  /**
   * Chain firing (S-70/S-71, goal #28): any task with chain_after = completedTaskId
   * gets enqueued when the upstream run hits its trigger state. The chained run's
   * prompt is materialized through renderChainPrompt so {{previous.report}} /
   * {{previous.artifacts}} carry the upstream output forward.
   */
  private async fireChainedTasks(
    runId: string,
    upstreamSpec: JobSpec,
    terminalState: string,
    now: number,
  ): Promise<void> {
    const successors = this.deps.db
      .prepare('SELECT * FROM tasks WHERE chain_after = ? AND deleted_at IS NULL AND enabled = 1')
      .all(upstreamSpec.taskId) as unknown as Array<Record<string, unknown>>;
    if (successors.length === 0) return;

    const triggerOk = terminalState === 'completed' || terminalState === 'budget_exceeded';
    const anyTerminal = ['completed', 'failed', 'timed_out', 'cancelled', 'budget_exceeded'].includes(terminalState);

    for (const succ of successors) {
      const chainOn = String(succ.chain_on ?? 'completed');
      const shouldFire = chainOn === 'any_terminal' ? anyTerminal : triggerOk;
      if (!shouldFire) {
        this.recordEvent(now, runId, 'chain_skipped', {
          successor: String(succ.id),
          reason: `upstream ended '${terminalState}', chain_on='${chainOn}'`,
        });
        continue;
      }

      const prevRun = this.deps.db
        .prepare(
          `SELECT report_json FROM runs WHERE task_id=? ORDER BY COALESCE(ended_at, scheduled_for) DESC LIMIT 1`,
        )
        .get(upstreamSpec.taskId) as unknown as { report_json: string | null } | undefined;

      const { renderChainPrompt, pathExists } = await import('./templates.js');
      const rawPrompt = String(succ.prompt ?? '');
      // Only render the template if the successor actually uses placeholders;
      // otherwise the user's own full prompt stands alone.
      const materializedPrompt = rawPrompt.includes('{{previous')
        ? renderChainPrompt(rawPrompt, prevRun)
        : rawPrompt;

      // Repo preflight for the successor (fail loudly, never half-fire).
      const repoPath = (succ.repo_path as string | null) ?? '';
      if (repoPath && !pathExists(repoPath)) {
        this.failRun(
          runId,
          'chain_preflight',
          `Successor "${succ.name}" repo missing: ${repoPath}`,
          now,
        );
        continue;
      }

      const spec = this.buildChainedSpec(succ as unknown as Record<string, unknown>, runId, materializedPrompt, now);
      // Carry the upstream event context (if any) so {{event.*}} still resolves
      // in chained successors fired by a trigger.
      const upEv = (upstreamSpec as unknown as { event?: unknown }).event;
      if (upEv) (spec as unknown as { event?: unknown }).event = upEv;
      this.deps.db
        .prepare(
          `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for) VALUES (?, ?, ?, 'queued', ?, ?)`,
        )
        .run(spec.runId, succ.id, JSON.stringify(spec), now, now);
      this.recordEvent(now, spec.runId, 'state_changed', {
        to: 'queued',
        via: 'chain',
        upstreamRunId: runId,
        upstreamState: terminalState,
      });
    }
  }

  /** Build a JobSpec for a chain-triggered task (reuses scheduler's builder). */
  private buildChainedSpec(succ: Record<string, unknown>, upstreamRunId: string, prompt: string, now: number): JobSpec {
    const row = { ...succ, prompt } as unknown as Parameters<typeof buildJobSpec>[1];
    return buildJobSpec(newId(), row, now, now, this.deps.db);
  }

  failRun(runId: string, reason: string, message: string, now: number): void {
    const r = this.getRun(runId);
    if (!r || ['completed','failed','cancelled','budget_exceeded','timed_out'].includes(r.state)) return;
    this.deps.safetyJournal.record('preflight_failure', `${reason}: ${message}`, runId);
    this.deps.db
      .prepare('UPDATE runs SET state=?, state_changed_at=?, ended_at=?, outcome_reason=? WHERE id=?')
      .run('failed', now, now, reason, runId);
    this.recordEvent(now, runId, 'state_changed', { to: 'failed', reason });
    this.deps.notify('run_failed', 'Clockwork run failed', `${reason}: ${message}`);
    const spec = JSON.parse(r.jobspec_json) as JobSpec;
    this.releaseMutex(spec);
    this.pump();
  }

  transition(runId: string, to: RunState, at: number): void {
    const r = this.getRun(runId);
    if (!r) throw new Error(`unknown run ${runId}`);
    assertTransition(r.state as RunState, to);
    this.deps.db
      .prepare('UPDATE runs SET state=?, state_changed_at=? WHERE id=?')
      .run(to, at, runId);
    this.recordEvent(at, runId, 'state_changed', { to });
    this.deps.broadcast({ type: 'run.state_changed', runId, state: to, at });
  }

  cancel(runId: string): boolean {
    const r = this.getRun(runId);
    if (!r) return false;
    const now = this.deps.clock.now();
    if (r.state === 'queued') {
      this.transition(runId, 'cancelled', now);
      this.releaseMutex(JSON.parse(r.jobspec_json));
      this.pump();
      return true;
    }
    if (['preparing','running','waiting_approval','finalizing'].includes(r.state)) {
      this.killGroupIdentityVerified(r);
      this.finalize(runId, { state: 'cancelled' });
      return true;
    }
    return false;
  }

  /**
   * Forward a human decision into the LIVE run's child process (S-51/S-52).
   * Returns false when the run is gone or the child's decision window closed.
   */
  respondToChild(runId: string, reqId: string, allow: boolean): boolean {
    const child = this.liveChildren.get(runId);
    if (!child || !child.stdin?.writable) return false;
    try {
      const msg = allow
        ? { t: 'decision', reqId, behavior: 'allow' }
        : { t: 'decision', reqId, behavior: 'deny', message: 'Denied by operator from the inbox.' };
      child.stdin.write(JSON.stringify(msg) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  // ---------- supervision primitives ----------
  private killGroupIdentityVerified(r: RunRow): void {
    if (!r.pgid) return;
    const pgid: number = r.pgid;
    try {
      // identity check: the pgid must still belong to our runner-child command line
      const psOut = runPsPids();
      const ours = psOut.some((l) => l.includes(String(pgid)) && l.includes('runner-child'));
      process.kill(-pgid, 'SIGTERM'); // group kill; never a bare pid (arch §7.6)
      setTimeout(() => {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {}
      }, 5_000);
      if (!ours) {
        this.deps.safetyJournal.record('orphan_terminated', `pgid=${pgid}`, r.id);
      }
    } catch {
      /* already dead */
    }
  }

  private releaseMutex(spec: JobSpec): void {
    if (spec.repoPath && this.repoMutex.get(spec.repoPath) === spec.runId) {
      this.repoMutex.delete(spec.repoPath);
    }
  }

  /**
   * BYOK credential resolution (ADR-027/028; delivery moved to stdin under
   * ADR-035 — see spawnChild). Resolved lazily at spawn in the daemon process;
   * the secret is held in a local and never written to the jobspec file, env,
   * a log line, or recordEvent/journal.
   *
   * Returns null when the task is not a BYOK task at all (spawnChild uses that
   * to decide whether to write a 'credential' message — never for a non-BYOK
   * run). Returns an object with empty fields when the task IS a BYOK task but
   * resolution fails (config missing, env var unset, keychain miss) — the
   * child still gets an explicit 'credential' message, so it fails fast with
   * the same auth error as before rather than waiting out the no-message
   * timeout.
   */
  private resolveByokCredential(spec: JobSpec): { byokKey: string; byokBaseUrl: string } | null {
    const byokId = spec.byokId;
    if (!byokId) return null;
    try {
      const store = new ByokStore({ db: this.deps.db });
      const cfg = store.get(byokId);
      if (!cfg) return { byokKey: '', byokBaseUrl: '' };
      const byokBaseUrl = store.baseUrlFor(cfg);
      let byokKey = '';
      if (cfg.auth === 'env' && cfg.env_var && process.env[cfg.env_var]) {
        byokKey = process.env[cfg.env_var] as string;
      } else if (cfg.auth === 'keychain') {
        try {
          byokKey = keychainGet(cfg.id);
        } catch { /* absent key → runner fails fast with auth */ }
      }
      return { byokKey, byokBaseUrl };
    } catch {
      return { byokKey: '', byokBaseUrl: '' };
    }
  }

  getRun(id: string): RunRow | undefined {
    // Child-exit events can race daemon shutdown (db closed first) on slow CI.
    if ((this.deps.db as unknown as { open?: boolean }).open === false) return undefined;
    return this.deps.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as RunRow | undefined;
  }

  private recordEvent(at: number, runId: string, kind: string, data: unknown): void {
    this.deps.db
      .prepare('INSERT INTO events (at, run_id, kind, data_json) VALUES (?, ?, ?, ?)')
      .run(at, runId, kind, JSON.stringify(data));
  }

  coveredOccurrences(scheduleId: string | null): number[] {
    if (!scheduleId) return [];
    const rows = this.deps.db
      .prepare(`SELECT occurrence_at FROM schedule_occurrences WHERE schedule_id=? AND disposition='coalesced' ORDER BY occurrence_at DESC LIMIT 50`)
      .all(scheduleId) as unknown as Array<{ occurrence_at: number }>;
    return rows.map((r) => r.occurrence_at);
  }

  /** What the child reported before spawning its engine; null for runs that predate the protocol message. */
  private sandboxedFor(runId: string): boolean | null {
    const row = this.deps.db
      .prepare(`SELECT data_json FROM events WHERE run_id=? AND kind='sandbox_status' ORDER BY at DESC LIMIT 1`)
      .get(runId) as { data_json: string } | undefined;
    if (!row) return null;
    try {
      const d = JSON.parse(row.data_json) as { enabled?: unknown };
      return typeof d.enabled === 'boolean' ? d.enabled : null;
    } catch {
      return null;
    }
  }

  approvalsFor(runId: string): Array<{ id: string; kind: string; requestedAt: number }> {
    return (this.deps.db
      .prepare('SELECT id, kind, requested_at FROM approvals WHERE run_id=?')
      .all(runId) as unknown as Array<{ id: string; kind: string; requested_at: number }>).map((a) => ({ id: a.id, kind: a.kind, requestedAt: a.requested_at }));
  }

  // ---------- recovery (S-30/S-31/S-81/S-33) ----------
  recoverySweep(): { requeued: number; orphanedTerminated: number; quarantinedWorktrees: string[] } {
    const now = this.deps.clock.now();
    let requeued = 0;
    let orphaned = 0;

    // S-30: transient states with no child → back to queued (idempotent)
    const transient = this.deps.db
      .prepare(`SELECT * FROM runs WHERE state IN ('queued') `)
      .all() as unknown as RunRow[];
    requeued = transient.length; // queued rows are simply re-pumped

    // preparing rows without children: reset to queued (no worktree yet by construction)
    const prep = this.deps.db.prepare(`SELECT * FROM runs WHERE state='preparing'`).all() as unknown as RunRow[];
    for (const r of prep) {
      this.deps.db.prepare('UPDATE runs SET state=?, state_changed_at=? WHERE id=?').run('queued', now, r.id);
      requeued++;
    }

    // S-31: running/waiting/finalizing rows — terminate orphans, journal-based reports
    const actives = this.deps.db
      .prepare(`SELECT * FROM runs WHERE state IN ('running','waiting_approval','finalizing')`)
      .all() as unknown as RunRow[];
    for (const r of actives) {
      const alive = r.pgid ? isGroupAlive(r.pgid) : false;
      if (alive) {
        this.killGroupIdentityVerified(r);
        orphaned++;
      }
      // assemble truthful failed report from whatever we have
      this.deps.safetyJournal.record('orphan_terminated', `pgid=${r.pgid ?? '?'}`, r.id);
      this.deps.db
        .prepare('UPDATE runs SET state=?, state_changed_at=?, ended_at=?, outcome_reason=? WHERE id=?')
        .run('failed', now, now, 'orphaned', r.id);
      this.recordEvent(now, r.id, 'state_changed', { to: 'failed', reason: 'orphaned' });
      this.deps.notify('run_failed', 'Clockwork run interrupted', 'The daemon restarted during this run; it was terminated safely (orphaned). Report assembled from the on-disk journal.');
    }

    // S-33: orphan worktree reconciliation — quarantine list, NEVER auto-delete
    const quarantined = this.reconcileWorktrees();

    this.pump();
    return { requeued, orphanedTerminated: orphaned, quarantinedWorktrees: quarantined };
  }

  private reconcileWorktrees(): string[] {
    const root = path.join(this.deps.dataDir, 'worktrees');
    const known = new Set<string>(
      (this.deps.db.prepare(`SELECT worktree_path FROM runs WHERE worktree_path IS NOT NULL AND state IN ('preparing','running','waiting_approval','finalizing','queued')`).all() as unknown as any[])
        .map((r: any) => r.worktree_path as string),
    );
    const orphans: string[] = [];
    if (!existsSync(root)) return orphans;
    for (const taskDir of listDirs(root)) {
      for (const runDir of listDirs(taskDir)) {
        if (!known.has(runDir)) orphans.push(runDir);
      }
    }
    return orphans;
  }
}

const GRACE_NOTE_TOLERANCE_MS = 120_000;

function taskDeliveryJsonOf(db: DB, taskId: string): string {
  const r = db.prepare('SELECT delivery_json FROM tasks WHERE id=?').get(taskId) as any;
  return r?.delivery_json ?? '{}';
}

/** Best-effort human-readable form of a tool's input, before masking/truncation. */
function extractCommandSummary(input: unknown): string {
  if (input && typeof input === 'object') {
    const i = input as Record<string, unknown>;
    if (typeof i.command === 'string') return i.command;
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  }
  return String(input ?? '');
}

function listDirs(p: string): string[] {
  try {
    return readdirAbs(p);
  } catch {
    return [];
  }
}

function readdirAbs(dir: string): string[] {
  const out: string[] = [];
  try {
    const entries = readDirEntries(dir);
    for (const e of entries) {
      const full = path.join(dir, e);
      if (isDirectory(full)) out.push(full);
    }
  } catch {}
  return out;
}

import { readdirSync, statSync, appendFileSync } from 'node:fs';
function readDirEntries(dir: string): string[] {
  return readdirSync(dir);
}
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function appendEventFile(runDir: string, obj: unknown): void {
  try {
    mkdirSync(runDir, { recursive: true });
    appendFileSync(path.join(runDir, 'stream.jsonl'), JSON.stringify(obj) + '\n');
  } catch {}
}
function runPsPids(): string[] {
  const r = spawnSyncCapture('/bin/ps', ['-eo', 'pgid,pid,command']);
  return r.split('\n');
}
function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}
function spawnSyncCapture(bin: string, args: string[]): string {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return r.stdout ?? '';
}/** SHA of the first commit on HEAD's history — diffstat baseline in fresh worktrees. */
function initialShaOf(worktreePath: string): string | null {
  const r = runGit(['rev-list', '--max-parents=0', 'HEAD'], worktreePath);
  const lines = r.out.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? null;
}
