# Commercialization Gauntlet — Checkpoint 2

Branch: feature/commercial-byok-ux (pushed). Base: main @ 9123de3.

## COMPLETED (all verified live)

1. **BYOK rebuild** (`61d31fc`): guided 3-stage connect flow (provider cards ->
   visible masked key field -> searchable ModelSelector -> real Test connection
   BEFORE save; save gated on passing test; abort persists nothing);
   friendly error mapping; Z.ai added; 15 registry models have names;
   is_default + model_label persisted (migration 0007); connected-provider
   cards with Set default/Test/Replace key/Remove; composer shows default.
2. **Entitlements** (`fbdd8c6`): EntitlementService — Ed25519-signed tokens,
   local verification, SQLite cache, 72h offline grace, revalidation window,
   clock-rollback guard, fail-closed with no shipping key; /license/activate
   + /license/deactivate; Settings "Plan & license" card + self-generating
   capability matrix (17 features).
3. **Onboarding v2** (`a89cc9a`): provider-readiness step routes new users to
   BYOK setup when nothing is connected.
4. **Research folded in** (`ac5c04c`, `7441883`): Lemon Squeezy chosen as MoR
   (native licenses + activation API + sub-tied expiry); pricing ladder
   Free / Pro $99yr+$299 lifetime / Team $120/user/yr / Ent custom on landing
   page (honest "launching soon", no fake checkout); docs/byok-guide.md;
   docs/commercialization/DECISIONS.md.

## TEST RESULTS

- 152/152 tests (21 files) incl. 8 new entitlement tests (real crypto,
  forgery rejection, grace expiry, rollback degradation).
- typecheck clean; lint 0 errors (141 pre-existing warnings); build green.
- Live Playwright: key field visible step-2, model search+Enter works,
  bogus key -> actionable error, save disabled until valid test, aborted
  flow persists zero configs, LicenseCard states render, garbage license
  -> human-readable rejection, CSP sweep 0 violations.

## SECURITY RESULTS

- Keys remain Keychain-only; hints redacted; bearer auth covers all new
  routes (/byok/validate, /license/*); audit log records activate/deactivate/
  set_default; no secret logging paths added. Fail-closed entitlements mean
  no paid state exists until the real public key ships.

## REMAINING (priority order)

1. PR + merge feature/commercial-byok-ux after review (CI runs automatically).
2. Lemon Squeezy seller approval (manual — start early, days of lead time),
   then webhook receiver that mints signed entitlement tokens; ship
   ENTITLEMENT_PUBLIC_KEY_HEX to enable real activation.
3. Upgrade UX deepening: contextual upgrade prompts at gated capabilities
   (currently only Plan & License card + matrix exist; features.ts has the
   tiers but enforcement points are still only retention/policy/audit).
4. Support bundle export (sanitized diagnostics) — §36 not started.
5. Visual QA pass when vision tooling restored (screenshots queued in
   ~/Desktop/clockwork-byok-audit/).
6. Composer still uses native select for BYOK choice (functional, low-risk);
   replace with shared picker component if time allows.
7. Hermes/OpenCode real execution runs through the new flow (§39) — engine
   matrix unchanged by UI work, but re-run full-loop E2E before release.
