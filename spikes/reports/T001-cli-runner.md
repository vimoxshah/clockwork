# T-001 — CLI runner PoC report

- Date: 2026-08-21T17:26:06.101Z
- Engine: claude CLI 2.1.238 (Claude Code), subscription login, no API key
- Wall time: 48783ms, cost: $0.9162, turns: 10

| Check | Result | Detail |
|---|---|---|
| claude CLI present | PASS | 2.1.238 (Claude Code) |
| headless run completes on subscription login (no API key) | PASS | exit=0 wallMs=48783 lastError=undefined stderr= |
| per-event usage telemetry granularity | PASS | 10 assistant-usage events; final cumulative cost=$0.9162, turns=10 |
| structured summary extraction (result event) | PASS | summary: Done. Added a JSDoc block to `add` in `calc.ts:1-7` and committed it as `6a0134b docs: jsdoc for add` on `clockwork/spike/t001`. Working tree is clean.

```ts
/**
 * Returns the sum of two numbers.
 * |
| worktree mutation contained (commit landed in worktree branch) | PASS | 6a0134b docs: jsdoc for add |
| session id captured for resume | PASS | 3d004f08-135b-4191-9f5b-1424aef728bd |

## Raw event types seen

```
["system","nonjson","rate_limit_event"]
```

## Usage timeline (per assistant event)

```json
[
  {
    "t": 10736,
    "input_tokens": 2,
    "cache_creation_input_tokens": 59506,
    "cache_read_input_tokens": 0,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 59506
    },
    "output_tokens": 1,
    "service_tier": "standard",
    "inference_geo": "not_available"
  },
  {
    "t": 12977,
    "input_tokens": 2,
    "cache_creation_input_tokens": 59506,
    "cache_read_input_tokens": 0,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 59506
    },
    "output_tokens": 1,
    "service_tier": "standard",
    "inference_geo": "not_available"
  },
  {
    "t": 18746,
    "input_tokens": 2,
    "cache_creation_input_tokens": 6930,
    "cache_read_input_tokens": 59506,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 6930
    },
    "output_tokens": 3,
    "service_tier": "standard",
    "inference_geo": "not_available"
  },
  {
    "t": 22128,
    "input_tokens": 2,
    "cache_creation_input_tokens": 6930,
    "cache_read_input_tokens": 59506,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 6930
    },
    "output_tokens": 3,
    "service_tier": "standard",
    "inference_geo": "not_available"
  },
  {
    "t": 26512,
    "input_tokens": 2,
    "cache_creation_input_tokens": 1155,
    "cache_read_input_tokens": 66436,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 1155
    },
    "output_tokens": 17,
    "service_tier": "standard",
    "inference_geo": "not_available"
  },
  {
    "t": 29508,
    "input_tokens": 2,
    "cache_creation_input_tokens": 243,
    "cache_read_input_tokens": 67591,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 243
    },
    "output_tokens": 5,
    "service_tier": "standard",
    "inference_geo": "not_available"
  },
  {
    "t": 30100,
    "input_tokens": 2,
    "cache_creation_input_tokens": 243,
    "cache_read_input_tokens": 67591,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 243
    },
    "output_tokens": 5,
    "service_tier": "standard",
    "inference_geo": "not_available"
  },
  {
    "t": 37972,
    "input_tokens": 2,
    "cache_creation_input_tokens": 138,
    "cache_read_input_tokens": 67834,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 138
    },
    "output_tokens": 17,
    "service_tier": "standard",
    "inference_geo": "not_available"
  },
  {
    "t": 41765,
    "input_tokens": 2,
    "cache_creation_input_tokens": 167,
    "cache_read_input_tokens": 67972,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 0,
      "ephemeral_1h_input_tokens": 167
    },
    "output_tokens": 16,
    "service_tier": "standard",
    "inference_geo": "not_available"
  },
  {
    "t": 46972,
    "input_tokens": 2,
   
```
