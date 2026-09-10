/**
 * T4-8: "Export a template, share a job" — the two controls TasksView.tsx
 * adds on top of the existing `/templates/preview` + `/templates/import`
 * routes (api.ts, already covered server-side by
 * packages/daemon/test/templates-export.test.ts). This file proves the
 * BUTTONS are actually wired to those routes, the same split
 * proof-of-work-export.test.tsx uses for its own daemon route.
 *
 *   1. A row's overflow "Export template" action downloads a file (blob →
 *      object URL → synthetic `<a download>` click), mirroring
 *      ProofOfWorkExport.tsx's own pattern exactly, and surfaces a failure
 *      instead of swallowing it.
 *   2. The toolbar's "Import template" dialog reads a selected File, previews
 *      it via POST /templates/preview, renders the flags, and only THEN
 *      offers Import — which POSTs to /templates/import. A red flag disables
 *      the Import button (client-side courtesy; the server is the real
 *      refusal, proven in the daemon suite).
 *
 * Fetch is stubbed by PATH (query string ignored, same convention
 * tasks-workforce.test.tsx's `stubRoutes` uses), not by method — every route
 * used here has one method per path, so that stays unambiguous. Unlike that
 * file's helper, this one also records every call (method/url/body) so the
 * import dialog's POST bodies can be asserted on directly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskViewT } from '../src/api';
import { renderComponent, waitFor, waitForElement, waitForText } from './helpers/dom';

function task(over: Partial<TaskViewT> & { id: string; name: string }): TaskViewT {
  return {
    prompt: 'do the thing',
    profileId: null,
    repoPath: null,
    permissionMode: 'acceptEdits',
    budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
    missedPolicy: 'run-late',
    overlapPolicy: 'skip',
    enabled: true,
    version: 1,
    nextFire: null,
    ...over,
  };
}

interface StubCall {
  method: string;
  url: string;
  body?: unknown;
}

/** Route table, keyed by pathname (query ignored) → a fetch stub, with every call recorded. */
function stubRoutes(handlers: Record<string, (call: StubCall) => unknown>): { calls: StubCall[] } {
  const calls: StubCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const path = url.split('?')[0]!;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const call: StubCall = { method, url, body };
      calls.push(call);
      const handler = handlers[path];
      if (!handler) return new Response(JSON.stringify({ error: `no stub for ${method} ${path}` }), { status: 404 });
      const result = handler(call);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), { status: 200 });
    }),
  );
  return { calls };
}

/** jsdom has neither of these; the export button calls both on every download. */
function stubBrowserDownload(): { createObjectURL: ReturnType<typeof vi.fn>; revokeObjectURL: ReturnType<typeof vi.fn>; click: ReturnType<typeof vi.fn> } {
  const createObjectURL = vi.fn(() => 'blob:mock-url');
  const revokeObjectURL = vi.fn();
  (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: typeof revokeObjectURL }).revokeObjectURL = revokeObjectURL;
  const click = vi.fn();
  HTMLAnchorElement.prototype.click = click;
  return { createObjectURL, revokeObjectURL, click };
}

const render = renderComponent;

/** React 18 flushes a discrete click synchronously — see helpers/dom.tsx's file header. */
function click(el: Element | null | undefined): void {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).click();
}

const BASE_ROUTES = {
  '/tasks': () => [] as TaskViewT[],
  '/queue': () => [],
  '/workforce/plan-execute': () => ({ pairs: [] }),
  '/runs': () => [],
};

