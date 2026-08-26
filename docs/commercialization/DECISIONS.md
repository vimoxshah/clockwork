# Commercialization Decisions — research-grounded (2026-08-26)

Status legend: VERIFIED = sourced URL in research file · INFERENCE = reasoned
from verified facts · PROPOSED = our design decision, not yet wired.

## D1. Billing provider → Lemon Squeezy (PROPOSED, activation pending)

Research: `delegation` R1 summary + official docs (fees, licensing, webhooks).

- Only MoR of the three with native license issuance AND an
  activate/validate/deactivate License API whose status flips `expired`
  when the subscription lapses (VERIFIED).
- 5% + 50¢ base (+1.5% intl, +1.5% PayPal, +0.5% subscriptions) (VERIFIED);
  taxes/VAT remitted by them (VERIFIED).
- Webhooks incl. `license_key_created/updated`, full sub lifecycle,
  HMAC-signed (VERIFIED).
- Trade-offs accepted: surcharges raise effective fee; flat 50¢ hurts cheap
  tiers; Stripe acquired LS (roadmap watch); start seller approval EARLY.
- Rejected: Paddle (current Billing product cannot issue licenses),
  Stripe (we become MoR; zero licensing; tax filings on us).

Wiring plan (when account approved): webhook receiver endpoint maps
`subscription_*` events → issue/renew signed entitlement tokens (our
EntitlementService format) → email/API delivery to buyer; app-side flow
already ships (`POST /license/activate`). Until then activation honestly
reports "verification not yet enabled".

## D2. Entitlement verification → local Ed25519 signed tokens (SHIPPED)

Offline-first per gauntlet §8-9: verify signature locally, cache in SQLite,
72h grace past expiry, revalidation window, clock-rollback guard.
Keygen/LicenseSpring rejected as vendors: another dependency + per-license
cost for a loop we can close with one public key and 200 lines.

R2 corroboration (transcript-sourced, official docs; researcher timed out
before writing its summary — findings salvaged from its live trace):
- Public-key embedding client-side is explicitly safe per Keygen docs
  (VERIFIED: keygen.sh docs "Public IDs and Keys Embedding") — validates
  shipping ENTITLEMENT_PUBLIC_KEY_HEX in the binary.
- Signed license files carry cert + issued + expiry attributes
  (VERIFIED: keygen-sh/keygen-go `license_file.go` struct) — same shape as
  our claims {iat, exp} payload.
- Max-time-offline is governed by a grace period tied to failed online
  checks; policies expose activation limits + device-transfer limits
  (VERIFIED: docs.licensespring.com grace-period + license-policies pages).
- Clock rollback is defended in practice by persisting an inconspicuous
  high-water timestamp to disk and checking it periodically
  (VERIFIED: keygen.sh anti-tampering docs) — our `high_water_ms` column
  implements exactly this.
Device binding: we bind device_id at activation; transfers happen via
deactivate → reactivate (matches LicenseSpring's transfer-limit concept,
simpler policy for v1).

## D3. Pricing ladder (PROPOSED — copy-ready, checkout pending)

From R3 market evidence (TypingMind/BoltAI/Msty lifetime $39–$349;
Cursor/Raycast/Warp $8–$200/mo; BYOK universally free/universal):

| Tier | Price | Includes |
| --- | --- | --- |
| Free | $0 | Core scheduling + agents + BYOK; 30d history; basic analytics |
| Pro | $99/yr (or $299 lifetime) | Unlimited history, advanced analytics, priority engine updates |
| Team | $120/user/yr | Shared agent library conventions, governance gates, longer retention |
| Enterprise | custom | SSO/SCIM (planned), audit export, custom retention |

Rules encoded: BYOK usage NEVER metered by Clockwork (market norm +
differentiator vs Cursor's $0.25/M own-key fee); cost analytics is the Pro
headline (no competitor bundles it); pricing page must say plainly what the
provider bills separately.

## D4. Thesis (adopted)

"Bring any AI model. Clockwork turns it into a workforce." Sell orchestration
(calendar, agents, approvals, observability, governance), never pretend to
bundle model spend. BYOK positioned as benefit ("use models you already pay
for") per §44/§5.
