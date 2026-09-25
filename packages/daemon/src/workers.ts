/**
 * Multi-machine workers (P4): registry, pairing ceremony, tokens, heartbeat.
 *
 * A worker is another Clockwork daemon (Mini/homelab) that pulls jobspecs and
 * executes them under its own sandbox. Trust model, stated plainly:
 *
 * - Identity = ed25519 pubkey, verified once at claim through the pairing
 *   crypto (pairing.ts). After that, a bearer token (sha256 stored, returned
 *   once at approve) authenticates heartbeat/pull/complete calls.
 * - Pairing is human-gated twice: the operator pastes the worker's pubkey to
 *   start (init), and a human approves AFTER the signature verifies (claim
 *   records identity, approve issues the token). A valid signature alone
 *   never earns a token.
 * - The primary never sends secrets to a worker: jobspecs carry prompts and
 *   paths, never PATs or keys (same rule as the runner child env).
 * - No new run states anywhere: assignment is timestamps on queued rows.
 */
import { randomBytes, createHash, createPublicKey, timingSafeEqual, type KeyLike } from 'node:crypto';
import type { DB } from './db.js';
import { mintPairingEntry, verifyPairingAttempt, sqlitePairingStore, sha256Hex, type PairingStore } from './pairing.js';

/** Miss three 30s heartbeats and the worker is silent. */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

export interface WorkerRow {
  id: string;
  name: string;
  pubkey_hash: string;
  platform: string | null;
  capabilities: string;
  token_hash: string | null;
  status: 'pending' | 'paired' | 'revoked';
  claimed_at: number | null;
  online: number;
  last_heartbeat: number | null;
  created_at: number;
}

export type WorkerFailure =
  | { ok: false; reason: 'not_found' | 'bad_state' | 'bad_signature' | 'unknown_nonce' | 'revoked' | 'expired' | 'bad_key' | 'unauthorized'; message: string };

