/**
 * T4-2 — "Run a sample job now": one click, and what it actually books.
 *
 * The README promises a first run in sixty seconds and then lists five steps
 * that each need a decision. This button removes all five, which means IT is
 * now making them — so the tests here read the POST body field by field
 * rather than checking that a request happened. `permissionMode: 'plan'` and
 * `maxUsd: 0.5` are the safety claim of firing a run at a stranger's machine
 * on their first click; a test that only asserted "createTask was called"
 * would stay green through the exact regression that matters.
 *
 * The other half is the refusal. When the daemon finds no repository the
 * button must book NOTHING and offer the bundled snippet instead — a
 * one-click feature that guesses a directory is worse than one that admits it
 * found nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OnboardingGate, SAMPLE_JOB_BUDGET, SAMPLE_JOB_PERMISSION_MODE } from '../src/App';
import { neverHappens, renderComponent, waitFor, waitForElement, waitForText } from './helpers/dom';

const APP = readFileSync(path.resolve(import.meta.dirname, '../src/App.tsx'), 'utf8');

const REPO_PLAN = {
  repo: { path: '/Users/u/acme-api', name: 'acme-api', source: 'home' },
  lookedIn: ['repos you have booked work against before', '~/.clockwork/repos', '~ (top level only)'],
  profileSlug: 'code-reviewer',
  profileId: 'prof_cr',
  job: { name: 'Code review: acme-api', prompt: 'First-pass code review of the acme-api repository.', bundled: false },
};

const NO_REPO_PLAN = {
  ...REPO_PLAN,
  repo: null,
  job: { name: 'Code review: bundled sample', prompt: 'First-pass code review of the snippet below.', bundled: true },
};

interface Call {
  url: string;
  method: string;
  body?: any;
}

interface StubOptions {
  plan?: unknown;
  /** Non-2xx for POST /tasks, to prove a refusal is shown rather than swallowed. */
  createStatus?: number;
  createError?: string;
  /** Non-2xx for the PATCH that disarms the one-shot. */
  patchStatus?: number;
  /** claude + auth + git: what THIS booking needs, which is not the same as `hasProvider`. */
  readyToBook?: boolean;
  hasProvider?: boolean;
  planStatus?: number;
}

