cask "clockwork" do
  # T1-2 — one cask, both Macs. `arch` maps the machine Homebrew is running on
  # onto the string tauri-bundler writes into the DMG name (aarch64 / x64), and
  # `sha256` takes one digest per architecture. These two stanzas ARE the
  # on_arm/on_intel mechanism rather than an alternative to it: both set
  # Homebrew's own `@on_system_blocks_exist` flag, in `def arch` and
  # `def sha256` (Library/Homebrew/cask/dsl.rb), so the cask carries the same
  # per-architecture branch with one url and one caveats block instead of two
  # of each. `arch` sits above `version` because that is the stanza order
  # Homebrew's own cop enforces (rubocops/cask/constants/stanza.rb).
  arch arm: "aarch64", intel: "x64"

  version "0.14.0"
  # Both digests are real (checked into checksums-sha256.txt on the v0.14.0
  # release) — the two-leg build matrix has published an Intel DMG since
  # 0.12.0. An earlier revision of this comment warned that the intel digest
  # was a 64-zero PLACEHOLDER; that stopped being true once the Intel leg
  # shipped, and the warning outlived the condition it described.
  sha256 arm:   "9d3ad5a7b943ada2f7f643392c4a795d439a0d91bc3d7ea4980061d2399600a9",
         intel: "9fc914bda182c10f674eee5f7801a31e7fba8f7f626fbb553c7fb89ee41876bd"

  # Straight from the GitHub release, which is where the artifact and its
  # published checksum canonically live. It used to point at the marketing
  # site's own /downloads copy, and that mirror is updated by a separate
  # deploy — so between publishing a release and redeploying the site, this
  # url 404'd and every `brew install --cask clockwork` failed. One source.
  url "https://github.com/vimoxshah/clockwork/releases/download/v#{version}/Clockwork_#{version}_#{arch}.dmg"
  name "Clockwork"
  desc "Calendar that schedules AI coding agents in sandboxed git worktrees"
  homepage "https://vimoxshah.github.io/clockwork/"

  # Ventura, matching the app's own LSMinimumSystemVersion (13.0).
  #
  # A `depends_on arch: :arm64` line stood beside it until T1-2. It was true of
  # every release up to 0.11.2, and it is the one line that would refuse the
  # Intel install this cask now offers — so it goes with the change that makes
  # the Intel DMG exist, not after someone reports that brew skipped their Mac.
  depends_on macos: :ventura

  app "Clockwork.app"

  # `clockwork` on PATH (BUN-3): symlinks this file into the Homebrew prefix
  # bin dir. It is a thin wrapper, staged by tools/stage-bundle.mjs, that execs
  # the app's own bundled Node against its own bundled CLI entry point — no
  # system Node required. bundled-resources-staged.test.ts guards that the
  # staging script actually places a file at this exact path.
  #
  # DO NOT sync this stanza to the published tap until a release DMG contains
  # Contents/Resources/app/bin/clockwork. Every DMG through 0.14.0 predates
  # this wrapper: `binary` only symlinks — it does not check the target
  # exists — so `brew install` would succeed and leave `clockwork` a dangling
  # link. docs/cli.md names the full command that works on those installs.
  binary "#{appdir}/Clockwork.app/Contents/Resources/app/bin/clockwork"

  # The build is not notarised — an Apple Developer certificate is $99/year and
  # this is an early release. Homebrew 6 removed --no-quarantine and
  # HOMEBREW_CASK_OPTS does not accept it either, so quarantine is always
  # applied and the user clears it afterwards. Homebrew still verifies the
  # sha256 above, so this is a binary whose hash was checked for you.
  caveats <<~EOS
    Clockwork is not notarised by Apple yet, so macOS quarantines it.

    Clear the flag before first launch:
      xattr -dr com.apple.quarantine /Applications/Clockwork.app

    From 0.11.0 this cask installs everything: the app carries the daemon and
    its own Node runtime, and registers a background agent on first launch.
    There is nothing else to install and no token to paste.

    The `clockwork` terminal CLI is on your PATH now too — try `clockwork
    status` once the app has launched at least once.

    You do need at least one provider CLI you are already logged into
    (claude, codex, opencode or hermes) on your PATH.
  EOS

  zap trash: [
    "~/.clockwork",
    "~/Library/Application Support/com.clockwork.app",
    "~/Library/Saved Application State/com.clockwork.app.savedState",
  ]
end
