#!/usr/bin/env bash
# Stage a freshly built DMG for public distribution:
#   - copy the DMG + checksums into the Pages-published downloads directory
#   - update the version and sha256 in the Homebrew cask
#   - update the version in the landing page download links
# Run from the repo root after `tauri build --bundles dmg`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Public base URL for downloads. Cloudflare Pages gives every project a free
# <project>.pages.dev subdomain with HTTPS, so no domain purchase is required.
# Override when the project name differs, or once a custom domain is bought:
#   BASE_URL=https://clockworkd.com ./packaging/stage-release.sh
BASE_URL="${BASE_URL:-https://clockwork.vmoksh-shah179.workers.dev}"
BUNDLE="$ROOT/src-tauri/target/release/bundle/dmg"
DEST="$ROOT/landing-page/downloads"

# Preferred input: the DMG downloaded from the GitHub release, e.g.
#   gh release download v0.5.0 -p 'Clockwork_*_aarch64.dmg' -D /tmp/rel
#   DMG=/tmp/rel/Clockwork_0.5.0_aarch64.dmg ./packaging/stage-release.sh
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

VERSION="$(basename "$DMG" | sed -E 's/Clockwork_(.+)_aarch64\.dmg/\1/')"
mkdir -p "$DEST"
rm -f "$DEST"/Clockwork_*_aarch64.dmg
cp "$DMG" "$DEST/"
( cd "$DEST" && shasum -a 256 "Clockwork_${VERSION}_aarch64.dmg" > checksums-sha256.txt )
SHA="$(cut -d' ' -f1 < "$DEST/checksums-sha256.txt")"

# Homebrew cask
CASK="$ROOT/packaging/homebrew/clockwork.rb"
/usr/bin/sed -i '' -E "s/^  version \".*\"/  version \"${VERSION}\"/" "$CASK"
/usr/bin/sed -i '' -E "s/^  sha256 \".*\"/  sha256 \"${SHA}\"/" "$CASK"

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

# keep the cask host in sync with BASE_URL
/usr/bin/sed -i '' -E "s#url \"https://[^/]+/downloads/#url \"${BASE_URL}/downloads/#" "$CASK"
/usr/bin/sed -i '' -E "s#homepage \"https://[^/]+/?\"#homepage \"${BASE_URL}/\"#" "$CASK"

echo "staged ${VERSION}"
echo "  base   ${BASE_URL}"
echo "  dmg    $DEST/Clockwork_${VERSION}_aarch64.dmg"
echo "  sha256 ${SHA}"
echo "  cask + landing page updated — commit, merge and push to redeploy Pages"
