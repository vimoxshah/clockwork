# T-009 — Profile materialization report

- Date: 2026-08-21T18:01:55.006Z
- Skill: secret-keeper@1.0.0 → .claude/skills/secret-keeper/ (materialized per-run)
- Materialized skills: secret-keeper@1.0.0; missing: none

| Check | Result |
|---|---|
| Control run (no skill) does NOT reveal secret | PASS ("I don't have a secret word — nothing in this session contain" exit=0) |
| Treatment run WITH materialized skill reveals secret (CRANBERRY-42) | PASS (exit=0) |
| No global config mutation (state confined to ~/.claude state subpaths + worktree) | PASS (profile-scoped writes only) |

**Verdict:** G0 GREEN — booked profiles demonstrably change run behavior via per-run .claude/ materialization.
