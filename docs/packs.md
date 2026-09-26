# Template packs

One file installs a team's whole workflow: a manifest, versioned templates,
and detached signatures. Install from a file or an `https://` URL, in the
app (Tasks › Packs) or from the terminal (`clockwork pack install …`).

## Trust without a registry

There is no Clockwork cloud to host a pack registry, so there is no central
authority to consult — trust is TOFU over ed25519, same DER-hex key
convention as worker pairing:

1. **Preview first, always.** Manifest, signature state (trusted key,
   unknown fingerprint, or bad), per-template security flags, and what would
   land. Preview installs nothing.
2. **Unknown keys need explicit consent.** The fingerprint shows beside a
   trust checkbox (or `--trust-key`); ticking it pins the key for that
   publisher. A known keyId arriving with *different* key bytes refuses as
   `key_changed` — rotation never updates quietly.
3. **Bad signatures and red-flag templates refuse the whole install.**
   Nothing partial ever lands: one red template blocks every template.

Pack URLs fetch over `https://` only (2 MB cap, 15 s timeout). Plain http,
file URLs and oversized bodies refuse before parsing.

## What installation does (and does not do)

- Every template goes through the single-template import path exactly:
  same security preview, same disabled-on-arrival, same `$2 / 50 turns / 1h`
  budgets, no repo, no profile, no schedule. A pack cannot grant what a file
  cannot — review and schedule each task from Tasks afterwards.
- Same version twice refuses (`already_installed`, `force` to repeat — force
  mints fresh task copies beside the old ones, it never rewrites them).
  Older versions never downgrade. Newer versions install *alongside*: the old
  tasks stay until you remove them, so an update can never silently rewrite
  a working routine.
- Packs declaring `minClockworkVersion` above this daemon refuse as
  incompatible, naming both versions.

## Updates and uninstall

Re-fetch the same source: a higher version installs next to the old one
(compare in Tasks › Packs, then remove the stale tasks or the old pack).
Uninstall removes only tasks still **disabled and never run** — anything
enabled or run is yours now and stays, reported as kept.

## Publishing a pack

Assemble `{schema: 'clockwork.pack.v1', manifest, templates, signatures}`
(`manifest` needs `name`, an `x.y.z` `version`, and `publisher`), then sign
the canonical bytes:

```bash
clockwork pack sign pack.json --key publisher-priv.hex
```

Paste the printed `{keyId, pubkeyHex, signature}` into `signatures[]`.
Guard the private key like any other: it mints trust in your name. Teams
typically publish the pack file beside the repo it serves (releases page,
internal site) and share the key fingerprint out of band for first installs.
