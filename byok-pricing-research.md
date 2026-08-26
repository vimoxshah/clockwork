# Clockwork Pricing Research — BYOK Developer/Desktop AI Tools
*Researched 2026-08-26. Every fact tagged VERIFIED (official page fetched, URL given) or INFERENCE (my synthesis). Third-party tracker figures are marked TRACKER where the official page didn't confirm the number.*

## 1. Per-product table

| Product | Price | Model | What's gated | BYOK vs bundled AI treatment |
|---|---|---|---|---|
| **TypingMind** | Standard/Extended/Premium tiers, all **one-time**; Premium shown at **$99** (50% off $198 list); Bulk license $395/10 users; Teams from ~$4/seat/mo (~$7k/yr custom contracts per tracker) | **One-time** (+ recurring cloud-sync add-on ~$10/mo per tracker) | Ads removal & basic chat (Standard); web search, image gen, vision, docs (Extended); multi-model chats, plugins, projects/folders (Premium). VERIFIED tier structure, feature split, "All plans are one-time payments… Price does not include API costs": https://www.typingmind.com/buy ; https://docs.typingmind.com/quickstart/typingmind-license-plans | **Pure BYOK is the product.** Users pay providers directly per token; no bundled tokens ever. VERIFIED |
| **BoltAI** | Tiers Essential/Pro/Pro+/Team, all **one-time perpetual**; official FAQ cites Essential **$79**, 1 yr updates included, renewals at 40% off; **Team Perpetual $99/seat** (5-seat min), optional $79/seat/yr renewal. Third-party trackers conflict on Pro-tier numbers ($99–$199 list, frequent promos) — TRACKER only | **One-time** w/ paid optional update renewals | Trial is limited (no vision, agents, MCP, code exec, projects); Pro unlocks agents, workflows, MCP tools, code interpreter, doc Q&A. Cloud Sync/mobile/new updates require renewal after year 1. VERIFIED structure + gating: https://boltai.com/pricing | Pure BYOK ("you pay API providers separately" — trackers); no bundled tokens. VERIFIED model, INFERENCE on wording |
| **LM Studio** | Desktop app **$0** (free for personal AND commercial use since Jul 2025); **Enterprise = contact sales** (SSO, model/MCP gating, private collab). New "Bionic" pay-as-you-go cloud inference + upcoming "Bionic Pass" on pricing page | **Free app**; monetize teams/enterprise + metered cloud | Nothing in the local app is gated; money is in org features (SSO, gating) and hosted inference. VERIFIED: https://lmstudio.ai/blog/free-for-work ; https://lmstudio.ai/pricing | Local models = user's hardware, zero cost; optional first-party cloud inference sold per-token (ZDR). BYOD (bring-your-own-device-compute). VERIFIED |
| **Cherry Studio** | **$0**, open-source (AGPLv3); separate commercial **Enterprise Edition** for private deployment/governance (no public price found) | **Free/OSS** | Nothing; all providers via user keys. VERIFIED free/OSS/BYOK: https://unsubbed.co/tools/cherry-studio ; repo facts: https://vibecrowd.fund/repos/cherryhq--cherry-studio | Pure BYOK; you pay providers directly. VERIFIED |
| **Cursor** | Hobby free; **Individual $20/mo**; Pro+ **$60/mo**; Ultra **$200/mo**; **Teams $40/user/mo**; Enterprise custom (SCIM, audit logs, pooled usage, repo/model/MCP access controls). Annual ≈20% off (tracker) | **Subscription** (usage pools inside) | Agent limits, frontier models, MCPs/skills/hooks, cloud agents gated above Hobby; Teams adds SSO, analytics, privacy mode; Enterprise adds controls. VERIFIED prices/features: https://cursor.com/pricing | Mostly **bundled**: plans include usage pools (Pro=$20, Pro+=$70, Ultra=$400 of API-rate usage per docs). Legacy BYOK still supported but second-class: proprietary Composer models refuse BYOK keys, and a **$0.25/M-token "Cursor Token Fee" applies even when using your own keys**. VERIFIED: https://cursor.com/docs/models-and-pricing ; https://forum.cursor.com/t/composer-2-5-error-this-model-does-not-support-custom-api-keys/163374 ; https://forum.cursor.com/t/on-demande-usage-limit-even-when-using-my-own-api-keys/150219 |
| **Raycast** | Free forever tier; **Pro from $8/mo** (annual; ~$10 monthly per tracker); **Advanced AI add-on** brings Pro+Advanced AI to ~$16/mo (trackers show $16–20 depending on billing); Teams Pro $12/user; Teams+Advanced AI $20/user; Enterprise custom with **BYOK, provider allow-list, SAML/SCIM** | **Subscription** | Core launcher free; Raycast AI + cloud sync are Pro; frontier models are paid add-on; free tier gets ~50 AI msgs (tracker). No non-AI Pro tier offered (VERIFIED FAQ). VERIFIED pages: http://www.raycast.com/pricing ; https://www.raycast.com/pro | **Hybrid**: bundled AI included in sub; BYO-key exists and bypasses Raycast's limits (per changelog-based tracker https://www.getjarvis.eu/research/raycast-ai-facts ); Enterprise markets BYOK + allow-lists as governance. Mixed signal: BYOK at bottom (free) AND top (enterprise) of ladder |
| **Warp** | Free tier explicitly supports BYO key; **Build $20/mo** ($18 annual) = 1,500 credits ≈ **$20 of agent usage at API rates** + reloads; **Max $200/mo** = 12× Build credits; **Business $50/user/mo** (up to 25 seats) incl. BYOK/custom endpoints, SAML SSO; Enterprise custom. Older model was flat request quotas ($15 Pro/2,500 reqs → replaced after backlash) | **Subscription + usage-based credits** | Full agent access, extended cloud agents, indexing above Free. VERIFIED: https://www.warp.dev/pricing ; pivot to credits+BYOK: https://www.warp.dev/blog/warp-new-pricing-flexibility-byok ; quota-change reaction: https://news.ycombinator.com/item?id=45772558 | **BYOK available on ALL individual plans incl. Free** ("flexibility to use Warp's AI or bring their own"); bundled credits priced *at API rates* — i.e., they openly benchmark their margin against raw API cost |
| **AnythingLLM** (extra) | Desktop + self-host Docker **$0** (MIT); Cloud Basic **$50/mo**, Pro $99/mo; new "Pro" sub removes free daily allowance of system-wide Magic features (price unpublished) | **Free/OSS**; paid = managed hosting + convenience caps | Multi-user/sharing needs self-host or cloud; desktop single-user unlimited. Trackers (multiple agree): https://aitoolbox.hk/tools/anythingllm ; https://serchai.com/en/reviews/anythingllm | BYOK throughout; cloud tier is "bring your own LLM API key" too — they charge for hosting, never for tokens |
| **Msty Studio** (extra) | Free capable desktop tier; **Aurum $149/user/yr** OR **Aurum Lifetime $349 one-time**; Teams/Enterprise ~$300/user/yr, 5-seat min, SSO/RBAC/audit | **Hybrid: sells BOTH subscription and lifetime** | Web access, Azure/Bedrock, workflow automation (Turnstiles), Insights gated to Aurum; free keeps chat, agents, RAG, MCP. VERIFIED: https://msty.ai/studio/pricing ; https://msty.ai/resources/blog/msty-studio-free/ | BYOK/local-first; paid tiers unlock enterprise providers + power features, not tokens |

