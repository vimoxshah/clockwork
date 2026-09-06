cask "clockwork" do
  version "0.7.0"
  sha256 "f517e8963216b15cfeed47847e84a39ebb685c4d6d8394e3f14db299ad5697c6"

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

    Clockwork needs Node 22+ and at least one provider CLI
    (claude, codex, opencode or hermes) already on your PATH.
  EOS

  zap trash: [
    "~/.clockwork",
    "~/Library/Application Support/com.clockwork.app",
    "~/Library/Saved Application State/com.clockwork.app.savedState",
  ]
end
