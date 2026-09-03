#!/usr/bin/env bash
# Refresh public/clockwork-sandbox/ from the runner sources and stamp the
# revision it came from.
#
# The published copy exists so people can audit the security boundary. A stale
# copy is worse than none: it invites trust in code the app no longer runs.
# public-sandbox-sync.test.ts fails the build if this has not been run after a
# source change, so this script is the fix, not an optional chore.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=packages/runner/src
TEST=packages/runner/test
OUT=public/clockwork-sandbox

for f in sandbox deny-list run-env service-path; do cp "$SRC/$f.ts" "$OUT/src/$f.ts"; done
for f in sandbox-credentials control-plane-escape run-env-allowlist deny-list; do
  cp "$TEST/$f.test.ts" "$OUT/test/$f.test.ts"
done

# Stamp the source revision. Never a version tag: run-env.ts does not exist in
# the v0.4.0 binary, so a version number here would be a lie.
SHA="$(git rev-parse --short HEAD)"
DIRTY=""
git diff --quiet HEAD -- "$SRC" "$TEST" || DIRTY=" (+uncommitted changes)"
sed -i '' "s|^SYNCED_FROM: clockwork@.*|SYNCED_FROM: clockwork@${SHA}${DIRTY}|" "$OUT/README.md"

echo "synced 8 files; stamped clockwork@${SHA}${DIRTY}"
