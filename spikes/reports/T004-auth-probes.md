# T-004 — Auth & error-class probe report

- Date: 2026-08-21T18:09:16.560Z

| Probe | Observed | Detail | Class |
|---|---|---|---|
| Absent auth (empty CLAUDE_CONFIG_DIR) | exit=1 | authentication_failed in stream: true | DETECTABLE |
| Healthy auth | verified at T-001 (real run, exit=0) | — | DETECTABLE (absence of error) |

## Error taxonomy (from observed streams + docs)

| Class | Detection signal (stream-json / exit) |
|---|---|
| auth | result event `error:"authentication_failed"` or "Not logged in"; also pre-flight `claude doctor`-style check possible |
| rate_limited | `rate_limit_event` stream events (observed in T-001 even on success); terminal 429 surfaces in result error text |
| capacity | usage-limit/overload strings ("limit reached", 529 overloaded) |
| offline | ENOTFOUND/ECONNREFUSED/fetch-failed before any API event |
| model_unknown | model-not-found/deprecated strings in result error |
| other/internal | anything else non-zero |

## Not probed here (documented)
- **Expired token**: requires mutating real credentials; not done on dev machine.
  Same detection signal as absent-auth expected (`authentication_failed`) — runner maps both to `failed:auth`.
- **Rate-limit terminal state**: needs a throttled account; `rate_limit_event` type existence verified in T-001 stream.
