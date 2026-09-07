# Clockwork — Task Status Matrix

Machine-readable status per `plan/05-execution-plan.md` task IDs.
Status vocabulary: **DONE · PARTIAL · MISSING · BROKEN · UNKNOWN** (per audit
contract). External-dependency and time-gated items are annotated.

Last updated: 2026-09-07 (delivery pass — Slack and email channels with their
Settings and composer surfaces; T-307's root cause found and FIXED, so the
calendar numbers below are new, not the 2026-09-06 ones)

## Phase −1 — Evidence sprint

| ID | Status | Notes / Evidence |
|---|---|---|
| T-011 | MISSING | Interview infrastructure ready (`evidence/interview-script.md`: script, coding sheet, recruiting channels). 0 of 15 interviews conducted — requires real external participants. |
| T-012 | MISSING | Honest-pitch landing page built (`evidence/landing-page/index.html`, awake-machine constraint included, use-case waitlist form). No traffic driven; form backend needs wiring before launch. |
| T-013 | PARTIAL | Readout template + decision frame + override clause written (`evidence/EVIDENCE-READOUT.md`), status **UNVERIFIED**. G-1 remains unmet; no override recorded. |

## Phase 0 — Engine spike

| ID | Status | Notes / Evidence |
|---|---|---|
| T-001 | DONE | Real headless `claude -p --output-format stream-json` on subscription login: exit 0, 10 usage events, structured summary, session-id capture, worktree containment. `spikes/reports/T001-cli-runner.md` |
| T-002 | DONE | Interruption matrix as permanent tests: SIGTERM/timeout→timed_out/budget→budget_exceeded/turn-stop, group-kill leaves no zombies incl. grandchildren. `packages/runner/test/interrupt-matrix.test.ts` (8 tests) |
| T-003 | DONE | Re-run 2026-09-05 against CLI 2.1.261: `--permission-prompt-tool` now PRESENT and proven by run (tool called, 100s hold honoured inside the sandbox). Keep-alive HITL wired for the CLI engine via a loopback HTTP MCP bridge (ADR-034 supersedes ADR-020). `spikes/reports/T007-engine-contract-matrix-2.1.261.md` |
| T-004 | DONE | Absent-auth probe: `authentication_failed` detectable in stream (exit 1). Error taxonomy documented incl. observed `rate_limit_event`. Expired-token simulation documented as not-probed (requires mutating real creds). `spikes/reports/T004-auth-probes.md` |
| T-005 | DONE | Scheduler micro-PoC became product code with fixture suite: 18 fake-clock tests across America/New_York, Europe/Berlin, Australia/Lord_Howe, UTC; concurrent double-fire attack cannot produce two runs. `packages/daemon/test/scheduler.test.ts` |
| T-006 | DONE | Auth posture memo: own-login actuator, no credential scraping, expiry UX defined, SDK fallback lane. `spikes/reports/T006-auth-posture.md` |
| T-007 | DONE | Engine contract matrix v1 for CLI 2.1.238 with re-run procedure; two load-bearing assumptions corrected (--max-turns absent, permission hook absent) → runtime consequence via ADR-020. `spikes/reports/T007-engine-contract-matrix.md` |
| T-008 | DONE | Seatbelt escape suite **13/13 PASS**: ssh/aws/gnupg/shell-history reads denied; out-of-scope writes denied; symlink traversal denied; git+node+`claude -p` functional inside profile. Keychain-read exception documented. `spikes/reports/T008-sandbox.md` |
| T-009 | DONE | Control/treatment proof: skill materialized into `.claude/skills/` changed run output (CRANBERRY-42); no-skill control declined. `spikes/reports/T009-profile-materialization.md` |

**G0: PASSED** — with the pre-authorized branch exercised (CLI HITL unavailable → M1 fail-safe; SDK engine promoted to M1 for HITL users).

## Phase 1 — M1 private alpha (Track A)

