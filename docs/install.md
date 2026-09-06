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

## Verifying the download (please actually do this)

Clockwork is **not notarised by Apple**. An Apple Developer certificate costs
$99/year and this is an early build, so the app is ad-hoc signed. macOS adds a
quarantine flag to anything downloaded from the internet and will refuse to open
an unsigned app until that flag is cleared — often with a misleading message
saying the app is "damaged".

That is a real trade-off, not a formality. Clearing quarantine tells your Mac you
trust this specific binary, so verify it first:

```bash
# 1. Check the hash matches the published one
shasum -a 256 ~/Downloads/Clockwork_0.8.0_aarch64.dmg
curl -s https://clockwork.vmoksh-shah179.workers.dev/downloads/checksums-sha256.txt
```

If those two do not match, **stop** — do not install it, and report it.

```bash
# 2. Install: open the DMG and drag Clockwork to Applications, then
xattr -dr com.apple.quarantine /Applications/Clockwork.app

# 3. Launch
open -a Clockwork
```

### Homebrew does this for you

```bash
brew tap vimoxshah/clockwork
brew trust vimoxshah/clockwork
brew install --cask clockwork
xattr -dr com.apple.quarantine /Applications/Clockwork.app
```

Homebrew verifies the SHA-256 from the cask before installing, so the bytes are
checked for you. It cannot skip quarantine — Homebrew 6 removed
`--no-quarantine`, and `HOMEBREW_CASK_OPTS` does not accept it either — so you
still clear the flag by hand. The difference is that you are clearing it on a
binary whose hash was already verified, rather than on a file you downloaded and
never checked. That is why this is the recommended path.

### What Clockwork can reach once installed

Worth knowing before you clear quarantine on any tool that runs unattended code:

- Agent runs execute inside a macOS Seatbelt sandbox, in a per-run git worktree.
  Writes are restricted to that worktree.
- Credential paths — `~/.ssh`, `~/.aws`, `~/.gnupg`, browser cookies, shell
  history — are denied to the run, and the run environment is an allowlist that
  does not forward `SSH_AUTH_SOCK` or any provider token.
- The daemon binds `127.0.0.1` only and is never exposed to your network.
- Your provider API keys stay in the macOS Keychain.

These are enforced and tested, not aspirational — see `packages/runner/test/`.
