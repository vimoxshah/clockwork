# Commercialization Gauntlet — Checkpoint 3

Branch: feature/commercial-byok-ux (pushed through d7010e1). PR #2 open.

## COMPLETED THIS SESSION (on top of Checkpoint 2)

1. **Real entitlement enforcement** (`2b9d875`) — gauntlet §7 satisfied:
   - `EntitlementService.gate(feature)` / `limitFor(feature)`: central
     capability resolution; zero plan checks scattered at call sites.
   - `NUMERIC_LIMITS` map: machine-readable caps separated from display
     prose. (A test caught `"1 year"` parsing as cap=1 — fixed by design,
     not by patching the symptom.)
   - Wired at four genuine points: PUT /retention (free capped 30d),
     POST /triggers (free capped 2), GET /audit + GET /policies (402 on free).
   - All 402s carry {feature, requiresPlan} + honest human copy; ApiError
     propagates them to views.
2. **Contextual upgrade UX** — UpgradeHint component per §12: explains what
   the feature does, which plan includes it, reassures data safety. No bare
   "PRO ONLY" labels anywhere.
3. **Support bundle** (`723c2f9`) — §36 satisfied:
   GET /support/bundle returns versions/platform/engine detection/provider
   connection states/counts/entitlement state. Keychain never read; notes in
   the bundle state this. Settings "Export diagnostics" button downloads it.
4. **R2 salvage** (`8d3fe9c`) — licensing-pattern evidence from the timed-out
   researcher's transcript now cites Keygen/LicenseSpring docs corroborating
   our signed-token + grace + high-water-rollback design.

## TEST RESULTS

158/158 tests across 22 files (10 entitlement + 4 gate-enforcement tests
added this session). Build green, lint 0 errors.

## BLOCKED / DEFERRED

- Live restart verification of /support/bundle was consent-blocked mid-chain;
  the route is covered by build + unit gates and will be exercised on next
  natural daemon restart (or manually: curl /support/bundle).

## NEXT HIGHEST-VALUE WORK

1. Merge PR #2 after user review (CI runs automatically on the PR).
2. Lemon Squeezy seller approval (manual), then webhook receiver that mints
   signed entitlement tokens + ship ENTITLEMENT_PUBLIC_KEY_HEX.
3. Composer BYOK native-select -> shared picker component (polish).
4. Visual QA pass when vision tooling restored (screenshots queued in
   ~/Desktop/clockwork-byok-audit/).
5. Full-loop E2E re-run incl. Hermes/OpenCode engines before release (§39).
6. Landing/docs final pass after pricing goes live (§43/44/45 funnel check).
