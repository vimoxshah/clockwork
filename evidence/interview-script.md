# Problem Interview Script — T-011

> Target: 15 interviews with Claude Max subscribers who maintain ≥2 active repos.
> Recruiting channels: X/Twitter dev community, Claude Discord, HN "Ask" threads,
> personal network warm intros.
> Evidence bar: **≥40% (6/15) independently describe a concrete job they would
> schedule THIS WEEK** without prompting.

---

## Setup notes for interviewer

- 30 minutes, recorded WITH consent (or detailed notes if not).
- Do NOT demo Clockwork before questions 1–7. This is a problem interview,
  not a pitch. We are testing whether the pain exists, not whether they like
  our solution.
- Log answers in `interviews/<date>-<initials>.md` using the coding sheet below.

## Script

### Warm-up (2 min)

1. What do you work on? How many active repos do you personally maintain?
2. Which Claude plan are you on? Roughly what fraction of your subscription
   capacity do you actually use in a week?

### Current behavior (10 min)

3. Walk me through the last time you used Claude Code for something
   repetitive — a chore you've done more than once across repos. What was it?
4. How do you currently handle recurring repo chores? (cron? CI? by hand?
   ignore them?) *Probe: how often, how long does it take, what slips?*
5. Have you ever run `claude -p` or any agent non-interactively? What for?
   What was scary or annoying about it?
6. Tell me about the last time you thought "an agent could have done this
   overnight." What stopped you?

### The gap (5 min)

7. If you could hand ONE recurring chore to an agent that runs on a schedule
   while your machine is awake, what specifically would it be this week?
   *(THE question. Verbatim answer required. Coding: concrete-with-scope vs vague.)*
8. Who would you trust to run unattended: read-only analysis? edits in an
   isolated branch? opening PRs? pushing to main? Where's YOUR line?

### Trust & constraints (8 min)

9. What would make you NOT trust a scheduled agent run? *(probe: cost blowups,
   destructive actions, prompt injection via repo content)*
10. A scheduled run costs $0.40 and opens a draft PR with dependency bumps.
    Walk me through what you'd do when you see it the next morning.
11. Your laptop is asleep at 2am when the job was booked. What should happen?
    *(listen for: honesty expectations vs magic thinking)*
12. Would you install a background daemon that fires these jobs? Any
    reservations? *(daemon trust is a real adoption gate — log verbatim concerns)*

### Wrap (5 min)

13. On a scale of 1–10, how painful is the recurring-chore problem you
    described? Why that number?
14. If this existed today as described — scheduled agent runs with budgets,
    isolation, reports — would you pay $15/mo? Why / why not?
15. Can I follow up when there's something to try? Best contact?

## Coding sheet (per interview)

| Code | Meaning |
|---|---|
| C1-concrete | Q7 produced a specific, scoped job with a real trigger ("update deps every Monday") |
| C1-vague | Q7 answered generically ("whatever's annoying") |
| T-trust-line | Q8 drew a clear boundary |
| T-daemon-ok / T-daemon-hesitant | Q12 stance |
| P-pay | Q14 = yes |

## Evidence bar evaluation

- **≥40% C1-concrete** → proceed to Phase 1 build spend.
- **<40% but strong signal in another persona** → pivot-persona memo.
- **<40% flat** → stop memo.

All results appended to `EVIDENCE-READOUT.md`.
