/**
 * F2 shift-handoff memory shipped with a working daemon route pair
 * (`GET`/`POST /workforce/handoff/:taskId`) and no button anywhere in the
 * app — a recurring task started every occurrence cold. This tests the
 * panel that makes that memory visible where a task's runs are read, and
 * lets a human append to it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent, waitFor, waitForElement, waitForText } from './helpers/dom';

/**
 * This file is where the flake was first seen: the CI failure read
 * `expected '' to contain 'nothing carried over yet'`, i.e. an EMPTY container.
 * A local two-reads-agree `settle()` was the first patch; it lived here only,
 * and "two reads agree" can still agree on the pre-fetch state. Every case now
 * waits for the specific thing it goes on to assert, using the shared helpers.
 */
const render = renderComponent;

const now = 1_700_000_000_000;

const agentMemory = {
  id: 'mem_1',
  taskId: 'task_1',
  runId: 'run_0',
  author: 'agent',
  kind: 'handoff',
  tried: 'Bumped lodash to 4.17.21',
  blocked: 'peer dependency conflict with jest-cli',
  nextCheck: 'confirm jest-cli 30 is out before retrying',
  body: null,
  createdAt: now,
};

const humanNote = {
  id: 'mem_2',
  taskId: 'task_1',
  runId: 'run_prev',
  author: 'human',
  kind: 'note',
  tried: null,
  blocked: null,
  nextCheck: null,
  body: 'Please stop touching the lockfile directly.',
  createdAt: now - 1000,
};

function stubHandoffFetch(opts: {
  memories?: unknown[];
  getStatus?: number;
  appendStatus?: number;
  appendError?: string;
} = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (!/^\/workforce\/handoff\//.test(u)) throw new Error(`unexpected fetch: ${u}`);
    if (init?.method === 'POST') {
      if (opts.appendStatus && opts.appendStatus !== 201) {
        return new Response(JSON.stringify({ error: opts.appendError ?? 'boom' }), { status: opts.appendStatus });
      }
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: 'mem_new',
          taskId: 'task_1',
          runId: body.runId ?? null,
          author: body.author ?? 'agent',
          kind: body.kind ?? 'handoff',
          tried: body.tried ?? null,
          blocked: body.blocked ?? null,
          nextCheck: body.nextCheck ?? null,
          body: body.body ?? null,
          createdAt: now + 5000,
        }),
        { status: 201 },
      );
    }
    if (opts.getStatus && opts.getStatus !== 200) {
      return new Response(JSON.stringify({ error: 'boom' }), { status: opts.getStatus });
    }
    return new Response(JSON.stringify({ memories: opts.memories ?? [] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('TaskMemoryPanel (F2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders both an agent handoff entry and a human note, newest first as the daemon returns them', async () => {
    stubHandoffFetch({ memories: [humanNote, agentMemory] });
    const { TaskMemoryPanel } = await import('../src/components/TaskMemoryPanel');
    const container = await render(<TaskMemoryPanel taskId="task_1" runId="run_1" version={0} />);
    await waitFor(
      () => container.querySelectorAll('[data-testid="memory-entry"]').length === 2,
      'both memory entries the daemon returned',
      { describe: () => `entries = ${container.querySelectorAll('[data-testid="memory-entry"]').length}` },
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Please stop touching the lockfile directly');
    expect(text).toContain('Bumped lodash to 4.17.21');
    expect(text).toContain('peer dependency conflict with jest-cli');
    expect(text).toContain('confirm jest-cli 30 is out before retrying');
    expect(container.querySelectorAll('[data-testid="memory-entry"]')).toHaveLength(2);
  });

  it('gives an honest empty state that explains the feature instead of a bare "nothing here"', async () => {
    stubHandoffFetch({ memories: [] });
    const { TaskMemoryPanel } = await import('../src/components/TaskMemoryPanel');
    const container = await render(<TaskMemoryPanel taskId="task_1" runId="run_1" version={0} />);
    // The exact assertion that broke CI, now waited for instead of slept past.
    await waitForText(container, 'Nothing carried over yet');
    const text = container.textContent ?? '';
    expect(text.toLowerCase()).toContain('nothing carried over yet');
    expect(container.querySelector('[data-testid="memory-note-input"]')).not.toBeNull();
  });

  it('adding a note POSTs { author: human, kind: note, body, runId } and refreshes the list', async () => {
    const fetchMock = stubHandoffFetch({ memories: [] });
    const { TaskMemoryPanel } = await import('../src/components/TaskMemoryPanel');
    const container = await render(<TaskMemoryPanel taskId="task_1" runId="run_1" version={0} />);
    await waitForElement(container, '[data-testid="memory-note-input"]');

    const input = container.querySelector('[data-testid="memory-note-input"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'the failing test is flaky, not broken');
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const submit = container.querySelector('[data-testid="memory-note-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The reload GET is issued only after the POST resolves, so a second GET is
    // the last event in the chain this test asserts on.
    await waitFor(
      () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== 'POST').length >= 2,
      'the POST and the reload GET that follows it',
      { describe: () => `fetch calls = ${JSON.stringify(fetchMock.mock.calls.map((c) => [String(c[0]), (c[1] as RequestInit | undefined)?.method ?? 'GET']))}` },
    );

    const postCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(postCall, 'Add note must POST to /workforce/handoff/:taskId').toBeDefined();
    expect(String(postCall![0])).toBe('/workforce/handoff/task_1');
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({
      author: 'human',
      kind: 'note',
      body: 'the failing test is flaky, not broken',
      runId: 'run_1',
    });
    // reload after a successful append: at least one more GET than the initial mount
    const getCalls = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== 'POST');
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('the Add note button stays disabled for a blank note', async () => {
    stubHandoffFetch({ memories: [] });
    const { TaskMemoryPanel } = await import('../src/components/TaskMemoryPanel');
    const container = await render(<TaskMemoryPanel taskId="task_1" runId="run_1" version={0} />);
    await waitForElement(container, '[data-testid="memory-note-submit"]');
    const submit = container.querySelector('[data-testid="memory-note-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('a soft-deleted task\'s 422 "unknown task" reads as read-only history, not a raw error', async () => {
    stubHandoffFetch({ memories: [agentMemory], appendStatus: 422, appendError: 'unknown task' });
    const { TaskMemoryPanel } = await import('../src/components/TaskMemoryPanel');
    const container = await render(<TaskMemoryPanel taskId="task_deleted" runId="run_1" version={0} />);
    await waitForElement(container, '[data-testid="memory-note-input"]');

    const input = container.querySelector('[data-testid="memory-note-input"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'trying to add a note anyway');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (container.querySelector('[data-testid="memory-note-submit"]') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await waitForText(container, 'This task was deleted');

    expect(container.textContent).toContain('This task was deleted');
    expect(container.querySelector('[data-testid="memory-note-input"]'), 'the write form must close, not error-loop').toBeNull();
    // history from before deletion must still be visible
    expect(container.textContent).toContain('Bumped lodash to 4.17.21');
  });

  it('surfaces a failed GET instead of a blank panel', async () => {
    stubHandoffFetch({ getStatus: 500 });
    const { TaskMemoryPanel } = await import('../src/components/TaskMemoryPanel');
    const container = await render(<TaskMemoryPanel taskId="task_1" runId="run_1" version={0} />);
    await waitForElement(container, '.error-banner');
    expect(container.querySelector('.error-banner')).not.toBeNull();
    expect(container.textContent).toContain('boom');
  });
});
