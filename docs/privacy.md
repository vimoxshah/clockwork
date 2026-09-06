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

### From the app: nothing

**Nothing.** The authors operate no telemetry, analytics, crash reporting, or
phone-home service. The daemon listens only on `127.0.0.1` and makes no
connections to infrastructure controlled by the authors. Installing and running
Clockwork sends us nothing, ever — there is no opt-out because there is nothing
to opt out of.

### From the website: your email, only if you type it in

The marketing site has one optional field: a release-notes signup. If you enter
an address and press the button, we store **that address and the time you
submitted it**, and nothing else — no IP address, no user agent, no referrer, no
cookie, no analytics script on any page.

We use it to send release notes. We do not sell it, share it, or send anything
else to it. To be removed, email
[vmoksh.shah179@gmail.com](mailto:vmoksh.shah179@gmail.com) and it is deleted.

This is a website form, not app telemetry. The two are separate on purpose: the
app's promise above is unconditional.

## AI provider keys

API keys you enter are written directly to your macOS Keychain by the Clockwork
daemon and read back only at run start. They are never stored in the database,
log files, or task payloads, and never transmitted anywhere except to the
provider endpoint you configured.

## Purchasing a Clockwork plan (licensing)

Clockwork plans (Free / Pro / Team) are sold through **Lemon Squeezy**, a
merchant of record. When you buy:

- **What Lemon Squeezy receives**: your email and payment details, for
  checkout, tax handling, and invoices — under their privacy policy. Clockwork's
  authors never see card numbers.
- **What we send back to you**: a signed license token by email.
- **What the app does with it**: verifies the signature locally against a
  public key embedded in the binary and caches the result in
  `~/.clockwork/clockwork.sqlite`. Everyday use requires no connection to us;
  an expired subscription keeps working through a 72-hour offline grace period,
  then the app returns to the Free tier. Your tasks, runs, keys, and history
  are never deleted or reduced by licensing state.

## Cloud execution

If/when cloud execution targets ship, this policy will be updated before the
feature ships to describe exactly what is sent where. No cloud execution
occurs in the current version.

## Contact

Questions about this policy, a data request, or anything else:
**vmoksh.shah179@gmail.com**

You can also open an issue directly on the main repository — it's public:
https://github.com/vimoxshah/clockwork/issues

(The Homebrew tap has its own tracker too, for install-specific issues:
https://github.com/vimoxshah/homebrew-clockwork/issues)
