# Lemon Squeezy → Entitlement Wiring Design

Status: DESIGN COMPLETE, implementation blocked on seller approval (§52 checkpoint).
When the LS account exists, implement exactly this — no redesign needed.

## Topology (no premature cloud, §48)

```
LS checkout ──> LS hosted page (payment, taxes, invoices)
LS webhooks ──> [tiny HTTPS receiver] ──signs──> entitlement token (email/API to buyer)
Clockwork app <──activate token──> local Ed25519 verify (already shipped)
```

The ONLY new server piece is the webhook receiver: one endpoint, no database
of its own (state lives in LS), no customer data at rest. It can be a
serverless function on the same domain as the landing page.

## Event mapping

| LS event | Receiver action |
| --- | --- |
| `order_created` | If variant is a license product AND first order for that email: mint token {sub=order_id, plan=variant→tier map, iat=now, exp=period_end}, email to buyer via LS receipt custom text / separate transactional email. |
| `subscription_created` | Same as order_created for subscription products; exp = renews_at + 72h grace buffer. |
| `subscription_updated` | Plan changed: mint replacement token with new plan/exp; include instructions to reactivate. Old token remains valid until its own exp (self-limiting). |
| `subscription_expired` / `subscription_cancelled` (at period end) | No action — existing token simply expires at exp. This is why exp must track renews_at. |
| `subscription_payment_success` | Renewal: mint fresh token with new exp (renews_at + 72h); email "your license renewed". |
| `subscription_payment_failed` | Email dunning notice (LS handles retries); token stays valid until exp (grace behavior emerges naturally). |
| `license_key_created` | Not used — we issue our OWN tokens instead of LS license keys because our verifier needs claims (plan, exp, device) LS keys don't carry. LS license API remains available later for seat-limited Enterprise seats if needed. |

## Token minting

- Key: Ed25519 private key generated once, stored in the receiver's env
  (`CW_ENTITLEMENT_SIGNING_KEY`, PKCS8 PEM). Public half goes into
  `ENTITLEMENT_PUBLIC_KEY_HEX` (SPKI DER hex) in `packages/daemon/src/entitlements.ts`.
- Claims = existing `EntitlementClaims` interface. No format changes.
- Rotate = publish new public key alongside old for one release cycle
  (verify tries both) before retiring old.

## Variant → tier map (from DECISIONS.md D3)

| LS product/variant | plan claim |
| --- | --- |
| Clockwork Pro monthly/annual/lifetime | `pro` |
| Clockwork Team seat | `team` (per-seat; device binding enforces) |
| Enterprise | manual fulfillment (signed token generated offline) |

Lifetime = token with exp = now + 50 years, sub = order id.

## Receiver security checklist

1. Verify LS signature: raw-body HMAC-SHA256 against `X-Signature` using
   `CW_LS_WEBHOOK_SECRET` (env; never committed).
2. Constant-time compare; reject non-matching with 401.
3. Idempotency: key on `meta.event_name` + payload id; duplicates return 200
   without re-minting (LS retries on non-2xx per their docs).
4. Rate-limit by source IP (receiver platform feature is fine).
5. Logs contain event ids only — never tokens or emails in plaintext logs.
6. Never expose a token-minting path publicly; the receiver only speaks to LS.

## App-side work remaining after key generation

- Replace `ENTITLEMENT_PUBLIC_KEY_HEX = ''` with the real hex (one line;
  tests already cover both configured and unconfigured paths).
- Landing/pricing buttons link to LS checkout URLs.
- Optional: `POST /license/revalidate` calling LS License API `validate` for
  online refresh — NOT required for v1 (exp-based expiry suffices).

## Trial decision (§11)

Free tier IS the trial (research-validated pattern): full core, honest caps.
No separate time-boxed trial mechanism for v1 — avoids clock-gaming surface
and matches TypingMind/BoltAI/Warp norms.
