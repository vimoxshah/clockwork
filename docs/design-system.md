# Design system — type scale

Status: **done.** Colour was already systematized, the type scale was rebuilt
and enforced, and radius/shadow/spacing/motion were measured in iteration 17
and found already consistent — see below. Every layer now has either a token
set or a measured reason it needs none.

## Type

Every size in the app comes from this scale. There are **zero** arbitrary
font sizes in `packages/ui/src`, and two tests in
`packages/ui/test/design-system.test.ts` fail the build if one reappears.

| Token | Size / leading | Use | Sites |
| --- | --- | --- | --- |
| `text-micro` | 10px / 15px | dense metadata, rare | 2 |
| `text-xxs` | 11px / 16.5px | badges, captions | 18 |
| `text-caption` | 12px / 18px | secondary text | 16 |
| `text-xs` | 12px / 16px | Tailwind default, tighter 12px | 34 |
| `text-compact` | 13px / 19.5px | **the dense-UI body size** | 33 |
| `text-sm` | 14px / 20px | Tailwind default | 4 |
| `text-base` | 16px / 24px | Tailwind default | 4 |

### Why every token pairs a line-height

Tailwind's preflight sets `line-height: 1.5` on `<html>` and `body` sets
none, so a hand-written `text-[13px]` already rendered at 19.5px. Pairing
each token at exactly **1.5×** therefore documents what was already
happening and changes nothing visually.

The alternative — font-size-only tokens — was tried and rejected. It leaves
`text-micro/xxs/caption/compact` behaving differently from Tailwind's own
`text-xs/sm/base`, which *do* carry leading. Two independent reviewers
flagged the same thing: same `text-` prefix, opposite contract, so a
developer either forgets `leading-*` or double-compensates.

### Why 12px has two tokens

`text-caption` (12px/18px) and `text-xs` (12px/16px) are the same size with
deliberately different leading. `caption` is the inherited 1.5 rhythm;
`text-xs` is Tailwind's tighter pairing, already used on 34 sites. Remapping
one to the other would silently move 16 or 34 sites by 2px per line. **Prefer
`text-caption` for new work**; `text-xs` stays for what already uses it.

### Naming

Named for size and density, never for a place. `compact` is 13px because
that is the dense-UI size — the real `<body>` is 14px, so calling it `body`
was misleading, and `ui` said nothing at all. Both were rejected in review.

## The rest of the system — measured, not assumed

| Area | State | Action |
| --- | --- | --- |
| Colour | 25 semantic vars, `[data-theme]` flipped, Tailwind-wired | none needed |
| Type | rebuilt into a scale, 0 arbitrary values, guarded | done |
| Radius | 4 values (`md`/`lg`/`xl`/`full`), 54 uses, **0 arbitrary** | guarded |
| Motion | Tailwind defaults only — **0 custom easings, 0 arbitrary durations** | guarded |
| Shadow | 4 values, 8 uses | leave |
| Spacing | Tailwind defaults throughout | leave |

An earlier version of this file listed radius and motion as "not tokenized"
and named them the next candidates. **That was an assumption, and measuring it
showed it was wrong.** Radius already resolves to four consistent steps with
no arbitrary values, and motion uses Tailwind's defaults with nothing custom
at all. Inventing semantic aliases (`rounded-card`, `duration-fast`) would
have been churn against a defect that does not exist.

What was added instead is two regression guards in
`packages/ui/test/design-system.test.ts`, matching the type guard: no
arbitrary `rounded-[…]`, and no arbitrary `duration-[…]` / `ease-[…]`. Both
proven by planting each violation and watching the matching test fail.

### A measurement error worth recording

The first pass at this audit grepped `ease-[a-z]+` and reported two custom
easings, `ease-notes` and `ease-engineer`. Neither exists. The pattern had
matched inside **prose** — the words "release-notes" and "release-engineer" in
agent-profile copy. Nothing appeared in the built CSS.

The motion guard therefore matches only bracketed forms (`ease-[…]`), which
cannot occur in ordinary text. A grep that scans source for class names will
find them in strings that merely look like class names.
