/**
 * Settings' half of the workforce wave: F3 office hours, F7 earned autonomy,
 * and the plan matrix that ticked twelve capabilities while nine of them had
 * no screen.
 *
 * Three kinds of assertion, deliberately:
 *   1. Source-level — SettingsView must MOUNT the two cards. A component
 *      nobody renders is a feature nobody can reach, and no isolated render
 *      test would notice (the lesson workforce-inbox.test.tsx records).
 *   2. Behaviour-level — jsdom + createRoot, the approach the existing UI
 *      tests use. Every control the cards draw must reach the daemon route it
 *      claims to, with the body the daemon expects, and every refusal must
 *      reach the user.
 *   3. Honesty-level — the capability matrix must WITHHOLD its tick from a
 *      feature this build has no screen for, and grant it once one registers.
 *      That is the bug being fixed, so it is asserted from both sides.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neverHappens, renderComponent, waitFor, waitForElement, waitForText } from './helpers/dom';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SETTINGS = readFileSync(resolve(SRC, 'components/SettingsView.tsx'), 'utf8');

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const render = renderComponent;

/** Waits for a route to appear in the recorded calls, printing them if it does not. */
const sawCall = (calls: Call[], what: string, match: (c: Call) => boolean): Promise<true> =>
  waitFor(() => calls.some(match) || undefined, what, {
    describe: () => `calls = ${JSON.stringify(calls.map((c) => `${c.method} ${c.url}`))}`,
  });

