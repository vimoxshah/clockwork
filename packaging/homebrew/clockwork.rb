cask "clockwork" do
  version "0.11.0"
  sha256 "53b9780c1452479f03457bec7578a778aea74c8d8a9a60cd04f7143dfe84b6c0"

  url "https://clockwork.vmoksh-shah179.workers.dev/downloads/Clockwork_#{version}_aarch64.dmg"
  name "Clockwork"
  desc "Calendar that schedules AI coding agents in sandboxed git worktrees"
  homepage "https://clockwork.vmoksh-shah179.workers.dev/"

  depends_on macos: :sonoma
  depends_on arch: :arm64

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

    This cask installs the WINDOW, not the daemon behind it. Clockwork is a
    native frame around a local daemon that serves the interface and API on
    127.0.0.1:4747, and the daemon is installed from source:

      git clone https://github.com/vimoxshah/clockwork && cd clockwork
      pnpm install && pnpm build
      node packages/daemon/dist/main.js

    Until it runs, the app has nothing to display. Run `pnpm install` with the
    same Node you start the daemon with — better-sqlite3 is compiled per Node
    ABI, so switching versions later breaks it (check
    ~/.clockwork/daemon.log.err).

    Also needs Node 22+ and at least one provider CLI
    (claude, codex, opencode or hermes) already on your PATH.
  EOS

  zap trash: [
    "~/.clockwork",
    "~/Library/Application Support/com.clockwork.app",
    "~/Library/Saved Application State/com.clockwork.app.savedState",
  ]
end
