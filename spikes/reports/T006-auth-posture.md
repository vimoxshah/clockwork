# T-006 — Auth Posture Memo (R-5)

**Date:** 2026-08-21 · **Status:** Current

## Posture

Clockwork schedules the user's **own installed Claude Code under their own login**.
It is the same actuator as a user's cron job or CI wrapper running `claude -p`; no
auth material is created, stored, proxied, or scraped by Clockwork. The daemon holds
a pointer only; the runner child inherits nothing but a sanitized environment and
reads credentials from the same stores interactive `claude` uses (keychain /
`~/.claude/.credentials.json`).

## Verified facts (T-001/T-004/T-008)

- Headless `-p --output-format stream-json` works on subscription login, no API key (T-001 real run).
- Absent/expired auth is programmatically detectable (`authentication_failed`) → `failed:auth`
  with an actionable "Open Claude Code and re-login" notification (S-40).
- Sandboxed runs authenticate via keychain with scoped state writes (T-008).

## Remaining ToS considerations (honest list)

1. Anthropic restricting automated/headless use of subscription accounts generally
   would degrade the default engine. Mitigations: usage stays within the user's own
   plan limits by construction; SDK/API-key engine is the documented fallback lane;
   posture re-checked at every contract-matrix re-run.
2. No auth scraping ever: we never read token files ourselves, never pass tokens
   between processes, never log credential paths.

## Expiry UX (daemon context, no TTY)

Pre-flight auth probe at run start (cheap `-p "ok"` probe or doctor call) → on
`authentication_failed`: run fails fast at `preparing`, OS notification fires, task
auto-pauses after 2 consecutive failures (S-40 rule), inbox item explains exactly how
to fix. Mid-run expiry maps to `failed:auth` via the error taxonomy.

## SDK option posture

API-key users may select the SDK engine (M1 opt-in after T-212 integration). Billing,
rate limits, and capabilities then follow the API key; the capability matrix drives
UI degradation per engine either way.
