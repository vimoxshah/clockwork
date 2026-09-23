import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mintPairingEntry, verifyPairingAttempt, sqlitePairingStore, type PairingRow, type PairingStore } from '../src/pairing.js';
import { openDatabase, createMigrator, loadMigrationsFrom } from '../src/db.js';

function memStore(): PairingStore & { rows: Map<string, PairingRow> } {
  const rows = new Map<string, PairingRow>();
  return {
    rows,
    get: (h) => rows.get(h),
    set: (r) => {
      rows.set(r.token_hash, r);
    },
    consume: (h) => rows.delete(h),
    revokeAll: (now) => {
      for (const r of rows.values()) r.revoked_at = now;
    },
  };
}

function keypair(): { pubHex: string; pubKey: any; privKey: any } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
  return { pubHex: pubDer, pubKey: publicKey, privKey: privateKey };
}

describe('pairing bound to peer key (R5-A)', () => {
  it('mint + verify ok, single-use', () => {
    const s = memStore();
    const kp = keypair();
    const { nonce, row } = mintPairingEntry(kp.pubHex, 1_000);
    s.set(row);
    const sig = sign(null, Buffer.from(nonce, 'hex'), kp.privKey);
    expect(verifyPairingAttempt(s, { nonce, pubkeyHex: kp.pubHex, signature: sig, publicKey: kp.pubKey, now: 2_000 })).toEqual({ ok: true });
  });

  it('replay rejected', () => {
    const s = memStore();
    const kp = keypair();
    const { nonce, row } = mintPairingEntry(kp.pubHex, 1_000);
    s.set(row);
    const sig = sign(null, Buffer.from(nonce, 'hex'), kp.privKey);
    expect(verifyPairingAttempt(s, { nonce, pubkeyHex: kp.pubHex, signature: sig, publicKey: kp.pubKey, now: 2_000 }).ok).toBe(true);
    const sig2 = sign(null, Buffer.from(nonce, 'hex'), kp.privKey);
    const r2 = verifyPairingAttempt(s, { nonce, pubkeyHex: kp.pubHex, signature: sig2, publicKey: kp.pubKey, now: 3_000 });
    expect(r2).toEqual({ ok: false, reason: 'unknown' });
  });

  it('expired rejected + row consumed', () => {
    const s = memStore();
    const kp = keypair();
    const { nonce, row } = mintPairingEntry(kp.pubHex, 1_000);
    s.set(row);
    const sig = sign(null, Buffer.from(nonce, 'hex'), kp.privKey);
    const r = verifyPairingAttempt(s, { nonce, pubkeyHex: kp.pubHex, signature: sig, publicKey: kp.pubKey, now: 1_000 + 10 * 60 * 1000 + 1 });
    expect(r).toEqual({ ok: false, reason: 'expired' });
    expect(s.get(row.token_hash)).toBeUndefined();
  });

  it('wrong pubkey rejected', () => {
    const s = memStore();
    const a = keypair();
    const b = keypair();
    const { nonce, row } = mintPairingEntry(a.pubHex, 1_000);
    s.set(row);
    const sigB = sign(null, Buffer.from(nonce, 'hex'), b.privKey);
    expect(
      verifyPairingAttempt(s, { nonce, pubkeyHex: b.pubHex, signature: sigB, publicKey: b.pubKey, now: 2_000 }),
    ).toEqual({ ok: false, reason: 'pubkey_mismatch' });
  });

  it('revoked rejected', () => {
    const s = memStore();
    const kp = keypair();
    const { nonce, row } = mintPairingEntry(kp.pubHex, 1_000);
    s.set(row);
    s.revokeAll(1_500);
    const sig = sign(null, Buffer.from(nonce, 'hex'), kp.privKey);
    expect(verifyPairingAttempt(s, { nonce, pubkeyHex: kp.pubHex, signature: sig, publicKey: kp.pubKey, now: 2_000 })).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('0012 migration applies + SQLite store round-trips', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-pair-'));
    try {
      const { db } = openDatabase(dir);
      createMigrator(db, loadMigrationsFrom(path.join(__dirname, '..', 'migrations')), path.join(dir, 'clockwork.sqlite')).migrate();
      const applied = (db.prepare("SELECT id FROM schema_migrations WHERE id = '0012_pairing_tokens'").get() as any)?.id;
      expect(applied).toBe('0012_pairing_tokens');
      const s = sqlitePairingStore(db);
      const kp = keypair();
      const { nonce, row } = mintPairingEntry(kp.pubHex);
      s.set(row);
      const sig = sign(null, Buffer.from(nonce, 'hex'), kp.privKey);
      expect(verifyPairingAttempt(s, { nonce, pubkeyHex: kp.pubHex, signature: sig, publicKey: kp.pubKey }).ok).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
