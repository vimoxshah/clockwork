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
      fontSize: {
        xxs: ['11px', '14px'],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
export default config;
