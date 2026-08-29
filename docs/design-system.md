# Design system — type scale

Status: **type scale done and enforced.** Colour was already systematized.
Radius, shadow, spacing and motion are not yet tokenized (see Open below).

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

## Open — not tokenized

| Area | State |
| --- | --- |
| Colour | **Done.** 25 semantic vars, `[data-theme]` flipped, Tailwind-wired. |
| Radius | 4 values, 54 uses. Consistent in practice, no semantic names. |
| Shadow | 4 values, 8 uses. Low surface; leave. |
| Spacing | Tailwind defaults throughout. Arguably correct; no action. |
| Motion | Durations/easings ad hoc. Nothing tokenized. |

Radius and motion are the next candidates. Neither is visibly broken, so
neither should jump the queue ahead of product work.
