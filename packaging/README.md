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
brew trust vimoxshah/clockwork
brew install --cask clockwork
xattr -dr com.apple.quarantine /Applications/Clockwork.app
```

`brew trust` is required: Homebrew 6 refuses casks from third-party taps until
the user explicitly trusts the tap.

Quarantine cannot be skipped at install time. Homebrew 6 removed
`--no-quarantine`, and `HOMEBREW_CASK_OPTS` accepts only `--*dir`, `--language`,
`--require-sha` and `--no-binaries` — so the user clears the flag afterwards.
Homebrew still verifies the SHA-256, so what they clear quarantine on is a
binary whose hash was already checked.

`packaging/homebrew/clockwork.rb` and `packaging/homebrew/README.md` are the
source of truth. On each release copy them to the tap repo:

- `clockwork.rb` -> `Casks/clockwork.rb`
- `README.md`    -> `README.md`

Both are covered by `install-instructions.test.ts`, which is why they live here
rather than only in the tap. The copy step itself is manual and unguarded.

## Publishing the audit repo (github.com/vimoxshah/clockwork-sandbox)

`public/clockwork-sandbox/` in this repo is the source of truth. Publishing it
is TWO steps, and the first one does not do the second:

1. `./packaging/sync-public-sandbox.sh` — copies the eight files out of
   `packages/runner/` and stamps `SYNCED_FROM` with the current git sha.
   `public-sandbox-sync.test.ts` fails the build if this has not been run after
   a source change.
2. Copy `public/clockwork-sandbox/` into a clone of the public repo and push.
   **This is manual.** The guard in step 1 only protects main -> `public/`; it
   cannot see the published repo, exactly as the tap guard cannot.

A green build therefore means "the copy in this repo is current", NOT "the
public repo is current". Do step 2 on every release that touches the sandbox,
the deny list, the run env, or service-path.

`SYNCED_FROM` records a sha in this PRIVATE repo. Outside readers cannot
resolve it; it is an audit trail for us, and the public README says so.

## Why not GitHub Pages

GitHub Pages is unavailable here: the repo is private and the account is on the
free plan, so the API returns "Your current plan does not support GitHub Pages
for this repository". The `pages` workflow was deleted rather than left to fail
on every landing-page change — recoverable from git history if the repo ever
goes public or the plan changes.

Cloudflare Workers serves the same `landing-page/` directory and deploys on push
to `main`, so nothing was lost.

## Cost: zero

Cloudflare Pages gives every project a free `<project>.pages.dev` subdomain with
HTTPS. **No domain purchase is required.** The landing page uses relative links
(`/downloads/...`) so it works on whatever host serves it; only the Homebrew cask
needs an absolute URL, and that is set from one variable.

A custom domain is a branding decision, not a functional one. Buy it if the
experiment gets traction — not before.

## Before this works publicly

- [ ] Connect this repo to Cloudflare
- [x] Public `homebrew-clockwork` tap repo created, cask published

### Cloudflare: two flows, both free

Cloudflare's dashboard now funnels git-connected projects into **Workers**
rather than **Pages**. The two look similar but configure differently:

**Workers (what the dashboard defaults to).** No "build output directory"
field — the directory is declared in `wrangler.jsonc` at the repo root, which
is committed. Accept the auto-filled settings:

| Field | Value |
| --- | --- |
| Build command | *(leave empty — nothing to compile)* |
| Deploy command | `npx wrangler deploy` (auto-filled, keep it) |
| Root directory | `/` (repo root, so wrangler.jsonc is found) |

`wrangler.jsonc` points at `./landing-page` and declares no `main` script, so
this is a purely static host — nothing executes server-side.

**Pages (if the dashboard still offers it).** Workers & Pages → Create → the
**Pages** tab → Connect to Git, then:

| Field | Value |
| --- | --- |
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `landing-page` |

Either produces `https://<project>.pages.dev` or `https://<project>.<subdomain>.workers.dev`
on the free plan. Whichever URL you get, re-point the cask with:

```bash
BASE_URL=https://your-actual-url ./packaging/stage-release.sh
```

If the Pages project ends up on a different subdomain, re-point everything with
one command:

```bash
BASE_URL=https://your-project.pages.dev ./packaging/stage-release.sh
```

Then copy `packaging/homebrew/clockwork.rb` into the tap repo's `Casks/` and push.

Until Pages is connected, the cask URL will 404 — so do not share the tap link
until you have run `brew install --cask clockwork` yourself.
