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
       * App type scale. Sizes are font-size ONLY (no paired line-height) so
       * each token is a drop-in for the arbitrary value it replaces — body
       * sets no line-height, so these inherit `normal` exactly as the
       * hand-written text-[13px] etc. did. Leading stays a component concern.
       * xxs previously paired 14px leading; it is font-size only now so that
       * 11px has ONE spelling instead of two.
       */
      fontSize: {
        micro: '10px',
        xxs: '11px',
        body: '13px',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
export default config;
