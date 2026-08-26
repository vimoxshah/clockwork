# BYOK Guide — Bring Your Own Keys

Clockwork is orchestration-only billing: you connect the AI providers you
already pay, and Clockwork schedules agent work on them. **Clockwork never
bills you for model usage and never sees a raw key after you paste it.**

## How keys are stored

- API keys are written once to your **macOS Keychain** (`clockwork-byok-*`
  service entries) by the local daemon.
- The database keeps only a redacted hint (`••••9A2F`) and metadata — never
  the key. Logs never contain credentials.
- Removing a provider in Settings deletes both the config row and the
  Keychain entry.

## Connecting a provider

Settings → **API providers (BYOK)** → *Connect a provider*:

1. **Choose provider** — Anthropic, OpenAI, Google AI, OpenRouter, DeepSeek,
   xAI, Mistral, Z.ai, or any custom OpenAI-compatible endpoint (Ollama,
   vLLM, LM Studio, enterprise gateways).
2. **Paste your API key** — masked field with show/hide; stored to Keychain.
3. **Choose a model** — searchable selector with friendly names, context
   size, and price-per-million chips. Advanced users can enter any model ID.
4. **Test connection** — one tiny real call verifies key, endpoint, and
   model availability *before* anything is saved.
5. **Save & connect** — only a passing test can be saved. Nothing persists
   if you close the dialog first.

## Default provider

The first connection becomes the default automatically. Use **Set default**
on any card to change it: tasks without an explicit provider run on the
default. Tasks pinned to a specific provider always use that one.

## Errors, decoded

| Symptom | Meaning | Fix |
| --- | --- | --- |
| "API key was rejected" | 401/403 from provider | Re-paste the full key; confirm the right account |
| Rate-limit message | 429 | Wait and re-test; key is fine |
| No billing/quota left | 402 | Add credits in the provider dashboard |
| Endpoint not found | 404 | Check Base URL (usually ends `/v1`) |
| Provider outage | 5xx | Retry shortly |
| Could not reach provider | network/DNS/timeout | Check connectivity, VPN, firewall |

## Subscription logins vs API keys

Anthropic (Claude Code CLI) and OpenAI (Codex CLI) subscription logins are a
separate execution path configured under **CLI engines** — they need no API
key at all. A provider connected here is billed per-token to your API
account, which is separate from any ChatGPT/Claude subscription.

## Security notes

- Bearer-authenticated loopback API; the daemon binds to 127.0.0.1 only.
- Validation calls go directly from your machine to the provider — never
  through Clockwork infrastructure (there is none).
- `security find-generic-password` access requires your session; keys never
  enter backups of the Clockwork data directory.