## 2. Synthesis (all INFERENCE unless cited)

**(1) One-time vs subscription prevalence.** The niche splits cleanly by customer: *indie/prosumer BYOK frontends* (TypingMind, BoltAI, Msty) sell **one-time/lifetime licenses** ($39–$349) because their buyers are exactly the people allergic to subscriptions — that's why they're using BYOK at all. *VC-backed platforms* (Cursor, Warp, Raycast) run **subscriptions with usage economics**, because bundled inference creates COGS that must be metered. Open-source players (LM Studio, Cherry Studio, AnythingLLM) keep the app free and monetize **teams/enterprise governance or hosting**. Notably, even the "one-time" vendors leak into recurring: TypingMind charges monthly for cloud sync, BoltAI renews updates at 40%/yr, Msty prices lifetime at 2.3× the yearly sub.

**(2) Typical price points.**
- Individual prosumer: **$39–$99 once** (TypingMind/BoltAI entry→premium) or **$8–$20/mo** (Raycast Pro → Warp Build/Cursor Pro).
- Power-user ceiling: **$60–$200/mo** (Cursor Pro+/Ultra, Warp Max) — always justified by usage volume, never by features alone.
- Teams: **$40–$50/user/mo** with SSO/analytics (Cursor Teams $40, Warp Business $50); indie tools instead do per-seat perpetual ($99/seat BoltAI, $395/10-user TypingMind bulk).
- Governance/enterprise: SSO, SCIM/SAML, RBAC, audit logs, allow-lists, pooled billing = universal Enterprise gate, almost always contact-sales.