| ID | Status | Notes / Evidence |
|---|---|---|
| T-101 | DONE | pnpm monorepo packages/{shared,runner,daemon,ui} + spikes; eslint flat, vitest workspace, CI workflow boot-smoke. |
| T-102 | PARTIAL | DDL executed verbatim from arch §1 via forward-only migrations, WAL + synchronous=FULL, run-dir layout. Crash-mid-write test (S-34 partial) not yet explicit — recovery tests cover fresh-open paths. |
| T-103 | DONE | Tick loop (30s), next_fire materialization, occurrence-ledger claims in one transaction, missed policies + coalescing, overlap skip/queue, COUNT-exhaustion auto-disable, wall-clock-only comparisons. Wake catch-up satisfied by tick cadence within NFR-1's 120s (OS wake-event subscription = later optimization). Keep-awake assertions armed per-run when plugged in. 18 fixtures green. |
| T-104 | DONE | FSM with legal-transition enforcement; global semaphore (2); repo mutex; queue FIFO by scheduled_for; single-instance lockfile+port probe; recovery sweep S-30/S-31/S-81 green incl. REAL orphan process termination. |
| T-105 | DONE | REAL-ENGINE E2E VERIFIED LIVE (2026-08-22): daemon→ledger tick→child→claude -p→completed report -e.376/1 turn→FTS searchable. USER/LOGNAME env requirement for keychain ACL discovered + fixed. AgentRunner seam + ClaudeCliRunner (stream parser tolerant to unknown events, budget guard soft-cap w/ overshoot measurement, hard turn/time caps enforced by Clockwork per ADR-020), MockRunner, worktree lifecycle w/ hooks-off default (S-84), profile materializer (T-009-proven), sanitized env, JSONL IPC + heartbeat, on-disk journals, report serializer w/ diffstat + S-39 prune, disk-floor monitor. |
| T-106 | PARTIAL | Error taxonomy mapping (auth/rate_limited/capacity/offline/model_unknown) from stream events; pre-flight repo validation; auto-pause after 2 consecutive auth failures (S-40) wired. Transient backoff helper exists but scheduler auto-re-enqueue not wired (retry defaults OFF by spec). |
| T-107 | DONE | Fastify REST+SSE, bearer token 0600, task CRUD w/ zod validation at save (past-time S-23, invalid RRULE S-26, non-git S-36 all rejected), optimistic versioning 409s (S-82 tested), run-now, runs/report/cancel, approvals CAS, FTS /search, widget snapshot, pause/resume. Contract tests green. |
| T-108 | PARTIAL | LaunchAgent plist generation + install/uninstall + doctor (6 checks incl. duplicate instance). Code complete; live `launchctl bootstrap` verification pending on a clean machine (CI smoke covers daemon boot only). |
| T-109 | DONE | Daemon-side osascript notifier + quiet-hours suppression; works with UI closed by construction. |
| T-110 | DONE | Retention pruning (7d success / 30d failed worktrees, reports forever) + startup worktree reconciliation with quarantine list (never auto-deletes). |
| T-111 | DONE (2026-09-05) | **Correction:** until 2026-09-05 this row overstated — the profile generator, symlink resolution, credential-collision refusal and escape suite were done, but NO production spawn used them (`new ClaudeCliRunner()` passed no spec; other engines had no hook). Now every engine spawn incl. BYOK bash routes through `applySandbox()`; `runner-child` builds the spec; profile v2 admits the CLI work dir + cwd file; `CW_SANDBOX=off` is journaled and stamped on the report. Guarded by `runner-env-wiring.test.ts` "sandbox wiring". Verified in-sandbox: Claude ✅, OpenCode ✅, Hermes ⚠️ (pre-existing `$HOME` cwd bug), Codex ❓ (local config error). ADR-034. |
| T-112 | PARTIAL | Profiles table, 3 seeded built-ins (Generalist/Dep Surgeon/Docs Scribe), bundled versioned skill pack authored (3 skills × SKILL.md procedures), name@version resolver (+user-skill fallback), @mention resolution server-side. Profile identity shown in report header/delivery text; calendar/inbox chips not yet rendered everywhere. |
| T-113 | DONE (measured 2026-09-06) | FTS5 search_idx, index-on-finalize + task save, snippeted /search, inbox search box. **5k-corpus <100ms benchmark now measured**: 5,060-document index (5,000 run docs + 60 task docs), common-term case (`repo*`, which matches nearly the whole index — the hard case, since FTS5 bm25-ranks every match before `LIMIT 50`). Ten runs on 2026-09-06, six of the bench alone and four inside the full suite: median **3.24–27.58ms**, p95 **3.32–31.70ms** — **the <100ms claim held in all ten**, the only bound in this bench that did. Other cases across those runs: rare term 0.02–0.26ms, multi-term + `kind=run` filter 2.50–24.54ms, real `GET /search?q=repo` HTTP round trip 3.49–10.05ms median. The verdict is stable here where T-307's is not, because the bound is ~4x away at the worst measurement rather than straddling it — but the number itself still moved 8x with machine load, so read it as a range, never as a constant. `packages/daemon/test/workforce-bench.test.ts`. |
| T-114 | PARTIAL | queue schedule kind persisted; GET /queue computes position + wait reason (slot/repo/paused); queue lane UI with cancel. Composer cannot yet book ASAP items directly (schedule-kind=queue selection missing). |

## Phase 1 — Track B (UI)

Shell note: React+Vite web app served by the daemon; Tauri wrapper deferred to packaging (ADR-025 — no Rust toolchain in build environment; UI code is wrapper-ready).

