import type { Config } from 'tailwindcss';

/**
 * Tailwind wired to the app's SEMANTIC CSS variables (see styles.css).
 * [data-theme='light'|'dark'] on <html> flips the variables — classes like
 * bg-surface text-fg border-border work in both themes with zero branching.
 */
const config: Config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-hover': 'var(--surface-hover)',
        'surface-active': 'var(--surface-active)',
        fg: 'var(--fg)',
        muted: 'var(--muted)',
        dim: 'var(--dim)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        accent: 'var(--accent)',
        'accent-fg': 'var(--accent-fg)',
        success: 'var(--success)',
        info: 'var(--info)',
        danger: 'var(--danger)',
        warning: 'var(--warning)',
        'ev-completed-bg': 'var(--ev-completed-bg)',
        'ev-completed-fg': 'var(--ev-completed-fg)',
        'ev-failed-bg': 'var(--ev-failed-bg)',
        'ev-failed-fg': 'var(--ev-failed-fg)',
        'ev-running-bg': 'var(--ev-running-bg)',
        'ev-running-fg': 'var(--ev-running-fg)',
        'ev-needsyou-bg': 'var(--ev-needsyou-bg)',
        'ev-needsyou-fg': 'var(--ev-needsyou-fg)',
      },
      borderColor: {
        DEFAULT: 'var(--border)',
        strong: 'var(--border-strong)',
      },
      /**
       * App type scale. Every token pairs an explicit line-height at exactly
       * 1.5x, which is what these sizes already rendered at: Tailwind's
       * preflight sets line-height:1.5 on <html> and body sets none, so the
       * hand-written text-[13px] inherited 19.5px. Pairing at 1.5x therefore
       * changes nothing visually while making the contract uniform.
       *
       * S-review: both validators flagged a font-size-only scale sitting
       * beside Tailwind's paired text-xs/sm/base as an inconsistent contract
       * ("same prefix, opposite behaviour"). Hence 12px is `caption` here
       * rather than remapping to text-xs, whose 16px leading would have
       * silently tightened 16 sites by 2px.
       *
       * Named `compact` not `body`/`ui`: 13px is the dense-UI size while the
       * real <body> is 14px.
       */
      fontSize: {
        micro: ['10px', '15px'],
        xxs: ['11px', '16.5px'],
        caption: ['12px', '18px'],
        compact: ['13px', '19.5px'],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
export default config;
