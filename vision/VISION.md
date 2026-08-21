# Clockwork — Vision

> **The calendar where your agents show up for work.**

## 1. The thesis

Coding agents crossed a threshold: they can complete meaningful, multi-step work unattended. But the interaction model is still **synchronous babysitting** — you open a terminal, type a prompt, and watch. The result: agents work only when *you* work, your subscription capacity idles 18+ hours a day, and every recurring chore (test triage, dependency updates, digests, reviews) is re-typed by hand or buried in per-repo CI plumbing.

The missing primitive is **time**. Humans coordinate work through calendars; agents have no equivalent. Whoever gives agents a calendar turns them from a tool you *operate* into a workforce you *manage*.

**Clockwork's bet:** the next interface for agents is not a better chat window — it's a **booking system**. You schedule an agent the way you book a contractor: define the job, attach the context, set the budget, pick the time. The work happens without you. The results come to you.

## 2. The core loop

**Book → Run → Review → Repeat.**

1. **Book** — click a calendar slot → task composer: pick an **agent profile** (a named persona — "Dep Surgeon", "Docs Scribe" — carrying its skill set, model, permissions, and budget defaults; or just `@mention` it in the prompt), then the prompt, working directory/repo, attached context (files, URLs, MCP servers, prior-run outputs), budget caps (max spend / turns / wall-clock), one-off or recurring (RRULE).
2. **Run** — a local daemon fires the task at the scheduled time through **your own installed Claude Code, headless** (`claude -p`, riding your existing subscription login — no API key; the Agent SDK is an opt-in engine for API-key users): OS-sandboxed, isolated git worktree, hard timeout, spend cap, with the booked **agent profile's** skills loaded for that run. Runs happen with the app window closed.
   *Honest constraint:* runs execute **when your machine is awake**. Clockwork keeps the machine awake through a scheduled window when plugged in (and attempts OS scheduled-wake where available), tells you loudly when sleep caused a miss, and makes "run it before I sleep / when I'm back" one click. The unattended-overnight story is real on an always-on machine (desktop, mini, homelab) — H2's multi-machine workers make that first-class. We market what's true.
