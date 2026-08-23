# Landing page motion: engineering decision

## Decision
The landing page uses **CSS-only motion** (scroll-reveal via IntersectionObserver,
hover transitions, reduced-motion media query). Three.js and GSAP were evaluated
and deliberately **not** added.

## Rationale
- **Storytelling value:** Clockwork's USP is legibility — a real calendar with
  real agent work. The strongest visual evidence is the actual product
  (screenshots of the month grid, composer, reports). A 3D scene would compete
  with the product for attention, not amplify it.
- **Performance:** three.js + GSAP add ~600KB+ minified (150KB+ gzip) to a
  marketing page whose entire job is to load instantly and show screenshots.
  Core Web Vitals (LCP on the hero screenshot) would degrade for zero narrative
  gain.
- **Maintenance:** CSS reveals are 20 lines and can't break; a WebGL hero is a
  permanent compatibility/perf surface.
- **Accessibility:** CSS approach respects `prefers-reduced-motion` trivially.

## Revisit trigger
If the hero later needs an animated "agent day timeline" visualization that
screenshots can't convey, prefer a small hand-rolled canvas animation (~2KB)
over a full 3D engine. GSAP becomes defensible only if scroll-driven
multi-step storytelling is added across many sections.
