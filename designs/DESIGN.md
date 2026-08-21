# Clockwork — Design Language & Prototype

**Artifacts:** `prototype.html` (interactive, 5 screens — open in a browser or via the published artifact link) · this doc (the language behind it).

## Identity

- **Metaphor:** horology. Precision instrument, not chat toy. The wordmark is spaced small caps with *WORK* in brass; the mark is a clock face whose hands read ~19:35 (an evening run).
- **Single-theme dark, by intent.** The product's world is night runs on a developer desktop; the app commits to it (documented choice, not an omission).

## Tokens

| Token | Value | Role |
|---|---|---|
| `--ground` | `#0C0E14` | window ground — ink-blue, never pure black |
| `--panel` / `--raised` / `--overlay` | `#141824` / `#1A1F2E` / `#1F2536` | elevation steps |
| `--brass` | `#E8A33D` | **the brand accent** — wordmark, primary buttons, today marker, and every "needs you" moment |
| `--ink` / `--ink-mut` / `--ink-dim` | `#E9EBF3` / `#9BA1B6` / `#6A7189` | text hierarchy |
| `--ok` | `#4BC97F` | completed / approve |
| `--info` | `#5EA7F0` | booked (future) / running / unread |
| `--bad` | `#E05C5C` | stopped / failed |

Semantic colors are distinct from the accent — with one deliberate exception: **brass doubles as the human-in-the-loop color** (`needs you`), so the moments where the product asks for a human are also the moments it is most itself.

**Type:** system sans (`-apple-system`) for UI — native is correct for a macOS app; `SF Mono` + `tabular-nums` for every time, cost, duration, branch name, and ID. No webfonts; nothing to fall back from.

## The six principles (each is visible in the prototype)

1. **Time is the interface** — the primary object is the *future run*: a booking on a week grid. Past and future share one surface (filled = happened, dashed = booked).
2. **Trust is visible** — sandbox badge in the composer, policy checks in the run timeline, budget meters ("$2.02 of $3.00") on every report. Safety is shown, not claimed.
3. **Honest estimates** — the capacity band carries "estimate" on its face; keep-awake (⏾) and slept-through states are loud, never silent. Copy matches the plan's honesty stance (FR-25, R-7).
4. **Needs-you is brass** — exactly one color pulses, everywhere HITL appears (calendar event, inbox chip, approvals card, menubar badge). Nothing else animates.
5. **Reports worth reading** — summary → result → timeline → actions, one primary CTA ("Create draft PR"), "Mark useful" feeds the north-star metric (accepted outcomes).
6. **Native calm** — macOS materials, quiet chrome, drama reserved for the agents' work.

## Screens in the prototype (v2 — 2026-07-16 scope revision)

| # | Screen | What it demonstrates |
|---|---|---|
| 01 | **Calendar (week)** | outcome-colored past runs, dashed future bookings, now-line, per-day capacity estimate band, keep-awake moons, this-week sidebar stats |
| 02 | **Book a run (composer)** | **agent-profile selector (Dep Surgeon / Docs Scribe / Generalist) with @mention + per-run skill loading**, engine line (`claude -p` on your login — no API key), prompt-first booking, repo preflight ✓, permission segmented control (no bypass mode), soft-cap budget trio, missed-run policy, machine-availability hint, **delivery channels (Inbox / Notify / Telegram / WhatsApp / Webhook)**, sandbox statement, dry-run CTA |
| 03 | **Inbox + Run report** | **FTS search box (⌘K)**, unread list with outcome chips, report anatomy (stats row incl. engine + delivered-to, **profile chip**, summary, branch + diffstat, timeline with policy events, actions + mark-useful) |
| 04 | **Approvals** | permission card (held runner, countdown, timeout fallback, approve/deny — interactive, profile in metadata) and question card (option buttons) |
| 05 | **Menubar + widget** | tray popover (next runs, waiting-on-you, unread, pause-all switch), native notification toast, **Clockwork Mini desktop widget** (next-run countdown + done / needs-you / booked pills) — the no-window surfaces |

## Profile identity system (added v2)

Each profile owns a color + glyph chip used identically everywhere (composer, calendar, inbox, report header, approval metadata): **Dep Surgeon** teal `#7FD8C8` ✚ · **Docs Scribe** violet `#B9A7F2` ✎ · **Generalist** neutral ◦. Profile colors are deliberately *not* semantic-state colors — identity and outcome never compete: the chip says who ran, the chip's neighbors say how it went.

## Interaction notes (prototyped in JS)

Tab switching between screens; approve/deny resolves the approval card; "Mark useful" toggles; pause-all switch; "Book run" confirms. Everything else is static by design — this is a look-and-feel prototype, not a functional shell.

## Open design questions (for the next iteration)

1. Light theme: commit dark-only for v1, or offer light for daytime-heavy users? (Current stance: dark-committed.)
2. Calendar month view density — dots-per-day vs mini-bars.
3. Empty states: first-run calendar with a "book your first run" ghost slot (onboarding moment, FR-21).
4. Windows/Linux chrome adaptation post-v1 (title bar, tray conventions differ).
