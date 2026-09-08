cask "clockwork" do
  version "0.11.0"
  sha256 "53b9780c1452479f03457bec7578a778aea74c8d8a9a60cd04f7143dfe84b6c0"

  # Straight from the GitHub release, which is where the artifact and its
  # published checksum canonically live. It used to point at the marketing
  # site's own /downloads copy, and that mirror is updated by a separate
  # deploy — so between publishing a release and redeploying the site, this
  # url 404'd and every `brew install --cask clockwork` failed. One source.
  url "https://github.com/vimoxshah/clockwork/releases/download/v#{version}/Clockwork_#{version}_aarch64.dmg"
  name "Clockwork"
  desc "Calendar that schedules AI coding agents in sandboxed git worktrees"
  homepage "https://vimoxshah.github.io/clockwork/"

  # Ventura, matching the app's own LSMinimumSystemVersion (13.0).
  depends_on macos: :ventura
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
