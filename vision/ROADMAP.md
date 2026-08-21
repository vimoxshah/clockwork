# Clockwork — Roadmap

Three horizons. Each horizon has a **theme**, its **shipping milestones**, and an **exit criterion** — the measurable state that unlocks the next horizon. Dates assume 1 senior engineer + heavy AI-assisted development from 2026-08; a second engineer compresses calendar time ~35–40%. *(Re-baselined after adversarial review round 1 — the original 16–18-week v1 was arithmetic fiction; see `reviews/codex-sol-review-round1.md` #29/#30.)*

---

## Horizon 1 — The personal agent calendar (months 0–8, macOS-first, subscription-native)

**Theme: make one developer trust unattended agent work enough to rely on it.**

| Milestone | Contents | Target (1 eng) |
|---|---|---|
| **M-1 — Evidence sprint (overlaps M0)** | 15 target-persona interviews + landing-page smoke test. Evidence bar: ≥40% of interviewees describe a recurring job they'd schedule this week; ≥5% smoke-test conversion to waitlist-with-use-case. | Weeks 1–2 |
| **M0 — Spike (go/no-go)** | **CLI-engine PoC (`claude -p`, subscription login, no API key)**: worktree → run → Run Report. Kill/timeout/cost-cap proven. HITL mechanics decided per engine (T-003). Auth posture memo (T-006). Engine contract matrix v1 (T-007). Sandbox + **profile skill-loading** PoCs (T-008/T-009). | Weeks 1–2.5 |
| **M1 — Private alpha** | Daemon + SQLite + occurrence-ledger scheduler (DST-safe). Calendar UI. Composer v1 **with agent profiles (3 built-ins, @mention)**. Inbox + reports **with FTS search**. OS notifications. **OS sandbox containment + runner env hygiene (gate blocker — no external user before this).** Keep-awake window. macOS only. | Week 15 |
| **M2 — Public beta** | HITL approve/deny/answer (keep-alive model). **Profile editor + custom profiles. ⌘K command palette. Telegram delivery. SDK engine option.** Linear chaining. Templates. Crash-safe recovery hardening. Signed DMG + auto-update. Safety journal + incident reporting. License finalized. | Weeks 22–24 |
| **M3 — v1 launch** | **WhatsApp-gateway + generic webhook + email delivery. Clockwork Mini desktop widget.** Auto-PR. Template/profile import/export. URL/MCP context (flagged). Capacity assistant **only if** precision bar met, else cut. Docs + 10 canonical templates. Launch. | Weeks 29–35 |

**Exit criteria:** 1,000 weekly-active schedulers · ≥40% of runs from recurring jobs · ≥20% of 200+ cohort users still have a live recurring job at day 30 · zero containment escapes · Phase −1 evidence bar met before Phase 1 spend.

**Explicitly deferred out of H1:** **Windows + Linux + native WidgetKit (first post-v1 releases, ~+4–5 weeks)**, teams/multi-user, cloud anything, mobile, non-Claude agents, marketplace.

---

## Horizon 2 — The team's agent workforce (months 8–15)

**Theme: from personal habit to shared operating rhythm.**

- **Shared template library** — org-scoped, versioned templates; "install the team's nightly-triage pack."
- **Audit log** — per-repo, per-user run history; exportable; the compliance answer.
- **Remote approvals relay (optional cloud)** — E2E-encrypted push of approval requests to phone/web; the *only* cloud component, opt-in, no code or transcripts transit it. **Cloud-free alternative:** chat-based approvals through the user's own gateway bridge (Hermes/OpenClaw-style) — inbound "approve"/"deny" replies POST back to the daemon via the same gateway contract delivery uses (arch §6).
- **Multi-machine awareness** — laptop + always-on Mac mini/homelab register as "workers"; jobs pin to a machine or float. *(Also the structural answer to the sleeping-laptop constraint — overnight jobs run on the always-on worker.)*
- **Windows + Linux GA hardening** — promoted from post-v1 releases to fully supported platforms.
- **Non-code task packs** — research digests, report generation, inbox triage via MCP connectors; opens the PM/ops persona.
- **Priorities & quotas** — per-job priority classes; per-person/per-team capacity budgets.

**Exit criteria:** 50 paying teams · ≥30% of approvals answered from mobile · template packs shared inside ≥20 orgs.

---

## Horizon 3 — The workforce OS (months 15+)

**Theme: the calendar becomes the management plane for agent labor.**

- **Multi-vendor runners** — Codex, Gemini CLI collectors behind the same Runner interface; per-job vendor choice.
- **Cost/quality routing** — "cheapest agent that passes this job's eval suite"; per-template eval harnesses.
- **Delegation policies** — codified trust: "anything under $2, no prod access, test-passing → runs unattended; else HITL."
- **Org capacity planning** — forecast agent-hours, budget burn, per-team allocation; the CFO view.
- **Compliance-grade audit** — signed run provenance, retention policies, SIEM export.

**Exit criterion (aspiration):** Clockwork is the system of record for "what did our agents do last quarter."

---

## Sequencing rationale

0. **Evidence before build** — Phase −1's interview + smoke-test bar gates Phase 1 spend; four months of engineering on an unvalidated wedge is the most expensive possible way to learn nobody wants it.
1. **Trust before scale** — OS-sandbox containment, HITL, budgets, and isolation ship *before any external user touches it*; one destructive unattended run in beta kills the category locally.
2. **Habit before monetization** — the recurring-job habit (H1 exit metric) is the retention engine; pricing lands with H2 team features, not on solo devs during trust-building.
3. **Local before cloud** — every H1 feature works offline; cloud enters only where physics demands it (phone approvals), scoped to metadata.
4. **One vendor before many** — the Runner interface is designed multi-vendor from day 0 (see DECISIONS ADR-007) but only Claude is implemented until the loop is loved. Breadth before depth is how AgentCalendar stayed shallow.