function fail(reason: WorkerFailure['reason'], message: string): WorkerFailure {
  return { ok: false, reason, message };
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isWorkerOnline(row: Pick<WorkerRow, 'status' | 'last_heartbeat'>, now: number): boolean {
  return row.status === 'paired' && row.last_heartbeat !== null && now - row.last_heartbeat < HEARTBEAT_TIMEOUT_MS;
}

export function listWorkers(db: DB, now: number): Array<WorkerRow & { onlineComputed: boolean }> {
  const rows = db.prepare('SELECT * FROM workers ORDER BY created_at').all() as WorkerRow[];
  return rows.map((r) => ({ ...r, token_hash: null as unknown as string, onlineComputed: isWorkerOnline(r, now) }));
}

/**
 * Start pairing: the operator pastes the worker's pubkey (shown by the
 * worker's `clockworkd worker-key` / pairing screen). Returns the one-time
 * nonce the worker claims with — displayed once, like every secret here.
 */
export function initPairing(
  db: DB,
  input: { name: string; platform?: string; capabilities?: string; pubkeyHex: string; now?: number },
): { ok: true; workerId: string; nonce: string; expiresAt: number } | WorkerFailure {
  const now = input.now ?? Date.now();
  const name = input.name.trim().slice(0, 80);
  if (!name) return fail('bad_state', 'Worker name is required.');
  let key: KeyLike;
  try {
    key = createPublicKey({ key: Buffer.from(input.pubkeyHex.trim(), 'hex'), format: 'der', type: 'spki' });
  } catch {
    return fail('bad_key', 'That is not a valid ed25519 public key (DER hex). The worker shows its key on its pairing screen.');
  }
  if (key.asymmetricKeyType !== 'ed25519') return fail('bad_key', 'Only ed25519 worker keys are accepted.');
  // One open pairing per key: two pending rows on the same pubkey make claim
  // lookup ambiguous (first match wins). Not a bypass — the signature still
  // has to verify — but a confusion worth refusing.
  const open = db.prepare("SELECT id FROM workers WHERE pubkey_hash=? AND status='pending'").get(sha256Hex(input.pubkeyHex.trim())) as any;
  if (open) return fail('bad_state', `A pairing for this key is already open (worker ${(open as any).id}) — approve or remove it first.`);
  const { nonce, row } = mintPairingEntry(input.pubkeyHex.trim(), now);
  const store: PairingStore = sqlitePairingStore(db);
  store.set(row);
  const id = newId('wrk');
  db.prepare(
    `INSERT INTO workers (id, name, pubkey_hash, platform, capabilities, status, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, name, sha256Hex(input.pubkeyHex.trim()), input.platform?.slice(0, 120) ?? null, input.capabilities ?? '{}', 'pending', now);
  return { ok: true, workerId: id, nonce, expiresAt: row.expires_at };
}

/**
 * Worker claims the nonce with its private key. Success records identity
 * (claimed_at) but issues NOTHING — a human approves afterwards.
 */
export function claimPairing(
  db: DB,
  input: { nonce: string; pubkeyHex: string; signatureHex: string; now?: number },
): { ok: true; workerId: string } | WorkerFailure {
  const now = input.now ?? Date.now();
  let key: KeyLike;
  try {
    key = createPublicKey({ key: Buffer.from(input.pubkeyHex.trim(), 'hex'), format: 'der', type: 'spki' });
  } catch {
    return fail('bad_key', 'Unparseable public key.');
  }
  const row = db.prepare('SELECT * FROM workers WHERE pubkey_hash=?').get(sha256Hex(input.pubkeyHex.trim())) as WorkerRow | undefined;
  if (!row) return fail('not_found', 'No pairing was started for this key — the operator starts it on the primary first.');
  if (row.status === 'revoked') return fail('revoked', 'This worker was revoked — start a fresh pairing.');
  if (row.status === 'paired') return fail('bad_state', 'This worker is already paired.');
  let sig: Buffer;
  try {
    sig = Buffer.from(input.signatureHex.trim(), 'hex');
  } catch {
    return fail('bad_signature', 'Unparseable signature.');
  }
  const store: PairingStore = sqlitePairingStore(db);
  const r = verifyPairingAttempt(store, { nonce: input.nonce, pubkeyHex: input.pubkeyHex.trim(), signature: sig, publicKey: key, now });
  if (!r.ok) {
    const messages: Record<string, string> = {
      unknown: 'Unknown or already-used nonce — nonces are single-use; start over with a fresh one.',
      revoked: 'This pairing was revoked.',
      expired: 'The nonce expired (10 minutes) — start over.',
      pubkey_mismatch: 'Signature key does not match the registered worker key.',
      bad_signature: 'Signature verification failed.',
      replay: 'Nonce already consumed.',
    };
    return fail(r.reason === 'unknown' || r.reason === 'replay' ? 'unknown_nonce' : (r.reason as WorkerFailure['reason']), messages[r.reason] ?? 'Claim failed.');
  }
  db.prepare('UPDATE workers SET claimed_at=? WHERE id=?').run(now, row.id);
  return { ok: true, workerId: row.id };
}

/**
 * Human approval: only from claimed-pending, issues the bearer token ONCE.
 * The token is sha256-stored; this return is the only time it exists in
 * plaintext outside the worker.
 */
export function approveWorker(db: DB, workerId: string): { ok: true; token: string } | WorkerFailure {
  const row = db.prepare('SELECT * FROM workers WHERE id=?').get(workerId) as WorkerRow | undefined;
  if (!row) return fail('not_found', 'Unknown worker.');
  if (row.status === 'revoked') return fail('revoked', 'This worker was revoked.');
  if (row.status === 'paired') return fail('bad_state', 'Already paired — revoke first to re-pair.');
  if (row.claimed_at === null) return fail('bad_state', 'The worker has not claimed yet — its signature is unverified, and approval waits for it.');
  const token = randomBytes(32).toString('hex');
  db.prepare(`UPDATE workers SET status='paired', token_hash=? WHERE id=?`).run(tokenHash(token), workerId);
  return { ok: true, token };
}

export function revokeWorker(db: DB, workerId: string, now = Date.now()): { ok: true; unassigned: number; lost: number } | WorkerFailure {
  const row = db.prepare('SELECT * FROM workers WHERE id=?').get(workerId) as WorkerRow | undefined;
  if (!row) return fail('not_found', 'Unknown worker.');
  const tx = db.transaction(() => {
    db.prepare(`UPDATE workers SET status='revoked', token_hash=NULL, online=0 WHERE id=?`).run(workerId);
    // Queued-but-unpulled rows come home to the local pump. Claimed rows the
    // worker may be executing die loudly as worker_lost — their token is
    // dead, so no completion for them will ever be accepted.
    const un = db.prepare(`UPDATE runs SET worker_id=NULL WHERE worker_id=? AND state='queued' AND worker_claimed_at IS NULL`).run(workerId);
    const lost = db.prepare(`UPDATE runs SET state='failed', outcome_reason='worker_lost', ended_at=? WHERE worker_id=? AND state='queued' AND worker_claimed_at IS NOT NULL`).run(now, workerId);
    return { unassigned: Number(un.changes), lost: Number(lost.changes) };
  });
  return { ok: true, ...tx() };
}

export function removeWorker(db: DB, workerId: string): { ok: true; unassigned: number; lost: number } | WorkerFailure {
  const row = db.prepare('SELECT * FROM workers WHERE id=?').get(workerId) as WorkerRow | undefined;
  if (!row) return fail('not_found', 'Unknown worker.');
  // Same settlement as revoke (explicit beats FK backstop): queued-unpulled
  // rows come home, claimed rows fail loudly — a removed worker's in-flight
  // work must never silently re-run locally, nor wait forever on a dead id.
  const tx = db.transaction(() => {
    const un = db.prepare(`UPDATE runs SET worker_id=NULL WHERE worker_id=? AND state='queued' AND worker_claimed_at IS NULL`).run(workerId);
    const lost = db.prepare(`UPDATE runs SET state='failed', outcome_reason='worker_lost', ended_at=? WHERE worker_id=? AND state='queued' AND worker_claimed_at IS NOT NULL`).run(Date.now(), workerId);
    db.prepare('DELETE FROM workers WHERE id=?').run(workerId);
    return { unassigned: Number(un.changes), lost: Number(lost.changes) };
  });
  return { ok: true, ...tx() };
}

/** Worker bearer auth for the protocol routes (NOT the user bearer). */
export function authWorker(db: DB, workerId: string, token: string | undefined): WorkerRow | null {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM workers WHERE id=?').get(workerId) as WorkerRow | undefined;
  if (!row || row.status !== 'paired' || !row.token_hash) return null;
  const a = Buffer.from(tokenHash(token));
  const b = Buffer.from(row.token_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row;
}

/** Token-only lookup (GET /workers/me): tokens are unique 32-byte secrets. */
export function authWorkerByToken(db: DB, token: string | undefined): WorkerRow | null {
  if (!token) return null;
  const h = tokenHash(token);
  const rows = db.prepare('SELECT * FROM workers WHERE token_hash IS NOT NULL').all() as WorkerRow[];
  for (const row of rows) {
    if (row.status !== 'paired') continue;
    const a = Buffer.from(h);
    const b = Buffer.from(row.token_hash!);
    if (a.length === b.length && timingSafeEqual(a, b)) return row;
  }
  return null;
}

/** Pin validation at save: unknown pins refuse — a typo must not strand a task. */
export function assertPinOk(db: DB, pin: string | null | undefined): string | null {
  if (!pin) return null;
  const w = db.prepare('SELECT id FROM workers WHERE id=?').get(pin) as any;
  if (!w) return `unknown worker '${pin}' — pair it first under Settings › Workers`;
  return null;
}

/**
 * Resolve a task's pin at fire time: the pinned worker id, or null for
 * local. Required pins wait even when offline; preferred pins fall back to
 * local (the caller notes it). Unknown/deleted/revoked pins behave as
 * required-offline — never silently local, or a removed Mini would reroute
 * overnight work onto the sleeping laptop it was pinned away from.
 */
export function resolveWorkerPin(
  db: DB,
  taskRow: { worker_pin?: string | null; worker_required?: number | null },
  now = Date.now(),
): { workerId: string | null; fellBack: boolean; waitingOn: string | null } {
  const pin = taskRow.worker_pin ?? null;
  if (!pin) return { workerId: null, fellBack: false, waitingOn: null };
  const w = db.prepare('SELECT * FROM workers WHERE id=?').get(pin) as WorkerRow | undefined;
  const required = Number(taskRow.worker_required ?? 0) === 1;
  // Unknown, deleted, revoked, pending or offline pins all resolve the same
  // way: required waits (loudly — the queue shows what it waits on, and
  // deleting a worker never silently reroutes overnight work onto the laptop
  // it was pinned away from), preferred falls back to local.
  if (!w || w.status !== 'paired' || !isWorkerOnline(w, now)) {
    return required
      ? { workerId: pin, fellBack: false, waitingOn: pin }
      : { workerId: null, fellBack: true, waitingOn: null };
  }
  return { workerId: pin, fellBack: false, waitingOn: null };
}

/**
 * Silence sweep: paired workers past the heartbeat timeout go offline, and
 * their claimed-but-unreported runs fail loudly as worker_lost — a run that
 * may or may not have executed is NEVER reported complete. Queued-unpulled
 * rows stay put (required pins wait; preferred pins were already local).
 */
export function sweepWorkers(
  db: DB,
  now: number,
  notify: (kind: string, title: string, body: string) => void,
): { offlined: string[]; lost: number } {
  const stale = db.prepare(`SELECT * FROM workers WHERE status='paired' AND online=1 AND (last_heartbeat IS NULL OR last_heartbeat < ?)`).all(now - HEARTBEAT_TIMEOUT_MS) as WorkerRow[];
  let lost = 0;
  for (const w of stale) {
    db.prepare('UPDATE workers SET online=0 WHERE id=?').run(w.id);
    const rows = db.prepare(`SELECT id, task_id FROM runs WHERE worker_id=? AND state='queued' AND worker_claimed_at IS NOT NULL`).all(w.id) as any[];
    for (const r of rows) {
      db.prepare(`UPDATE runs SET state='failed', outcome_reason='worker_lost', ended_at=? WHERE id=?`).run(now, r.id);
      db.prepare('INSERT INTO events (at, run_id, kind, data_json) VALUES (?, ?, ?, ?)').run(
        now,
        r.id,
        'state_changed',
        JSON.stringify({ to: 'failed', reason: 'worker_lost', worker: w.id }),
      );
      lost++;
    }
  }
  if (stale.length > 0) {
    notify('worker_offline', `Worker${stale.length === 1 ? '' : 's'} silent: ${stale.map((w) => w.name).join(', ')}`, `${lost} claimed run${lost === 1 ? '' : 's'} marked worker_lost — never reported complete. Re-queue from Tasks if the work still matters.`);
  }
  return { offlined: stale.map((w) => w.id), lost };
}

/**
 * Preferred-pin fallback visibility: when a task carries a pin but the
 * stamped spec went local (worker offline), say so on the run. Without this
 * the fallback is silent — the queue would show a local run for a
 * worker-pinned task with no explanation. Call at every runs INSERT site.
 */
export function noteWorkerFallback(
  db: DB,
  runId: string,
  taskRow: { worker_pin?: string | null },
  specWorkerId: string | null | undefined,
  now: number,
): void {
  if (taskRow.worker_pin && !specWorkerId) {
    db.prepare('INSERT INTO events (at, run_id, kind, data_json) VALUES (?, ?, ?, ?)').run(
      now,
      runId,
      'worker_fallback',
      JSON.stringify({ pin: taskRow.worker_pin }),
    );
  }
}

export interface WorkerSweepOptions {
  db: DB;
  notify: (kind: string, title: string, body: string) => void;
  intervalMs?: number;
  log?: (message: string) => void;
}

/**
 * Silence sweep on the heartbeat cadence, same shape as startRetentionSweep:
 * startup run (a machine that slept through the cadence still notices on
 * wake), timer with unref, housekeeping never takes the daemon down.
 */
export function startWorkerSweep(options: WorkerSweepOptions): { stop(): void } {
  function defaultLog(m: string): void {
    process.stderr.write(`${m}\n`);
  }
  const { db, notify, intervalMs = HEARTBEAT_TIMEOUT_MS, log = defaultLog } = options;
  const run = (): void => {
    try {
      const r = sweepWorkers(db, Date.now(), notify);
      if (r.offlined.length > 0) log(`[workers] ${r.offlined.length} went silent, ${r.lost} claimed run(s) marked worker_lost`);
    } catch (err) {
      log(`[workers] sweep failed: ${(err as Error).message}`);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
