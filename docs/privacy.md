# Clockwork Privacy Policy

*Effective: 2026-08-24 · Version 1.0*

Clockwork is **local-first**. This policy explains exactly what happens to
data when you use it.

## What Clockwork stores, and where

| Data | Where it lives | Who can see it |
|---|---|---|
| Tasks, schedules, profiles | `~/.clockwork/clockwork.sqlite` (your Mac) | You |
| Run history, reports, transcripts | `~/.clockwork/runs/` (your Mac) | You |
| Provider API keys | macOS Keychain (`clockwork-byok-*` entries) | Your user account only |
| Daemon auth token | `~/.clockwork/api-token` (your Mac) | Local processes you run |

## What leaves your machine

Only two categories of data ever leave your Mac:

1. **Prompts and context you schedule**, sent to the AI provider you chose for
   that task (Anthropic, OpenAI, a self-hosted endpoint, etc.). That provider's
   privacy policy then applies to your prompts. Choose providers accordingly —
   self-hosted endpoints keep prompts fully on-premises.
2. **Delivery payloads you configure**: run-report notifications sent to
   Telegram chats or webhook URLs you explicitly set up.

## What we collect

**Nothing.** The authors operate no telemetry, analytics, crash reporting, or
phone-home service. The daemon listens only on `127.0.0.1` and makes no
connections to infrastructure controlled by the authors.

## AI provider keys

API keys you enter are written directly to your macOS Keychain by the Clockwork
daemon and read back only at run start. They are never stored in the database,
log files, or task payloads, and never transmitted anywhere except to the
provider endpoint you configured.

## Cloud execution

If/when cloud execution targets ship, this policy will be updated before the
feature ships to describe exactly what is sent where. No cloud execution
occurs in the current version.

## Contact

Questions about this policy: open an issue on the repository.
