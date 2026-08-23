/**
 * Command palette (Cmd+K) + global keyboard shortcuts.
 * Registry-driven: every shortcut declared once here, rendered in Settings.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

export type Tab = 'calendar' | 'inbox' | 'agents' | 'tasks' | 'new' | 'settings';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  section: 'Navigate' | 'Create' | 'Search' | 'Settings';
  shortcut?: string;
  run: () => void;
}

/** Global shortcut registry — single source of truth (docs/SHORTCUTS.md mirrors this). */
export const SHORTCUTS: Array<{ keys: string; action: string; context: string }> = [
  { keys: '⌘K', action: 'Command palette', context: 'anywhere' },
  { keys: '⌘N', action: 'New task', context: 'anywhere' },
  { keys: '⌘1', action: 'Calendar', context: 'anywhere' },
  { keys: '⌘2', action: 'Inbox', context: 'anywhere' },
  { keys: '⌘3', action: 'Tasks', context: 'anywhere' },
  { keys: '⌘4', action: 'Agents', context: 'anywhere' },
  { keys: '⌘,', action: 'Settings', context: 'anywhere' },
  { keys: '/', action: 'Focus inbox search', context: 'Inbox' },
  { keys: 'Esc', action: 'Close dialog / palette', context: 'dialogs' },
];

function matchesShortcut(e: KeyboardEvent, combo: string): boolean {
  // combos like "⌘K", "⌘,", "⌘1"
  if (!combo.startsWith('⌘')) return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  const key = combo.slice(1).toLowerCase();
  return e.key.toLowerCase() === key;
}

export function useGlobalShortcuts(handlers: {
  onPalette: () => void;
  setTab: (t: Tab) => void;
}): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (matchesShortcut(e, '⌘K')) {
        e.preventDefault();
        handlers.onPalette();
        return;
      }
      if (matchesShortcut(e, '⌘N')) { e.preventDefault(); handlers.setTab('new'); return; }
      if (matchesShortcut(e, '⌘1')) { e.preventDefault(); handlers.setTab('calendar'); return; }
      if (matchesShortcut(e, '⌘2')) { e.preventDefault(); handlers.setTab('inbox'); return; }
      if (matchesShortcut(e, '⌘3')) { e.preventDefault(); handlers.setTab('tasks'); return; }
      if (matchesShortcut(e, '⌘4')) { e.preventDefault(); handlers.setTab('agents'); return; }
      if (matchesShortcut(e, '⌘,')) { e.preventDefault(); handlers.setTab('settings'); return; }
      void typing;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}): JSX.Element | null {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return commands.slice(0, 12);
    return commands
      .filter((c) => c.label.toLowerCase().includes(term) || c.section.toLowerCase().includes(term))
      .slice(0, 12);
  }, [q, commands]);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = results[idx];
        if (cmd) { onClose(); cmd.run(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, results, idx, onClose]);

  if (!open) return null;
  let lastSection = '';
  return (
    <div className="dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="dialog palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: '92%' }}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          placeholder="Type a command or search…"
          aria-label="Command search"
          style={{ width: '100%', marginBottom: 8 }}
          data-testid="palette-input"
        />
        {results.length === 0 && <p className="hint">No matching commands.</p>}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 320, overflow: 'auto' }}>
          {results.map((c, i) => {
            const header = c.section !== lastSection ? c.section : null;
            lastSection = c.section;
            return (
              <li key={c.id}>
                {header && <div className="hint" style={{ padding: '6px 8px 2px', fontWeight: 600 }}>{header}</div>}
                <button
                  onClick={() => { onClose(); c.run(); }}
                  onMouseEnter={() => setIdx(i)}
                  className={i === idx ? 'on' : ''}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    width: '100%', textAlign: 'left', padding: '7px 10px',
                    borderRadius: 8, background: i === idx ? 'var(--surface-active)' : 'transparent',
                    border: 'none', color: 'var(--fg)', cursor: 'pointer', fontSize: 13.5,
                  }}
                  data-testid="palette-item"
                >
                  <span>{c.label}</span>
                  {(c.shortcut || c.hint) && (
                    <kbd style={{ fontSize: 11, opacity: 0.65 }}>{c.shortcut ?? c.hint}</kbd>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>↑↓ navigate · ↵ run · esc close</p>
      </div>
    </div>
  );
}
