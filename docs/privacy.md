# Privacy

**No Clockwork-hosted cloud. No Clockwork account. Local-first.**

Your data lives in `~/.clockwork/` on your machine. We can't read it, and
there's no server to breach.

## Where data goes when a run happens

1. **Anthropic** — the prompt, attached context, and repo content the agent
   reads are processed by Anthropic's API under your own login/API key. This is
   inherent to running an agent; it's the same flow as your interactive Claude
   Code sessions.
2. **Deliveries you configure** — if you set up Telegram, a webhook, or email,
   run reports go there. Nothing is delivered anywhere by default except local
   OS notifications.
3. **Update checks** — disabled by default in engineering builds.

We never claim "code never leaves your machine." The honest claim: **data goes
only where you pointed it.**

## What we collect

Nothing in engineering builds. Planned beta builds ship consent-screened,
structure-only telemetry (outcome counts, incident flags — never prompts,
paths, or code) so kill-criteria metrics stay observable without reading your
content (VISION §10). GA builds are opt-in.

## Always-on, local-only safety journal

`~/.clockwork/safety-journal.jsonl` records deny-list hits, sandbox violations,
budget hard-stops, and approval decisions. It exists so *you* — and only you —
can audit what runs tried to do. One-click anonymized incident reporting builds
on it from first beta.
