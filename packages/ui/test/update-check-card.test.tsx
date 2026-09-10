/**
 * T1-6: the UI half of "check for updates", user-initiated only.
 *
 * `UpdateCheckCard` (`SettingsView.tsx`) is the one screen that can ask
 * whether a newer Clockwork release exists. The actual GitHub request runs
 * in the Tauri shell (`src-tauri/src/lib.rs`'s `check_for_updates_command`,
 * covered by that file's own `cargo test`); this file covers the half that
 * lives in this package — that the card asks only on a click, never on
 * mount, and that all four outcomes `update_check_json` can send back
 * render as the honest, distinct things they are: nothing is ever silent,
 * and a failure never reads as "up to date".
 *
 * Mounted alone, the same reason `QuietHoursCard`/`DeliveryCard` are —
 * rendering all of `SettingsView` would route a dozen unrelated fetches for
 * one click.
 *
 * The bridge this card calls (`window.__TAURI_INTERNALS__`) is not
 * `fetch`, so it is not something `vi.stubGlobal` already has a house style
 * for here; it is assigned and torn down by hand, the same shape
 * `vi.stubGlobal('fetch', …)` gets elsewhere in this suite.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpdateCheckCard } from '../src/components/SettingsView';
import { renderComponent, waitForElement, waitForText, neverHappens, waitFor } from './helpers/dom';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SETTINGS = readFileSync(resolve(SRC, 'components', 'SettingsView.tsx'), 'utf8');

/** A controllable stand-in for `window.__TAURI_INTERNALS__`. */
function mockBridge(handler: (cmd: string) => Promise<unknown>): { calls: string[] } {
  const calls: string[] = [];
  window.__TAURI_INTERNALS__ = {
    invoke<T>(cmd: string): Promise<T> {
      calls.push(cmd);
      // SAFETY: test double. The real bridge's T is chosen by the caller
      // (`tauriInvoke<UpdateCheckResult>` in SettingsView.tsx); this mock
      // always resolves with whatever the test configured `handler` to
      // return for that call, which the test itself controls.
      return handler(cmd) as Promise<T>;
    },
  };
  return { calls };
}

function click(el: Element | null): void {
  expect(el, 'control missing from the DOM').not.toBeNull();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  document.body.innerHTML = '';
});

describe('SettingsView mounts the update-check card', () => {
  it('imports and renders UpdateCheckCard under a #check-for-updates anchor', () => {
    // A stable element id, same convention as every other card's section
    // heading (`#office-hours`, `#quiet-hours`) — not currently a jump
    // target from anywhere (the tray runs its own check natively instead
    // of routing here; see `run_update_check` in `src-tauri/src/lib.rs`),
    // but an unmounted card, or one under a different id, is still a
    // structural regression this pins against.
    expect(SETTINGS).toContain("import { OfficeHoursCard } from './OfficeHoursCard'");
    expect(SETTINGS).toContain('<UpdateCheckCard />');
    expect(SETTINGS).toContain('id="check-for-updates"');
  });
});

describe('Settings ▸ Check for updates — asks only when clicked, never on mount', () => {
  it('renders a button and makes no IPC call before it is clicked', async () => {
    const { calls } = mockBridge(async () => ({ status: 'up_to_date', current: '0.11.2', message: "You're on the latest version (0.11.2)." }));
    const container = await renderComponent(<UpdateCheckCard />);
    await waitForElement(container, '[data-testid="check-for-updates-button"]');
    await neverHappens(() => calls.length > 0, 'an unrequested check_for_updates_command call', {
      describe: () => JSON.stringify(calls),
    });
  });

  it('calls exactly check_for_updates_command, once, on click', async () => {
    const { calls } = mockBridge(async () => ({ status: 'up_to_date', current: '0.11.2', message: "You're on the latest version (0.11.2)." }));
    const container = await renderComponent(<UpdateCheckCard />);
    click(container.querySelector('[data-testid="check-for-updates-button"]'));
    await waitFor(() => calls.length > 0, 'the click to invoke the command', { describe: () => JSON.stringify(calls) });
    expect(calls).toEqual(['check_for_updates_command']);
  });
});

