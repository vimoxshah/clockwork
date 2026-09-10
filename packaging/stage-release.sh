#!/usr/bin/env bash
# Stage a freshly built DMG for public distribution:
#   - update the version and sha256 in the Homebrew cask
#   - update the version and size shown on the landing page
# The DMG itself is served from the GitHub release; nothing is copied here.
# Run from the repo root after `tauri build --bundles dmg`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Public base URL for downloads. Cloudflare Pages gives every project a free
# <project>.pages.dev subdomain with HTTPS, so no domain purchase is required.
# Override when the project name differs, or once a custom domain is bought:
#   BASE_URL=https://clockworkd.com ./packaging/stage-release.sh
BASE_URL="${BASE_URL:-https://vimoxshah.github.io/clockwork}"
BUNDLE="$ROOT/src-tauri/target/release/bundle/dmg"

# Preferred input: the DMG downloaded from the GitHub release, e.g.
#   gh release download v0.5.0 -p 'Clockwork_*_aarch64.dmg' -D /tmp/rel
#   DMG=/tmp/rel/Clockwork_0.5.0_aarch64.dmg ./packaging/stage-release.sh
# T1-2: the cask carries a digest PER ARCHITECTURE now, so this script needs
# both DMGs. DMG= is the arm64 one (kept as the name, so existing invocations
# still mean what they meant); DMG_X64= is the Intel one. Without the second,
# the Intel digest keeps whatever it had — which is a 64-zero placeholder on a
# fresh cask — so the script REFUSES rather than staging half a release and
# leaving `brew install` broken for Intel users.
if [ -n "${DMG:-}" ]; then
  [ -f "$DMG" ] || { echo "DMG not found: $DMG" >&2; exit 1; }
else
  DMG="$(ls -1 "$BUNDLE"/Clockwork_*_aarch64.dmg 2>/dev/null | tail -1)"
  [ -n "$DMG" ] || { echo "no DMG in $BUNDLE — run the tauri build first, or pass DMG=<release asset>" >&2; exit 1; }

  # A locally built DMG is NOT byte-identical to the one CI publishes, so its
  # hash differs. Staging a local build over a published one silently breaks the
  # cask for everyone who already has the published hash. Prefer the release
  # artifact (DMG=...); pass ALLOW_LOCAL=1 to override deliberately.
  if [ "${ALLOW_LOCAL:-0}" != "1" ]; then
    echo "refusing to stage a locally built DMG." >&2
    echo "download the artifact from the GitHub release (DMG=<path>), or re-run with ALLOW_LOCAL=1" >&2
    exit 1
  fi
fi

VERSION="$(basename "$DMG" | sed -E 's/Clockwork_(.+)_(aarch64|x64)\.dmg/\1/')"

if [ -z "${DMG_X64:-}" ]; then
  # `|| true` is load-bearing: this script runs under `set -euo pipefail`, and
  # a failing `ls` inside a command substitution kills it before the message
  # below can explain why. It exited 1 with an empty log until this was added.
  DMG_X64="$(ls -1 "$BUNDLE"/Clockwork_*_x64.dmg 2>/dev/null | tail -1 || true)"
fi
if [ -z "${DMG_X64:-}" ]; then
  echo "no Intel DMG. The cask pins a digest per architecture, so staging only" >&2
  echo "arm64 would leave the Intel sha256 stale (or the 64-zero placeholder)," >&2
  echo "and \`brew install --cask clockwork\` would fail its checksum on every" >&2
  echo "Intel Mac. Pass DMG_X64=<release asset>, or SKIP_X64=1 to stage arm64" >&2
  echo "alone and accept that the Intel half of the cask is wrong." >&2
  [ "${SKIP_X64:-0}" = "1" ] || exit 1
else
  [ -f "$DMG_X64" ] || { echo "Intel DMG not found: $DMG_X64" >&2; exit 1; }
  V64="$(basename "$DMG_X64" | sed -E 's/Clockwork_(.+)_x64\.dmg/\1/')"
  [ "$V64" = "$VERSION" ] || { echo "version mismatch: arm64 is $VERSION, Intel is $V64" >&2; exit 1; }
fi
# The DMG is NOT copied into the repo. It used to be, because a private repo
# cannot serve a release asset to an anonymous request, so the site had to host
# its own copy. The repo is public now and the download links point at
# releases/latest, so a vendored copy would only add 51 MB to git history on
# every release and give the checksum two places to disagree.
SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"