3. **Review** — every run files a structured **Run Report** (summary, diff/PR link, artifacts, transcript, cost) into a **searchable** results inbox, and delivers wherever you live: OS notification, Telegram, WhatsApp (via your gateway), webhook (Slack/Discord/anything), or the desktop widget. Runs that hit a decision point don't fail — they **pause and file an approval request**.
4. **Repeat** — save as template, chain tasks (B consumes A's output; B runs only if A succeeded), let capacity-aware scheduling shift flexible jobs into idle subscription windows.

## 3. Who it's for

| Persona | Situation | What Clockwork gives them |
|---|---|---|
| **Solo developer / indie hacker** | Pays for Claude Max, uses ~30% of capacity, drowns in repo chores | Overnight workforce: wake up to triaged issues, updated deps, a draft PR. Zero infra. |
| **Tech lead on a small team** | Recurring hygiene (flaky tests, drift checks, release notes) eats senior time | A shared library of scheduled jobs; results land in the team's chat (Telegram, WhatsApp, Slack-via-webhook); approvals instead of interruptions |
| **Staff/platform engineer** | Already hand-rolls `claude -p` in cron/CI per repo | One pane of glass across all repos, with HITL, budgets, and an audit trail CI never gives |
| **AI-forward PM / ops person** (H2) | Wants recurring digests, research, report generation without engineering help | Templates + non-code tasks; the calendar metaphor requires no terminal literacy |

Primary wedge persona: **the solo developer on a Claude subscription.** Cheapest to reach, feels the capacity-waste pain daily, tolerates v1 rough edges, evangelizes in public.

## 4. Why now

- **Headless Claude Code exists** — the full harness (tools, MCP, permissions, skills, sessions) is invocable as `claude -p` on the subscription login the user already has, with the Agent SDK as a programmatic alternative. The execution engine is a dependency, not a build — and it requires no new auth from the user.
- **Subscription capacity windows** (5-hour / weekly caps) created a new resource-management problem nobody owns: idle capacity is money already spent, evaporating.
- **Trust tooling matured** — worktrees, permission modes, sandboxing, budget telemetry make unattended runs defensible for the first time.
- **The competition is half-built**: AgentCalendar visualizes *past* sessions (observability-first, scheduling bolted on); Claude Code's cron primitives and claude.ai cloud routines have no calendar, no composer, no local-repo inbox; OpenAI's scheduled tasks are chat-scoped, not repo-scoped; CI cron is per-repo plumbing with no unified view and no HITL. All of them are one roadmap decision away from getting better — speed and UX depth are the only defensible response (risk R-1).

Two premises this plan treats as **hypotheses to verify, not facts** (Phase −1/0 gates): that target users actually want scheduled — not just interactive — agent runs (evidence sprint), and that headless subscription use keeps working as it does today (much narrower than the earlier third-party-SDK-auth worry, since Clockwork drives the user's *own* Claude Code — risk R-5, engine posture memo at T-006).

## 5. Differentiation — the two features that make it *great*

1. **Human-in-the-loop as a calendar-native object.** Approvals, pauses, and "the agent has a question" are first-class items on the calendar and in the inbox — not failures, not buried logs. This is the trust mechanism that makes people delegate real work, and it is the flagship.
2. **Trustworthy unattended execution.** OS-sandboxed runs, worktree isolation, budget bounds, branch-never-main outputs, and reports honest enough to act on. Boring on a slide; decisive in retention.

**Capacity-aware scheduling** remains on the roadmap as an *estimate-grade* assistant (there is no official quota API — the model is heuristic by construction). It ships feature-flagged, labeled as an estimate, and only if it clears a precision bar in beta (risk R-7). It is deliberately no longer positioned as the flagship.

Supporting moats (accrue over time):
- **Profiles + template library** — shareable, versioned agent personas ("Dep Surgeon") and job definitions ("nightly flaky-test triage") become the npm of recurring agent work.
- **Run history corpus** — local, private, and the substrate for "this job's cost is trending up 40%" intelligence nobody else can offer.
- **Local-first, no Clockwork cloud** — data flows only to Anthropic's API and deliveries you explicitly configure (Telegram, your WhatsApp gateway, webhooks, SMTP); nothing transits Clockwork-hosted infrastructure, and there is no Clockwork account.

## 6. What Clockwork is NOT

- **Not an agent framework.** We write zero agent-loop code; headless Claude Code (default) or the Agent SDK (option) is the engine. We are the *scheduling, isolation, and review layer* around it.
- **Not a CI replacement.** CI reacts to code events; Clockwork owns *time-driven* and *human-delegated* work. They compose (a Clockwork job can open the PR that CI then tests).
- **Not a cloud service (in H1).** Local-first is the trust story, the zero-COGS story, and the fastest path to ship. Cloud enters only as an optional relay (H2+), never as a requirement.
- **Not multi-agent-vendor on day one.** Claude-only until the core loop is loved. The runner is an interface so Codex/Gemini become collectors later, not rewrites.

## 7. Where it can go — the horizons

### H1 (months 0–8): The personal agent calendar
Local desktop app, macOS-first, Claude-only, **subscription-native (`claude -p` default engine — no API key)**. Book/Run/Review loop with agent profiles, sandbox containment, recurrence, templates, linear chaining, HITL approvals, searchable inbox + ⌘K, Telegram/WhatsApp-gateway/webhook delivery, desktop mini-widget; capacity assistant only if it clears its precision bar. **Success: 1,000 weekly-active schedulers; ≥40% of runs are recurring jobs; a demonstrably formed "come back to accepted results" habit.**

### H2 (months 8–15): The team's agent workforce
Windows/Linux GA, shared template library, per-repo run audit log, mobile/remote approvals via an optional relay, richer non-code tasks (research digests, report generation), multi-machine awareness (laptop + always-on mini — the structural fix for the sleeping-laptop constraint). **Success: 50 paying teams; approvals answered from a phone; templates shared inside orgs.**

### H3 (months 15+): The workforce OS
The calendar becomes the management plane for a mixed workforce: multiple agent vendors, cost/quality routing ("cheapest agent that passes this job's eval"), delegation policies ("anything under $2 and no-prod-access runs unattended"), org-level capacity planning, compliance-grade audit. The wedge — time — becomes the organizing abstraction for how organizations consume agent labor. **Success: Clockwork is the system of record for "what did our agents do last quarter."**

## 8. Business model (sketch — full math in `plan/06-risks-and-costs.md`)

- **H1 is deliberately unmonetized** — trust and habit first; payments/licensing are unbuilt scope that lands with H2.
- **Free source-available core** (local app, 3 active recurring jobs) — trust + distribution. License stance: FSL-style source-available by default, finalized before first external beta (ADR-009).
- **Pro, $15/user/mo** (from H2) — unlimited jobs, chaining, chat/webhook delivery channels, profile + template import, capacity assistant if it clears its precision bar.
- **Team, $30/user/mo** (H2) — shared libraries, audit log, remote approvals relay, priorities & quotas.
- The structural advantage: **agent runs execute on the user's own Claude subscription (default) or API key (option) — our COGS don't scale with usage.** Margin lives in software, not inference resale. This advantage is as durable as headless subscription use remaining permitted (R-5, now a narrow risk) — posture documented at Phase 0.

## 9. North-star metric

**Accepted outcomes per user per week** — a run whose output the user *acted on*: branch merged / PR opened from it, artifact used, or explicitly marked useful in the inbox. Opens are engagement; acceptance is value. Guardrail metric: **8-week recurring-job survival** (a job still enabled and producing accepted outcomes two months in). Vanity counterparts to avoid: runs scheduled, reports opened.

## 10. Kill criteria (intellectual honesty)

Stop or pivot if, after H1 ships to 200+ users:
- <20% of users have ≥1 recurring job alive after 30 days (no habit → no product, just a demo), or
- Anthropic ships a first-party calendar/inbox with HITL inside Claude Code's surfaces **and** template/trust features stop differentiating within one quarter, or
- containment escapes (a run affecting anything outside its sandbox/worktree) exceed **zero tolerance** — any confirmed escape is a stop-ship until root-caused; broader trust incidents >1 per 1,000 runs across the beta fleet mean the category isn't ready.

Measurement honesty: these require data. Beta builds ship with consent-screened, anonymized telemetry **on by default for beta** (structure-only: outcomes, counts, incident flags — never prompts/paths/code); GA builds are opt-in. A local always-on **safety journal** records sandbox/deny events regardless, and a one-click anonymized incident report exists from first beta.
