# Installing Clockwork on macOS

## The short version

1. Download `Clockwork-<version>-aarch64.dmg` from
   [Releases](https://github.com/vimoxshah/clockwork/releases/latest) (Apple Silicon, macOS 14+).
2. Verify integrity (recommended):
   ```bash
   shasum -a 256 ~/Downloads/Clockwork-*-aarch64.dmg
   # compare with checksums-sha256.txt attached to the release
   ```
3. Open the DMG and drag **Clockwork** into **Applications**.
4. Launch Clockwork.
5. Pair the UI with your local daemon: paste the token from `~/.clockwork/api-token`
   (printed during first daemon setup).

## Gatekeeper & signature status — read this honestly

Clockwork is distributed **directly**, not through the Mac App Store.

- If a release is **signed and notarized** (releases built after Apple Developer
  credentials are configured in CI), it launches normally: macOS verifies the
  notarization ticket silently.
- If a release is **unsigned** (early releases), macOS will say the app "cannot
  be opened because Apple cannot check it for malicious software". This is
  expected for unsigned direct downloads. To open it once:
  right-click (or Control-click) Clockwork.app → **Open** → **Open**. Or approve
  it under **System Settings → Privacy & Security → Security**, which shows an
  "Open Anyway" button after a blocked launch attempt.

We will always tell you which kind of release you're downloading — check the
release notes' "Signature status" section. Do not disable Gatekeeper globally.

## After launch

1. Clockwork needs the local daemon (`clockworkd`) running — the app walks you
   through first-run setup, or run:
   ```bash
   git clone https://github.com/vimoxshah/clockwork && cd clockwork
   pnpm install && pnpm build
   node packages/daemon/dist/main.js
   ```
2. Install at least one provider CLI and log in once:
   - [`claude`](https://docs.anthropic.com/en/docs/claude-code) (recommended)
   - `codex`, `opencode`, or [`hermes`](https://github.com/NousResearch/hermes-agent)
3. Check **Settings → Providers** — each installed engine shows its version and health.
4. Optional: connect your personal calendar (**Settings → Calendars**) via a
   read-only ICS subscription URL.

## Permissions Clockwork itself requests

The desktop app runs as a normal user process. It does not ask for screen
recording, accessibility, or full-disk access. Agent runs execute inside
sandboxed worktrees whose file writes are restricted by macOS Seatbelt; SSH
keys and credential stores are deliberately unreadable from within a run.

## Uninstall

Quit Clockwork, then drag it from Applications to Trash. Data lives in
`~/.clockwork/` — delete that folder to remove all tasks, runs, and reports.
