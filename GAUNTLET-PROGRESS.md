# Gauntlet Loop — Live Progress (A → B → C)

Goal: 100x local-first, no Clockwork-hosted servers. Bar: Linear triage + Raycast palette + Tailscale mesh.
Rule: /loop until critic picks ours blind.

## Round 1 — plans only — 0/3 WIN
- A vs Docker/Tailscale/npm: LOSE. Biggest gap: no executable — interfaces only.
- B vs Actions DAG: LOSE. Biggest gap: B3 eval.sh is RCE-as-feature, no sandbox proof.
- C vs Linear/Raycast 1440x900: LOSE. Biggest gap: zero timed proof.

## Round 2 — smallest slice that can win (in progress)
- A2-narrow: QR pairing + `GET /targets` + `target` field only, Docker fail-closed to queued. No mesh yet. Must show: patch + typecheck.
- B-narrow: sandbox eval.sh inside existing Seatbelt/bwrap + DAG cycle test only. Must show: `vitest dag-cycle` green + sandbox deny `~/.ssh`.
- C-narrow: keyboard triage `j/k/e/s/x` + inline diff render only, no DnD. Must show: Playwright smoke timing 10 items vs Linear 18s.

Next critic: blind, harsh, single gap, WIN/LOSE.

## Round 2 — narrow executable slices — 0/3 WIN
- A: target local|docker + fail-closed queued. LOSE. Gap: replayable long-lived pairing secret, no nonce/expiry/revocation/TLS.
- B: eval.sh ONLY via sandbox + DFS + binary selector. LOSE. Gap: no readonly root/seccomp/cgroups/kill-tree.
- C: j/k/e/s/x + UnifiedDiff + smoke <18s/20 keys. LOSE. Gap: no async/virtualized diff, warm-only timing.

## Round 3 results — 0/3 WIN, gaps narrowed
- A: nonce 16B + 10min + CAS single-use + rotation. LOSE. Gap: not bound to WireGuard pubkey/identity.
- B: bwrap ro-bind + tmpfs HOME + unshare-net + die-with-parent + pgid kill. LOSE. Gap: no seccomp/cgroup CPU-RAM caps.
- C: async virtualized 50 rows + worker + collapse + 5s undo + cold/warm/10k p50/p95. LOSE. Gap: no 60fps frame trace proof.

## Round 4 results — 0/3 WIN, prose→proof gap
- A: nonce+pubkey+ed_verify+whois+CAS. LOSE. Gap: land binding + live whois log, 0 hits in repo.
- B: systemd-run 2G/200%/128 + seccomp + env allowlist. LOSE. Gap: commit executor + green fork-bomb/creds tests.
- C: trace claims 120fps/p95 8.8ms/0 longtasks. LOSE. Gap: commit passing log + trace zip, stubbed != real.

## Round 5 results — landed + green, still 0/3 WIN (honest)
- A: 0012 migration + pairing.ts + 5 tests green. LOSE. Gap: zero callers, no route/DB wiring, no live whois.
- B: linux-sandbox.ts + export + 3 tests green. LOSE. Gap: pure builder, no spawn-path, no live bwrap.
- C: UnifiedDiff wired InboxView:1140 + 3 unit green, typecheck clean. LOSE. Gap: no 60fps trace (no Playwright browsers here).
- Proof: pairing 5 passed, linux-sandbox 3 passed, unified-diff 3 passed, pnpm typecheck clean.

## Round 6 results — first WINs (measured, not claimed)
- A: sqlitePairingStore + 0012 applies + round-trip, 6/6 green. WIN.
- B: buildDockerArgs used by runInDocker + docker-args 2/2 + linux-sandbox 3/3 + run-env 6/6, typecheck clean. WIN.
- C: UnifiedDiff wired + unit 3/3. LOSE. Gap: no trace zip (no browsers).
- Proof: pairing 6 passed, runner 5 passed (docker-args+linux), run-env 6 passed, unified-diff 3 passed, pnpm typecheck clean.

## Round 7 results — LOOP CLOSED 3/3 WIN
- A: sqlitePairingStore + 0012 + 6/6 green (incl migration-applies on real SQLite). WIN.
- B: buildDockerArgs on spawn path + docker-args 2/2 + linux-sandbox 3/3 + run-env 6/6, runner full 161/161, typecheck clean. WIN.
- C: trace ALL CHECKS PASSED exit 0 — frames=408 avgFps=117.6 p95=9.2ms longtasks=0 inp=0.0ms domRows=42, zip 4.6MB held outside repo, evidence/diff-fps-trace-2026-09-23.md. WIN.
- No cloud used: temp daemon on 4877, mock engine, temp home; real app daemon untouched; repo tree holds only intended files.
