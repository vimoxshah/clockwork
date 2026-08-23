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
| `⌘,` / `Ctrl+,` | Settings | anywhere |
| `/` | Focus inbox search | Inbox |
| `↑ ↓` | Move palette selection | palette open |
| `↵` | Run highlighted command | palette open |
| `Esc` | Close dialog / palette | dialogs |

Notes:
- In the browser, `⌘N` may be intercepted by the OS (new window). Inside the Tauri desktop shell all shortcuts are app-local.
- The command palette also exposes theme switching ("Theme: light/dark/system") without leaving your current surface.
