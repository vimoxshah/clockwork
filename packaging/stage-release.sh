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
BASE_URL="${BASE_URL:-https://clockwork.pages.dev}"
BUNDLE="$ROOT/src-tauri/target/release/bundle/dmg"
DEST="$ROOT/landing-page/downloads"

DMG="$(ls -1 "$BUNDLE"/Clockwork_*_aarch64.dmg 2>/dev/null | tail -1)"
[ -n "$DMG" ] || { echo "no DMG in $BUNDLE — run the tauri build first" >&2; exit 1; }

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

# landing page download links + button label
PAGE="$ROOT/landing-page/index.html"
/usr/bin/sed -i '' -E "s#/downloads/Clockwork_[0-9.]+_aarch64\.dmg#/downloads/Clockwork_${VERSION}_aarch64.dmg#g" "$PAGE"
/usr/bin/sed -i '' -E "s#Download Clockwork [0-9.]+ for Mac#Download Clockwork ${VERSION} for Mac#" "$PAGE"
/usr/bin/sed -i '' -E "s#Clockwork_[0-9.]+_aarch64\.dmg#Clockwork_${VERSION}_aarch64.dmg#g" "$PAGE"

# keep the cask host in sync with BASE_URL
/usr/bin/sed -i '' -E "s#url \"https://[^/]+/downloads/#url \"${BASE_URL}/downloads/#" "$CASK"
/usr/bin/sed -i '' -E "s#homepage \"https://[^/]+/?\"#homepage \"${BASE_URL}/\"#" "$CASK"

echo "staged ${VERSION}"
echo "  base   ${BASE_URL}"
echo "  dmg    $DEST/Clockwork_${VERSION}_aarch64.dmg"
echo "  sha256 ${SHA}"
echo "  cask + landing page updated — commit, merge and push to redeploy Pages"
