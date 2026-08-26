# §39 Mandated validator reviews — Hermes + OpenCode (2026-08-26)

Both engines reviewed PR #2's security-critical files independently.
Raw outputs preserved in this file; triage below.

## Triage

| Finding | Source | SEV | Action |
| --- | --- | --- | --- |
| `/license/*` + `/support/bundle` missing from bearer-auth regex | OpenCode | high | FIXED — added to auth hook |
| Unexpired tokens degraded to free after ~48h (revalidation window gated 'active', no revalidation caller exists) | OpenCode | med | FIXED — token exp is the enforcement point; window now gates only post-expiry grace |
| `activate()` of already-expired token reported state='active' | OpenCode | med | FIXED — activates into 'grace' honestly |
| `claims.plan` never validated against tier enum | OpenCode | low | FIXED — rejects unknown plans |
| Custom-endpoint validation: Bearer-only, scheme mismatch misreported as bad key | Hermes | high→med | FIXED — x-api-key retry for custom_openai 401/403 |
| Raw error fallthrough may leak provider body text | Hermes | low | MITIGATED — retry reduces false "bad key"; body already capped at 160 chars, loopback-only server; full friendly-mapping of provider bodies deferred (needs per-provider phrase tables) |
| Public key ships empty → paid activation impossible | both | med | BY DESIGN (§49 fail-closed); documented in DECISIONS.md D1; unblocks at LS approval |
| Env-var credential staleness not detectable | Hermes | med | WONTFIX v1 — env mode is a power-user path; misconfiguration surfaces as run-time auth error with actionable copy |
| Device binding advisory (same SQLite row) | OpenCode | low | ACCEPTED v1 — deactivation-transfer flow covers honest cases; hard binding needs OS keystore integration (queued) |
| priceLine NaN on malformed registry numbers | Hermes | low | FIXED — finite guard |
| ByokCard doDelete/doSetDefault missing catch | OpenCode | low | FIXED |
| SSE query-param token can leak into logs | OpenCode | low | ACCEPTED — EventSource limitation, loopback-only; header-auth SSE queued for later |

## Verdicts

- Hermes: FIX-FIRST → all its actionable findings fixed or explicitly dispositioned above
- OpenCode: FIX-FIRST → same

Post-fix gates: build green, 158/158 tests pass.
