# `clockwork` terminal CLI

The inbox and task list for terminal natives: same loopback API the GUI
uses, same bearer token, same refusals. Anything here can also be done in
the app, and anything refused here is refused there too.

## Install

**From the cask** (once a release ships `Contents/Resources/app/bin/clockwork`
— see the note in `packaging/homebrew/clockwork.rb`): `brew install --cask
clockwork` puts `clockwork` on PATH. It runs the Node bundled inside
`Clockwork.app`, so no system Node is required.

If your installed app predates that wrapper (every DMG through 0.14.0), run
the bundled CLI directly with the app's own Node:

```bash
/Applications/Clockwork.app/Contents/MacOS/node \
  /Applications/Clockwork.app/Contents/Resources/app/packages/daemon/dist/clockwork-cli.js status
```

No install step while running from source:

```bash
pnpm --filter @clockwork/daemon build
node packages/daemon/dist/clockwork-cli.js status
```

Or link it onto your PATH once: `pnpm --filter @clockwork/daemon exec npm link`
(uses your shell's npm prefix), then `clockwork status` works anywhere.

`clockwork --help`, `clockwork help` and a bare `clockwork` all print usage
without needing an api token — useful before `clockworkd` has ever run.

## Tour

```bash
$ clockwork status
clockworkd 0.14.1
paused: no · active: 0 · queued: 2
next: Sep 28, 02:00 AM

$ clockwork runs
RUN         STATUS     TASK              COST    WHEN
…f3a21bc    waiting    Security audit    $0.00   Sep 28, 02:14 AM
…8c21bb99   completed  Engineering sync  $1.20   Sep 27, 09:41 PM

$ clockwork approvals
ID          KIND        RUN         WAITING SINCE
…a91fd001   permission  …f3a21bc    Sep 28, 02:14 AM

$ clockwork approve a91fd001 --note "tests green, go"
✓ Approved a91fd001
$ clockwork run task-triage --json
{"runId":"run_…"}
```

`show <run-id>` prints the report and accepts any run id that is unique by a
prefix or a suffix, not only the full id (ambiguous ones list every match);
`open <run-id>` prints the branch checkout (it never launches an editor —
output is text you can pipe); `tasks`, `queue`, `agents`, `workers` list their
panes; `approve --deny` denies.

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
