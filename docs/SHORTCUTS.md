# Clockwork Keyboard Shortcuts

Every shortcut is declared once in the registry (`packages/ui/src/components/CommandPalette.tsx` → `SHORTCUTS`) and rendered live in **Settings → Keyboard shortcuts**, so the in-app guide can never drift from the code.

| Shortcut | Action | Context |
|---|---|---|
| `⌘K` / `Ctrl+K` | Command palette (search commands, switch theme, navigate) | anywhere |
| `⌘N` / `Ctrl+N` | New task (composer) | anywhere |
| `⌘1` / `Ctrl+1` | Calendar | anywhere |
| `⌘2` / `Ctrl+2` | Inbox | anywhere |
| `⌘3` / `Ctrl+3` | Tasks | anywhere |
| `⌘4` / `Ctrl+4` | Agents | anywhere |
| `⌘5` / `Ctrl+5` | Analytics | anywhere |
| `⌘,` / `Ctrl+,` | Settings | anywhere |
| `/` | Focus inbox search | Inbox |
| `↑ ↓` | Move palette selection | palette open |
| `↵` | Run highlighted command | palette open |
| `Esc` | Close dialog / palette | dialogs |

Notes:
- In the browser, `⌘N` may be intercepted by the OS (new window). Inside the Tauri desktop shell all shortcuts are app-local.
- The command palette also exposes theme switching ("Theme: light/dark/system") without leaving your current surface.
- **Known gap (T4-10):** `⌘5` is wired as its own listener in `App.tsx`, not yet added to the registry this file otherwise mirrors (`CommandPalette.tsx` → `SHORTCUTS`, `useGlobalShortcuts`). That file was outside this change's touch set, so `⌘5` works and is in the palette, but **Settings → Keyboard shortcuts will not list it** until `CommandPalette.tsx`'s `SHORTCUTS` array, its `Tab` type (currently missing `'analytics'`), and `useGlobalShortcuts` pick up the fifth case too — the "can never drift" guarantee at the top of this file does not yet cover this row.
