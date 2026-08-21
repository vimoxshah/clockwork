# Evidence Readout — T-013 (GATE G-1)

> **STATUS: UNVERIFIED — EVIDENCE SPRINT NOT YET EXECUTED.**
>
> This document is the template + decision frame. The numbers below are
> placeholders and MUST NOT be treated as evidence. Per ADR-015, Phase 1 build
> spend beyond the engineering environment used for this implementation is not
> authorized until the bar is met or a conscious written override is recorded.

## Bar (from `plan/05-execution-plan.md`)

| Metric | Bar | Actual | Status |
|---|---|---|---|
| Target-persona interviews completed (T-011) | 15 | 0 | ⬜ UNVERIFIED |
| Interviewees describing a concrete job they'd schedule THIS WEEK | ≥40% (6/15) | n/a | ⬜ UNVERIFIED |
| Landing-page visitors with honest pitch (T-012) | ≥300 | 0 | ⬜ UNVERIFIED |
| Visitor → waitlist-with-use-case conversion | ≥5% | n/a | ⬜ UNVERIFIED |

## Assets ready

- `evidence/interview-script.md` — full script + coding sheet (no demo before Q7)
- `evidence/landing-page/index.html` — honest-pitch landing page incl. the
  awake-machine constraint, waitlist form asking for the use case; form action
  needs a real backend before traffic is driven
- Recruiting channels named in the script header

## Decision frame

- **PROCEED** — bars met → Phase 1 continues per plan.
- **PIVOT-PERSONA** — <40% overall but one segment shows ≥40% → rewrite wedge,
  re-run with that persona only.
- **STOP** — <40% flat after 15 interviews AND landing signal weak → log stop
  memo here; do not spend on distribution until the problem thesis changes.

## Override clause (ADR-015)

A conscious override of G-1 may be logged ONLY in this format:

```
OVERRIDE RECORDED: <date>
By: <name>
Reason: <specific rationale>
Scope of override: <what spend it unlocks>
```

No override has been recorded as of this file's creation. The engineering work
completed in this repository was produced under an internal build authorization
to validate feasibility (Phase 0 gates), which is distinct from market-facing
spend gated by G-1.
