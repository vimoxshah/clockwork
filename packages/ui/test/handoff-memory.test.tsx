/**
 * F2 shift-handoff memory shipped with a working daemon route pair
 * (`GET`/`POST /workforce/handoff/:taskId`) and no button anywhere in the
 * app — a recurring task started every occurrence cold. This tests the
 * panel that makes that memory visible where a task's runs are read, and
 * lets a human append to it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function render(node: JSX.Element): Promise<HTMLDivElement> {
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  createRoot(container).render(node);
  await new Promise((r) => setTimeout(r, 30));
  return container;
}

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
    const text = container.textContent ?? '';
    expect(text.toLowerCase()).toContain('nothing carried over yet');
    expect(container.querySelector('[data-testid="memory-note-input"]')).not.toBeNull();
  });

  it('adding a note POSTs { author: human, kind: note, body, runId } and refreshes the list', async () => {
    const fetchMock = stubHandoffFetch({ memories: [] });
    const { TaskMemoryPanel } = await import('../src/components/TaskMemoryPanel');
    const container = await render(<TaskMemoryPanel taskId="task_1" runId="run_1" version={0} />);

    const input = container.querySelector('[data-testid="memory-note-input"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'the failing test is flaky, not broken');
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const submit = container.querySelector('[data-testid="memory-note-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));

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
    const submit = container.querySelector('[data-testid="memory-note-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('a soft-deleted task\'s 422 "unknown task" reads as read-only history, not a raw error', async () => {
    stubHandoffFetch({ memories: [agentMemory], appendStatus: 422, appendError: 'unknown task' });
    const { TaskMemoryPanel } = await import('../src/components/TaskMemoryPanel');
    const container = await render(<TaskMemoryPanel taskId="task_deleted" runId="run_1" version={0} />);

    const input = container.querySelector('[data-testid="memory-note-input"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'trying to add a note anyway');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (container.querySelector('[data-testid="memory-note-submit"]') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 30));

    expect(container.textContent).toContain('This task was deleted');
    expect(container.querySelector('[data-testid="memory-note-input"]'), 'the write form must close, not error-loop').toBeNull();
    // history from before deletion must still be visible
    expect(container.textContent).toContain('Bumped lodash to 4.17.21');
  });

  it('surfaces a failed GET instead of a blank panel', async () => {
    stubHandoffFetch({ getStatus: 500 });
    const { TaskMemoryPanel } = await import('../src/components/TaskMemoryPanel');
    const container = await render(<TaskMemoryPanel taskId="task_1" runId="run_1" version={0} />);
    expect(container.querySelector('.error-banner')).not.toBeNull();
    expect(container.textContent).toContain('boom');
  });
});
