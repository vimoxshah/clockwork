# Bring your own runner — design

Iteration 4. Replaces the hosted-execution plan that iteration 3 dropped.

## Why hosted execution was dropped

Clockwork's security promise is that the provider key never leaves the user's
machine. `packages/daemon/src/byok.ts` implements this literally: credentials
live in the macOS keychain via the `security` CLI, and
`run-manager.ts:732` reads one only at dispatch time to inject
`CW_BYOK_KEY` into the run's child-process environment.

A Clockwork-hosted runner would need that key. Every mitigation — scoped
keys, per-run tokens, explicit consent — still ships it off the machine. It
is not a blocker to engineer around; it is the promise negated.

## The reframe

**"Bring your own runner" is not a remote *executor*. It is a remote
*daemon*.**

That distinction is the whole design. Consider the two shapes:

| | Where the key lives | Does it transit? |
| --- | --- | --- |
| Remote executor — local daemon dispatches work to a remote box | local keychain | **yes — fatal** |
| **Remote daemon — the whole daemon runs on the user's box** | that box's own store | **no** |

Only the second preserves the promise. The trust boundary *relocates* to a
machine the user already controls; it never widens. Clockwork never holds a
credential in either shape, and in the second nothing crosses the wire but
task data the user already owns.

Concretely: the user runs `clockworkd` on a spare Mac, a Linux box, a VPS, or
their own cloud account. The desktop app becomes a client pointing at it.
The 3am job runs at 3am because that machine is awake — not because
Clockwork hosts anything.

## Why this is close to shipping

Three properties already hold:

1. **The UI is already an HTTP client.** It talks to the daemon over
   `127.0.0.1:4747` and does not share process memory with it.
2. **Bearer-token auth already exists** on every data route
   (`api.ts:84`). The authorization model does not need inventing.
3. **A no-keychain credential path already exists.** `byok.ts` supports
   `auth: 'env'` alongside `auth: 'keychain'` — a headless runner reads its
   key from its own environment. This is exactly the mechanism a remote
   daemon needs, and it is already built and already used.

## What is actually missing

Honest gap list, each verified against the code:

| # | Gap | Evidence | Severity |
| --- | --- | --- | --- |
| 1 | Daemon binds loopback only | `main.ts:91` — `host: '127.0.0.1'` hardcoded | blocks |
| 2 | No TLS | plain HTTP; a bearer token on a LAN or WAN is sniffable | blocks |
| 3 | SSE authenticates by query parameter | `api.ts:95` — `EventSource` cannot set headers, so the token rides in the URL | blocks over a network |
| 4 | No pairing flow | token is read from a file on the same host | blocks |
| 5 | UI has no notion of a remote daemon address | assumes same origin | blocks |

Gap 3 deserves emphasis. It was accepted as a **v1 risk on loopback** and
recorded during an internal validator review. That
acceptance does not survive this change: a token in a URL reaches proxy logs,
browser history and referrers. **Remote support cannot ship until SSE auth
moves out of the query string.** This is the one place where the existing
deferral becomes a real vulnerability rather than a tolerable one.

## Proposed shape

```
  Desktop app  ──TLS + bearer──▶  clockworkd on YOUR machine
   (client)                        ├─ own keychain / env credential
                                   ├─ own git worktrees
                                   └─ own provider calls
```

Sequencing, cheapest-first:

1. **Opt-in bind address.** `--host` flag, default unchanged at `127.0.0.1`.
   Loopback stays the default forever; exposure is always a deliberate act.
2. **Fix SSE auth** (gap 3) before any non-loopback bind is permitted. The
   two should ship in the same change so the insecure combination never
   exists in a release.
3. **TLS.** Self-signed with a pinned fingerprint shown at pairing is
   adequate for a single-user tool and avoids a certificate authority.
4. **Pairing.** Short-lived code displayed by the daemon, entered once in the
   app, exchanged for the long-lived token.
5. **Remote address in the UI**, with the connected host always visible so a
   user is never unsure which machine is executing their code.

## What this does NOT solve

- **It is not a product for people without a spare machine.** That is a real
  segment and this design abandons it deliberately, because serving it means
  hosting, and hosting means holding keys.
- **It generates no recurring revenue by itself.** Hosted execution had COGS
  and therefore a defensible subscription. This has almost none, which is
  good for the user and removes the pricing story iteration 3 built. The
  monetization question is reopened, not answered, by this document.
- **It is unvalidated.** No user has asked for this. It resolves a
  contradiction we identified ourselves. Whether developers want it is
  exactly what the interviews should establish before any of it is built.

---

# Amendment after security review (§65/§66)

Hermes reviewed this design and returned **REDESIGN**. It is right, and the
sequencing above is wrong. Recorded rather than quietly edited, because the
error is instructive.

## The design solved the wrong problem

Hermes: *"The design treats this as a transport security problem and ignores
that it's an endpoint security and authorization problem... The daemon's job
is to execute arbitrary code on a host that holds a secret. The security
model should start with 'what is the minimum privilege the daemon needs, how
is it constrained, what happens when auth fails, and how is abuse detected?'
Instead the design starts with 'how do we let the desktop app reach the
daemon over the network.'"*

Every step in the sequence above — bind flag, SSE fix, TLS, pairing, host
display — secures the *connection*. **None of them constrain what happens
once a connection is established.** Building them first would feel like
progress while the real risk was untouched.

`Severity: high.`

## Blast radius, stated plainly

`Severity: critical.` If someone reaches this daemon they get arbitrary code
execution on a host that holds a provider API key, with the daemon's full
filesystem privileges. Nothing in the design limits that. The worktree
sandbox constrains *the agent's* workspace; it does not constrain an attacker
who reaches the control plane and can simply book a task.

This is materially worse than the loopback case, where reaching the daemon
already implies local access.

## The consideration that was entirely absent

The desktop app is a local tool. **A remote daemon is a long-lived network
service** that must be patched, updated and monitored on a machine the user
may forget exists. It needs its own update mechanism — and that mechanism is
itself a supply-chain path to every connected client. Nothing above
acknowledged this.

## Corrected sequence

Authorization and containment come first; transport is necessary but not
sufficient.

1. **Threat model the daemon as a network-exposed code-execution service**,
   not as an app with an HTTP interface. This reframing drives the rest.
2. **Least privilege.** Dedicated non-root user, constrained by sandbox or
   container, explicit filesystem and network policy.
3. **Authorization scope.** Today the bearer token is all-or-nothing: holding
   it means booking arbitrary code execution. Remote exposure needs scoped
   capabilities and a token lifecycle — expiry, rotation, revocation — none
   of which exist.
4. **Audit and anomaly detection.** Every executed command attributable. An
   `audit_log` feature already exists in the registry; this is where it earns
   its place.
5. **Update mechanism** for the daemon, designed before exposure, treating
   the update channel as the high-value target it is.
6. *Then* transport: SSE auth fix, TLS, pairing, bind flag, host display —
   with SSE still strictly before any non-loopback bind.

## Status

**This design is not ready to build.** The reframing is sound — remote daemon
rather than remote executor genuinely preserves the key promise — but it sits
on an incomplete security model. Steps 1–5 must be designed before step 6 is
worth writing.

It also remains unvalidated as a *product*: no user has asked for it. It
resolves a contradiction we identified ourselves, and whether developers want
it is what the interviews should establish first.
