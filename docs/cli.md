# `clockwork` terminal CLI

The inbox and task list for terminal natives: same loopback API the GUI
uses, same bearer token, same refusals. Anything here can also be done in
the app, and anything refused here is refused there too.

## Install

No install step while running from source:

```bash
pnpm --filter @clockwork/daemon build
node packages/daemon/dist/clockwork-cli.js status
```

Or link it onto your PATH once: `pnpm --filter @clockwork/daemon exec npm link`
(uses your shell's npm prefix), then `clockwork status` works anywhere.

## Tour

```bash
$ clockwork status
clockworkd 0.13.0
paused: no · active: 0 · queued: 2
next: Sep 28, 02:00 AM

$ clockwork runs
RUN       STATUS     AGENT    COST    WHEN
9f3a21    waiting    Securit  $0.00   Sep 28, 02:14 AM
8c21bb    completed  Enginee  $1.20   Sep 27, 09:41 PM

$ clockwork approvals
ID        KIND        RUN       WAITING SINCE
a91f      permission  9f3a21    Sep 28, 02:14 AM

$ clockwork approve a91f --note "tests green, go"
✓ Approved a91f
$ clockwork run task-triage --json
{"runId":"run_…"}
```

`show <run-id>` prints the report; `open <run-id>` prints the branch
checkout (it never launches an editor — output is text you can pipe);
`tasks`, `queue`, `agents`, `workers` list their panes; `approve --deny`
denies.

## Scripting

- `--json` prints exactly one JSON value to stdout; human tables never mix
  in. Errors always go to stderr.
- Exit codes: `0` ok · `1` usage/validation · `2` daemon unreachable or bad
  credentials · `3` not found · `4` refused (gate/conflict) or daemon error
  (HTTP 5xx, named in the message). `--note` takes exactly one shell word —
  quote it. Errors always go to stderr.
- Example — page nothing, fail loudly in cron:
  `clockwork approvals --json | jq length`

## Auth and scope

Reads `~/.clockwork/api-token` (0600, `CLOCKWORK_HOME`-aware) and speaks to
`127.0.0.1:4747` (`--port` / `CLOCKWORK_PORT` override). The token never
prints, even with `--json`. Destructive surface is deliberately small:
answering approvals and queueing runs; everything else reads. Pairing
workers, editing tasks and managing credentials stay in the app.