**(3) Is BYOK free-tier or paid-tier?** Three patterns coexist: (a) **BYOK *is* the free/product** — TypingMind, Cherry Studio, AnythingLLM, LM Studio treat keys as the default and charge for convenience/features/orgs; (b) **BYOK available everywhere including free** — Warp explicitly offers bring-your-own on Free; (c) **BYOK as escape hatch or enterprise feature** — Raycast lets keys bypass limits but markets BYOK + provider allow-list as an Enterprise capability; Cursor tolerates BYOK but taxes it ($0.25/M token fee even on your own keys) and blocks its own models. Consensus: nobody charges *for the right to use your own key* except via friction (Cursor's token fee); charging for orchestration value around the key is the accepted pattern. That validates Clockwork's core premise.

**(4) Willingness-to-pay signals.**
- TypingMind claims **20,641+ customers** paying $39–$198 once (VERIFIED claim on their page; number self-reported).
- Cursor sustains **$200/mo Ultra** and **$40/user/mo Teams** — developers demonstrably pay 5–10× a ChatGPT sub when agent leverage is real (their own copy: "We recommend Pro+ for daily agent users, and Ultra for agent power users").
- Warp's repeated repricing (flat quotas → credit packs at API rates) shows heavy users hit ceilings and accept usage billing, but HN backlash to losing grandfathered value shows churn risk on regressive changes.
- BoltAI/Msty selling **lifetime at $99–$349** proves a cash-up-front prosumer segment exists on macOS specifically.
- Recurring revenue is extracted via *retention features*: sync, history, analytics, updates — not via locking the key.
- Enterprise gates (SSO/audit/pooled spend) are identical across Cursor/Warp/LM Studio/Raycast/Msty → these are table stakes for the top ladder rung, not differentiators.

## 3. Candidate pricing ladders for Clockwork

**Validation of internal draft:** the Free / Pro(advanced orchestration+analytics+retention) / Team(collab+governance) / Enterprise(SSO+controls) shape matches the market exactly — every successful player here uses a free-to-generous base, pays for power features individually, and gates org features at Team, security at Enterprise. Two challenges from the evidence: (1) *cost analytics is your most differentiated feature and no competitor bundles it* — consider whether analytics belongs in Pro rather than partially behind Team, since "spend visibility" is what BYOK users lack today (they see five provider dashboards); (2) *scheduled/agentic work consumes real tokens*, so expect users to ask how Clockwork relates to usage — answer Warp-style: "we never touch your tokens" is a marketing asset; put it in the pricing page copy.

**Ladder A — "Indie prosumer" (matches TypingMind/BoltAI/Msty buyer):**
- **Free**: connect agents, manual runs, basic calendar, 1–2 schedules, local history.
- **Pro — $79 one-time** (or $69 launch): unlimited schedules, advanced orchestration (dependencies/retries), full cost analytics, 90-day retention, approvals.
- **Pro Lifetime — $249**: everything in Pro forever (anchors against $149/yr alternatives; mirrors Msty's $349).
- **Team — $15/user/mo** or $149/user/yr: shared schedule library, roles/approval chains, pooled dashboards, longer retention. (Undercuts Cursor/Warp Teams deliberately: no tokens inside.)
- **Enterprise — custom**: SSO/SCIM, audit logs, policy controls, air-gapped option.
*Risk: one-time starves the roadmap budget; BoltAI's 40% update-renewal and TypingMind's sync add-on show how indies patch this.*

**Ladder B — "SaaS standard" (matches Cursor/Warp/Raycast norms):**
- **Free**: full BYOK loop for a single agent, 2 active schedules, 7-day history — generous enough to be the default recommendation (Warp/Raycast precedent).
- **Pro — $12–16/mo** (annual $10–12): unlimited scheduled agents, orchestration chains, cost analytics + budgets/alerts, approval flows, 1-year retention. Priced between Raycast Pro and Cursor Pro because Clockwork bundles zero inference.
- **Team — $25–30/user/mo**: shared workspace, role-based approvals, team cost attribution, admin dashboard, SSO lite. (Below Cursor's $40 since we carry no COGS.)
- **Enterprise — custom**: SAML/SCIM, audit logs, policy engine, self-host/inference-endpoint allow-listing (copy Raycast's "provider allow-list" framing).
*Safest for a VC-track company; matches category expectations; predictable revenue.*

**Ladder C — Hybrid (recommended starting point):**
- **Free**: as B, plus read-only cost dashboard across connected providers (hook users with the unique feature).
- **Pro — $99/yr** (~$8/mo): everything operational — unlimited schedules, orchestration, analytics, alerts, retention. Deliberately cheap: our users' biggest bill is Anthropic/OpenAI; we win by being a rounding error next to it (TypingMind's $39 anchor proves low-ticket works when the user already pays providers).
- **Lifetime toggle — $299** for Pro (capture the one-time segment; Msty precedent).
- **Team — $120/user/yr** ($10/user/mo): collaboration, governance, shared approval queues, cost attribution by project.
- **Enterprise — custom**: SSO/controls/compliance.
*Grounded in: indie one-time tolerance ($39–$349 range, VERIFIED across TypingMind/BoltAI/Msty) + sub norms ($8–20/mo individual, $40–50/user/mo teams with heavier bundles) + the fact that Clockwork has no inference COGS so it can undercut Cursor/Warp teams while keeping gross margin near 100%.*

## Sources
- TypingMind pricing (fetched): https://www.typingmind.com/buy
- TypingMind plans doc (fetched): https://docs.typingmind.com/quickstart/typingmind-license-plans
- BoltAI pricing (fetched): https://boltai.com/pricing
- LM Studio free-for-work announcement: https://lmstudio.ai/blog/free-for-work
- LM Studio pricing (Bionic/pass): https://lmstudio.ai/pricing
- Cherry Studio overview: https://unsubbed.co/tools/cherry-studio
- Cherry Studio repo stats: https://vibecrowd.fund/repos/cherryhq--cherry-studio
- Cursor pricing (fetched): https://cursor.com/pricing
- Cursor usage pools: https://cursor.com/docs/models-and-pricing
- Cursor BYOK restrictions (team response): https://forum.cursor.com/t/composer-2-5-error-this-model-does-not-support-custom-api-keys/163374
- Cursor BYOK token fee: https://forum.cursor.com/t/on-demande-usage-limit-even-when-using-my-own-api-keys/150219
- Raycast pricing (fetched): http://www.raycast.com/pricing ; https://www.raycast.com/pro
- Raycast BYOK/limits tracker: https://www.getjarvis.eu/research/raycast-ai-facts
- Raycast plan prices tracker: https://outmano.com/tools/raycast/pricing ; https://toolradar.com/tools/raycast/pricing
- Warp pricing (fetched): https://www.warp.dev/pricing
- Warp Build/BYOK announcement: https://www.warp.dev/blog/warp-new-pricing-flexibility-byok
- Warp repricing discussion: https://news.ycombinator.com/item?id=45772558
- AnythingLLM pricing trackers: https://aitoolbox.hk/tools/anythingllm ; https://serchai.com/en/reviews/anythingllm
- Msty pricing (fetched): https://msty.ai/studio/pricing ; free-tier blog: https://msty.ai/resources/blog/msty-studio-free/
