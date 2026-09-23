# DIFF-FPS-TRACE — measured 2026-09-23 (Round 7, C bar proof)

Command (isolated mock daemon, temp CLOCKWORK_HOME, no real data touched):

  CLOCKWORK_HOME=$TDIR CLOCKWORK_PORT=4877 CW_ENGINE=mock node packages/daemon/dist/main.js
  BASE=http://127.0.0.1:4877 PROXY=http://127.0.0.1:4877 CLOCKWORK_HOME=$TDIR \
    ./packages/daemon/node_modules/.bin/tsx packages/ui/e2e/smoke/diff-fps-trace.ts

Result (real output, exit 0):

  ✓ j selects the run and opens its report — Perf diff run
  ✓ e expands the virtualized diff
  frames=408 avgFps=117.6 p95=9.2ms longtasks=0 inp=0.0ms domRows=42
  ✓ virtualized window stays small (<120 rows for 10k lines) — rows=42
  ✓ avg fps >= 55 (Linear 60fps bar) — 117.6
  ✓ p95 frame < 33ms — 9.2ms
  ✓ INP < 200ms (Raycast open bar) — 0.0ms

  DIFF-FPS-TRACE: ALL CHECKS PASSED

Artifacts: playwright-trace-diff-fps.zip (4.6 MB, 1440x900, screenshots+snapshots)
held outside the repo (temp dir, not committed — binary). Re-run the command
above to reproduce; thresholds live in packages/ui/e2e/smoke/diff-fps-trace.ts.
