# Multi-machine workers

One daemon can lend its runner to another. The typical shape: the laptop holds
the calendar and the inbox; an always-on Mini (or homelab box) executes the
overnight jobs. No Clockwork-hosted relay exists anywhere in this path — the
two daemons talk over your own tunnel (Tailscale, WireGuard, or plain LAN).

## Pairing a worker (three human-visible steps)

1. On the worker, run `clockworkd worker-key`. It prints the worker's ed25519
   public key (DER hex) and stores the private key 0600 beside it. The private
   key never prints.
2. On the primary, **Settings › Workers → Pair new worker**: name it, paste
   the pubkey. The primary shows a **nonce** (10 minutes, single use) — hand
   it to the worker (paste it into the worker's environment or config).
3. The worker claims with its signature. The primary records the identity but
   issues nothing yet. **Approve** on the primary — only then does it return
   the bearer token, exactly once, for the worker's configuration
   (`CLOCKWORK_WORKER_TOKEN`, primary URL in `CLOCKWORK_WORKER_PRIMARY`).

A valid signature alone never earns a token. Approval waits for a verified
claim; claiming waits for an operator-started pairing.

## Routing tasks

- **No pin**: runs locally, as before.
- **Pinned, worker online**: the run is created with the pin and waits for
  the worker to pull it. The local pump never touches it.
- **Pinned + required, worker silent**: the run waits (the queue says what it
  waits on). Deleting a worker never reroutes onto the laptop silently.
- **Pinned + preferred, worker silent**: runs locally, with a
  `worker_fallback` event on the run saying so.
- **Unknown pin**: refused at save — a typo cannot strand a task.

Set pins in Settings › Workers (task picker + required toggle), or
`PATCH /tasks/:id {"workerPin","workerRequired"}` over the API.

## What the worker needs

- The **same repositories at the same paths** (same username, shared
  checkout, or synced tree). A job whose repo is missing on the worker is
  **declined loudly** (`worker_declined`), never executed elsewhere and never
  silently requeued.
- Its own provider CLI logged in (it executes under its own sandbox with its
  own subscription or key).
- Reachability to the primary's loopback port through your tunnel.

## When things go wrong (stated, not hidden)

- **Worker silent 90s** (three missed heartbeats): marked silent; runs it
  claimed but never reported **fail as `worker_lost`** — a run that may or
  may not have executed is never reported complete. Unpulled queued rows stay
  put. One notification names the worker and the count.
- **Revoke**: token dies immediately; queued-unpulled rows come home to the
  local pump; claimed rows fail as `worker_lost`.
- **Token leak**: revoke and re-pair. Tokens are sha256-stored; the only
  plaintext copy is the one shown at approve time.
- **Two workers, one job**: the pull claim is atomic — the loser gets "no
  job", never the same job.
- **Primary restarts**: worker rows, pins and tokens persist in SQLite; the
  worker's next heartbeat marks it online again. Runs the worker finished but
  never reported stay claimed until the sweep marks them lost — report
  delivery is at-most-once per side, and the sweep is the tiebreaker.
