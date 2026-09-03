# Clockwork — sandbox, deny list, run env

[Clockwork](https://clockwork.vmoksh-shah179.workers.dev) runs AI coding agents
unattended against your repositories. That is a lot to ask of a tool you just
downloaded, so the parts that decide what an agent can reach are published here
under Apache-2.0.

**These files are open source. The Clockwork application itself is proprietary.**
This repository is not the product; it is the security boundary, extracted so
you can read it and run its tests.

## What is here

| File | What it decides |
| --- | --- |
| `src/sandbox.ts` | The macOS Seatbelt profile: what a run may read, write and execute |
| `src/deny-list.ts` | Commands and paths refused before a run starts |
| `src/run-env.ts` | The environment allowlist — why `SSH_AUTH_SOCK` never reaches a run |
| `src/service-path.ts` | PATH augmentation (a LaunchAgent starts with almost none) |

Four test files exercise them.

## Run the tests

```bash
npm install
npm test
```

Requires **macOS** and Node 22+. The sandbox tests shell out to the real
`sandbox-exec`; they cannot be meaningfully run on Linux or Windows. CI runs
them on `macos-latest` on every push, so there is a public record of the suite
passing on a machine none of us controls.

## What these tests actually prove

They are written to fail loudly, not to look reassuring. Each one plants the
violation it is meant to catch:

- `sandbox-credentials` writes a fake secret into `~/.ssh`, `~/.aws`, `~/.gnupg`
  and friends, then runs a real `cat` **inside the sandbox** and asserts it
  fails. If the deny list stopped working, this test would notice.
- `control-plane-escape` does the same for Clockwork's own API token and
  database — a run that could read those could grant itself anything.
- `run-env-allowlist` feeds the env builder a hostile environment (ssh-agent,
  AWS keys, provider tokens, `NODE_OPTIONS`, `LD_PRELOAD`,
  `DYLD_INSERT_LIBRARIES`, proxies) and asserts what survives. It checks leaked
  **values**, not just key names, so a variable copied under a different name is
  still caught.
- `deny-list` covers the pre-flight command and path checks.

## What they do NOT prove

Being straight about the limits, because a security claim you cannot check is
just marketing:

- **This repository cannot prove the shipped binary runs this code.** You are
  reading source; the app is a signed-ish DMG built from a private repository.
  A test in that private repo asserts these files stay byte-identical to the
  ones the app builds from, and each sync commit records the source revision
  below — but that is a process, not a proof. If you need certainty, build from
  source is not currently an option, and you should weigh that.
- **The Seatbelt profile permits `system-socket`.** The ssh-agent claim holds
  because of the env allowlist, not the sandbox. An earlier internal audit got
  this exactly backwards and "verified" the claim against the wrong
  environment. `src/run-env.ts` documents it.
- **Writes are confined to a per-run git worktree**, not to nothing. An agent
  can still change files it was asked to change.
- These tests cover this boundary only. They say nothing about the rest of the
  application.

## Found a hole?

Please tell me before telling the internet: **vmoksh.shah179@gmail.com**. A
reproduction against these tests is the fastest possible bug report, which is
much of the reason this repo exists.

---

<!-- SYNC-MARKER: do not edit by hand; written by packaging/sync-public-sandbox.sh -->
<!-- The revision below is a commit in Clockwork's PRIVATE repository. You cannot
     resolve it, and it is not meant to be a link — it exists so a specific
     published copy can be traced back to the exact source it came from. -->
SYNCED_FROM: clockwork@883c2c0
