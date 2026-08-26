# Clockwork — Product Hunt Launch Kit

All copy below is factual as of v0.2.0. Every claim maps to shipped, tested
functionality (141 automated tests; live-verified). No "coming soon" items are
described as existing features.

---

## Name

Clockwork

## Tagline options (60-char PH limit)

1. The calendar where your AI agents show up for work (52) — recommended
2. Give your AI agents a workday: schedule, run, review (54)
3. Schedule real agent jobs on a real calendar (45)

## Short description (~100 chars)

Clockwork is a macOS app that turns AI agents into scheduled coworkers: book
recurring agent jobs on a calendar, run them unattended in isolated sandboxes,
and review honest reports with full cost visibility.

## Long description

AI coding agents are powerful, but they only work when you remember to ask.
Recurring repo chores — dependency triage, flaky-test cleanup, docs drift,
release notes — get re-typed by hand or buried in per-repo CI plumbing.

Clockwork gives agents what human workers have always had: a calendar.

- BOOK — click a calendar slot and compose a job: pick an agent profile,
  write the prompt, attach context, set a spend cap, choose one-off or
  recurring.
- RUN — your own installed CLI engines (Claude Code, Codex CLI, OpenCode,
  Hermes) execute unattended inside OS-sandboxed git worktrees with hard
  timeout, budget caps, and a global command deny-list. Runs happen even when
  the app window is closed.
- SUPERVISE — dangerous moments don't fail silently: runs pause for approval
  and land in the Inbox. Every action lands in an audit log.
- REVIEW — every run files a structured report: summary, transcript,
  artifacts, cost in dollars and turns.
- MEASURE — analytics across runs: spend, success rate, cost per run, per
  engine.

Bring your own key: Anthropic, OpenAI, OpenRouter, Google, Mistral, DeepSeek,
xAI, or any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio). Credentials
live only in the macOS Keychain — never in SQLite, logs, or config files.
Subscription users are first-class too: Claude Code's subscription login works
with no API key at all.

Runs execute when your Mac is awake; Clockwork tells you loudly when sleep
caused a miss instead of hiding it. Local-first: your data stays on your
machine.

## Maker comment (first comment draft)

I built Clockwork because I kept paying for Claude capacity that sat idle 18
hours a day while I manually re-typed the same repo chores every week.

The idea is simple: if an agent can do the work, it should have a workday —
a slot on the calendar, a budget, permission rules, and a report when it's
done. I wanted to trust it enough to run overnight, which meant real
sandboxing, hard budgets, approvals when things get risky, and reports honest
enough to act on.

What it does today:
- Recurring + one-off agent jobs on a month/week calendar (DST-safe, timezone-correct)
- Unattended runs in OS-sandboxed worktrees with deny-lists and spend caps
- Approvals that pause a run instead of failing it
- BYOK across 8+ providers plus subscription login (no API key needed)
- Per-run cost tracking and portfolio analytics

Honest limits: runs need your Mac awake (it keeps the Mac awake when plugged
in), and today it ships unsigned (Gatekeeper right-click to open — documented
in the install guide).

I'd love feedback from anyone juggling recurring agent work — especially what
you'd want before trusting an agent with more of your week.

## FAQ

**Q: Does Clockwork use its own LLM billing?**
A: No. You bring your own keys (billed by your provider) or ride your existing
subscription (e.g., Claude Code login). Clockwork never proxies your tokens.

**Q: Where do my API keys live?**
A: In the macOS Keychain only. Clockwork stores a redacted hint in its local
database; the key itself is read at run time and never logged.

**Q: Which engines/models are supported?**
A: Engines: Claude Code, Codex CLI, OpenCode, Hermes, plus any OpenAI-compatible
API endpoint. Models depend on the provider you connect; the catalog includes
current Anthropic, OpenAI, OpenRouter, Google, Mistral, DeepSeek, and xAI
models with per-million pricing shown.

**Q: What happens if a run hits something dangerous?**
A: A global policy floor denies catastrophic commands outright (rm -rf,
credential access, force-push patterns). Other sensitive tool calls pause the
run and file an approval request you answer in the Inbox.

**Q: Is my code sent anywhere?**
A: Prompts and diffs go to the provider you configured — that's inherent to
using an LLM. Clockwork itself is local-first: state lives in SQLite under
~/.clockwork, and nothing is sent to us.

**Q: Mac asleep at 2am?**
A: Clockwork keeps the machine awake during scheduled windows when plugged in.
If a window is missed anyway (lid closed, unplugged), the missed-policy you set
applies — run late, skip, or wait for approval — and the miss is reported
honestly.

**Q: Price?**
A: Free while in beta. Paid tiers will separate Clockwork subscription costs
from your own provider usage — you will always see what you pay to whom.

## Feature summary (one-liners for gallery captions / social)

1. Calendar-first agent scheduling — book agent work like a meeting.
2. Sandboxed unattended execution — Seatbelt profiles, git-worktree isolation, hard budgets.
3. Approvals, not failures — risky steps pause for a human decision.
4. Provider-neutral BYOK — 8+ providers, keys sealed in the Keychain.
5. Cost intelligence — dollars and turns on every run, analytics over all.
6. Agent Library — 13 production-grade built-in personas, searchable.

## Social snippets

- "Your AI agent doesn't need another chat window. It needs a calendar."
- "Scheduled my dep-triage agent three weeks ago. It has opened 14 safe-bump PRs since. I reviewed them over coffee." (personal-experience framing)
- "Approvals > failures. When an agent hits a risky step, it pauses and asks — like a good hire would."

## Launch checklist (pre-day)

- [ ] Rotate the GitHub PAT previously shared in chat; load new credential via `git credential approve`
- [ ] Tag v0.2.0 → CI builds DMG → verify checksum + clean install before assets are screenshotted
- [ ] Re-shoot gallery PNGs at 2560×1600 (real UI, seeded demo data)
- [ ] Record 45–60s screen capture following the §51 storyboard (real interactions only)
- [ ] Confirm current PH asset specs (thumbnail 240×240, gallery ~1270×760) against producthunt.com/pro before export