| ID | Status | Notes / Evidence |
|---|---|---|
| T-121 | PARTIAL | Single-port app serving + live health (daemon version, active/queued counts, next fire, PAUSED badge) replaces tray until Tauri lands; token handshake manual (file paste) vs Tauri-injected. |
| T-122 | PARTIAL | Week calendar: past runs outcome-colored, future bookings dashed, today marker, honest power-model copy. Month/day views and click-slot-to-composer not yet wired. |
| T-123 | PARTIAL | Composer: name/prompt/repo/profile selector/permission mode (plan|acceptEdits only — no bypass)/budget trio/once+weekly RRULE builder/server-validated errors displayed inline. Monthly recurrence + cron builder missing. |
| T-124 | PARTIAL | Inbox list w/ state chips + search filter; report view: summary block, diffstat table, cost/turns/duration/branch stats, ran-late banner, coalesced-coverage note, approvals panel. Transcript viewer from disk + unread badges missing. |
| T-125 | PARTIAL | Onboarding detection panel (Claude installed/authed, git, MCP config, sample-task guidance) + settings w/ pause-all + snapshot stats. One-click sample task creation missing. |
| T-126 | PARTIAL | Live states visible in topbar health + queue lane + inbox chips; cancel available for queued/running. Streaming log tail view missing. |

## Phase 2 — M2 public beta

