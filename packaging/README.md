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

## Cost: zero

Cloudflare Pages gives every project a free `<project>.pages.dev` subdomain with
HTTPS. **No domain purchase is required.** The landing page uses relative links
(`/downloads/...`) so it works on whatever host serves it; only the Homebrew cask
needs an absolute URL, and that is set from one variable.

A custom domain is a branding decision, not a functional one. Buy it if the
experiment gets traction — not before.

## Before this works publicly

- [ ] Connect this repo to Cloudflare Pages
      - Framework preset: **None**
      - Build command: *(empty)*
      - Build output directory: **`landing-page`**
      - Project name: **`clockwork`** → serves at `https://clockwork.pages.dev`
- [x] Public `homebrew-clockwork` tap repo created, cask published

If the Pages project ends up on a different subdomain, re-point everything with
one command:

```bash
BASE_URL=https://your-project.pages.dev ./packaging/stage-release.sh
```

Then copy `packaging/homebrew/clockwork.rb` into the tap repo's `Casks/` and push.

Until Pages is connected, the cask URL will 404 — so do not share the tap link
until you have run `brew install --cask --no-quarantine clockwork` yourself.