describe('Settings ▸ Check for updates — the four honest outcomes', () => {
  it('says plainly that it checked and found nothing newer (up to date)', async () => {
    mockBridge(async () => ({ status: 'up_to_date', current: '0.11.2', message: "You're on the latest version (0.11.2)." }));
    const container = await renderComponent(<UpdateCheckCard />);
    click(container.querySelector('[data-testid="check-for-updates-button"]'));
    await waitForText(container, "You're on the latest version (0.11.2).");
    expect(container.querySelector('[data-testid="check-for-updates-result"]')?.className).toBe('ok-banner');
  });

  it('shows the current version, the latest, and a working link to the release notes', async () => {
    mockBridge(async () => ({
      status: 'newer_available',
      current: '0.9.0',
      latest: '0.11.2',
      notesUrl: 'https://github.com/vimoxshah/clockwork/releases/tag/v0.11.2',
      message: "Clockwork 0.11.2 is available — you're on 0.9.0.",
    }));
    const container = await renderComponent(<UpdateCheckCard />);
    click(container.querySelector('[data-testid="check-for-updates-button"]'));
    await waitForText(container, "Clockwork 0.11.2 is available — you're on 0.9.0.");
    expect(container.textContent).toContain('0.9.0');
    expect(container.textContent).toContain('0.11.2');
    const link = await waitForElement<HTMLAnchorElement>(container, '[data-testid="check-for-updates-notes-link"]');
    expect(link.href).toBe('https://github.com/vimoxshah/clockwork/releases/tag/v0.11.2');
    expect(link.textContent).toBe('Release notes');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noreferrer');
  });

  it('never turns a javascript: notes URL into a clickable link (agent-content-escaping.test.tsx names the vector)', async () => {
    mockBridge(async () => ({
      status: 'newer_available',
      current: '0.9.0',
      latest: '0.11.2',
      notesUrl: 'javascript:globalThis.__pwned=1',
      message: "Clockwork 0.11.2 is available — you're on 0.9.0.",
    }));
    const container = await renderComponent(<UpdateCheckCard />);
    click(container.querySelector('[data-testid="check-for-updates-button"]'));
    await waitForText(container, "Clockwork 0.11.2 is available — you're on 0.9.0.");
    expect(container.querySelector('[data-testid="check-for-updates-notes-link"]'), 'a non-https notesUrl must render no link at all').toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('a network failure reports the check failed — never "up to date"', async () => {
    mockBridge(async () => ({ status: 'check_failed', message: "Couldn't reach GitHub to check for updates: connection refused" }));
    const container = await renderComponent(<UpdateCheckCard />);
    click(container.querySelector('[data-testid="check-for-updates-button"]'));
    const el = await waitForElement(container, '[data-testid="check-for-updates-result"]');
    expect(el.className).toBe('error-banner');
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.textContent).toContain("Couldn't reach GitHub");
    expect(container.textContent).not.toContain('latest version');
  });

  it('a malformed response also reports the check failed, distinctly worded from a network failure', async () => {
    mockBridge(async () => ({ status: 'check_failed', message: "GitHub answered, but the response didn't make sense: could not read a version out of \"latest\"" }));
    const container = await renderComponent(<UpdateCheckCard />);
    click(container.querySelector('[data-testid="check-for-updates-button"]'));
    const el = await waitForElement(container, '[data-testid="check-for-updates-result"]');
    expect(el.className).toBe('error-banner');
    expect(el.textContent).toContain('GitHub answered');
  });

  it('an IPC-level rejection (not a status the command sent) still renders as failed, never silently', async () => {
    mockBridge(async () => {
      throw new Error('ipc channel closed');
    });
    const container = await renderComponent(<UpdateCheckCard />);
    click(container.querySelector('[data-testid="check-for-updates-button"]'));
    const el = await waitForElement(container, '[data-testid="check-for-updates-result"]');
    expect(el.className).toBe('error-banner');
    expect(el.textContent).toContain('ipc channel closed');
  });
});

describe('Settings ▸ Check for updates — outside the desktop shell', () => {
  it('says the feature needs the desktop app rather than hanging or crashing', async () => {
    // No mockBridge() call: window.__TAURI_INTERNALS__ is exactly what a
    // browser tab pointed at 127.0.0.1:4747 has — nothing.
    const container = await renderComponent(<UpdateCheckCard />);
    click(container.querySelector('[data-testid="check-for-updates-button"]'));
    await waitForText(container, 'need the Clockwork desktop app');
    expect(container.querySelector('[data-testid="check-for-updates-unavailable"]')).not.toBeNull();
  });
});