| ID | Status | Notes / Evidence |
|---|---|---|
| T-201 | DONE for CLI engine (2026-09-05) | Approval rows persist across restarts (S-54), CAS respond endpoint (S-57), inbox needs-you panel, deny-list floor never approvable (S-55). **Now actually reachable:** the CLI engine raises permission requests through the loopback bridge and HOLDS until a human answers or the run's wall-clock ends (was: never raised in production; fixed 120s window). Codex/OpenCode/Hermes have no permission hook — their containment is the sandbox alone. ADR-034. |
| T-202 | PARTIAL | Linear chain validation (cycles rejected at save, S-72), {{previous.report}} binding w/ honest truncation (S-73), upstream-failure semantics in schema. Calendar ghost rendering for skipped successors missing. |
| T-203 | PARTIAL | Security preview (red/yellow/info flags), import arrives DISABLED (S-74), apply-time variable validation (S-75). Export-as-JSON missing. |
| T-204 | PARTIAL | Orphan terminate+journal-report done (real-process tests), reboot sweep done. Disk-full pause-all suggestion, DB backup-on-migrate, updater drain: missing. |
| T-205 | PARTIAL | **UNSIGNED DMG BUILT** (2026-08-22): `src-tauri/target/release/bundle/dmg/Clockwork_0.1.0_aarch64.dmg` (2.7MB) + Clockwork.app via Tauri 2 shell — Rust toolchain installed in-session, mount-tested. Signing + notarization remain BLOCKED(external): Apple Developer cert ($99/yr). |
| T-206 | MISSING | Beta telemetry + crash reporting + one-click incident report. Safety journal (the local substrate) ships already. |
| T-207 | PARTIAL | Docs suite v1 shipped (security/scheduling/architecture/install/privacy/troubleshooting/contributing + README). 5 canonical template files not yet authored. |
| T-208 | DONE | FSL-1.1 LICENSE + CONTRIBUTING.md w/ security disclosure policy (ADR-009 closed). |
| T-209 | MISSING | In-app profile editor (API CRUD exists; UI editor + duplicate-a-built-in flow missing). |
| T-210 | MISSING | ⌘K command palette. |
| T-211 | PARTIAL | Five adapters behind one `DeliveryChannel` interface — OS notifier, Telegram Bot API, HMAC-signed webhook, Slack incoming webhook, SMTP relay — with S-43 retry×3 exponential, receipts in the report footer, and credentials never runner-visible. **The setup UI shipped.** Settings › Notifications & delivery holds the bot token, the webhook secret, the Slack incoming-webhook URL and the SMTP relay + From address; every field is write-only and read back only masked (`readDeliveryConfigStatus`), and Telegram, Slack and SMTP each have a test-send (`POST /delivery-config/test-telegram|test-slack|test-smtp`). The composer carries the per-task Telegram chat id, the group allow-list, a Slack opt-in switch and email recipients. **Approval REQUESTS now use the same fan-out as run reports** — `deliverApproval` in `packages/daemon/src/delivery-dispatch.ts` is one fan-out for both directions, so a task wired for Slack or email is told a run is waiting. The DECISION is not symmetric and the screens say so: only the app and Telegram can take one (Telegram's message carries approve/deny buttons behind the inbound poller; Slack and email can only point at the Inbox). Still missing: no test-send for the generic webhook, and the per-task webhook URL has no composer field — it is set through the task's `delivery.webhook.url` over the API only. `packages/daemon/test/delivery-config-api.test.ts`, `packages/ui/test/delivery-channels-ui.test.tsx`. |
| T-212 | MISSING | ClaudeSdkRunner engine option (SDK dependency not yet integrated; capability flags stubbed in matrix doc; UI degradation plumbing pending). |

## Phase 3 — M3 v1

| ID | Status | Notes / Evidence |
|---|---|---|
| T-301 | CUT_RECOMMENDED | Capacity assistant is conditional on beta precision ≥70% (FR-7/R-7). No beta telemetry exists ⇒ per plan it must be cut without ceremony unless/until precision evidence arrives. Recorded here as the default decision pending any overriding beta data. |
| T-302 | PARTIAL | Per-task delivery config stored + dispatched; env/file credential bridge. **The settings centre and the test-send flow both ship** (see T-211). What is still missing is the keychain: `writeDeliveryCreds` keeps every credential in `delivery-creds.json` under the data dir at file mode 0600 (re-`chmod`ed after each write, because `writeFileSync`'s mode is ignored on an existing file), merged over `CLOCKWORK_DELIVER_*` env vars with the file winning. `plan/02-architecture.md` §4 and `plan/03-tech-stack.md` row 14 both say OS keychain; that arrives with the Tauri step, which is T-205 and blocked on an Apple Developer certificate. A 0600 file is weaker than the Keychain and is named as such here rather than described as "secure storage". |
| T-303 | MISSING | Auto-PR via gh. |
| T-306 | MISSING | URL + MCP context attachment (prompt-injection stance documented; implementation deferred). |
| T-307 | PARTIAL (re-measured 2026-09-07; NFR-3's number is now met on the machine that was measured, and the acceptance machine is still unmeasured) | **Where it stands today.** Three full `rtk proxy pnpm test` runs on 2026-09-07, Apple M4 MacBook Pro (10 cores, 16GB, Node v24.13.1): `GET /calendar` year view over the 5,000-run corpus plus 470 expanded bookings measured medians of **40.82-42.17ms** and p95 of **52.90-67.14ms** (n=15 each); the route's default 62d/31d window measured medians of **13.80-16.62ms** and p95 of **18.14-23.62ms** (n=5 each). NFR-3's bound is a 500ms median on 5,000 historical runs (`plan/01-product-spec.md:91`); the median and the p95 are both well under it in all three. Three runs, and the number still moves with the machine — read the range, not a figure from inside it. **What the earlier record said, and why it is kept.** Until this pass the same bench measured year-view medians of **349.59-684.26ms** and p95s of **429.41-1163.14ms** across ten runs on 2026-09-06, on one laptop at one commit inside 90 minutes: the 500ms median held in six of the ten and was missed in the other four, and the p95 was **above the 500ms ceiling in seven of the ten**, decided by `uptime` load average (12.5-27.1 when the gated bench went red, 7.4-7.9 when it went green) rather than by anything in the code. The default window bracketed the same way, 329.21-738.97ms, over the ceiling in three of ten. That record was honest when it was written and it is history now, not the current number — it is left standing because it is the evidence that the fix below is what moved the number, and because a reader deciding whether to trust 41.92ms should be able to see how wide the same measurement once was. **What actually fixed it — and it is NOT what this task's roadmap line said.** `recurrence.ts` synthesizes a `DTSTART` for any RRULE saved without one, and it used to anchor at 1970-01-01. `RRule.between()` is a replay, not a search: it walks from DTSTART one period at a time and only then starts accepting dates, so every calendar request replayed 56 years of occurrences per schedule before reaching the window, and grew by another year of replay every calendar year. `advancedAnchorMs()` now moves that synthetic anchor forward by a WHOLE number of INTERVAL periods in the rule's own FREQ unit, kept one period below the padded lower bound, which yields exactly the old occurrence set intersected with `[anchor, infinity)`. Isolated, expanding one rule over a month view: `FREQ=DAILY;BYHOUR=9;BYMINUTE=0` cost **25.76ms** against the 1970 anchor and **0.092-0.167ms** across the three 2026-09-07 runs; `FREQ=WEEKLY;BYDAY=MO,WE,FR` **6.18ms** -> **0.038-0.065ms**. Two shapes were not slow but unusable, and these are the separate save-rung figures recorded in `packages/daemon/test/recurrence-anchor.test.ts` — one `nextOccurrenceAfter` over an 8-day horizon, not the month view above: `FREQ=HOURLY` **1,347ms** -> **2.0ms**, `FREQ=MINUTELY` **78,941ms** -> **87.6ms**, which is 79 seconds of blocking the save request and then the tick that touches the schedule. The per-year growth is gone too: across the three runs the same rule over the same window width costs 0.088-0.155ms for a 2026 window and 0.088-0.159ms for a 2126 one — the ordering between them flips run to run, which is what "no longer a function of the date" looks like. **Equivalence is the load-bearing half, not speed**: `packages/daemon/test/recurrence-anchor.test.ts` (30 tests) expands every shape both ways — every DST transition, both hemispheres' zones, the 732-day next-fire horizon — and requires the two occurrence lists to be identical, and it pins the three refusals that must keep the 1970 anchor (a stated COUNT, a sub-daily counter that can leave the INTERVAL grid, a degenerate INTERVAL). **COUNT is the one cost the anchor cannot touch**, because dropping early occurrences promotes later ones into the count and un-exhausts an exhausted rule, which would break S-24 auto-disable. Cost is linear in COUNT — 34ms at 10,000, 277ms at 100,000, 2.6s at 1,000,000, **79 seconds at 40,000,000** — so `MAX_RRULE_COUNT = 100_000` refuses a larger one at save time with a named 422. It refuses nothing real: a per-minute rule still fires for 69 days, a daily one for 274 years. `packages/daemon/test/rrule-count-ceiling.test.ts`. **Per-day aggregation shipped as well, and it is real — but it was never the speed.** `GET /calendar?group=day` (S-64) folds the runs half in SQLite into one row per non-empty day with the outcome breakdown a month or year cell needs, and both modes are bounded by `CALENDAR_ROW_LIMIT` (5,000; `?limit=` may only lower it) with `limits.truncated` reported so a capped answer never looks complete. Measured interleaved on one corpus in one process on 2026-09-07 (`packages/daemon/test/calendar-aggregate-bench.test.ts`): payload **1.130MB -> 51.4KB** (22.5x, byte-identical in all three runs because bytes are deterministic here), and the runs half of the request **18.11-19.27ms as events against 4.68-7.52ms as counts** (n=15 each) — 2.6-3.9x cheaper. That is the same saving the fold always made, and it is why the fold alone did not deliver the speed: when the replay dominated, the runs half was roughly 3% of a ~355ms request. With the replay gone the same fold is most of the request, so it now shows end to end — 27.11-29.29ms as events against 8.15-13.21ms as counts (n=5 each, interleaved). The earlier windowed projection (`json_extract(jobspec_json,'$.taskName')` instead of the whole frozen blob) remains a payload win of the same kind: 10.16MB -> 1.15MB on the year view, no measurable latency change at the time. **What is still not proven, and what is still broken.** The acceptance text is "NFR-3 numbers met on a **base M1 Air**" (`plan/05-execution-plan.md:100`). Every number in this row is an Apple M4; the M1 Air has still never been measured and nothing here is extrapolated to it, so the criterion is **unproven on the acceptance machine**, not passing. DB vacuum and idle CPU/RSS profiling, also named in this task's scope, remain unmeasured. The bench still does not assert its wall-clock bounds inside the default test command (see the bench-gate note under "Test inventory") — the reason for that gate was never the size of the margin, it was that a bound inside `pnpm test` makes the suite's colour a property of the machine. And one rule shape still hangs, upstream and reachable today: an hourly rule whose coarser BY part is unreachable from its own INTERVAL grid — `FREQ=HOURLY;INTERVAL=2;BYHOUR=3`, whose hours stay even — spins forever inside rrule 2.8.1's skip loop, at the 1970 anchor and at the advanced one alike, because the reachable residues depend only on `gcd(INTERVAL, 24)`. The anchor work preserved that hang exactly as it preserved everything else; it is not fixed. `packages/daemon/test/workforce-bench.test.ts`. |
| T-308 | MISSING | Launch kit (landing page exists as evidence asset; demo video/templates pack missing). |
| T-309 | PENDING-BETA | Hardening reserve opens with external beta. |
| T-310 | PARTIAL | Every adapter this task names now ships. **Webhook**: HMAC-signed JSON (`x-clockwork-signature: sha256=…`) for both the run report and the approval request. **Slack**: Block Kit over an incoming webhook — header, failure reason, summary, and cost/turns/branch/agent fields; an approval adds the tool, the command as a code block and the auto-deny moment as Slack's own `<!date^…>` token so each reader sees it in their zone. No Approve/Deny buttons, deliberately: Slack interactivity POSTs the click to a public HTTPS request URL and the daemon binds loopback only (S-2), so a button would be a control that silently does nothing. **Email**: an SMTP client written on `node:net` + `node:tls` — EHLO, opportunistic STARTTLS, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA, and one base64-encoded `text/plain; charset=utf-8` body — with **no dependency added**. `plan/03-tech-stack.md` row 13 penciled in nodemailer; submission of one plain-text message to the user's own relay did not need it, and the module header lists what would bring it back: attachments, multipart bodies, HTML alternatives, XOAUTH2/OAuth2, DKIM signing, pipelining, connection pooling, DSN/SMTPUTF8, and internationalised addresses. It refuses to send credentials over an unencrypted connection unless the URL opts in for a trusted local relay. **WhatsApp is not a missing adapter.** ADR-018 and `plan/02-architecture.md` §240 define a gateway as any HTTP endpoint — `http://127.0.0.1:<port>` for a self-hosted bridge included — that accepts the signed Run Report payload, so the generic webhook adapter already IS that channel; a second `whatsapp-gateway` class would be the same POST under another name, and `DeliveryConfigCred` keeps the unused `gatewayUrl`/`gatewayToken` keys only because the credential loader preserves unknown keys. **What genuinely remains is documentation**: `plan/05-execution-plan.md:103` asks for channel docs "incl. self-hosted bridge recipe", and that recipe is unwritten. `packages/daemon/test/slack-delivery.test.ts` (24), `packages/daemon/test/smtp-delivery.test.ts` (26), `packages/daemon/test/delivery-channels.test.ts` (17). |
| T-311 | MISSING | Clockwork Mini widget (snapshot endpoint ships already — read-only aggregate scope). |

## Phase 4 — Agent Workforce (F1–F12)

Twelve features from `plan/AGENT-WORKFORCE-SPEC.md` (a separate spec from
`05-execution-plan.md`, hence F-IDs not T-IDs here). Migration `0008_agent_workforce.sql`
landed the schema; all twelve daemon modules, their `/workforce/*` routes, and
scheduler/run-manager wiring landed in the integration pass. `features.ts` now
reports each one's real implementation status (three `enforced`, nine
`available` — no `planned` placeholders remain for this batch). Full
per-feature detail, routes, and refusal-path notes: `docs/agent-workforce.md`.

| ID | Status | Notes / Evidence |
|---|---|---|
| F1 plan-then-execute | DONE | `plan_then_execute` (**enforced**): execute half of a booking stays `enabled=0` permanently; only a human's `resolve('approved')` books its run. ADR-041. `packages/daemon/test/plan-execute.test.ts`. |
| F2 shift-handoff | DONE | `shift_handoff` (available): per-task memory injected only when the prompt contains `{{handoff.previous}}`; human notes from F6 land here. `packages/daemon/test/handoff.test.ts`. |
| F3 office-hours | DONE | `office_hours` (**enforced**): defers approval-flagged tasks into declared windows. It marks the claimed occurrence `deferred` the way quiet hours does, but it deliberately does **not** pre-claim a ledger row at the resume instant, and it bumps `next_fire` for every schedule kind including `once` — both differences are the opposite of quiet hours and both are load-bearing (`scheduler.ts`, and the F3 section of `docs/agent-workforce.md`). Off by default, and **three setup steps, not two**: enable the pref, define windows, and enrol the task's profile in F7 autonomy — nothing else in the product sets `profiles.may_require_approval`, which is the flag this feature gates on. Fails open on any error. ADR-038. `packages/daemon/test/office-hours.test.ts`. |
| F4 sentinel-worker | DONE | `sentinel_worker` (available): cheap sentinel run books a worker through the existing trigger/policy path on trip; every evaluation (trip or not) is logged. `packages/daemon/test/sentinel.test.ts`. |
| F5 repo-shipped-jobs | DONE | `repo_shipped_jobs` (available): discovers `.clockwork/jobs.json`/`.yaml`, offers only, imports disabled with a security preview; job file cannot set permission mode/engine/budget — hardcoded to template-import defaults. ADR-040. `packages/daemon/test/repo-jobs.test.ts`. |
| F6 accept-with-note | DONE | `accept_with_note` (available): inbox accept/reject/accept-with-note; the acceptance signal F7/F10/F11 all read. `packages/daemon/test/acceptance.test.ts`, UI `OutcomeControls.tsx` mounted in `InboxView.tsx`. |
| F7 earned-autonomy | DONE | `earned_autonomy` (**enforced**): offer-only, opt-in ladder `plan→acceptEdits→unattended`; unenrolled profiles are unconstrained; ceiling enforced as a second 403 gate at 3 call sites, ahead of the write. **Only the bottom rung refuses anything.** `acceptEdits` and `unattended` both map to permission mode `acceptEdits` (`AUTONOMY_RUNG_SETTINGS`, `packages/shared/src/workforce.ts`), so the gate — which fires only on `allowed === 'plan'` — never fires for either. The `acceptEdits → unattended` promotion changes no permission and blocks no run; it only clears `may_require_approval`, whose one reader is F3 office hours, so its whole effect is "this profile's tasks stop being deferred into office hours", and only while F3 is on. Enrolling or accepting an offer also **overwrites** `profiles.permission_mode` with the rung's mode. ADR-037. `packages/daemon/test/autonomy-policy.test.ts`. |
| F8 self-healing | DONE | `self_healing` (available): N-failure streak books one diagnostic run in `plan` mode; output is an approval item, never a self-applied edit. ADR-039. `packages/daemon/test/self-healing.test.ts`. |
| F9 proposed-events | DONE | `proposed_events` (available): report `proposedEvents[]` → downloadable `.ics`; no write path to any real calendar. **Has a producer since 2026-09-06**: an agent emits one fenced ` ```clockwork-events ` JSON block in its final summary, `finalize()` parses it into the field through `packages/runner/src/proposed-events-parse.ts` and strips the block from the prose. Model output is untrusted, so the parse is bounded (≤20 events, ≤8 KB block, first block only), assigns its own `key` (the `.ics` UID component), strips control characters, masks credentials, and never throws — a bad block costs the suggestions and leaves a timeline note, never the run. Nothing is auto-injected into prompts: a task or profile prompt has to ask for it, so a run that was never asked still shows none. ADR-042. `packages/daemon/test/proposed-events.test.ts`, `packages/runner/test/proposed-events-parse.test.ts`, `packages/daemon/test/proposed-events-producer.test.ts`, UI `ProposedEvents.tsx` mounted in `InboxView.tsx`. |
| F10 agent-timesheets | DONE | `agent_timesheets` (available): per-profile hours/cost/effective-rate over a date range. Measured on 2026-09-06 over ten runs (six of the bench alone, four inside the full suite), 5k-run corpus, n=25 each: full 365d window median **16.95–47.49ms**, p95 **17.45–64.94ms**. Filtering to one profile is the same SQL with a JS-side filter, so it costs the same to within the noise (median 16.66–35.75ms). The low end of the range is a quiet machine and the high end a loaded one; two earlier revisions of this row gave first a single-run number and then a three-run range, and neither survived a loaded machine. `packages/daemon/test/timesheets.test.ts`. |
| F11 performance-reviews | DONE | `performance_reviews` (available): per-profile scorecard (acceptance/failure rate, cost trend), plain SQL, no model call; `/review-prompt` returns prompt text only — no seeded reviewer profile writes the prose automatically. Measured on 2026-09-06 over ten runs (six of the bench alone, four inside the full suite): one profile (2 windowed scans) median **13.06–34.45ms**, p95 **13.62–64.35ms** (n=25); all 7 groups (15 full scans of `runs`) median **101.97–232.68ms**, p95 **112.87–269.04ms** (n=15) — the most expensive workforce query, driven by scan count rather than row count. No bound is claimed for it. The low end of each range is a quiet machine and the high end a loaded one; a single number for either would be that machine's number, not the code's. `packages/daemon/test/performance.test.ts`. |
| F12 proof-of-work-export | DONE | `proof_of_work_export` (available): self-contained masked/escaped HTML export, no external references, `includeTranscript` off by default, audited. `packages/daemon/test/proof-of-work.test.ts`. |

**S-9 tick loop at scale, recurring shape (new coverage, pre-existing cost, now mostly gone):** the pre-existing 500-task/50-due scale fixture (`scheduler.test.ts:317-325`) has only ever seeded `kind:'once'` schedules, which short-circuit `occurrencesBetween` — it never measured the recurring path production actually runs. `workforce-bench.test.ts` adds that case: 500 tasks/50 due, all `FREQ=DAILY`. It measured **1439.55–1581.01ms** across three isolated runs on 2026-09-06 (1497.04ms in one earlier run under full-suite contention), against 12.92–17.97ms for the `'once'` shape — the same DTSTART-1970 replay as the T-307 calendar finding above, at 26.89ms per fire. With the anchor advance in `recurrence.ts` the same case measured **104.86-183.72ms** across three full-suite runs on 2026-09-07, against 20.30-23.70ms for the `'once'` shape and 29.26-32.17ms with F3 office hours switched on. It was inside both the fixture's 5s bound and the 30s tick budget before and it still is; what changed is the margin. This is T-103 scheduler code and none of the twelve workforce features touch it, so it was never a workforce regression either way.

## Post-v1 (out of scope)

| ID | Status |
|---|---|
| T-401 Windows | MISSING (planned post-v1) |
| T-402 Linux | MISSING (planned post-v1) |

## Gate ledger

| Gate | State |
|---|---|
| G-1 (evidence) | **BLOCKED(external)** — bars unmet, assets ready, no override recorded |
| G0 (engine spike) | **PASSED** (with ADR-020 branch) |
| G1 (M1 exit) | **PARTIAL** — core loop proven end-to-end (mock engine full-loop tests + real-engine PoC); fresh-Mac-by-non-builder demo not performed; dogfood streak time-gated (program defined in `dogfood/DOGFOOD.md`) |
| G2 (M2 exit) | **BLOCKED(external)** — requires 20 beta users, wild HITL round-trip, zero data-loss/containment incidents |
| G3 (v1 gate) | **BLOCKED(external + time)** — 30-day dogfood streak, kill-criteria observability, signing/notarization |

## Test inventory vs mandate

Every row below was re-counted from a real `rtk proxy pnpm test` run on
2026-09-07 and confirmed against a repeat run with the same file set, and the
rows sum to the total.

This table goes stale the moment a suite is added, and it does so faster than
anything else here. Two earlier runs on the same day agree with each other
exactly and differ from these two by a single UI suite that landed in between.
Three earlier versions of the table were wrong in the same direction: one
listed only some suites while calling the last row a total, one went stale at
788 while the suite had grown to 1185, and the 1185 itself went stale when the
delivery and RRULE-anchor suites landed. So the counts are read off a real run
every time, never carried forward by hand — and a reader who finds them wrong
should re-run rather than argue with them.

| Suite | Count | Location |
|---|---|---|
| Runner unit/scenario | 156 | `packages/runner/test/*` (17 files) |
| Daemon scheduler fixtures | 18 | `packages/daemon/test/scheduler.test.ts` |
| API contracts | 33 | `packages/daemon/test/api.test.ts` |
| Full-loop child-process integration | 4 | `packages/daemon/test/full-loop.test.ts` |
| Recovery (real orphan kills) | 3 | `packages/daemon/test/recovery.test.ts` |
| Templates/chains | 9 | `packages/daemon/test/templates-chains.test.ts` |
| Agent Workforce F1–F12 (feature modules) | 332 | `packages/daemon/test/{plan-execute,handoff,office-hours,sentinel,repo-jobs,acceptance,autonomy-policy,self-healing,proposed-events,timesheets,performance,proof-of-work}.test.ts` |
| Agent Workforce foundation + API contracts | 105 | `packages/daemon/test/workforce-foundation.test.ts` (16), `packages/daemon/test/workforce-api.test.ts` (89) |
| Performance benches (T-113 / T-307 / S-9, and the S-64 fold) | 22 | `packages/daemon/test/workforce-bench.test.ts` (16), `packages/daemon/test/calendar-aggregate-bench.test.ts` (6) |
| RRULE anchor equivalence + COUNT ceiling (the T-307 root cause) | 33 | `packages/daemon/test/recurrence-anchor.test.ts` (30), `packages/daemon/test/rrule-count-ceiling.test.ts` (3) |
| Delivery channels (Slack, SMTP, shared adapters, config API) | 109 | `packages/daemon/test/slack-delivery.test.ts` (24), `packages/daemon/test/smtp-delivery.test.ts` (26), `packages/daemon/test/delivery-channels.test.ts` (17), `packages/daemon/test/delivery-config-api.test.ts` (42) |
| Claim tripwires (docs vs code) | 44 | `packages/daemon/test/claims-honesty.test.ts` |
| Finalize/teardown race regression | 6 | `packages/daemon/test/finalize-teardown.test.ts` |
| Keep-awake wiring guard | 7 | `packages/daemon/test/keep-awake-wiring.test.ts` |
| Other daemon suites (31 files) | 228 | analytics, approval-notify, calendar-aggregate, chains, credential-channel, entitlements, event-prompts, feature-honesty, gates, health-version, hooks-rawbody, ics, ics-import, ics-ssrf, install-instructions, landing-honesty, loopback-bind, next-fire-honesty, pause, policy-engine, profile-api-patch, profile-repo-patch, proposed-events-producer, quiet-hours, recurrence, retention-sweep, save-time-recurrence, single-instance, task-repo-patch, telegram-approvals, triggers |
| UI component tests (22 files) | 280 | `packages/ui/test/*` |
| **Total automated (measured 2026-09-07, `rtk proxy pnpm test`)** | **1389 passed, 0 failed, across 100 files** | full run: daemon + runner + shared + ui workspaces (`packages/shared` ships no test file of its own) |

**The bench still does not assert its latency bounds in this run, and the
margin is not the reason.** Every wall-clock bound in
`workforce-bench.test.ts` and `calendar-aggregate-bench.test.ts` goes through
`assertLatency` (`packages/daemon/test/helpers/bench-gate.ts`), which measures
and prints the number but only fails when `CLOCKWORK_BENCH_ASSERT=1` is set.
One session on 2026-09-06 is the demonstration, and it still stands even
though the numbers under it have moved: six gated runs of that bench, on one
laptop at one commit inside 90 minutes, split **three red / three green** —
red at `uptime` load averages of 12.5–27.1, green at 7.4–7.9, and every single
failure a T-307 calendar bound. The default `rtk proxy pnpm test` was green in
both conditions, across all 54 files the suite held at that commit. Since the
RRULE anchor fix the same year-view bound measures 40.82–42.17ms against 500ms
rather than 349.59–684.26ms against 500ms, so a busy laptop is far less likely
to decide the verdict — but the gate is not about the size of the margin. A
wall-clock assertion inside the default test command makes the suite's colour
a property of the machine, and that is true at any margin. Correctness
assertions in both files (corpus size, row counts, payload bytes, HTTP status,
response shape) are never gated, and they are what a green run actually
proves. To gate on the numbers, run `CLOCKWORK_BENCH_ASSERT=1 npx vitest run
test/workforce-bench.test.ts` from `packages/daemon` — and read a red result
as "this machine is busy, or this code got slower", because the bench cannot
tell you which.

**One caveat on the total, carried forward from an earlier session.** The
count reproduces; the process exit code has not always agreed with it. Of the
full-suite runs made on 2026-09-06 while that pass was adding and then
removing tripwires (totals 748 → 754 → 752 as the tripwire set changed),
**two reported their full count with zero failures and still exited
non-zero**, on the same unhandled rejection originating in
`packages/daemon/test/api.test.ts`:
`TypeError: The database connection is not open` inside `RunManager.finalize`
→ `recordEvent` (`packages/daemon/src/run-manager.ts:649`, then line 876).
No test failed; a run finalized asynchronously after its test had closed the
database. All three 2026-09-07 runs exited **0**, so the race did not fire in any of
them — which is exactly what a race does, and is not
evidence it is gone. Read the total row as the claim, and treat a non-zero
exit with no failing test as this race until it is fixed. It is recorded
rather than fixed here because it is a teardown race in daemon code no
documentation pass owns.

Manual logs: sandbox escape matrix (13 checks) `spikes/reports/T008-sandbox.md`; live smoke (boot→book→fire→report→search) recorded in commit e583e01; real-engine verification runs T-001/T-008/T-009.
