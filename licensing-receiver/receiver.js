/**
 * Clockwork licensing receiver (commercial gauntlet §8/13).
 *
 * Single-purpose HTTPS endpoint that accepts Lemon Squeezy webhooks,
 * verifies their HMAC signature, and mints Ed25519-signed entitlement
 * tokens consumed by the desktop app's EntitlementService.activate().
 *
 * Zero npm dependencies — runs on any Node >= 20 host (Fly.io, Railway,
 * Vercel Node runtime, a $5 VPS). Deploy before LS approval; activate by
 * setting env vars and pointing LS webhooks at /webhooks/lemonsqueezy.
 *
 * Env vars:
 *   CW_LS_WEBHOOK_SECRET   hex/base64 secret from LS dashboard (required in prod)
 *   CW_ENTITLEMENT_KEY     Ed25519 private key, PKCS8 PEM (required in prod)
 *   CW_VARIANT_MAP         JSON: {"<LS variant name or id>": "pro"|"team"}
 *   CW_LIFETIME_VARIANTS   JSON array of variant names/ids sold as lifetime
 *   CW_OUTBOX_DIR          dir for minted tokens (default ./outbox)
 *   CW_PORT                listen port (default 8787)
 *
 * Fulfillment model (v1, solo-dev volume): each minted token is written to
 * CW_OUTBOX_DIR/<event-id>.json containing the token + buyer email. The
 * operator emails it manually or via their mail provider later. No email
 * credentials live here; nothing is faked.
 */
import { createHmac, timingSafeEqual, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const GRACE_MS = 72 * 3600_000;

function envConfig() {
  return {
    lsSecret: process.env.CW_LS_WEBHOOK_SECRET ?? '',
    privateKeyPem: process.env.CW_ENTITLEMENT_KEY ?? '',
    variantMap: safeJson(process.env.CW_VARIANT_MAP, {}),
    lifetimeVariants: new Set(safeJson(process.env.CW_LIFETIME_VARIANTS, [])),
    outboxDir: process.env.CW_OUTBOX_DIR ?? './outbox',
    port: Number(process.env.CW_PORT ?? 8787),
  };
}

function safeJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

/** Constant-time LS signature check over the RAW body. */
export function verifySignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = String(header).replace(/^sha256=/, '');
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Map an LS event to entitlement claims, or null when nothing should mint. */
export function claimsForEvent(event, cfg, now = Date.now()) {
  const meta = event?.meta ?? {};
  const eventName = meta.event_name ?? '';
  const attrs = event?.data?.attributes ?? {};
  const custom = attrs.custom_data ?? event?.meta?.custom_data ?? {};

  // Which product/variant identifiers did this event reference?
  const firstItem = (attrs.first_order_item ?? {});
  const variantName = String(firstItem.variant_name ?? '');
  const variantId = String(firstItem.variant_id ?? '');
  const plan =
    cfg.variantMap[variantName] ??
    cfg.variantMap[variantId] ??
    null;
  if (!plan) return null;

  const orderId = String(event.data?.id ?? custom.order_id ?? `evt_${Date.now()}`);
  const email = String(attrs.user_email ?? custom.email ?? 'unknown@buyer');

  switch (eventName) {
    case 'order_created':
    case 'subscription_created':
    case 'subscription_payment_success': {
      // Lifetime products: far-future exp. Subscriptions: renew date + grace.
      const isLifetime = cfg.lifetimeVariants.has(variantName) || cfg.lifetimeVariants.has(variantId);
      const renewsAt = Number(attrs.renews_at ? Date.parse(attrs.renews_at) : 0);
      const periodEnd = Number(attrs.period_end ? Date.parse(attrs.period_end) : 0);
      const baseEnd = Math.max(renewsAt, periodEnd);
      const exp = isLifetime || !baseEnd ? now + 50 * 365 * 86_400_000 : baseEnd + GRACE_MS;
      return { sub: orderId, plan, iat: now, exp, email };
    }
    case 'subscription_updated': {
      // Plan change: mint replacement; old token self-expires.
      const renewsAt = Number(attrs.renews_at ? Date.parse(attrs.renews_at) : 0);
      const exp = renewsAt ? renewsAt + GRACE_MS : now + 30 * 86_400_000;
      return { sub: orderId, plan, iat: now, exp, email };
    }
    // Expiry/cancellation/failure intentionally mint nothing: the outstanding
    // token expires on its own exp — grace emerges naturally.
    default:
      return null;
  }
}

export function mintToken(claims, privateKeyPem) {
  const payload = Buffer.from(JSON.stringify({
    sub: claims.sub,
    plan: claims.plan,
    iat: claims.iat,
    exp: claims.exp,
  }), 'utf8');
  const sig = cryptoSign(null, payload, createPrivateKey(privateKeyPem));
  return `${payload.toString('base64url')}.${sig.toString('base64url')}`;
}

/** Pure event -> outcome logic, separated from HTTP for direct testing. */
export function processEvent(event, cfg, now = Date.now()) {
  const eventName = event?.meta?.event_name ?? 'unknown';
  const eventId = String(event?.meta?.custom_data?.event_id ?? `${eventName}:${event?.data?.id ?? Date.now()}`);
  const claims = claimsForEvent(event, cfg, now);
  if (!claims) {
    return { status: 200, action: 'ignored', eventId, reason: `no mapped variant or non-minting event (${eventName})` };
  }
  if (!cfg.privateKeyPem) {
    return { status: 500, action: 'error', eventId, reason: 'CW_ENTITLEMENT_KEY not configured' };
  }
  const token = mintToken(claims, cfg.privateKeyPem);
  mkdirSync(cfg.outboxDir, { recursive: true });
  const file = path.join(cfg.outboxDir, `${eventId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  if (existsSync(file)) {
    return { status: 200, action: 'duplicate', eventId, file };
  }
  writeFileSync(file, JSON.stringify({
    eventId, email: claims.email, plan: claims.plan,
    expiresAt: new Date(claims.exp).toISOString(), token,
  }, null, 2));
  return { status: 200, action: 'minted', eventId, file };
}

export function createHandler(cfg = envConfig()) {
  return async function handler(req, res) {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/webhooks/lemonsqueezy')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);

    if (!verifySignature(raw, req.headers['x-signature'], cfg.lsSecret)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad signature' }));
      return;
    }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad json' }));
      return;
    }
    const outcome = processEvent(event, cfg);
    res.writeHead(outcome.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: outcome.action !== 'error', action: outcome.action }));
  };
}

export function startServer(cfg = envConfig()) {
  const { createServer } = require('node:http');
  const server = createServer(createHandler(cfg));
  server.listen(cfg.port, () => console.log(`licensing receiver on :${cfg.port}`));
  return server;
}

if (process.argv[1] && process.argv[1].endsWith('receiver.js') && process.env.CW_RUN_SERVER === '1') {
  startServer();
}
