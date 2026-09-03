# Troubleshooting

## Daemon won't start / "single instance"

Another clockworkd is running or the port is bound:

```bash
node packages/daemon/dist/cli.js doctor
launchctl kickstart -k gui/$(id -u)/com.clockwork.daemon   # restart the service
```

A stale `~/.clockwork/daemon.lock` from a crashed daemon is detected and taken
over automatically when the recorded pid is dead.

## "Not logged in" / failed:auth

Runs ride your Claude Code login. Open a terminal, run `claude`, log in once,
then re-enable the task. After two consecutive auth failures Clockwork pauses
the task and notifies you (S-40) — re-enable it after fixing auth.

## A run didn't fire overnight

The honest answer first: **runs execute only while the machine is awake.**
Check the inbox for a missed-run report ("skipped — machine slept" or "ran Xm
late"). Keep-awake arms when plugged in; closing the lid on battery defeats it.
For true overnight jobs, use an always-on machine.

## Run ended with budget_exceeded

The USD soft cap is enforced between agent messages; the report shows where it
stopped and the measured overshoot. Raise the task's budget or narrow the
prompt. Turn caps are hard bounds — same report path.

## Worktree left behind / unknown directories

After crashes, startup reconciliation lists unknown worktrees in settings
(quarantine) rather than deleting them. Verify, then remove manually:

```bash
git worktree list          # inside the affected repo
rm -rf ~/.clockwork/worktrees/<task>/<run-id>
```

## Delivery to Telegram/webhook failed

Delivery failures never affect run outcomes (S-43); they appear as receipts in
the report footer after 3 retries. Check tokens (`CLOCKWORK_DELIVER_` env vars
or `~/.clockwork/delivery-creds.json`) and network reachability.

## UI shows "Connect to daemon"

The UI needs the API token: `cat ~/.clockwork/api-token` and paste it into the
connect screen. Tokens rotate if you delete the file and restart the daemon.

## License / plan problems

- **"License verification is not yet enabled in this build"** — the public
  key isn't configured in this binary (pre-release builds). Nothing is wrong
  with your key; wait for a build that supports activation.
- **"This license key is not genuine"** — the token doesn't match Clockwork's
  signing key. Re-download from the official site; if it persists, contact
  support with your order id.
- **App shows "Reconnecting needed"** — your subscription couldn't be
  revalidated recently. Everything still works during grace; reconnect to the
  internet and restart the app to clear it.
- **Back on Free after an expiry** — renew, then Settings → Plan & license →
  activate the fresh key from your receipt. Tasks, runs, keys, and history are
  never touched by licensing state.

## Reset everything (nuclear)

```bash
node packages/daemon/dist/cli.js uninstall
rm -rf ~/.clockwork    # deletes tasks, reports, transcripts — export first!
```

## Still stuck?

Email **vmoksh.shah179@gmail.com** with:

- what you ran and what happened
- your macOS version and chip (`uname -m`)
- the daemon version from the app footer
- `curl -s http://127.0.0.1:4747/health` output if the daemon is up

A support bundle helps most — Settings → Export diagnostics. It contains
versions, provider connection states and counts, and deliberately no
credentials: API keys never leave the Keychain and are not included.
