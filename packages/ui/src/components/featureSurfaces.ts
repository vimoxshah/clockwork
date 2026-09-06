/**
 * Where a capability actually LIVES in this build.
 *
 * The bug this exists to kill: the plan matrix in `LicenseCard` ticked all
 * twelve agent-workforce capabilities as "included" while nine of them had no
 * screen anywhere in the app. `GET /capabilities` answers a different
 * question — "does your plan entitle you to this?" — and the matrix rendered
 * that answer as if it meant "you can use this here". A user reading it was
 * told they had features they could not reach.
 *
 * A hard-coded `READY = [...]` list would fix today's lie and grow tomorrow's:
 * the next feature that ships a daemon route without a screen gets ticked the
 * moment someone forgets to edit the list. So reachability is not declared
 * centrally — it is declared BY THE MOUNT SITE, at module scope, in the same
 * file whose JSX renders the surface:
 *
 *     export const OFFICE_HOURS_SURFACE = registerFeatureSurface({
 *       key: 'office_hours',
 *       tab: 'settings',
 *       where: 'Settings › Office hours',
 *       anchorId: 'office-hours',
 *     });
 *
 * Two properties follow, and both matter:
 *
 *   1. **It fails closed.** A registration only runs if its module is imported
 *      into the bundle — which, since `App.tsx` is the only entry, means a
 *      view actually pulls it in. A feature that ships with no screen, or with
 *      an orphan component nobody mounts, registers nothing, so the matrix
 *      cannot tick it. Forgetting to register understates; it can never
 *      overstate.
 *   2. **A missing registration is not rendered as an accusation.** An
 *      unregistered feature gets no tick and no location — the matrix simply
 *      says nothing about where it lives, rather than claiming "no interface
 *      exists". Withholding a claim is honest at any point in the wave; the
 *      opposite claim would go stale the hour another lane lands its screen.
 *
 * `packages/ui/test/workforce-settings.test.tsx` holds both ends up: every
 * surface registered for the settings tab must render its anchor element, and
 * an unregistered-but-entitled feature must not get a tick.
 */

/**
 * The tabs `App.tsx` routes on (its own `TABS`, which owns the hash contract).
 * A value outside this union would set a hash `tabFromHash()` rejects and drop
 * the user on Calendar, so the union is the guard against a dead "Show me".
 */
export type SurfaceTab = 'calendar' | 'inbox' | 'agents' | 'tasks' | 'analytics' | 'new' | 'settings';

export interface FeatureSurface {
  /** capability key exactly as `GET /capabilities` spells it (daemon `features.ts`) */
  key: string;
  /** which tab mounts it */
  tab: SurfaceTab;
  /** human path, shown beside the capability: 'Settings › Office hours' */
  where: string;
  /** `id` of the element the surface renders, so the matrix can scroll to it */
  anchorId: string;
}

/**
 * Keyed by capability, so a double import (HMR, a test re-importing a module)
 * replaces the entry instead of duplicating it.
 */
const surfaces = new Map<string, FeatureSurface>();

/** Declare that this module mounts a screen for `key`. Call at module scope. */
export function registerFeatureSurface(surface: FeatureSurface): FeatureSurface {
  surfaces.set(surface.key, surface);
  return surface;
}

/** The surface for one capability, or undefined when this build has none. */
export function featureSurface(key: string): FeatureSurface | undefined {
  return surfaces.get(key);
}

/** Every surface registered so far. Read at render time — never at module scope. */
export function featureSurfaces(): FeatureSurface[] {
  return [...surfaces.values()];
}

/**
 * Take the user to a surface.
 *
 * Not an `<a href="#office-hours">`: `App.tsx`'s `tabFromHash()` reads the
 * whole hash as a tab name, so a bare fragment anchor navigates to Calendar —
 * a link that silently goes to the wrong place is worse than no link. Switch
 * tab by hash first, then scroll on the next frame, because the target element
 * does not exist until the new tab renders.
 */
export function revealFeatureSurface(surface: FeatureSurface): void {
  const wanted = `#/${surface.tab}`;
  const sameTab = window.location.hash === wanted;
  if (!sameTab) window.location.hash = wanted;
  const scroll = (): void => {
    const el = document.getElementById(surface.anchorId);
    // jsdom has no layout, so scrollIntoView is not always defined there.
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if (sameTab) scroll();
  else setTimeout(scroll, 60);
}
