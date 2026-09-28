# Multi-machine workers

One daemon can lend its runner to another. The typical shape: the laptop holds
the calendar and the inbox; an always-on Mini (or homelab box) executes the
overnight jobs. No Clockwork-hosted relay exists anywhere in this path — the
two daemons talk over your own tunnel (Tailscale, WireGuard, or plain LAN).

## Pairing a worker

Everything happens in **Settings › Workers** on the two machines. No
terminal is needed. The primary is the machine that holds your tasks; the
worker is the one that will run them.

1. **On the worker**, find **This machine’s worker key**. If it says there
   is no identity yet, press **Create identity**. Press **Copy key**. The
   private key stays on the worker (0600) and never prints or leaves.
2. **On the primary**, under **Pair new worker**, type a name, paste the
   key, and press **Start pairing**. The primary shows a **nonce** (10
   minutes, single use). Press **Copy nonce**.
3. **On the worker**, under **Claim a pairing**, paste the primary’s URL
   (for example `http://laptop.tailnet:4747`) and the nonce, and press
   **Claim**. The worker signs the nonce with its own key and sends only
   the signature and its public key. The primary records the identity but
   issues nothing yet.
4. **On the primary**, press **Approve** on the worker’s row. The primary
   shows the bearer token, exactly once. Copy it.
5. **On the worker**, under **Join another daemon**, the URL is already
   filled in from step 3. Paste the token and press **Join**. It is saved
   0600 to `worker.json` and takes effect without a restart. The worker
   polls every 30 seconds; its next poll sends a heartbeat. Reopen
   **Settings › Workers** on the primary to see it marked **online**.

A valid signature alone never earns a token. Approval waits for a verified
claim; claiming waits for an operator-started pairing. If Claim is refused,
the card says why and what to do next (for example: the nonce expired or
was already used, so press **Start pairing** again).

Headless workers can skip step 5’s form: set `CLOCKWORK_WORKER_PRIMARY` and
`CLOCKWORK_WORKER_TOKEN` in the worker’s environment instead. Env wins when
both exist. `clockworkd worker-key` still mints the same key file from a
terminal, for the same case.

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
