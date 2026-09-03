# Update delivery — there is no path to ship a security fix

Iteration 16. `byo-runner.md` flagged the daemon's missing update mechanism as
a supply-chain concern and it had never been examined. This examines it.

**The finding is not a vulnerability. It is that a fix cannot reach anyone.**

## What exists

`VERIFIED` by reading `src-tauri/tauri.conf.json`, `Cargo.toml` and
`.github/workflows/release.yml`:

| | State |
| --- | --- |
| Tauri updater plugin | **absent** — `plugins: {}` |
| Updater artifacts | **absent** — `createUpdaterArtifacts` unset |
| Updater crate | **absent** from `Cargo.toml` |
| Any version check | **absent** — nothing queries the GitHub API or compares versions |
| Distribution | DMG on GitHub Releases, downloaded and dragged manually |
| SHA-256 checksums | published with each release |
| Code signing / notarization | **conditional** — runs only when `APPLE_CERT_P12` is configured |

## Why this became material in this session

Before now there were no security fixes to deliver. This session produced two:

- `fix/sandbox-token-escape` — a run could read the daemon token and take the
  control plane. Verified by execution.
- `fix/ics-redirect-scheme` — an SSRF shape in ICS fetching.

**Neither can reach an installed user.** Nothing in the app looks for a newer
version, so a user learns a fix exists only by independently visiting the
releases page. For a product whose core promise is a security boundary around
unattended agent execution, that is the gap worth naming.

## Not fixed here, and why

Adding an auto-updater is not an obvious win — `byo-runner.md` already
identified the update channel as a high-value supply-chain target. An updater
is code that downloads and executes new code with the user's privileges; done
without signature verification it is worse than no updater at all.

Even the lighter option — a version check that only *notifies* — is a
decision, not a refactor. It introduces a periodic network call to GitHub from
a product that markets itself as local-first, which touches the same honesty
question already open about the "your data stays in ~/.clockwork" footer.

Options, cheapest first:

1. **Release-notes verification step** (done below — no tradeoff).
2. **Manual check-for-updates**, user-initiated only. No background traffic;
   the user chooses when to ask.
3. **Passive notify** — a periodic version check. Needs a privacy disclosure
   and an opt-out.
4. **Full Tauri updater** with signature verification. Only worth it with
   signing keys managed properly; the release workflow currently signs only
   when secrets happen to be present.

## Fixed here

Checksums were published but the release notes never told anyone to use them.
A checksum nobody is instructed to verify protects nobody. The notes now carry
the verification command, which costs nothing and makes the existing artifact
useful.

## Honest limit

This assessment covers delivery only. Whether the signing secrets are actually
configured on the repository is not visible from the source, so whether any
given published DMG is signed was **not** verified — only that the workflow
signs conditionally.
