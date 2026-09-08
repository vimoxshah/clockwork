# Distribution

Clockwork ships as an **unsigned** DMG. An Apple Developer certificate is $99/year
and this is an experiment, so the app is ad-hoc signed and macOS Gatekeeper will
refuse to open it until the download quarantine flag is cleared. Every user-facing
surface says so plainly rather than letting Gatekeeper call the app "damaged".

## Where the DMG lives

**The GitHub release is the source of truth.** Every download link on the
landing page points at `releases/latest/download/Clockwork_aarch64.dmg`, and the
Homebrew cask installs from the versioned release asset. Both resolve the moment
a release publishes, with no second host to keep in sync.

`landing-page/downloads/` also carries a copy, served from the same origin as
the site by GitHub Pages. **This copy is now redundant and is not free:** the
DMG is 51 MB since the daemon and its Node runtime moved inside it, and every
release adds another 51 MB to git history permanently. It was committed when
the repo was private, because an anonymous request to a private repo's release
asset returns 404 and there was no other way to serve a public download. The
repo is public now, so that reason is gone.

**Open decision:** drop the vendored copy and let `landing-page/downloads/`
links point at the release instead. The only thing that would change for a
visitor is the origin the bytes come from.

## Cutting a release

1. `pnpm -r build && ./node_modules/.bin/tauri build --bundles dmg`
2. `./packaging/stage-release.sh` — copies the DMG plus checksums into
   `landing-page/downloads/` and rewrites the version and hash in the Homebrew
   cask and the landing page.
3. Commit, merge to `main`, push. The `pages` workflow redeploys the site.
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

## Auditing the sandbox

The security boundary lives in `packages/runner/src/{sandbox,deny-list,run-env,
service-path}.ts` and is dual-licensed under Apache-2.0 (LICENSE §12). It used
to be mirrored to a separate public repo so it could be read without exposing
the product; now that this repository is public, the code IS the audit surface
and the mirror has been retired.

## The host is GitHub Pages

`https://vimoxshah.github.io/clockwork/`, deployed by `.github/workflows/pages.yml`
on every push to `main` that touches `landing-page/`. It serves the page and
`/downloads/` alike.

This was not always possible. While the repo was private, the Pages API returned
"Your current plan does not support GitHub Pages for this repository", so the
site ran on a Cloudflare Worker instead (`wrangler.jsonc`, `worker/`). The repo
is public now and Pages works, so the Worker is redundant — it serves only
static assets, and the one route it owns (`POST /subscribe`, with a KV
namespace) has no caller: the landing page has no signup form.

**The Worker is still deployed and still serves the old page.** Deleting the
source here would not change that. Anyone holding a `clockwork.vmoksh-shah179.workers.dev`
link lands on whatever it last deployed, so delete or redirect the Worker in the
Cloudflare dashboard rather than leaving a stale copy of the site online.

## Cost: zero

GitHub Pages is free on a public repo and gives you HTTPS on
`<user>.github.io/<repo>`. **No domain purchase is required.** The landing page
uses relative links (`/downloads/...`) so it works on whatever host serves it;
the Homebrew cask needs an absolute URL and uses the GitHub release directly, so
it cannot go stale behind a site deploy.

A custom domain is a branding decision, not a functional one. Buy it if the
experiment gets traction — not before.

## Before this works publicly

- [x] GitHub Pages serving the site and `/downloads/`
- [x] Public `homebrew-clockwork` tap repo created, cask published
- [ ] Delete or redirect the old Cloudflare Worker, which still serves a stale
      copy of the site

### Site deployment

Nothing to configure by hand: `.github/workflows/pages.yml` uploads
`landing-page/` and deploys it on every push to `main` that touches that
directory. `actions/configure-pages` turns Pages on if it is not already, so a
fresh clone of this setup needs no dashboard step at all.

The landing page uses relative links, so it works unchanged on any host. If you
ever move it, `BASE_URL` in `stage-release.sh` is the one place that names the
site:

```bash
BASE_URL=https://your-new-host ./packaging/stage-release.sh
```

It sets the cask's `homepage` only — the cask's download url points at the
GitHub release and deliberately does not follow `BASE_URL`, so moving the site
can never break `brew install`.

Then copy `packaging/homebrew/clockwork.rb` into the tap repo's `Casks/` and push.

The cask downloads from the GitHub release, so it works as soon as the release
publishes — it no longer waits on a site deploy. Still run
`brew install --cask clockwork` yourself once before sharing the tap link.
