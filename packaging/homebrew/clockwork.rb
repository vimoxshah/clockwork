cask "clockwork" do
  version "0.4.0"
  sha256 "75dd370e40412222ad731bd23f9f6fc1200c1af7196914a767639301afd8e93a"

  url "https://clockwork.pages.dev/downloads/Clockwork_#{version}_aarch64.dmg"
  name "Clockwork"
  desc "Calendar that schedules AI coding agents in sandboxed git worktrees"
  homepage "https://clockwork.pages.dev/"

  depends_on macos: ">= :sonoma"
  depends_on arch: :arm64

  app "Clockwork.app"

  # The build is not notarised — an Apple Developer certificate is $99/year and
  # this is an early release. Install with:
  #     brew install --cask --no-quarantine clockwork
  # Without that flag macOS quarantine will refuse to open the app. Homebrew
  # still verifies the sha256 above, so you are trusting a binary whose hash you
  # can check, not an unverified download.
  caveats <<~EOS
    Clockwork is not notarised by Apple yet.

    If you installed without --no-quarantine and macOS refuses to open it:
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
