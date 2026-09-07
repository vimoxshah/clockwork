/**
 * F12 proof-of-work export was shipped with a working daemon route
 * (`GET /workforce/runs/:runId/proof-of-work`) and two typed api.ts helpers
 * (`proofOfWorkUrl`, `proofOfWork`) but no button anywhere in the app —
 * unreachable by the user. This is the reachability + behaviour test for
 * the component that fixes that: it must call `api.proofOfWork` with the
 * options the checkboxes show, download the bytes, and surface a failure
 * rather than swallow it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent, waitFor, waitForElement, waitForText } from './helpers/dom';

/**
 * The component takes no props that make it fetch on mount, so its whole UI is
 * in the first commit — waiting for the export button is waiting for the
 * render, and nothing here waits on a clock.
 */
async function render(node: JSX.Element): Promise<HTMLDivElement> {
  const container = await renderComponent(node);
  await waitForElement(container, '[data-testid="proof-of-work-export"]');
  return container;
}

/** jsdom has neither of these; the component calls both on every export. */
function stubBrowserDownload(): { createObjectURL: ReturnType<typeof vi.fn>; revokeObjectURL: ReturnType<typeof vi.fn>; click: ReturnType<typeof vi.fn> } {
  const createObjectURL = vi.fn(() => 'blob:mock-url');
  const revokeObjectURL = vi.fn();
  (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: typeof revokeObjectURL }).revokeObjectURL = revokeObjectURL;
  const click = vi.fn();
  HTMLAnchorElement.prototype.click = click;
  return { createObjectURL, revokeObjectURL, click };
}

describe('ProofOfWorkExport (F12)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exports with the daemon\'s documented defaults (diffStat on, transcript off, no path redaction)', async () => {
    const stubs = stubBrowserDownload();
    const fetchMock = vi.fn(async () => new Response('<html>proof</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { ProofOfWorkExport } = await import('../src/components/ProofOfWorkExport');
    const container = await render(<ProofOfWorkExport runId="run_1" />);

    const diffStat = container.querySelector('[aria-label="Include diff stat"]') as HTMLInputElement;
    const transcript = container.querySelector('[aria-label="Include transcript"]') as HTMLInputElement;
    const redact = container.querySelector('[aria-label="Also redact file paths and branch names"]') as HTMLInputElement;
    expect(diffStat.checked, 'includeDiffStat defaults true per docs/agent-workforce.md F12').toBe(true);
    expect(transcript.checked, 'includeTranscript defaults false — most sensitive artifact a run produces').toBe(false);
    expect(redact.checked).toBe(false);

    const button = container.querySelector('[data-testid="proof-of-work-export"]') as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // `setDone(true)` is the LAST thing exportNow does — after createObjectURL,
    // the anchor click and revokeObjectURL — so the banner appearing means
    // every call asserted below has already been made (ProofOfWorkExport.tsx:57-65).
    await waitForText(container, 'Downloaded');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('/workforce/runs/run_1/proof-of-work?includeTranscript=0&includeDiffStat=1&redactPaths=0');
    expect(stubs.createObjectURL).toHaveBeenCalledTimes(1);
    expect(stubs.click).toHaveBeenCalledTimes(1);
    expect(stubs.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(container.textContent).toContain('Downloaded');
  });

  it('reflects checkbox changes in the request query string', async () => {
    stubBrowserDownload();
    const fetchMock = vi.fn(async () => new Response('<html>proof</html>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { ProofOfWorkExport } = await import('../src/components/ProofOfWorkExport');
    const container = await render(<ProofOfWorkExport runId="run_2" />);

    const transcript = container.querySelector('[aria-label="Include transcript"]') as HTMLInputElement;
    transcript.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await waitFor(() => transcript.checked, 'the transcript checkbox to be toggled on', {
      describe: () => `transcript.checked = ${transcript.checked}`,
    });

    const redact = container.querySelector('[aria-label="Also redact file paths and branch names"]') as HTMLInputElement;
    redact.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await waitFor(() => redact.checked, 'the redact-paths checkbox to be toggled on', {
      describe: () => `redact.checked = ${redact.checked}`,
    });

    expect(transcript.checked, 'the click should have toggled the checkbox on').toBe(true);
    expect(redact.checked).toBe(true);

    (container.querySelector('[data-testid="proof-of-work-export"]') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await waitFor(() => fetchMock.mock.calls.length > 0, 'the export request to be issued', {
      describe: () => `fetch was called ${fetchMock.mock.calls.length} times`,
    });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('/workforce/runs/run_2/proof-of-work?includeTranscript=1&includeDiffStat=1&redactPaths=1');
  });

  it('surfaces a failed export instead of swallowing it', async () => {
    stubBrowserDownload();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })),
    );
    const { ProofOfWorkExport } = await import('../src/components/ProofOfWorkExport');
    const container = await render(<ProofOfWorkExport runId="run_missing" />);
    (container.querySelector('[data-testid="proof-of-work-export"]') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await waitForElement(container, '.error-banner');
    expect(container.querySelector('.error-banner')).not.toBeNull();
    expect(container.textContent).toContain('not_found');
  });

  it('never renders the bare proof-of-work URL as a link — the address 401s without the bearer header', async () => {
    stubBrowserDownload();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html/>', { status: 200 })));
    const { ProofOfWorkExport } = await import('../src/components/ProofOfWorkExport');
    // The only assertion is an absence, so it would also pass against a
    // container that never rendered. `render` above waits for the export button
    // first, so "no link" is now read off a panel that is genuinely on screen.
    const container = await render(<ProofOfWorkExport runId="run_1" />);
    expect(container.querySelector('a[href*="proof-of-work"]')).toBeNull();
  });
});
