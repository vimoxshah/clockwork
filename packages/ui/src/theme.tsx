/**
 * Theme system (light / dark / system) — FR-agnostic product polish.
 * Persists choice in localStorage (`clockwork.theme`); "system" follows the OS
 * via matchMedia and live-updates. Applies `data-theme` on <html>.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'clockwork.theme';

export function loadThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

function resolve(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref;
}

function apply(pref: ThemePref): void {
  const resolved = resolve(pref);
  document.documentElement.setAttribute('data-theme', resolved);
  // Keep native widgets (scrollbars, form controls) consistent too.
  document.documentElement.style.colorScheme = resolved;
}

const ThemeCtx = createContext<{ pref: ThemePref; setPref: (p: ThemePref) => void }>({
  pref: 'system',
  setPref: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pref, setPrefState] = useState<ThemePref>(() => loadThemePref());

  useEffect(() => {
    apply(pref);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => {
      if (loadThemePref() === 'system') apply('system');
    };
    mq.addEventListener('change', onChange);
    // external setters (command palette)
    const onSetTheme = (e: Event): void => {
      const p = (e as CustomEvent).detail;
      if (p === 'light' || p === 'dark' || p === 'system') setPrefState(p);
    };
    document.addEventListener('clockwork:set-theme', onSetTheme as EventListener);
    return () => {
      mq.removeEventListener('change', onChange);
      document.removeEventListener('clockwork:set-theme', onSetTheme as EventListener);
    };
  }, [pref]);

  const setPref = (p: ThemePref): void => {
    localStorage.setItem(KEY, p);
    setPrefState(p);
    apply(p);
  };

  return <ThemeCtx.Provider value={{ pref, setPref }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = (): { pref: ThemePref; setPref: (p: ThemePref) => void } => useContext(ThemeCtx);
