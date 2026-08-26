/**
 * Licensing receiver tests: synthetic Lemon Squeezy payloads, real HMAC,
 * real Ed25519 minting. No network, no LS account needed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifySignature, claimsForEvent, mintToken, processEvent } from './receiver.js';

const DAY = 86_400_000;
let secret;
let privateKeyPem;
let publicKey;
let cfg;

function lsEvent(eventName, overrides = {}) {
  return {
    meta: { event_name: eventName },
    data: {
      id: `ord_${Math.random().toString(36).slice(2, 8)}`,
      attributes: {
        user_email: 'buyer@example.com',
        renews_at: new Date(Date.now() + 30 * DAY).toISOString(),
        period_end: new Date(Date.now() + 30 * DAY).toISOString(),
        first_order_item: { variant_name: 'Clockwork Pro', variant_id: '12345' },
        ...overrides,
      },
    },
  };
}

beforeAll(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-receiver-'));
  const { publicKey: pub, privateKey } = generateKeyPairSync('ed25519');
  publicKey = pub;
  privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  secret = 'test-webhook-secret';
  cfg = {
    lsSecret: secret,
    privateKeyPem,
    variantMap: { 'Clockwork Pro': 'pro', '12345': 'pro', 'Clockwork Team': 'team', 'Pro Lifetime': 'pro' },
    lifetimeVariants: new Set(['Pro Lifetime']),
    outboxDir: dir,
    port: 0,
  };
});

describe('HMAC signature verification', () => {
  it('accepts a correctly signed raw body', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(verifySignature(body, sig, secret)).toBe(true);
  });
  it('rejects wrong signature, wrong key, or missing header', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySignature(body, 'sha256=deadbeef', secret)).toBe(false);
    expect(verifySignature(body, 'sha256=' + createHmac('sha256', 'other').update(body).digest('hex'), secret)).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'), '')).toBe(false);
  });
});

describe('event -> claims mapping', () => {
  it('mints subscription tokens expiring at renew date + grace', () => {
    const claims = claimsForEvent(lsEvent('subscription_created'), cfg);
    expect(claims.plan).toBe('pro');
    const expectedExp = Date.parse(lsEvent('subscription_created').data.attributes.renews_at) + GRACE_MS();
    expect(Math.abs(claims.exp - expectedExp)).toBeLessThan(1000);
  });

  it('mints lifetime tokens ~50 years out', () => {
    const evt = lsEvent('order_created', { first_order_item: { variant_name: 'Pro Lifetime', variant_id: '999' } });
    const claims = claimsForEvent(evt, cfg);
    expect(claims.exp).toBeGreaterThan(Date.now() + 40 * 365 * DAY);
  });

  it('ignores unmapped variants and terminal events', () => {
    expect(claimsForEvent(lsEvent('subscription_created', { first_order_item: { variant_name: 'Unknown', variant_id: 'x' } }), cfg)).toBeNull();
    expect(claimsForEvent(lsEvent('subscription_payment_failed'), cfg)).toBeNull();
    expect(claimsForEvent(lsEvent('subscription_expired'), cfg)).toBeNull();
  });

  it('maps plan changes on subscription_updated', () => {
    const evt = lsEvent('subscription_updated', { first_order_item: { variant_name: 'Clockwork Team', variant_id: '777' } });
    expect(claimsForEvent(evt, cfg).plan).toBe('team');
  });
});

describe('token + persistence', () => {
  it('mints a token the app-side verifier would accept structurally', async () => {
    const claims = claimsForEvent(lsEvent('order_created'), cfg);
    const token = mintToken(claims, privateKeyPem);
    const [payloadB64, sigB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    // Verify against the PUBLIC half exactly like EntitlementService does:
    // SPKI DER key + cryptoVerify(null, payload, key, sig).
    const { createPublicKey, verify } = await import('node:crypto');
    const key = createPublicKey({ key: publicKey.export({ type: 'spki', format: 'der' }), format: 'der', type: 'spki' });
    const ok = verify(null, Buffer.from(payloadB64, 'base64url'), key, Buffer.from(sigB64, 'base64url'));
    expect(ok).toBe(true);
    expect(payload.plan).toBe('pro');
    void readFileSync; void existsSync;
  });

  it('writes outbox files idempotently per event id', () => {
    const evt = lsEvent('order_created');
    evt.meta.custom_data = { event_id: 'fixed-id-1' };
    const first = processEvent(evt, cfg);
    expect(first.action).toBe('minted');
    const again = processEvent(evt, cfg);
    expect(again.action).toBe('duplicate');
    const written = JSON.parse(readFileSync(first.file, 'utf8'));
    expect(written.email).toBe('buyer@example.com');
    expect(written.token.split('.')).toHaveLength(2);
  });

  it('refuses to mint without a configured signing key', () => {
    const outcome = processEvent(lsEvent('order_created'), { ...cfg, privateKeyPem: '' });
    expect(outcome.action).toBe('error');
    expect(outcome.status).toBe(500);
  });
});

function GRACE_MS() { return 72 * 3600_000; }