function stubFetch(opts: StubOptions = {}): { calls: Call[] } {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url: u, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (u === '/onboarding/status') {
      const ready = opts.readyToBook ?? true;
      return json({
        claudeInstalled: ready,
        claudeAuthed: ready,
        gitInstalled: ready,
        mcpDetected: false,
        hasTasks: false,
        readyToBook: ready,
        hasProvider: opts.hasProvider ?? true,
        byokCount: opts.hasProvider === true && !ready ? 1 : 0,
      });
    }
    if (u === '/onboarding/sample') {
      if (opts.planStatus) return json({ error: 'daemon says no' }, opts.planStatus);
      return json(opts.plan ?? REPO_PLAN);
    }
    if (u === '/tasks' && method === 'POST') {
      if (opts.createStatus) return json({ error: opts.createError ?? 'refused' }, opts.createStatus);
      return json({ id: 'task_sample', version: 1 }, 201);
    }
    if (/^\/tasks\/[^/]+\/run-now$/.test(u) && method === 'POST') return json({ runId: 'run_sample' }, 202);
    if (/^\/tasks\/[^/]+$/.test(u) && method === 'PATCH') {
      if (opts.patchStatus) return json({ error: 'nope' }, opts.patchStatus);
      return json({ id: 'task_sample', version: 2 });
    }
    throw new Error(`unexpected fetch in onboarding-sample test: ${method} ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

function createCall(calls: Call[]): Call | undefined {
  return calls.find((c) => c.url === '/tasks' && c.method === 'POST');
}

/** Mount the gate and press the sample button. Returns the watched-run spy. */
async function clickSample(container: HTMLElement): Promise<void> {
  const btn = await waitForElement<HTMLButtonElement>(container, '[data-testid="onboard-run-sample"]');
  expect(btn.disabled, 'the sample button must be live when a provider is ready').toBe(false);
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function mount(onWatchRun: (runId: string) => void = () => {}): Promise<HTMLDivElement> {
  return renderComponent(<OnboardingGate version={0} onBook={() => {}} onWatchRun={onWatchRun} />);
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.setItem('clockwork.token', 'test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe('T4-2 the sample booking', () => {
  it('books the read-only reviewer, at $0.50, ASAP, against the repo the daemon found', async () => {
    const { calls } = stubFetch();
    const before = Date.now();
    const container = await mount();

    await clickSample(container);
    const create = await waitFor(() => createCall(calls), 'the sample booking to be posted', {
      describe: () => JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)),
    });

    // Read-only. Not "the profile is read-only by mission" — the mode.
    expect(create.body.permissionMode).toBe('plan');
    expect(create.body.permissionMode).not.toBe('acceptEdits');
    expect(SAMPLE_JOB_PERMISSION_MODE).toBe('plan');
    // Cheap.
    expect(create.body.budget).toEqual({ maxUsd: 0.5, maxTurns: 30, timeoutSec: 900 });
    expect(SAMPLE_JOB_BUDGET.maxUsd).toBe(0.5);
    // ASAP: a one-shot in the near future, because POST /tasks refuses a
    // `once` whose runAt is already behind the clock.
    expect(create.body.schedule.kind).toBe('once');
    expect(create.body.schedule.runAt).toBeGreaterThan(before);
    expect(create.body.schedule.runAt).toBeLessThanOrEqual(before + 20_000);
    expect(typeof create.body.schedule.tz).toBe('string');
    expect(create.body.schedule.tz.length).toBeGreaterThan(0);
    // Where, who, and what to say — all of it from the daemon's answer.
    expect(create.body.repoPath).toBe('/Users/u/acme-api');
    expect(create.body.profileSlugMention).toBe('code-reviewer');
    expect(create.body.name).toBe(REPO_PLAN.job.name);
    expect(create.body.prompt).toBe(REPO_PLAN.job.prompt);
    // No typing, so nothing may be left for the user to fill in.
    expect(create.body.overlapPolicy).toBe('skip');
    expect(create.body.missedPolicy).toBe('run-late');
  });

  it('starts the run at once and hands it to the live view', async () => {
    const { calls } = stubFetch();
    const watched: string[] = [];
    const container = await mount((runId) => watched.push(runId));

    await clickSample(container);
    await waitFor(() => watched.length > 0, 'the run to be handed to the live view');

    // ASAP alone is the next 30s scheduler sweep — half the minute this
    // button promises. So it is kicked by hand, and the id of THAT run is
    // what the Inbox is asked to open.
    expect(calls.some((c) => c.url === '/tasks/task_sample/run-now' && c.method === 'POST')).toBe(true);
    expect(watched).toEqual(['run_sample']);
  });

  it('disarms the one-shot it just fired by hand, so no second run is booked', async () => {
    const { calls } = stubFetch();
    const container = await mount();

    await clickSample(container);
    const patch = await waitFor(
      () => calls.find((c) => c.url === '/tasks/task_sample' && c.method === 'PATCH'),
      'the one-shot to be disarmed',
    );

    expect(patch.body).toEqual({ enabled: false });
  });

  it('still opens the live view when disarming fails — the run already started', async () => {
    const { calls } = stubFetch({ patchStatus: 500 });
    const watched: string[] = [];
    const container = await mount((runId) => watched.push(runId));

    await clickSample(container);
    await waitFor(() => watched.length > 0, 'the live view handoff to survive a failed PATCH');

    expect(watched).toEqual(['run_sample']);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
  });

  it('stays dead on a machine that carries a BYOK key but no Claude CLI', async () => {
    // The two readiness flags disagree exactly here, and this booking sends
    // no `byokId` — it resolves to the profile's `cli` engine. Gating on
    // `hasProvider` would light the button up on this machine and hand the
    // user a first run that dies at spawn.
    stubFetch({ hasProvider: true, readyToBook: false });
    const container = await mount();

    const btn = await waitForElement<HTMLButtonElement>(container, '[data-testid="onboard-run-sample"]');
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('title')).toContain('Claude CLI');
  });
});

describe('T4-2 when there is no repo to review', () => {
  it('books nothing and offers the bundled sample instead of guessing', async () => {
    const { calls } = stubFetch({ plan: NO_REPO_PLAN });
    const watched: string[] = [];
    const container = await mount((runId) => watched.push(runId));

    await clickSample(container);
    const offer = await waitForElement(container, '[data-testid="onboard-sample-offer"]');

    // The refusal is the feature. Nothing arbitrary was booked.
    await neverHappens(() => createCall(calls) !== undefined, 'a task booked with no repo found', {
      describe: () => JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)),
    });
    expect(watched).toEqual([]);
    // "Say so" — and say where it looked, or the user cannot act on it.
    expect(offer.textContent).toContain('No git repository found');
    for (const place of NO_REPO_PLAN.lookedIn) expect(offer.textContent).toContain(place);
  });

  it('books the bundled sample with no repoPath at all when the offer is taken', async () => {
    const { calls } = stubFetch({ plan: NO_REPO_PLAN });
    const watched: string[] = [];
    const container = await mount((runId) => watched.push(runId));

    await clickSample(container);
    const take = await waitForElement<HTMLButtonElement>(container, '[data-testid="onboard-sample-bundled"]');
    take.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const create = await waitFor(() => createCall(calls), 'the bundled sample to be booked');

    // No repoPath means a scratch run: the answer to "we found nothing of
    // yours" never cuts a worktree from anything the user owns.
    expect(create.body.repoPath).toBeUndefined();
    expect('repoPath' in create.body).toBe(false);
    // Same contract as the real thing.
    expect(create.body.permissionMode).toBe('plan');
    expect(create.body.budget).toEqual({ maxUsd: 0.5, maxTurns: 30, timeoutSec: 900 });
    expect(create.body.schedule.kind).toBe('once');
    expect(create.body.prompt).toBe(NO_REPO_PLAN.job.prompt);
    await waitFor(() => watched.length > 0, 'the bundled run to reach the live view');
    expect(watched).toEqual(['run_sample']);
  });
});

describe('T4-2 when the booking is refused', () => {
  it('shows the daemon’s reason and does not pretend a run started', async () => {
    const { calls } = stubFetch({ createStatus: 403, createError: 'policy: budget above the ceiling' });
    const watched: string[] = [];
    const container = await mount((runId) => watched.push(runId));

    await clickSample(container);
    const text = await waitForText(container, 'policy: budget above the ceiling');

    expect(text).toContain('Couldn’t start the sample run');
    expect(watched).toEqual([]);
    expect(calls.some((c) => /run-now/.test(c.url))).toBe(false);
  });

  it('reports a refusal from the sample route itself', async () => {
    const { calls } = stubFetch({ planStatus: 422 });
    const container = await mount();

    await clickSample(container);
    await waitForText(container, 'daemon says no');

    expect(createCall(calls)).toBeUndefined();
    expect(container.querySelector('[data-testid="onboard-sample-offer"]')).toBeNull();
  });
});

describe('T4-2 wiring', () => {
  it('App mounts the gate with the live-view handoff attached', async () => {
    // The gate cannot navigate on its own — App owns the tabs and InboxView's
    // deep-link queue. Asserted against the source, the same way the other
    // shell wiring is, so the handoff cannot quietly disappear.
    expect(APP).toContain('onWatchRun={(runId) => {');
    expect(APP).toContain('setPendingRunId(runId);');
    expect(APP).toMatch(/setPendingRunId\(runId\);\s*\n\s*setTab\('inbox'\);/);
  });
});
