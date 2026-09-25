/**
 * Pipelines section (P3): graph render with derived states, node click
 * detail, parent add/remove, run-now retry. Mounted directly (TaskPipeline)
 * with a stubbed loopback — the assertions are on what the daemon's
 * view-model says, never on local derivations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskPipeline } from '../src/components/TaskPipeline';
import { renderComponent, waitForElement, waitForText } from './helpers/dom';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const NODES = [
  { taskId: 'scan', name: 'Scan', enabled: true, parents: [], latestRun: { id: 'r1', state: 'completed', costUsd: 0.5, turns: 9 }, derived: 'succeeded' },
  {
    taskId: 'fix',
    name: 'Fix',
    enabled: true,
    parents: [{ parentId: 'scan', on: 'completed', via: 'edge' }],
    latestRun: null,
    derived: 'blocked',
  },
  {
    taskId: 'test',
    name: 'Test',
    enabled: true,
    parents: [{ parentId: 'fix', on: 'completed', via: 'edge' }],
    latestRun: null,
    derived: 'blocked',
  },
];

const TASKS = [
  { id: 'scan', name: 'Scan' },
  { id: 'fix', name: 'Fix' },
  { id: 'test', name: 'Test' },
] as any;

function stub(routes: Array<[RegExp, (call: Call) => Response | Promise<Response>]>): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      for (const [pattern, handler] of routes) {
        if (pattern.test(call.url)) return handler(call);
      }
      throw new Error(`unexpected request: ${call.method} ${call.url}`);
    }) as any,
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mount(): Promise<{ container: HTMLDivElement; calls: Call[] }> {
  const { calls } = stub([[/^\/tasks\/fix\/pipeline$/, () => json({ focus: 'fix', nodes: NODES })]]);
  const container = await renderComponent(<TaskPipeline taskId="fix" taskName="Fix" tasks={TASKS} version={1} />);
  await waitForElement(container, '[data-testid="task-pipeline"]');
  return { container, calls };
}

describe('pipeline graph', () => {
  it('renders upstream, focus and downstream with derived states', async () => {
    const { container } = await mount();
    await waitForText(container, 'Scan');
    await waitForText(container, 'Test');
    expect(container.querySelector('[data-testid="pipeline-node-scan"]')?.textContent).toContain('succeeded');
    expect(container.querySelector('[data-testid="pipeline-node-fix"]')?.textContent).toContain('blocked');
  });

  it('node click shows run detail and edge conditions', async () => {
    const { container } = await mount();
    await waitForElement(container, '[data-testid="pipeline-node-scan"]');
    (container.querySelector('[data-testid="pipeline-node-scan"]') as HTMLButtonElement).click();
    await waitForElement(container, '[data-testid="pipeline-node-detail"]');
    await waitForText(container, '$0.50');
    await waitForText(container, '9 turns');
  });

  it('run-now retries from the detail box', async () => {
    const { calls } = stub([
      [/^\/tasks\/fix\/pipeline$/, () => json({ focus: 'fix', nodes: NODES })],
      [/^\/tasks\/scan\/run-now$/, () => json({ runId: 'r9' })],
    ]);
    const container = await renderComponent(<TaskPipeline taskId="fix" taskName="Fix" tasks={TASKS} version={1} />);
    await waitForElement(container, '[data-testid="pipeline-node-scan"]');
    (container.querySelector('[data-testid="pipeline-node-scan"]') as HTMLButtonElement).click();
    await waitForElement(container, '[data-testid="pipeline-node-detail"]');
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Run now') as HTMLButtonElement;
    btn.click();
    await waitForText(container, 'Run queued');
    expect(calls.some((c) => c.url === '/tasks/scan/run-now')).toBe(true);
  });

  it('add + remove parent round-trips through the routes', async () => {
    const { calls } = stub([
      [/^\/tasks\/fix\/pipeline$/, () => json({ focus: 'fix', nodes: NODES })],
      [/^\/tasks\/fix\/parents$/, () => json({ parentId: 'test', on: 'completed' }, 201)],
      [/^\/tasks\/fix\/parents\/scan$/, () => json({ removed: true })],
    ]);
    const container = await renderComponent(<TaskPipeline taskId="fix" taskName="Fix" tasks={TASKS} version={1} />);
    await waitForElement(container, '[data-testid="pipeline-node-fix"]');
    (container.querySelector('[data-testid="pipeline-node-fix"]') as HTMLButtonElement).click();
    await waitForElement(container, '[data-testid="pipeline-add-parent"]');
    const sel = container.querySelector('[data-testid="pipeline-add-parent"]') as HTMLSelectElement;
    sel.value = 'test';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    (container.querySelector('[data-testid="pipeline-add-button"]') as HTMLButtonElement).click();
    await waitForText(container, 'Dependency added.');
    expect(calls.some((c) => c.url === '/tasks/fix/parents' && (c.body as any)?.parentId === 'test')).toBe(true);
    (container.querySelector('[data-testid="pipeline-remove-scan"]') as HTMLButtonElement).click();
    await waitForText(container, 'Dependency removed.');
  });
});
