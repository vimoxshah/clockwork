# Clockwork Homebrew tap

The calendar where your AI agents show up for work. Book agent jobs on a real
calendar; Clockwork runs them unattended in an isolated, sandboxed git worktree
and files a report you can read.

## Install

```bash
brew tap vimoxshah/clockwork
brew trust vimoxshah/clockwork
brew install --cask clockwork
xattr -dr com.apple.quarantine /Applications/Clockwork.app
```

`brew trust` is required: Homebrew refuses to load casks from third-party taps
until you explicitly trust them. That is a good default — you are vouching for
this tap, so read the cask first if you like: it is one file.

### Why the `xattr` step

Clockwork is **not notarised by Apple**. A Developer certificate is $99/year and
this is an early build, so the app is ad-hoc signed. macOS quarantines anything
downloaded from the internet and refuses to open unsigned apps — usually with a
misleading "the app is damaged" message.

Homebrew cannot skip that for you. Homebrew 6 removed `--no-quarantine`, and
`HOMEBREW_CASK_OPTS` accepts only `--*dir`, `--language`, `--require-sha` and
`--no-binaries` — so quarantine is always applied and you clear it yourself.

What Homebrew still does is verify the DMG's SHA-256 against the hash pinned in
the cask. So you are clearing quarantine on a binary whose hash was checked for
you, rather than on a file you downloaded and never verified.

## Requirements

- macOS 14 (Sonoma) or later, Apple silicon
- Node 22+
- At least one provider CLI on your PATH: `claude`, `codex`, `opencode` or `hermes`

## What it can reach

Worth knowing before you bypass Gatekeeper for any tool that runs code unattended:

- Runs execute in a macOS Seatbelt sandbox inside a per-run git worktree; writes
  are restricted to that worktree
- Credential paths (`~/.ssh`, `~/.aws`, `~/.gnupg`, browser cookies, shell
  history) are denied to the run
- The run environment is an allowlist — no `SSH_AUTH_SOCK`, no provider tokens
- The daemon binds `127.0.0.1` only
- Your provider API keys stay in the macOS Keychain

These are enforced and covered by tests, not aspirations — and you can check
that claim rather than believe it. The Seatbelt profile, credential deny list
and run-environment allowlist are published under Apache-2.0 at
https://github.com/vimoxshah/clockwork, together with the tests that
exercise them against a real `sandbox-exec`, and an honest list of what those
tests do not prove.

## Links

- Website: https://clockwork.vmoksh-shah179.workers.dev
- Issues: https://github.com/vimoxshah/homebrew-clockwork/issues
- Email: vmoksh.shah179@gmail.com

Clockwork is an early build and I read every message — bug reports, "this broke
on my repo", or what would make it worth paying for are all welcome.

This tap contains only the cask formula. Clockwork itself is closed source.