# Homebrew cask
CASK="$ROOT/packaging/homebrew/clockwork.rb"
/usr/bin/sed -i '' -E "s/^  version \".*\"/  version \"${VERSION}\"/" "$CASK"
# Two-arch cask (T1-2): `sha256 arm: "...", intel: "..."`. The old single-digest
# pattern `^  sha256 "` matches nothing in that shape, so it rewrote NOTHING and
# said nothing — the failure mode this replaces.
/usr/bin/sed -i '' -E "s/(arm:[[:space:]]*)\"[0-9a-f]{64}\"/\1\"${SHA}\"/" "$CASK"
if [ -n "${DMG_X64:-}" ]; then
  SHA64="$(shasum -a 256 "$DMG_X64" | cut -d' ' -f1)"
  /usr/bin/sed -i '' -E "s/(intel:[[:space:]]*)\"[0-9a-f]{64}\"/\1\"${SHA64}\"/" "$CASK"
fi
# Prove the rewrite landed. A sed that matches nothing exits 0, which is how
# this went unnoticed: verify the digests are actually in the file now.
grep -q "\"${SHA}\"" "$CASK" || { echo "arm64 digest was not written into $CASK — the cask's shape changed" >&2; exit 1; }
if [ -n "${DMG_X64:-}" ]; then
  grep -q "\"${SHA64}\"" "$CASK" || { echo "Intel digest was not written into $CASK" >&2; exit 1; }
fi

# landing page: every download link points at the stable-named asset of the
# LATEST GitHub release (release.yml publishes Clockwork_aarch64.dmg alongside
# the versioned file), so the links never go stale. Only the JSON-LD metadata
# carries the version.
PAGE="$ROOT/landing-page/index.html"
LATEST="https://github.com/vimoxshah/clockwork/releases/latest/download/Clockwork_aarch64.dmg"
/usr/bin/sed -i '' -E "s#href=\"https://github.com/vimoxshah/clockwork/releases/download/v[0-9.]+/Clockwork_[0-9.]+_aarch64\.dmg\"#href=\"${LATEST}\"#g" "$PAGE"
/usr/bin/sed -i '' -E "s#\"softwareVersion\": \"[0-9.]+\"#\"softwareVersion\": \"${VERSION}\"#" "$PAGE"
/usr/bin/sed -i '' -E "s#\"downloadUrl\": \"[^\"]+\"#\"downloadUrl\": \"${LATEST}\"#" "$PAGE"
/usr/bin/sed -i '' -E "s#href=\"https://github.com/vimoxshah/clockwork/releases/download/v[0-9.]+/checksums-sha256.txt\"#href=\"https://github.com/vimoxshah/clockwork/releases/latest/download/checksums-sha256.txt\"#g" "$PAGE"
/usr/bin/sed -i '' -E "s#Download Clockwork [0-9.]+ for Mac#Download Clockwork ${VERSION} for Mac#" "$PAGE"

# The data-ver / data-size spans are rewritten at runtime from the GitHub
# release, so a visitor normally sees the truth. Their INLINE values are the
# fallback a rate-limited visitor gets, and they were being refreshed by hand
# every release — which is exactly how the page sat on 0.4.0 while shipping
# 0.9.0. Refresh them here so the fallback is current too.
DMG_BYTES="$(/usr/bin/stat -f%z "$DMG")"
DMG_MB="$(/usr/bin/awk -v b="$DMG_BYTES" 'BEGIN{printf "%.1f", b/1048576}')"
/usr/bin/sed -i '' -E "s#(<span data-ver>)[0-9.]+(</span>)#\1${VERSION}\2#g" "$PAGE"
/usr/bin/sed -i '' -E "s#(<span data-size>)[0-9.]+ MB(</span>)#\1${DMG_MB} MB\2#g" "$PAGE"

# The cask url is NOT rewritten to BASE_URL any more: it points at the GitHub
# release asset, which exists the moment the release is published. Pointing it
# at the site's mirror meant every release broke `brew install` until the site
# was redeployed — a separate step, on a separate host.

/usr/bin/sed -i '' -E "s#homepage \"https://[^/]+/?\"#homepage \"${BASE_URL}/\"#" "$CASK"

echo "staged ${VERSION}"
echo "  base   ${BASE_URL}"
echo "  dmg    $DMG (served from the GitHub release, not vendored)"
echo "  sha256 ${SHA}"
echo "  cask + landing page updated — commit, merge and push to redeploy Pages"