function click(el: Element | null): void {
  expect(el, 'control missing from the DOM').not.toBeNull();
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** React tracks the value node-side, so the native setter is the only way in. */
function type(el: Element | null, value: string): void {
  expect(el, 'input missing from the DOM').not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el as HTMLInputElement, value);
  (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Routes only the calls a card is allowed to make. An unrouted request throws
 * rather than resolving empty — a silently-swallowed fetch would let a blank
 * card pass as a green test.
 */
function stubFetch(routes: Array<[RegExp, (call: Call) => Response]>): { calls: Call[] } {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const [pattern, handler] of routes) {
      if (pattern.test(call.url)) return handler(call);
    }
    throw new Error(`unexpected request: ${call.method} ${call.url}`);
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const WINDOW_ROW = {
  id: 'oh_1',
  label: 'Working hours',
  dow: 2,
  startMin: 540,
  endMin: 1020,
  tz: 'America/New_York',
  enabled: true,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const PROFILE_UNFLAGGED = {
  id: 'p_1',
  slug: 'docs-scribe',
  name: 'Docs Scribe',
  permission_mode: 'acceptEdits',
  autonomy_rung: null,
  may_require_approval: 0,
};

const PROFILE_ENROLLED = {
  id: 'p_2',
  slug: 'test-doctor',
  name: 'Test Doctor',
  permission_mode: 'plan',
  autonomy_rung: 'plan',
  autonomy_streak_required: null,
  may_require_approval: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 1. The cards are mounted, not merely written
// ---------------------------------------------------------------------------

describe('Settings mounts the two workforce cards it owns (F3, F7)', () => {
  it('imports and renders OfficeHoursCard', () => {
    expect(SETTINGS).toContain("import { OfficeHoursCard } from './OfficeHoursCard'");
    expect(SETTINGS).toContain('<OfficeHoursCard version={version} />');
  });

  it('imports and renders AutonomyCard', () => {
    expect(SETTINGS).toContain("import { AutonomyCard } from './AutonomyCard'");
    expect(SETTINGS).toContain('<AutonomyCard version={version} />');
  });

  it('gives every settings surface an anchor the matrix can scroll to', async () => {
    // A registered surface whose anchor does not exist is a "Show me" button
    // that goes nowhere — the dead-link class of bug, one indirection later.
    const { featureSurfaces } = await import('../src/components/featureSurfaces');
    await import('../src/components/SettingsView');
    const settingsSurfaces = featureSurfaces().filter((s) => s.tab === 'settings');
    expect(settingsSurfaces.length).toBeGreaterThan(0);
    const missing = settingsSurfaces.filter((s) => !SETTINGS.includes(`id="${s.anchorId}"`));
    expect(missing.map((s) => s.key), 'registered for Settings but nothing renders its anchor').toEqual([]);
  });

  // Regression: the "runs today / needs you / next" scheduling snapshot used
  // to be bare monospace text with no container ('.statrow mono'), floating
  // directly under the Scheduling card with nothing to visually anchor it to
  // the rest of the section — a user reads that as unfinished. The fix wraps
  // it in the same '.tasklist-row' card treatment every other row in this
  // section already uses (Theme, Pause all scheduling).
  it('wraps the scheduling snapshot in the same card treatment as the rest of the section', () => {
    expect(SETTINGS).toContain('<div className="tasklist-row" data-testid="scheduling-snapshot">');
    // the old bare, containerless rendering must be gone, not merely duplicated
    expect(SETTINGS).not.toContain('<div className="statrow mono" style={{ marginTop: 14 }}>');
  });
});

// ---------------------------------------------------------------------------
// 2. F3 — office hours
// ---------------------------------------------------------------------------

describe('OfficeHoursCard (F3)', () => {
  const officeHoursRoutes = (
    payload: { enabled: boolean; windows: unknown[] },
    profiles: unknown[],
  ): Array<[RegExp, (call: Call) => Response]> => [
    [/^\/workforce\/office-hours$/, (c) => (c.method === 'POST' ? json(WINDOW_ROW, 201) : json(payload))],
    [/^\/workforce\/office-hours\/enabled$/, (c) => json({ enabled: (c.body as { enabled: boolean }).enabled })],
    [/^\/workforce\/office-hours\/[^/]+$/, () => new Response(null, { status: 204 })],
    [/^\/profiles$/, () => json(profiles)],
  ];

  const mount = async (
    payload: { enabled: boolean; windows: unknown[] },
    profiles: unknown[] = [PROFILE_UNFLAGGED],
    extra: Array<[RegExp, (call: Call) => Response]> = [],
  ): Promise<{ container: HTMLDivElement; calls: Call[] }> => {
    const { calls } = stubFetch([...extra, ...officeHoursRoutes(payload, profiles)]);
    const { OfficeHoursCard } = await import('../src/components/OfficeHoursCard');
    const container = await render(<OfficeHoursCard version={1} />);
    // The card renders `Reading office hours…` and nothing else until the GET
    // answers (OfficeHoursCard.tsx:167), so the prerequisite row appearing is
    // the moment the body exists at all.
    await waitForElement(container, '[data-testid="office-hours-prerequisite"]');
    return { container, calls };
  };

  it('shows each stored window with its day, hours and zone', async () => {
    const { container } = await mount({ enabled: true, windows: [WINDOW_ROW] });
    await waitForElement(container, '[data-testid="office-hours-window"]');
    const text = container.textContent ?? '';
    expect(text).toContain('Tuesday 09:00–17:00');
    expect(text).toContain('America/New_York');
    expect(text).toContain('Working hours');
    expect(container.querySelectorAll('[data-testid="office-hours-window"]')).toHaveLength(1);
  });

  it('states the prerequisite and says plainly that nothing defers today', async () => {
    // The whole point: office hours ON with no flagged profile defers nothing,
    // and looks identical to a correct install. It must not look identical here.
    // The "Earned autonomy" button renders only if the F7 surface is in the
    // registry (OfficeHoursCard.tsx:388), and AutonomyCard registers it at
    // module scope. In the app SettingsView imports both; here that only
    // happened as a side effect of an EARLIER test's `import(SettingsView)`.
    // Under load that test hit the 5s timeout, its import never finished, and
    // this one failed with `a way through to F7: expected null not to be null`
    // — a cascade, not a defect in this card. Register it explicitly.
    await import('../src/components/AutonomyCard');
    const { container } = await mount({ enabled: true, windows: [WINDOW_ROW] }, [PROFILE_UNFLAGGED]);
    await waitForElement(container, '[data-testid="office-hours-none-flagged"]');
    const text = container.textContent ?? '';
    expect(text, 'the flag is the prerequisite').toContain('flagged');
    expect(text, 'and F7 enrolment is the only thing that sets it').toContain('autonomy ladder');
    expect(container.querySelector('[data-testid="office-hours-none-flagged"]')!.textContent).toContain(
      'office hours is on and defers nothing',
    );
    expect(container.querySelector('[data-testid="office-hours-to-autonomy"]'), 'a way through to F7').not.toBeNull();
  });

  it('names the profiles that ARE flagged instead of leaving it abstract', async () => {
    const { container } = await mount({ enabled: true, windows: [WINDOW_ROW] }, [
      PROFILE_UNFLAGGED,
      PROFILE_ENROLLED,
    ]);
    // Needs GET /profiles, not just GET /workforce/office-hours.
    await waitForElement(container, '[data-testid="office-hours-flagged"]');
    const flagged = container.querySelector('[data-testid="office-hours-flagged"]');
    expect(flagged).not.toBeNull();
    expect(flagged!.textContent).toContain('Test Doctor');
    expect(container.querySelector('[data-testid="office-hours-none-flagged"]')).toBeNull();
  });

  it('turning the switch on reaches PUT /workforce/office-hours/enabled', async () => {
    const { container, calls } = await mount({ enabled: false, windows: [] });
    click(container.querySelector('[data-testid="office-hours-enabled"]'));
    await sawCall(calls, 'PUT /workforce/office-hours/enabled', (c) => c.url === '/workforce/office-hours/enabled');
    const put = calls.find((c) => c.url === '/workforce/office-hours/enabled');
    expect(put, 'the master switch must reach the daemon').toBeDefined();
    expect(put!.method).toBe('PUT');
    expect(put!.body).toEqual({ enabled: true });
  });

  it('adds a window with minutes-since-midnight, not a time string', async () => {
    const { container, calls } = await mount({ enabled: true, windows: [] });
    type(container.querySelector('#oh-start'), '08:30');
    type(container.querySelector('#oh-end'), '12:00');
    type(container.querySelector('#oh-tz'), 'Europe/Berlin');
    type(container.querySelector('#oh-label'), 'Mornings');
    // `type` dispatches a discrete `input` event, which React 18 flushes before
    // dispatchEvent returns — the form state is already committed here.
    click(container.querySelector('[data-testid="office-hours-add"]'));
    await sawCall(calls, 'POST /workforce/office-hours', (c) => c.url === '/workforce/office-hours' && c.method === 'POST');
    const post = calls.find((c) => c.url === '/workforce/office-hours' && c.method === 'POST');
    expect(post, 'Add window must POST').toBeDefined();
    expect(post!.body).toEqual({ dow: 1, startMin: 510, endMin: 720, tz: 'Europe/Berlin', label: 'Mornings' });
  });

  it('treats an end of 00:00 as the end of that day (1440), which the input cannot spell', async () => {
    const { endFieldToMin, timeToMin } = await import('../src/components/OfficeHoursCard');
    expect(endFieldToMin('00:00')).toBe(1440);
    expect(endFieldToMin('17:00')).toBe(1020);
    expect(timeToMin('00:00')).toBe(0);
    expect(timeToMin('')).toBeNull();
    expect(timeToMin('99:99')).toBeNull();
  });

  it('refuses to offer a window the daemon would 422 — and says why', async () => {
    const { container, calls } = await mount({ enabled: true, windows: [] });
    type(container.querySelector('#oh-end'), '08:00'); // before the 09:00 default start
    // The explanation appearing is the state change the typing caused, so it is
    // the anchor for reading the button beside it.
    await waitForElement(container, '[data-testid="office-hours-problem"]');
    const add = container.querySelector('[data-testid="office-hours-add"]') as HTMLButtonElement;
    expect(add.disabled, 'a control that is guaranteed to fail must not be live').toBe(true);
    expect(container.querySelector('[data-testid="office-hours-problem"]')!.textContent).toContain(
      'cannot cross midnight',
    );
    click(add);
    // THE ONE DELIBERATE DELAY IN THIS SUITE. Everything else waits for
    // something to happen; here the whole claim is that nothing does, and no
    // condition can become true to end the wait. `neverHappens` watches for a
    // bounded window and fails the instant a POST appears — which is strictly
    // more than a sleep did, because a sleep only ever looked once, at the end.
    await neverHappens(
      () => calls.some((c) => c.method === 'POST'),
      'a POST from the disabled Add button',
      { describe: () => `calls = ${JSON.stringify(calls.map((c) => `${c.method} ${c.url}`))}` },
    );
    expect(calls.filter((c) => c.method === 'POST'), 'nothing may be sent').toEqual([]);
  });

  it('surfaces the daemon’s refusal verbatim rather than swallowing it', async () => {
    const { calls } = stubFetch([
      [
        /^\/workforce\/office-hours$/,
        (c) =>
          c.method === 'POST'
            ? json({ error: "Unknown IANA time zone 'Mars/Olympus' — use a name like 'America/New_York'." }, 422)
            : json({ enabled: true, windows: [] }),
      ],
      [/^\/profiles$/, () => json([PROFILE_UNFLAGGED])],
    ]);
    const { OfficeHoursCard } = await import('../src/components/OfficeHoursCard');
    const container = await render(<OfficeHoursCard version={1} />);
    await waitForElement(container, '[data-testid="office-hours-prerequisite"]');
    type(container.querySelector('#oh-tz'), 'Mars/Olympus');
    click(container.querySelector('[data-testid="office-hours-add"]'));
    await waitForElement(container, '[data-testid="office-hours-error"]');
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
    expect(container.querySelector('[data-testid="office-hours-error"]')!.textContent).toContain('Mars/Olympus');
  });

  it('removes a window through DELETE and reloads the list', async () => {
    const { container, calls } = await mount({ enabled: true, windows: [WINDOW_ROW] });
    await waitForElement(container, '[data-testid="office-hours-window"]');
    click(container.querySelector('[data-testid="office-hours-remove"]'));
    // The reload GET is issued only after the DELETE resolves, so waiting for
    // the second GET covers both assertions below.
    await waitFor(
      () => calls.filter((c) => c.url === '/workforce/office-hours' && c.method === 'GET').length > 1,
      'the DELETE and the reload GET that follows it',
      { describe: () => `calls = ${JSON.stringify(calls.map((c) => `${c.method} ${c.url}`))}` },
    );
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe('/workforce/office-hours/oh_1');
    // 204 has no body; a reload that never happens is the bug api.ts's 204
    // guard exists for, so prove the list was re-read after the delete.
    expect(calls.filter((c) => c.url === '/workforce/office-hours' && c.method === 'GET').length).toBeGreaterThan(1);
  });

  it('a failed load reports the failure instead of an empty state that is not true', async () => {
    stubFetch([
      [/^\/workforce\/office-hours$/, () => json({ error: 'database is locked' }, 500)],
      [/^\/profiles$/, () => json([PROFILE_UNFLAGGED])],
    ]);
    const { OfficeHoursCard } = await import('../src/components/OfficeHoursCard');
    const container = await render(<OfficeHoursCard version={1} />);
    await waitForText(container, 'Couldn’t load office hours');
    expect(container.querySelector('[data-testid="office-hours-empty"]'), '“no windows yet” is a claim we cannot make').toBeNull();
    expect(container.textContent).toContain('Couldn\u2019t load office hours');
    expect(container.textContent, 'nor may the switch report a state it never read').toContain('unknown');
  });

  it('says what a window IS when there are none, not just “nothing here”', async () => {
    const { container } = await mount({ enabled: false, windows: [] });
    await waitForElement(container, '[data-testid="office-hours-empty"]');
    const empty = container.querySelector('[data-testid="office-hours-empty"]');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain('block of one weekday');
    expect(empty!.textContent).toContain('Add your first one');
  });
});

// ---------------------------------------------------------------------------
// 3. F7 — earned autonomy
// ---------------------------------------------------------------------------

describe('AutonomyCard (F7)', () => {
  const OFFER = {
    id: 'off_1',
    profileId: 'p_2',
    fromRung: 'plan',
    toRung: 'acceptEdits',
    streak: 5,
    status: 'offered',
    offeredAt: 1_700_000_000_000,
    decidedAt: null,
  };

  const STATE = { profileId: 'p_2', rung: 'plan', streakRequired: 5, streak: 5, eligible: true };

  const routes = (opts: {
    offers?: unknown[];
    profiles?: unknown[];
    state?: () => Response;
    respond?: () => Response;
    enroll?: () => Response;
  } = {}): Array<[RegExp, (call: Call) => Response]> => [
    [/^\/workforce\/autonomy\/offers\?/, () => json({ offers: opts.offers ?? [OFFER] })],
    [/^\/workforce\/autonomy\/offers\/[^/]+\/respond$/, opts.respond ?? (() => json({ ...OFFER, status: 'accepted' }))],
    [/^\/workforce\/autonomy\/profiles\/[^/]+\/enroll$/, opts.enroll ?? (() => json({ ...STATE, rung: 'plan' }))],
    [/^\/workforce\/autonomy\/profiles\/[^/]+$/, opts.state ?? (() => json(STATE))],
    [/^\/profiles$/, () => json(opts.profiles ?? [PROFILE_UNFLAGGED, PROFILE_ENROLLED])],
  ];

  const mount = async (
    opts: Parameters<typeof routes>[0] = {},
  ): Promise<{ container: HTMLDivElement; calls: Call[] }> => {
    const { calls } = stubFetch(routes(opts));
    const { AutonomyCard } = await import('../src/components/AutonomyCard');
    const container = await render(<AutonomyCard version={1} />);
    return { container, calls };
  };

  it('shows a pending offer with the profile, the rungs and what accepting changes', async () => {
    const { container } = await mount();
    // The profile NAME comes from GET /profiles, the row from GET …/offers.
    await waitForText(container, 'Test Doctor');
    const offer = container.querySelector('[data-testid="autonomy-offer"]');
    expect(offer).not.toBeNull();
    const text = offer!.textContent ?? '';
    expect(text).toContain('Test Doctor');
    expect(text).toContain('plan → acceptEdits');
    expect(text, 'the streak that earned it').toContain('5');
    expect(text, 'accepting rewrites the permission mode; say so before the click').toContain(
      'permission mode to acceptEdits',
    );
  });

  it('Accept posts the human decision for that offer', async () => {
    const { container, calls } = await mount();
    await waitForElement(container, '[data-testid="autonomy-accept"]');
    click(container.querySelector('[data-testid="autonomy-accept"]'));
    await sawCall(calls, 'POST …/respond', (c) => c.url.endsWith('/respond'));
    const post = calls.find((c) => c.url.endsWith('/respond'));
    expect(post?.url).toBe('/workforce/autonomy/offers/off_1/respond');
    expect(post?.body).toEqual({ decision: 'accepted' });
  });

  it('Decline posts a decline, and says the streak has to grow before asking again', async () => {
    const { container, calls } = await mount({ respond: () => json({ ...OFFER, status: 'declined' }) });
    await waitForElement(container, '[data-testid="autonomy-decline"]');
    click(container.querySelector('[data-testid="autonomy-decline"]'));
    await waitForElement(container, '[data-testid="autonomy-msg"]');
    expect(calls.find((c) => c.url.endsWith('/respond'))?.body).toEqual({ decision: 'declined' });
    expect(container.querySelector('[data-testid="autonomy-msg"]')!.textContent).toContain('grow past 5');
  });

  it('a second verdict on the same offer is explained, not swallowed (409)', async () => {
    const { container } = await mount({ respond: () => json({ error: 'already_resolved' }, 409) });
    await waitForElement(container, '[data-testid="autonomy-accept"]');
    click(container.querySelector('[data-testid="autonomy-accept"]'));
    await waitForElement(container, '[data-testid="autonomy-error"]');
    expect(container.querySelector('[data-testid="autonomy-error"]')!.textContent).toContain(
      'already answered',
    );
  });

  it('lists enrolled profiles with the rung, the streak and the LIVE permission mode', async () => {
    const { container } = await mount({ offers: [] });
    // `streak 5 of 5` needs the per-profile autonomy state, the last of the
    // three requests this card makes.
    await waitForText(container, 'streak 5 of 5');
    const row = container.querySelector('[data-testid="autonomy-enrolled-row"]');
    expect(row).not.toBeNull();
    const text = row!.textContent ?? '';
    expect(text).toContain('Test Doctor');
    expect(text).toContain('rung plan');
    expect(text).toContain('streak 5 of 5');
    expect(text, 'read back off GET /profiles, so a drift in our rung map shows').toContain(
      'permission mode plan',
    );
    expect(text).toContain('flagged for office hours');
  });

  it('a profile whose autonomy state cannot be read still renders', async () => {
    // Promise.allSettled, not all: one failed lookup must not blank the table.
    const { container } = await mount({ offers: [], state: () => json({ error: 'not_found' }, 404) });
    await waitForText(container, 'streak unavailable');
    const row = container.querySelector('[data-testid="autonomy-enrolled-row"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('streak unavailable');
  });

  it('enrolling asks first, spells out the rewrite, and only then writes', async () => {
    const { container, calls } = await mount({ offers: [] });
    // The button is disabled until GET /profiles answers, so this is where the
    // profile list actually arrives (AutonomyCard.tsx:254).
    const open = await waitFor(
      () => {
        const b = container.querySelector('[data-testid="autonomy-enrol-open"]') as HTMLButtonElement | null;
        return b && !b.disabled ? b : undefined;
      },
      'the enrol button to become live once profiles are known',
      { describe: () => `button reads ${JSON.stringify(container.querySelector('[data-testid="autonomy-enrol-open"]')?.textContent)}` },
    );
    click(open);
    await waitForElement(container, '[data-testid="autonomy-enrol-pick"]');
    const pick = container.querySelectorAll('[data-testid="autonomy-enrol-pick"]');
    expect(pick, 'only the profiles that are NOT enrolled can be enrolled').toHaveLength(1);
    click(pick[0]!);
    // The confirm panel appearing is what makes "nothing written yet" a real
    // claim: the click HAS been processed and still nothing was sent.
    await waitForElement(container, '[data-testid="autonomy-confirm"]');

    const confirm = container.querySelector('[data-testid="autonomy-confirm"]');
    expect(confirm, 'a one-way write must not happen on the first click').not.toBeNull();
    expect(calls.some((c) => c.url.includes('/enroll')), 'nothing written yet').toBe(false);
    expect(confirm!.querySelector('[data-testid="autonomy-confirm-mode"]')!.textContent).toContain(
      'changes from acceptEdits to plan',
    );
    expect(confirm!.querySelector('[data-testid="autonomy-confirm-oneway"]')!.textContent).toContain(
      'cannot be undone',
    );

    click(container.querySelector('[data-testid="autonomy-confirm-btn"]'));
    await sawCall(calls, 'POST …/enroll', (c) => c.url.includes('/enroll'));
    const post = calls.find((c) => c.url.includes('/enroll'));
    expect(post?.url).toBe('/workforce/autonomy/profiles/p_1/enroll');
    expect(post?.body).toEqual({ rung: 'plan' });
  });

  it('the chosen rung is the one that gets written, with its own consequences', async () => {
    const { container, calls } = await mount({ offers: [] });
    const open = await waitFor(
      () => {
        const b = container.querySelector('[data-testid="autonomy-enrol-open"]') as HTMLButtonElement | null;
        return b && !b.disabled ? b : undefined;
      },
      'the enrol button to become live once profiles are known',
      { describe: () => `button reads ${JSON.stringify(container.querySelector('[data-testid="autonomy-enrol-open"]')?.textContent)}` },
    );
    click(open);
    await waitForElement(container, '[data-testid="autonomy-enrol-pick"]');
    click(container.querySelector('[data-testid="autonomy-enrol-pick"]'));
    await waitForElement(container, '[data-testid="autonomy-rung-unattended"]');
    click(container.querySelector('[data-testid="autonomy-rung-unattended"]'));
    await waitForText(container, 'blocks nothing extra');
    const confirm = container.querySelector('[data-testid="autonomy-confirm"]')!;
    expect(confirm.textContent, 'the top two rungs share a permission mode — do not imply otherwise').toContain(
      'blocks nothing extra',
    );
    expect(confirm.textContent, 'clearing the flag opts the profile OUT of office hours').toContain(
      'stops applying',
    );
    click(container.querySelector('[data-testid="autonomy-confirm-btn"]'));
    await sawCall(calls, 'POST …/enroll', (c) => c.url.includes('/enroll'));
    expect(calls.find((c) => c.url.includes('/enroll'))?.body).toEqual({ rung: 'unattended' });
  });

  it('a failed load reports the failure instead of “no offers right now”', async () => {
    stubFetch([
      [/^\/workforce\/autonomy\/offers\?/, () => json({ error: 'database is locked' }, 500)],
      [/^\/profiles$/, () => json([])],
    ]);
    const { AutonomyCard } = await import('../src/components/AutonomyCard');
    const container = await render(<AutonomyCard version={1} />);
    await waitForText(container, 'Couldn\u2019t load autonomy state');
    expect(container.querySelector('[data-testid="autonomy-no-offers"]')).toBeNull();
    expect(container.textContent).toContain('Couldn\u2019t load autonomy state');
  });

  it('explains how offers appear instead of showing a bare empty list', async () => {
    const { container } = await mount({ offers: [], profiles: [PROFILE_UNFLAGGED] });
    await waitForElement(container, '[data-testid="autonomy-no-offers"]');
    await waitForElement(container, '[data-testid="autonomy-none-enrolled"]');
    expect(container.querySelector('[data-testid="autonomy-no-offers"]')!.textContent).toContain(
      'accepted outcomes',
    );
    expect(container.querySelector('[data-testid="autonomy-none-enrolled"]')!.textContent).toContain(
      'opt-in',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The plan matrix stops claiming screens that do not exist
// ---------------------------------------------------------------------------

describe('capability matrix reflects what is reachable, not just what is licensed', () => {
  const CAPS = {
    tier: 'free',
    entitlement: { tier: 'free', state: 'none' },
    features: [
      { key: 'office_hours', label: 'Office hours for approvals', category: 'scheduling', enabled: true, status: 'enforced' },
      { key: 'agent_timesheets', label: 'Agent timesheets', category: 'analytics', enabled: true, status: 'available' },
      { key: 'sso_scim', label: 'SSO / SCIM', category: 'governance', enabled: false, status: 'planned' },
    ],
  };

  beforeEach(() => {
    // A fresh module graph, so the surface registry starts EMPTY and each test
    // controls exactly which surfaces exist.
    vi.resetModules();
    stubFetch([[/^\/capabilities$/, () => json(CAPS)]]);
  });

  const openMatrix = async (): Promise<HTMLDivElement> => {
    const { LicenseCard } = await import('../src/components/LicenseCard');
    const container = await render(<LicenseCard version={1} />);
    await waitForElement(container, '[data-testid="capability-matrix-toggle"]');
    click(container.querySelector('[data-testid="capability-matrix-toggle"]'));
    await waitForElement(container, '[data-testid="capability-matrix"]');
    return container;
  };

  it('withholds the tick from an entitled feature with no screen in this build', async () => {
    const container = await openMatrix();
    await waitForElement(container, '[data-testid="capability-office_hours"]');
    expect(container.querySelector('[data-testid="capability-office_hours"]'), 'the row still lists it').not.toBeNull();
    expect(
      container.querySelector('[data-testid="capability-tick-office_hours"]'),
      'ticking a feature with no screen is the bug being fixed',
    ).toBeNull();
    expect(container.querySelector('[data-testid="capability-goto-office_hours"]')).toBeNull();
    // Withholding a claim, not making the opposite one: no accusation of
    // absence that another lane's screen would falsify an hour later.
    expect(container.textContent).not.toContain('no interface');
  });

  it('grants the tick and prints the location once a surface registers', async () => {
    await import('../src/components/OfficeHoursCard'); // registers at module scope
    const container = await openMatrix();
    await waitForElement(container, '[data-testid="capability-tick-office_hours"]');
    expect(container.querySelector('[data-testid="capability-tick-office_hours"]')).not.toBeNull();
    const goto = container.querySelector('[data-testid="capability-goto-office_hours"]');
    expect(goto!.textContent).toBe('Settings › Office hours');
    // ...and a feature that still has no screen keeps its silence.
    expect(container.querySelector('[data-testid="capability-tick-agent_timesheets"]')).toBeNull();
  });

  it('leaves an unlicensed feature exactly as it was — planned stays planned', async () => {
    await import('../src/components/OfficeHoursCard');
    const container = await openMatrix();
    await waitForElement(container, '[data-testid="capability-sso_scim"]');
    const row = container.querySelector('[data-testid="capability-sso_scim"]');
    expect(row!.textContent).toContain('planned');
    expect(container.querySelector('[data-testid="capability-tick-sso_scim"]')).toBeNull();
  });

  it('the registry itself fails closed for a key nobody registered', async () => {
    const { featureSurface, registerFeatureSurface } = await import('../src/components/featureSurfaces');
    expect(featureSurface('repo_shipped_jobs')).toBeUndefined();
    registerFeatureSurface({ key: 'repo_shipped_jobs', tab: 'tasks', where: 'Tasks › Repo jobs', anchorId: 'repo-jobs' });
    expect(featureSurface('repo_shipped_jobs')?.where).toBe('Tasks › Repo jobs');
  });

  it('“Show me” switches tab by hash instead of a fragment App would misread', async () => {
    // `tabFromHash()` reads the WHOLE hash as a tab name, so `#office-hours`
    // lands the user on Calendar. The reveal must set `#/<tab>`.
    const { registerFeatureSurface, revealFeatureSurface } = await import('../src/components/featureSurfaces');
    window.location.hash = '#/calendar';
    const surface = registerFeatureSurface({ key: 'x_feature', tab: 'analytics', where: 'Analytics › X', anchorId: 'x' });
    // revealFeatureSurface defers its scroll by 60ms (featureSurfaces.ts:103).
    // Left running, that timer fires after vitest tears the jsdom environment
    // down and crashes the RUN with `ReferenceError: document is not defined` —
    // reproduced under load, and present before this change. Fake timers run it
    // here, while `document` still exists, instead of leaking it past teardown.
    vi.useFakeTimers();
    try {
      revealFeatureSurface(surface);
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
    expect(window.location.hash).toBe('#/analytics');
  });
});
