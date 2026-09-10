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

  version "0.12.1"
  # The intel digest is a PLACEHOLDER, and deliberately 64 zeroes rather than
  # prose. No Intel DMG exists yet — v0.11.0, v0.11.1 and v0.11.2 each
  # published aarch64 only — and the first one comes out of the next tag built
  # by release.yml's two-leg matrix. Zeroes are the placeholder that gets
  # CAUGHT if this file is published early: homebrew-tap-drift.yml reads every
  # 64-hex token out of the live tap and fails when one is absent from the
  # release's checksums-sha256.txt, while a "TBD" would not parse as a hash at
  # all and would slip past it.
  #
  # DO NOT copy this cask to the tap until the intel digest is real.
  # `packaging/stage-release.sh` cannot fill it in yet: it hashes the aarch64
  # DMG only, and its sed matches `^  sha256 "` — a single digest at two-space
  # indent — so against the two-digest form below it silently changes nothing.
  sha256 arm:   "fecea5550d2b8c69ae9bf7dcb9d08426b41cbfe8c4aa00db88c2bf62e1c95455",
         intel: "8cfaca686d059298ce9871130998f96611fd113a5c54e2077e90ac6a088fbf5a"

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

    You do need at least one provider CLI you are already logged into
    (claude, codex, opencode or hermes) on your PATH.
  EOS

  zap trash: [
    "~/.clockwork",
    "~/Library/Application Support/com.clockwork.app",
    "~/Library/Saved Application State/com.clockwork.app.savedState",
  ]
end
