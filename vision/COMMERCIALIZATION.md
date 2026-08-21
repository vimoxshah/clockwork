# Clockwork — Commercialization Analysis

*Added 2026-07-16, answering: can we commercialize this, why will people pay, and what value are we adding? Companion to `../plan/06-risks-and-costs.md` §4 (which stays the raw math; this is the argument).*

## TL;DR verdict

**Yes — commercializable, with eyes open.** The buyer logic is sound: Clockwork converts a subscription people *already pay for* into completed work while they're not looking, and charges ~10% of that subscription for the conversion. The honest caveats: the paying market is forming (not formed), the durable revenue is the **Team tier (H2)**, not solo Pro subscriptions, and the whole commercial case rests on one retention metric — recurring jobs that stay alive. This is a "ride the category as it forms" bet with strong unit economics, not a fast revenue machine.

---

## 1. The value we add (what the customer actually buys)

### a) Time arbitrage on money already spent — the headline value
A Claude Max subscriber pays **$100–200/month** and typically uses a fraction of their capacity windows (the idle 2am–8am block alone is ~25% of the week). Clockwork turns that idle, already-paid capacity into finished chores: dependency updates, test triage, TODO digests, changelog drafts, repo health reports.

The ROI arithmetic is almost embarrassing:
- Suppose Clockwork reliably completes **3–5 chores/week** that would each cost the developer 20–40 minutes → **4–10 hours/month** returned.
- At any defensible developer hour value ($50–150), that's **$200–1,500/month of recovered time for $15/month.**
- The pitch in one line: **"Your $200 subscription now works the night shift."**

### b) Not-having-to-build-it — the substitution value
The free alternative is real: a power user can cron `claude -p` today. What they cannot get without weeks of engineering (and ongoing maintenance): OS-sandboxed containment, worktree isolation, occurrence-ledger scheduling that survives sleep/DST/crashes, HITL approvals with held runners, a searchable report inbox, agent profiles with per-run skill loading, chat delivery, budgets and safety journals. **People pay to not own a scheduler-daemon.** (Compare: everyone *could* rsync to S3; they buy Backblaze.)

### c) Trust as a product — the risk value
Unattended agents are scary, and fear is what keeps this delegation from happening today. The sandbox, budget bounds, branch-never-main outputs, approval gates, and audit trail are the actual product for many buyers — the same way people pay for password managers not because storing text is hard, but because getting it wrong is expensive. **We monetize the confidence, not the cron.**

### d) The habit/switching-cost value (compounds over time)
Once a user has 5+ recurring jobs, tuned profiles, and a searchable history of accepted outcomes, Clockwork is their delegation operating system. Churn requires re-plumbing a working routine. This is the moat that makes subscription pricing defensible — and it's exactly the R-13 retention metric: **the commercial thesis and the kill criterion are the same number.**

### e) For teams (H2) — governance, the real ACV
Individuals buy time; **organizations buy control.** Shared profile/template libraries ("our nightly-triage pack"), who-ran-what audit logs, chat-based approvals, quotas and delegation policies. This is where $30/user/month is normal money and where the durable business lives — the solo tier is the wedge and the funnel, not the endgame.

## 2. Who pays — the ladder

| Tier | Who | Why they pay | Price |
|---|---|---|---|
| **Free** (source-available core, 3 active recurring jobs) | hobbyists, evaluators, DIYers | they don't — they're distribution, community, and trust (a closed daemon running agents on your machine fails the HN test) | $0 |
| **Pro** | solo devs & indie hackers on Max plans; consultants running many client repos | the §1a–§1d stack; the 3-job cap bites exactly when the habit forms | $15/mo |
| **Team** (H2) | 5–50-person eng teams already standardized on Claude | governance + shared practice + audit + chat approvals | $30/user/mo |
| Later options | profile/skill-pack marketplace take-rate; always-on "worker" licensing (H2 multi-machine) | optional upside, not load-bearing | — |

## 3. Honest counter-arguments (and our answers)

1. **"Anthropic will ship scheduling natively" (R-1).** Likely, eventually. Then the paid value shifts to what a platform vendor historically leaves to the ecosystem: cross-repo/multi-machine orchestration, team governance, chat-gateway delivery, profiles-as-shared-practice. Scheduling gets commoditized; the *management plane* doesn't. Speed matters: own the UX layer before the primitive ships.
2. **"Power users will DIY from the source-available core."** Yes — and they were never buyers. n8n, Sentry, Obsidian all prove the pattern: the free core builds the funnel; convenience, governance, and support convert the rest.
3. **"The retention risk (R-13) undermines subscriptions."** Correct — this is *the* commercial risk, bigger than competition. Mitigation is product, not pricing: bundled skills good enough that jobs keep producing accepted outcomes, and the north-star metric (accepted outcomes/user/week) watched from beta.
4. **"Market size?"** The wedge audience (Claude subscribers with active repos) is in the hundreds of thousands and growing with the category. We need thousands of Pro seats, not millions — an attach-rate problem, not a TAM problem. The real unknown is timing, which is what Phase −1's evidence sprint prices at ~$4k instead of $130k.

## 4. Revenue scenarios (gross, illustrative — not a financial model)

| Scenario | Assumptions | ARR |
|---|---|---|
| **Floor** (H1 exit only) | 1,000 WAU × 10% Pro conversion | ~$18k — hobby income; insufficient alone → why H2 exists |
| **Base** (12–18 mo post-launch) | 10k WAU × 12% Pro + 150 teams × avg 8 seats | ~$650k |
| **Category-win** | 40k WAU × 15% Pro + 800 teams × avg 10 seats | ~$4M |

Break-even on the ~$132k build ≈ **740 Pro-seat-years** — reachable in the Base case's first year. COGS stay ~zero (runs bill to the user's own subscription/key; no Clockwork cloud in H1), so gross margin is software-typical from day one.

## 5. What must be true (checkpoints already wired into the plan)

1. Phase −1 evidence bar met — people describe a job they'd schedule *this week* (gate G-1).
2. 30-day recurring-job survival ≥20% in beta (kill criterion / R-13 tripwire).
3. Zero containment escapes — trust incidents kill the category locally before pricing ever matters.
4. H1 stays unmonetized; pricing lands with H2 team features (payments/licensing/support are budgeted H2 scope, ~50–65 ed — see `06` §2).
5. Accepted-outcomes/user/week trends up across beta cohorts — the number a future investor or acquirer would ask for first. (Exit optionality — dev-tools acquirers, ecosystem consolidation — exists but is not the plan.)

**Bottom line:** the product earns its price by converting idle, already-paid AI capacity into finished work inside a safety envelope users couldn't cheaply build — and the business compounds where habit (solo) turns into governance (team).
