# Distribution

Clockwork ships as an **unsigned** DMG. An Apple Developer certificate is $99/year
and this is an experiment, so the app is ad-hoc signed and macOS Gatekeeper will
refuse to open it until the download quarantine flag is cleared. Every user-facing
surface says so plainly rather than letting Gatekeeper call the app "damaged".

## Where the DMG lives

`landing-page/downloads/` is published by Cloudflare Pages, so the DMG is served
from the same origin as the site. GitHub Releases cannot be used for public
downloads while the repository is private — an anonymous request to a private
repo's release asset returns 404.

The file is committed deliberately. It is 3.4 MB, Cloudflare Pages allows 25 MB
per file on the free plan, and an experiment with a handful of releases will not
meaningfully bloat history. Revisit if the release cadence increases.

## Cutting a release

1. `pnpm -r build && ./node_modules/.bin/tauri build --bundles dmg`
2. `./packaging/stage-release.sh` — copies the DMG plus checksums into
   `landing-page/downloads/` and rewrites the version and hash in the Homebrew
   cask and the landing page.
3. Commit, merge to `main`, push. Cloudflare Pages redeploys automatically.
4. Push the updated cask to the tap (see below).

## Homebrew tap

The tap is a **separate public repository**, `vimoxshah/homebrew-clockwork`,
containing only `Casks/clockwork.rb`. It holds no source code — publishing it
does not make this repository public.

```
brew tap vimoxshah/clockwork
brew install --cask --no-quarantine clockwork
```

`--no-quarantine` is what avoids the Gatekeeper prompt. Homebrew still verifies
the SHA-256, so the user is trusting a binary whose hash they can check.

`packaging/homebrew/clockwork.rb` is the source of truth; copy it to the tap
repo's `Casks/` directory on each release.

## Before this works publicly

- [ ] Buy the domain and point it at Cloudflare Pages
- [ ] Connect this repo to Cloudflare Pages (build output directory: `landing-page`)
- [ ] Create the public `homebrew-clockwork` repo and copy the cask into `Casks/`

Until the domain resolves, the cask URL in `clockwork.rb` will 404. The Pages
preview URL can be substituted for testing.