async function renderTasksView(routes: Record<string, (call: StubCall) => unknown>): Promise<{ container: HTMLDivElement; calls: StubCall[] }> {
  const { calls } = stubRoutes({ ...BASE_ROUTES, ...routes });
  const { default: TasksView } = await import('../src/components/TasksView');
  const container = await render(<TasksView version={1} />);
  return { container, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 1. Export template — a row's overflow menu
// ---------------------------------------------------------------------------

describe('T4-8 Export template (row overflow menu)', () => {
  const EXPORTED_TPL = {
    schema: 'clockwork.template.v1',
    name: 'Nightly digest',
    prompt: 'summarize open TODOs',
    permissionMode: 'acceptEdits',
    budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
    schedule: { kind: 'queue', tz: 'UTC' },
    missedPolicy: 'run-late',
    overlapPolicy: 'skip',
    delivery: { osNotify: true },
  };

  it('downloads the file the daemon route returns, via blob → object URL → anchor click', async () => {
    const stubs = stubBrowserDownload();
    const { container: c, calls } = await renderTasksView({
      '/tasks': () => [task({ id: 'task_1', name: 'Nightly digest' })],
      '/tasks/task_1/export-template': () =>
        new Response(JSON.stringify(EXPORTED_TPL, null, 2), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': 'attachment; filename="clockwork-template-task_1.json"',
          },
        }),
    });

    const row = await waitForElement(c, '[data-testid="task-row"]');
    click(row.querySelector('[aria-label="More actions for Nightly digest"]'));
    const exportItem = await waitForElement(c, '[data-testid="row-menu-export"]');
    click(exportItem);

    await waitFor(() => stubs.click.mock.calls.length > 0, 'the download anchor to be clicked', {
      describe: () => `anchor click called ${stubs.click.mock.calls.length} times`,
    });

    expect(calls.some((call) => call.method === 'GET' && call.url === '/tasks/task_1/export-template')).toBe(true);
    expect(stubs.createObjectURL).toHaveBeenCalledTimes(1);
    expect(stubs.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('surfaces a failed export instead of a silent no-op', async () => {
    stubBrowserDownload();
    const { container: c } = await renderTasksView({
      '/tasks': () => [task({ id: 'task_1', name: 'Nightly digest' })],
      '/tasks/task_1/export-template': () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }),
    });

    const row = await waitForElement(c, '[data-testid="task-row"]');
    click(row.querySelector('[aria-label="More actions for Nightly digest"]'));
    click(await waitForElement(c, '[data-testid="row-menu-export"]'));

    await waitForElement(c, '.error-banner');
    expect(c.querySelector('.error-banner')?.textContent).toContain('not_found');
  });

  it('the overflow menu still offers Delete beside Export — T4-8 adds to the menu, it does not replace what T4-5 put there', async () => {
    const { container: c } = await renderTasksView({
      '/tasks': () => [task({ id: 'task_1', name: 'Nightly digest' })],
    });
    const row = await waitForElement(c, '[data-testid="task-row"]');
    click(row.querySelector('[aria-label="More actions for Nightly digest"]'));
    const panel = await waitForElement(c, '[data-testid="row-menu-panel"]');
    expect(panel.querySelector('[aria-label="Export Nightly digest as a template"]')).not.toBeNull();
    expect(panel.querySelector('[aria-label="Delete Nightly digest"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Import template — the toolbar dialog
// ---------------------------------------------------------------------------

describe('T4-8 Import template (toolbar dialog)', () => {
  function templateFile(content: string, name = 'shared-job.json'): File {
    return new File([content], name, { type: 'application/json' });
  }

  function selectFile(input: HTMLInputElement, file: File): void {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const VALID_TPL = JSON.stringify({
    schema: 'clockwork.template.v1',
    name: 'Shared job',
    prompt: 'do the shared thing',
    permissionMode: 'acceptEdits',
    budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
  });

  it('previews a selected file via POST /templates/preview, then imports it — arrives disabled, review-then-enable message shown', async () => {
    const flags = [{ level: 'info', text: 'Imported templates arrive DISABLED — review then enable.' }];
    const { container: c, calls } = await renderTasksView({
      '/templates/preview': () => ({ preview: { flags, arrivesDisabled: true }, template: {} }),
      '/templates/import': () => new Response(JSON.stringify({ task: { id: 'task_new' }, flags }), { status: 201 }),
    });

    click(await waitForElement(c, '[data-testid="import-template-open"]'));
    const fileInput = await waitForElement<HTMLInputElement>(c, '[data-testid="import-template-file"]');
    selectFile(fileInput, templateFile(VALID_TPL));

    await waitForElement(c, '[data-testid="import-template-flags"]');
    expect(c.textContent).toContain('Imported templates arrive DISABLED');

    const confirmBtn = (await waitForElement(c, '[data-testid="import-template-confirm"]')) as HTMLButtonElement;
    expect(confirmBtn.disabled, 'no red flag — Import must be enabled').toBe(false);
    click(confirmBtn);

    await waitForText(c, 'Imported');
    expect(c.textContent).toContain('disabled');

    const previewCall = calls.find((call) => call.method === 'POST' && call.url === '/templates/preview');
    expect((previewCall?.body as { name?: string } | undefined)?.name).toBe('Shared job');
    const importCall = calls.find((call) => call.method === 'POST' && call.url === '/templates/import');
    expect((importCall?.body as { name?: string } | undefined)?.name).toBe('Shared job');
    // The dialog posts the SAME parsed file to both routes — no special-cased
    // "self-import" transform between preview and import.
    expect(importCall?.body).toEqual(previewCall?.body);
  });

  it('a red flag in the preview disables Import — the client-side courtesy; the server refusal is proven in the daemon suite', async () => {
    const flags = [{ level: 'red', text: 'bypassPermissions is banned in H1 — import will be rejected.' }];
    const { container: c } = await renderTasksView({
      '/templates/preview': () => ({ preview: { flags, arrivesDisabled: true }, template: {} }),
    });

    click(await waitForElement(c, '[data-testid="import-template-open"]'));
    const fileInput = await waitForElement<HTMLInputElement>(c, '[data-testid="import-template-file"]');
    selectFile(
      fileInput,
      templateFile(
        JSON.stringify({
          schema: 'clockwork.template.v1',
          name: 'evil',
          prompt: 'do things',
          permissionMode: 'bypassPermissions',
          budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
        }),
      ),
    );

    await waitForElement(c, '[data-testid="import-template-flags"]');
    expect(c.textContent).toContain('bypassPermissions is banned');
    const confirmBtn = (await waitForElement(c, '[data-testid="import-template-confirm"]')) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it('a file that is not valid JSON shows an error and never calls /templates/preview', async () => {
    const { container: c, calls } = await renderTasksView({});

    click(await waitForElement(c, '[data-testid="import-template-open"]'));
    const fileInput = await waitForElement<HTMLInputElement>(c, '[data-testid="import-template-file"]');
    selectFile(fileInput, templateFile('not json at all {{{', 'broken.json'));

    await waitForElement(c, '.error-banner');
    expect(c.querySelector('.error-banner')?.textContent).toContain('not valid JSON');
    expect(calls.some((call) => call.url === '/templates/preview')).toBe(false);
  });

  it('Cancel closes the dialog without importing anything', async () => {
    const { container: c, calls } = await renderTasksView({});
    click(await waitForElement(c, '[data-testid="import-template-open"]'));
    await waitForElement(c, '[data-testid="import-template-file"]');
    const dialog = c.querySelector('[role="dialog"]')!;
    click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'));

    await waitFor(() => c.querySelector('[data-testid="import-template-file"]') === null, 'the dialog to close', {
      describe: () => `dialog still present: ${c.innerHTML.slice(0, 200)}`,
    });
    expect(calls.some((call) => call.url.startsWith('/templates/'))).toBe(false);
  });
});
