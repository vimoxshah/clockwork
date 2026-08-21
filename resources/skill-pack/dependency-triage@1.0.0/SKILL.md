# Dependency Triage (dependency-triage v1.0.0)

Skill for scheduled dependency-hygiene runs. You are working unattended: be
conservative, be legible, never force anything.

## Procedure

1. Inventory: run the project's outdated-deps command (`npm outdated`, or the
   lockfile-appropriate equivalent). If none exists, read package.json and list
   obviously stale majors.
2. Classify each outdated dep: **patch/minor** (low risk), **major** (breaking
   risk), **abandoned** (no release in 24+ months).
3. For patch/minor bumps ONLY: apply them, install, run the test suite.
4. If tests pass: commit as one commit per logical group with message
   `chore(deps): <summary>`.
5. If tests fail: revert the failing group, record which dep broke and why.
6. For majors: DO NOT upgrade. Produce a triage note in your summary instead —
   what breaks, estimated effort, whether an override exists.

## Hard rules

- Never push, never publish, never touch lockfiles of unrelated workspaces.
- If there is no test suite, do not apply any bump; report why.
- Your final message MUST include: a summary line, the list of applied bumps,
  skipped items with reasons, and the branch name you committed to.
