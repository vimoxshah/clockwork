/**
 * Tasks ▸ Edit ▸ Overlap policy.
 *
 * The composer half of "surface overlap policy" (`composer-overlap-policy.test.tsx`)
 * only ever creates a task — `ComposerView.tsx` POSTs and never PATCHes
 * (`composer-webhook-url.test.tsx`'s "never PATCHes an existing task" pins that).
 * So "an existing task must load its current policy" cannot be a composer
 * behaviour; it has to be the dialog that actually PATCHes an existing row —
 * `EditDialog`, defined inside `TasksView.tsx` (not exported, so it is driven
 * here through the real "Edit" button on a task row, the same way
 * `tasks-workforce.test.tsx` drives it).
 *
 * `GET /tasks` (`TaskViewT`, `api.ts`) already carries `overlapPolicy` on every
 * row and `view()` (`daemon/src/api.ts`) already returns it — this closes the
 * gap on the screen only, same shape as the composer half.
 *
 * jsdom + `createRoot`, and a real Radix Select driven through
 * `test/helpers/radix.ts` (installs the pointer-capture/scrollIntoView
 * no-ops jsdom lacks — proven already by `quiet-hours-card.test.tsx`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskViewT } from '../src/api';
import { renderComponent, waitForElement, waitFor } from './helpers/dom';
import { pickOption } from './helpers/radix';

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

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Route table → a fetch stub, matching tasks-workforce.test.tsx's `stubRoutes` shape. */
function stub(tasks: TaskViewT[], calls: Call[]): (url: unknown, init?: RequestInit) => Promise<Response> {
  return async (url: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const path = call.url.split('?')[0];
    if (path === '/tasks' && call.method === 'GET') return json(tasks);
    if (path === '/queue') return json([]);
    if (path === '/workforce/plan-execute') return json({ pairs: [] });
    if (path === '/runs') return json([]);
    if (path.startsWith('/tasks/') && call.method === 'PATCH') {
      return json({ ...tasks.find((t) => `/tasks/${t.id}` === path), ...(call.body as object) });
    }
    return json({});
  };
}

function click(el: Element | null | undefined): void {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).click();
}

const textOf = (el: Element | null): string => el?.textContent ?? '';
const labels = (el: Element): string[] => [...el.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** Renders Tasks, waits for the row, opens its Edit dialog. */
async function openEdit(t: TaskViewT, calls: Call[]): Promise<HTMLElement> {
  vi.stubGlobal('fetch', vi.fn(stub([t], calls)));
  const { default: TasksView } = await import('../src/components/TasksView');
  const c = await renderComponent(<TasksView version={1} />);
  await waitForElement(c, '[data-testid="task-row"]');
  const row = c.querySelector('[data-testid="task-row"]')!;
  expect(labels(row)).toContain('Edit');
  click([...row.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Edit'));
  await waitForElement(document.body, '[data-testid="edit-overlap-policy"]');
  return c;
}

describe('Tasks ▸ Edit ▸ Overlap policy', () => {
  it('loads the task’s current policy — a "queue" task opens showing Queue, not the schema default', async () => {
    const calls: Call[] = [];
    await openEdit(task({ id: 't1', name: 'Nightly dep sweep', overlapPolicy: 'queue' }), calls);
    const trigger = document.querySelector('[data-testid="edit-overlap-policy"]')!;
    expect(textOf(trigger)).toContain('Queue');
    expect(textOf(trigger)).not.toContain('Skip');
  });

  it('a "skip" task opens showing Skip', async () => {
    const calls: Call[] = [];
    await openEdit(task({ id: 't1', name: 'Nightly dep sweep', overlapPolicy: 'skip' }), calls);
    const trigger = document.querySelector('[data-testid="edit-overlap-policy"]')!;
    expect(textOf(trigger)).toContain('Skip');
  });

  it('changing it and saving PATCHes overlapPolicy through to the daemon', async () => {
    const calls: Call[] = [];
    await openEdit(task({ id: 't1', name: 'Nightly dep sweep', overlapPolicy: 'skip' }), calls);
    const trigger = document.querySelector('[data-testid="edit-overlap-policy"]')!;
    await pickOption(trigger, 'Queue — book it anyway; same-repo runs take turns, a task with no repo just waits for a free slot');
    await waitFor(() => (trigger.textContent ?? '').includes('Queue'), 'the trigger to show the new selection');

    const saveBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Save');
    click(saveBtn);

    const patched = await waitFor(
      () => calls.find((c) => c.method === 'PATCH' && c.url === '/tasks/t1'),
      'PATCH /tasks/t1',
      { describe: () => JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)) },
    );
    expect((patched.body as { overlapPolicy: string }).overlapPolicy).toBe('queue');
  });

  it('saving without touching the control keeps the task’s existing policy, not the schema default', async () => {
    const calls: Call[] = [];
    await openEdit(task({ id: 't1', name: 'Nightly dep sweep', overlapPolicy: 'queue' }), calls);

    const saveBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Save');
    click(saveBtn);

    const patched = await waitFor(
      () => calls.find((c) => c.method === 'PATCH' && c.url === '/tasks/t1'),
      'PATCH /tasks/t1',
      { describe: () => JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)) },
    );
    expect((patched.body as { overlapPolicy: string }).overlapPolicy).toBe('queue');
  });
});
