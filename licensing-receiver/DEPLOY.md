# Licensing Receiver — deploy runbook (execute at LS approval)

Zero-dependency Node 20+ service in `licensing-receiver/`. Fully tested
(`receiver.test.js`, 9 tests) with synthetic signed webhooks; deployment is
configuration only.

## One-time setup (the day LS approves)

1. Generate the signing keypair — private goes to the receiver, public into
   the app:
   ```bash
   node -e "
   const { generateKeyPairSync } = require('node:crypto');
   const { publicKey, privateKey } = generateKeyPairSync('ed25519');
   console.log('CW_ENTITLEMENT_KEY (PEM):');
   console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }));
   console.log('ENTITLEMENT_PUBLIC_KEY_HEX:');
   console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('hex'));
   "
   ```
2. Set `ENTITLEMENT_PUBLIC_KEY_HEX` in `packages/daemon/src/entitlements.ts`
   to the hex above; bump version; release. From that build on, activation works.
3. Deploy `licensing-receiver/receiver.js` anywhere Node 20 runs
   (`node receiver.js` with `CW_RUN_SERVER=1`). Env:
   - `CW_LS_WEBHOOK_SECRET` — from LS Settings → Webhooks
   - `CW_ENTITLEMENT_KEY` — PEM above
   - `CW_VARIANT_MAP='{"Clockwork Pro":"pro","Clockwork Team":"team"}'`
   - `CW_LIFETIME_VARIANTS='["Pro Lifetime"]'`
   - `CW_OUTBOX_DIR=/data/outbox`
4. In LS: point webhooks at `https://<host>/webhooks/lemonsqueezy`; subscribe to
   order_created, subscription_created/updated/payment_success/expired/cancelled.
5. Smoke test: buy your own product once; a JSON file with the buyer email +
   token appears in the outbox within seconds.
6. Fulfillment v1: forward the token to the buyer's email (manual or mail
   merge). Buyer pastes it in Settings → Plan & license → Activate.

## Security notes

- Signature checked constant-time over the raw body; 401 otherwise.
- Idempotent per event id (LS retries are safe).
- No database, no customer data at rest beyond outbox tokens.
- Rotate keys by publishing the new public key alongside the old for one
  release before retiring it.

## What is deliberately NOT here

No email sending inside the receiver (no credentials in this service), no
database (LS is the source of truth), no license-key API use (our own signed
tokens carry plan/exp claims LS keys don't).
