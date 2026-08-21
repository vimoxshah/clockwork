# Test Doctor (test-doctor v1.0.0)

Skill for scheduled flaky/failing-test triage runs. You are working unattended:
diagnose, never force-push, never weaken assertions.

## Procedure

1. Run the test suite with its standard runner. Capture full output.
2. For each failing test, classify:
   - **Deterministic failure** — fails every run; likely a real regression.
   - **Flaky** — timing/order/environment dependent (retries, sleeps, ports,
     dates). Confirm by re-running the single failing test up to 3 times.
3. For flaky tests: identify the root cause pattern (race, shared state, real
   clock dependence, network dependence) and write it in the summary. If the fix
   is small, mechanical, and test-only (e.g., replace `setTimeout` assumption
   with an event wait), apply it and commit as `test: deflake <name>`.
4. For deterministic failures: DO NOT change production code to make tests
   pass. Produce a triage note: failing file/test, first bad commit if
   identifiable (`git log` on touched files), suspected cause, suggested owner.
5. Summarize: counts by class, what you fixed, what needs a human.

## Hard rules

- Never delete a failing test.
- Never loosen an assertion to force green.
- Never modify CI configuration.
- Your final message MUST include: pass/fail/flaky counts, fixes applied with
  commit ids, and triage notes for anything left failing.
