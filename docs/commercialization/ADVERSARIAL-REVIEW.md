# Adversarial review — commercial gauntlet §51 (2026-08-26)

Reviewer lenses walked against PR #2 state (branch @ 66ce2aa):

## First-time user
- Install -> welcome gate explains awake-Mac reality + provider options. "Connect a provider"
  routes to Settings (hash bug found here and fixed: '#settings' -> '#/settings').
- Add flow: provider cards are self-explanatory; key field visible immediately with
  keychain explanation; model names human ("DeepSeek Chat"); test-before-save prevents
  broken configs. VERDICT: would understand, would succeed.

## BYOK power user
- Custom model IDs available via selector footer; base URL + connection naming under
  Advanced for openrouter/custom; env-var mode still honored by backend (UI surfaces
  keychain mode; env remains API-compatible). Multiple connections supported, default is
  explicit per task — nothing silently switches (§24 copy fixed this session).
- Gap noted: no favorites/recents in ModelSelector yet (registry is curated ~15 models;
  search + badges cover scale to 100). Deferred with rationale.

## Paying Pro customer
- Plan & License card states plan, expiry, and what each tier includes from the app's own
  registry. Activation explains local verification. VERDICT: knows what they pay for.

## Expired / offline user
- Grace state copy says plainly: everything keeps working during grace, reconnect to
  confirm. Past grace: free tier, data untouched. No dark patterns.

## Security engineer
- Secret scan of full branch diff: no credential-shaped strings (only research prose);
  keys keychain-only; bundle endpoint never reads secrets; 402s carry feature metadata,
  never tokens; fail-closed entitlements until real key ships.

## Skeptical reviewer / buyer
- Landing pricing now shows real numbers ($99/yr Pro) with honest "launching soon" note;
  no fake checkout buttons; capability matrix generated from code, cannot drift.
- Remaining honesty gap (tracked): checkout itself awaits Lemon Squeezy approval — the
  product correctly refuses fake payment paths today.

## Support engineer
- Export diagnostics produces a sanitized JSON (no credentials by construction); friendly
  error mapping covers 401/429/quota/404/5xx/network classes; docs/byok-guide.md has the
  recovery table.

## Material issues found this pass: 2 (composer default copy, onboarding hash) — both fixed.
## Open items: LS approval (user), webhook minter, visual QA when vision returns.
