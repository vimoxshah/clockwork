/**
 * The nine unreachable workforce features get their UI in the next wave, and
 * every one of those surfaces codes against `api.ts`. A helper that names the
 * wrong route, drops a body field or sends the wrong verb fails at runtime in
 * a browser, because Vite strips types without checking them — so the contract
 * is pinned here, against the daemon routes in packages/daemon/src/api.ts.
 *
 * What each case asserts: the METHOD, the exact PATH (including how optional
 * query params are encoded), the JSON BODY, and that the bearer token rides
 * along. Nothing here mocks the helper under test; only `fetch` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setToken } from '../src/api';

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | undefined;
}

let calls: Call[] = [];

/** Records every request and answers each with the next queued response. */
function stubFetch(...responses: Response[]): void {
  const queue = [...responses];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      method: String(init.method),
      path,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      auth: headers.authorization,
    });
    return queue.shift() ?? json({});
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

beforeEach(() => {
  calls = [];
  setToken('tok_test');
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** The single request every case below inspects. */
function only(): Call {
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe('every workforce helper carries the bearer token', () => {
  it('sends Authorization on a GET and a POST alike', async () => {
    stubFetch(json({ sentinels: [] }), json({ enabled: false, windows: [] }));
    await api.sentinels();
    await api.officeHours();
    expect(calls.map((c) => c.auth)).toEqual(['Bearer tok_test', 'Bearer tok_test']);
  });
});

describe('plan-then-execute (F1)', () => {
  it('creates a pair from a task id, hour and zone', async () => {
    await api.planExecuteCreate({ taskId: 'task_1', planHour: 9, tz: 'America/New_York' });
    expect(only()).toMatchObject({
      method: 'POST',
      path: '/workforce/plan-execute',
      body: { taskId: 'task_1', planHour: 9, tz: 'America/New_York' },
    });
  });

  it('omits the status filter entirely when none is given', async () => {
    stubFetch(json({ pairs: [] }));
    await api.planExecuteList();
    expect(only().path).toBe('/workforce/plan-execute');
  });

  it('filters the list by status', async () => {
    stubFetch(json({ pairs: [] }));
    await api.planExecuteList('awaiting_approval');
    expect(only().path).toBe('/workforce/plan-execute?status=awaiting_approval');
  });

  it('reads one pair', async () => {
    await api.planExecuteGet('pe_1');
    expect(only()).toMatchObject({ method: 'GET', path: '/workforce/plan-execute/pe_1' });
  });

  it('resolves a pair with the decision in the body', async () => {
    await api.planExecuteResolve('pe_1', 'approved');
    expect(only()).toMatchObject({
      method: 'POST',
      path: '/workforce/plan-execute/pe_1/resolve',
      body: { decision: 'approved' },
    });
  });
});

describe('shift-handoff (F2)', () => {
  it('reads a task memory, with and without a limit', async () => {
    stubFetch(json({ memories: [] }), json({ memories: [] }));
    await api.handoff('task_1');
    await api.handoff('task_1', 3);
    expect(calls.map((c) => c.path)).toEqual([
      '/workforce/handoff/task_1',
      '/workforce/handoff/task_1?limit=3',
    ]);
  });

  it('appends without a taskId in the body — the route merges it from the path', async () => {
    await api.handoffAppend('task_1', { author: 'human', kind: 'note', body: 'watch the flaky test' });
    const call = only();
    expect(call).toMatchObject({ method: 'POST', path: '/workforce/handoff/task_1' });
    expect(call.body).toEqual({ author: 'human', kind: 'note', body: 'watch the flaky test' });
  });
});

describe('office hours (F3)', () => {
  it('reads the enabled flag and the windows in one call', async () => {
    stubFetch(json({ enabled: true, windows: [] }));
    const res = await api.officeHours();
    expect(only()).toMatchObject({ method: 'GET', path: '/workforce/office-hours' });
    expect(res.enabled).toBe(true);
  });

  it('creates a window', async () => {
    await api.officeHoursCreate({ dow: 1, startMin: 540, endMin: 1020, tz: 'UTC' });
    expect(only()).toMatchObject({
      method: 'POST',
      path: '/workforce/office-hours',
      body: { dow: 1, startMin: 540, endMin: 1020, tz: 'UTC' },
    });
  });

  it('writes the enabled flag', async () => {
    stubFetch(json({ enabled: false }));
    await api.officeHoursSetEnabled(false);
    expect(only()).toMatchObject({
      method: 'PUT',
      path: '/workforce/office-hours/enabled',
      body: { enabled: false },
    });
  });

  it('deletes a window and survives the empty 204 body', async () => {
    stubFetch(noContent());
    await expect(api.officeHoursDelete('oh_1')).resolves.toBeUndefined();
    expect(only()).toMatchObject({ method: 'DELETE', path: '/workforce/office-hours/oh_1' });
  });
});

describe('sentinels (F4)', () => {
  it('creates one', async () => {
    await api.sentinelCreate({ name: 'disk', sentinelTaskId: 'task_1', triggerId: 'trg_1', tripExpr: 'ALERT' });
    expect(only()).toMatchObject({
      method: 'POST',
      path: '/workforce/sentinels',
      body: { name: 'disk', sentinelTaskId: 'task_1', triggerId: 'trg_1', tripExpr: 'ALERT' },
    });
  });

  it('lists them', async () => {
    stubFetch(json({ sentinels: [] }));
    await api.sentinels();
    expect(only()).toMatchObject({ method: 'GET', path: '/workforce/sentinels' });
  });

  it('deletes one through the 204 route', async () => {
    stubFetch(noContent());
    await expect(api.sentinelDelete('sen_1')).resolves.toBeUndefined();
    expect(only()).toMatchObject({ method: 'DELETE', path: '/workforce/sentinels/sen_1' });
  });

  it('lists trips, with and without a limit', async () => {
    stubFetch(json({ trips: [] }), json({ trips: [] }));
    await api.sentinelTrips('sen_1');
    await api.sentinelTrips('sen_1', 10);
    expect(calls.map((c) => c.path)).toEqual([
      '/workforce/sentinels/sen_1/trips',
      '/workforce/sentinels/sen_1/trips?limit=10',
    ]);
  });
});

describe('repo-shipped jobs (F5)', () => {
  it('discovers from a repo path', async () => {
    stubFetch(json({ offers: [] }));
    await api.repoJobsDiscover('/Users/me/code/app');
    expect(only()).toMatchObject({
      method: 'POST',
      path: '/workforce/repo-jobs/discover',
      body: { repoPath: '/Users/me/code/app' },
    });
  });

  it('lists offers, optionally by status', async () => {
    stubFetch(json({ offers: [] }), json({ offers: [] }));
    await api.repoJobs();
    await api.repoJobs('offered');
    expect(calls.map((c) => c.path)).toEqual(['/workforce/repo-jobs', '/workforce/repo-jobs?status=offered']);
  });

  it('imports and dismisses by offer id', async () => {
    stubFetch(json({ taskId: 'task_9' }), json({ dismissed: true }));
    await api.repoJobImport('rj_1');
    await api.repoJobDismiss('rj_2');
    expect(calls).toMatchObject([
      { method: 'POST', path: '/workforce/repo-jobs/rj_1/import' },
      { method: 'POST', path: '/workforce/repo-jobs/rj_2/dismiss' },
    ]);
  });
});

describe('earned autonomy (F7)', () => {
  it('lists offers, optionally by status', async () => {
    stubFetch(json({ offers: [] }), json({ offers: [] }));
    await api.autonomyOffers();
    await api.autonomyOffers('offered');
    expect(calls.map((c) => c.path)).toEqual([
      '/workforce/autonomy/offers',
      '/workforce/autonomy/offers?status=offered',
    ]);
  });

  it('responds to an offer', async () => {
    await api.autonomyRespond('ao_1', 'accepted');
    expect(only()).toMatchObject({
      method: 'POST',
      path: '/workforce/autonomy/offers/ao_1/respond',
      body: { decision: 'accepted' },
    });
  });

  it('reads and enrols one profile', async () => {
    stubFetch(json({ profileId: 'prof_1' }), json({ profileId: 'prof_1' }));
    await api.autonomyProfile('prof_1');
    await api.autonomyEnroll('prof_1', 'acceptEdits');
    expect(calls).toMatchObject([
      { method: 'GET', path: '/workforce/autonomy/profiles/prof_1' },
      { method: 'POST', path: '/workforce/autonomy/profiles/prof_1/enroll', body: { rung: 'acceptEdits' } },
    ]);
  });

  it('lists the enrolled profiles out of /profiles, dropping the unenrolled', async () => {
    stubFetch(
      json([
        { id: 'p1', slug: 'a', name: 'A', autonomy_rung: 'plan', autonomy_streak_required: null },
        { id: 'p2', slug: 'b', name: 'B', autonomy_rung: null, autonomy_streak_required: null },
        { id: 'p3', slug: 'c', name: 'C', autonomy_rung: 'unattended', autonomy_streak_required: 8 },
      ]),
    );
    const enrolled = await api.autonomyEnrolledProfiles();
    expect(only()).toMatchObject({ method: 'GET', path: '/profiles' });
    expect(enrolled.map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(enrolled[1].autonomy_streak_required).toBe(8);
  });
});

describe('timesheets (F10)', () => {
  it('sends no window at all when none is asked for', async () => {
    stubFetch(json({ rows: [] }));
    await api.timesheet();
    expect(only().path).toBe('/workforce/timesheets');
  });

  it('sends from, to and profileId as epoch-ms query params', async () => {
    stubFetch(json({ rows: [] }));
    await api.timesheet({ from: 1000, to: 2000, profileId: 'prof_1' });
    expect(only().path).toBe('/workforce/timesheets?from=1000&to=2000&profileId=prof_1');
  });

  it('sets the human hourly rate, and clears it with null', async () => {
    stubFetch(json({ humanHourlyRateUsd: 85 }), json({ humanHourlyRateUsd: null }));
    await api.setHumanHourlyRate(85);
    await api.setHumanHourlyRate(null);
    expect(calls).toMatchObject([
      { method: 'PUT', path: '/workforce/prefs/hourly-rate', body: { humanHourlyRateUsd: 85 } },
      { method: 'PUT', path: '/workforce/prefs/hourly-rate', body: { humanHourlyRateUsd: null } },
    ]);
  });
});

describe('performance reviews (F11)', () => {
  it('lists cards, one card and the review prompt', async () => {
    stubFetch(json({ cards: [] }), json({ runs: 0 }), json({ prompt: 'x' }));
    await api.performanceCards();
    await api.performanceCard('prof_1', { from: 10, to: 20 });
    await api.performanceReviewPrompt('prof_1');
    expect(calls.map((c) => c.path)).toEqual([
      '/workforce/performance',
      '/workforce/performance/prof_1?from=10&to=20',
      '/workforce/performance/prof_1/review-prompt',
    ]);
  });
});

describe('proof-of-work (F12)', () => {
  it('builds the export URL, encoding only the options that were set', () => {
    expect(api.proofOfWorkUrl('run_1')).toBe('/workforce/runs/run_1/proof-of-work');
    expect(api.proofOfWorkUrl('run_1', { includeTranscript: true, redactPaths: false })).toBe(
      '/workforce/runs/run_1/proof-of-work?includeTranscript=1&redactPaths=0',
    );
  });

  it('fetches the HTML as a blob over the same authorized request', async () => {
    stubFetch(new Response('<html>proof</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const blob = await api.proofOfWork('run_1', { includeDiffStat: true });
    expect(await blob.text()).toBe('<html>proof</html>');
    expect(only()).toMatchObject({
      method: 'GET',
      path: '/workforce/runs/run_1/proof-of-work?includeDiffStat=1',
      auth: 'Bearer tok_test',
    });
  });

  it('raises the same ApiError as every JSON call when the run is unknown', async () => {
    // two answers queued: one per call below, or the second falls through to
    // the stub's default 200 and the assertion tests nothing.
    stubFetch(json({ error: 'not_found' }, 404), json({ error: 'not_found' }, 404));
    await expect(api.proofOfWork('nope')).rejects.toMatchObject({ status: 404, message: 'not_found' });
    await expect(api.proofOfWork('nope')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('a 204 response is a success, not a parse error', () => {
  /**
   * `Response.json()` REJECTS on an empty body, so before the guard in `req` a
   * successful delete threw a SyntaxError and the caller's `.then(reload)`
   * never ran — SettingsView.tsx:503 deletes a trigger exactly that way.
   */
  it('resolves the pre-existing DELETE /triggers/:id helper', async () => {
    stubFetch(noContent());
    await expect(api.deleteTrigger('trg_1')).resolves.toBeUndefined();
  });

  it('resolves the pre-existing DELETE /byok/:id helper', async () => {
    stubFetch(noContent());
    await expect(api.byokDelete('byok_1')).resolves.toBeUndefined();
  });
});
