/**
 * Round5-A. Mesh pairing bound to peer key (additive, no behavior change yet).
 *
 * Nonce (16B) + 10min expiry + single-use CAS + revocation + pubkey binding.
 * Stores SHA-256 hashes only. Signature is Ed25519 over the nonce bytes.
 * Local-only: no Clockwork cloud; verification runs on loopback.
 *
 * Round6: SQLite-backed store over the 0012_pairing_tokens migration.
 */
import { randomBytes, createHash, verify, type KeyLike } from 'node:crypto';
import { hashSecret } from './triggers.js';
import type { DB } from './db.js';

export const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface PairingRow {
  token_hash: string;
  pubkey_hash: string;
  expires_at: number;
  revoked_at: number | null;
}

export interface PairingStore {
  get(tokenHash: string): PairingRow | undefined;
  set(row: PairingRow): void;
  /** CAS consume: delete iff present. Returns true on first use. */
  consume(tokenHash: string): boolean;
  revokeAll(now: number): void;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function mintPairingEntry(pubkeyHex: string, now = Date.now()): { nonce: string; row: PairingRow } {
  const nonce = randomBytes(16).toString('hex');
  const row: PairingRow = {
    token_hash: hashSecret(nonce),
    pubkey_hash: sha256Hex(pubkeyHex),
    expires_at: now + PAIRING_TTL_MS,
    revoked_at: null,
  };
  return { nonce, row };
}

export function verifyPairingAttempt(
  store: PairingStore,
  opts: { nonce: string; pubkeyHex: string; signature: Buffer; publicKey: KeyLike; now?: number },
): { ok: true } | { ok: false; reason: 'unknown' | 'revoked' | 'expired' | 'pubkey_mismatch' | 'bad_signature' | 'replay' } {
  const now = opts.now ?? Date.now();
  const tokenHash = hashSecret(opts.nonce);
  const row = store.get(tokenHash);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (now > row.expires_at) {
    store.consume(tokenHash);
    return { ok: false, reason: 'expired' };
  }
  if (sha256Hex(opts.pubkeyHex) !== row.pubkey_hash) return { ok: false, reason: 'pubkey_mismatch' };
  const valid = verify(null, Buffer.from(opts.nonce, 'hex'), opts.publicKey, opts.signature);
  if (!valid) return { ok: false, reason: 'bad_signature' };
  if (!store.consume(tokenHash)) return { ok: false, reason: 'replay' };
  return { ok: true };
}

/** Round6: SQLite store over 0012_pairing_tokens. Hashes only, never plaintext. */
export function sqlitePairingStore(db: DB): PairingStore {
  const getStmt = db.prepare('SELECT token_hash, pubkey_hash, expires_at, revoked_at FROM pairing_tokens WHERE token_hash = ?');
  const setStmt = db.prepare(
    'INSERT OR REPLACE INTO pairing_tokens (token_hash, pubkey_hash, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const delStmt = db.prepare('DELETE FROM pairing_tokens WHERE token_hash = ?');
  return {
    get: (h) => getStmt.get(h) as PairingRow | undefined,
    set: (r) => {
      setStmt.run(r.token_hash, r.pubkey_hash, r.expires_at, r.revoked_at, Date.now());
    },
    consume: (h) => delStmt.run(h).changes === 1,
    revokeAll: (now) => {
      db.prepare('UPDATE pairing_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(now);
    },
  };
}
