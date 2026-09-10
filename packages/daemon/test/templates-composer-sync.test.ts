/**
 * T4-7: `packages/ui/src/components/ComposerView.tsx`'s `COMPOSER_TEMPLATES`
 * is a HAND-MIRRORED duplicate of `resources/templates/*.json` — see the doc
 * comment on `COMPOSER_TEMPLATES` there and on `loadBundledTemplates` in
 * `../src/templates.ts` for why a single source of truth was not reachable
 * within that task's touch scope (`packages/ui` has no `resolveJsonModule`,
 * and there is no daemon route serving the bundled files to the browser).
 *
 * An unpinned duplicate is a drift bug with a delay fuse. This is the pin —
 * same idiom as `landing-honesty.test.ts`'s `cards()`: read the two source
 * files as TEXT and hold one to the other, because `packages/ui` pulls in
 * JSX/Radix/lucide that a daemon-context vitest run has no transform for, so
 * importing `ComposerView.tsx` here is not an option.
 *
 * ROUND-2 REVIEW FIX: the first version of this file compared 7 fields and
 * titled itself "every field that must not drift" — cadence was the 8th
 * field the doc comment (and ComposerView.tsx's own) named and the code
 * never checked. Templates 4 and 5 had NO schedule assertion anywhere (1-3's
 * rrule is pinned by templates-library.test.ts, but only against the JSON
 * side), so the digest's hour or the changelog template's schedule KIND
 * could drift on one side alone and both suites stayed green. Fixed below by
 * capturing `schedule` too and comparing THROUGH THE REAL EMITTER.
 *
 * CROSSING schedule-rule.ts's OWN STATED BOUNDARY, DELIBERATELY, TEST-ONLY.
 * That file's header says "the daemon therefore cannot import this emitter"
 * — true, and unchanged, for PRODUCTION code: `packages/daemon/package.json`
 * declares no dependency on `@clockwork/ui`, `packages/daemon/tsconfig.json`
 * has `"include": ["src"]` (not `test`) and is not in the `tsc -b` project
 * graph `pnpm typecheck` builds, and `schedule-rule.ts` itself has ZERO
 * imports — a plain, self-contained `.ts` file, not a React/JSX module. A
 * relative import of it from THIS test file therefore: is not part of the
 * daemon's production dependency graph, is not checked (or breakable) by
 * `tsc -b`, and pulls in none of the "UI is a pure wire client" baggage the
 * boundary exists to keep out of a headless daemon. It is the ONLY way to
 * compare a JSON template's stored rrule string against the composer's
 * decomposed fields without a SECOND, hand-written rrule-string-builder in
 * this file — which is exactly the kind of parallel implementation that
 * could itself silently drift from the real one and defeat the point of this
 * test. If this ever needs to be undone, schedule-rule.ts's own header names
 * the fallback pattern: a checked-in fixture
 * (`packages/shared/fixtures/emittable-schedules.json`) kept honest by a
 * test on the UI side.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadBundledTemplates } from '../src/templates.js';
import { composeWeeklyRule, composeDailyRule, type Weekday } from '../../ui/src/lib/schedule-rule.js';

const TEMPLATES_DIR = path.resolve(import.meta.dirname, '../../../resources/templates');
const COMPOSER_VIEW = path.resolve(import.meta.dirname, '../../ui/src/components/ComposerView.tsx');

type ComposerSchedule = { kind: 'asap' } | { kind: 'rrule'; rruleFreq: string; rruleByDay: string[]; rruleTime: string };

interface ComposerTemplateFields {
  name: string;
  prompt: string;
  profileSlug: string;
  permissionMode: string;
  maxUsd: string;
  maxTurns: string;
  timeoutSec: string;
  schedule: ComposerSchedule;
}

/** Parses the `schedule: {...}` object CAPTURED AS TEXT by FIELD_RE below into a comparable shape. */
function parseComposerSchedule(raw: string): ComposerSchedule {
  if (/kind: 'asap'/.test(raw)) return { kind: 'asap' };
  const freq = /rruleFreq: '(\w+)'/.exec(raw)?.[1];
  const time = /rruleTime: '([\d:]+)'/.exec(raw)?.[1];
  const daysRaw = /rruleByDay: \[([^\]]*)\]/.exec(raw)?.[1] ?? '';
  const rruleByDay = daysRaw
    .split(',')
    .map((s) => s.trim().replace(/'/g, ''))
    .filter(Boolean);
  if (!freq || !time) throw new Error(`could not parse composer schedule object: ${raw}`);
  return { kind: 'rrule', rruleFreq: freq, rruleByDay, rruleTime: time };
}

/**
 * Extracts the composer's inline `COMPOSER_TEMPLATES` entries AS TEXT. None
 * of the five prompts contain an apostrophe (verified by eye against
 * resources/templates/*.json before this test was written), so a
 * single-quoted-string capture `'([^']+)'` never truncates early — if a
 * future template's prompt needs one, this regex must change to handle `\'`
 * at the same time, or it will silently capture a truncated prompt and this
 * test will pass on a lie. `scheduleLabel` is consumed (`'[^']+'`) but not
 * captured — it is decorative card text, not one of the fields that must not
 * drift.
 */
function composerTemplates(): ComposerTemplateFields[] {
  const src = readFileSync(COMPOSER_VIEW, 'utf8');
  const start = src.indexOf('const COMPOSER_TEMPLATES: ComposerTemplate[] = [');
  expect(start, 'COMPOSER_TEMPLATES constant not found in ComposerView.tsx — renamed or removed?').toBeGreaterThan(-1);
  const end = src.indexOf('\n];', start);
  expect(end, 'COMPOSER_TEMPLATES constant has no "\\n];" after it — its closing shape changed?').toBeGreaterThan(start);
  const block = src.slice(start, end);

  // Tolerant of a `//` comment line between any two fields (this codebase
  // comments heavily, in this very file's object — a bare `\s*` bridge broke
  // the instant a round-2 review comment landed between `timeoutSec` and
  // `scheduleLabel` on template 5; caught by re-running this test, not by
  // reasoning about it in advance).
  const WS = String.raw`(?:\s|//[^\n]*)*`;
  const FIELD_RE = new RegExp(
    `name: '([^']+)',${WS}prompt:${WS}'([^']+)',${WS}profileSlug: '([^']+)',${WS}permissionMode: '([^']+)',${WS}maxUsd: '([^']+)',${WS}maxTurns: '([^']+)',${WS}timeoutSec: '([^']+)',${WS}scheduleLabel: '[^']+',${WS}schedule: (\\{[^}]*\\}),`,
    'g',
  );
  return [...block.matchAll(FIELD_RE)].map((m) => ({
    name: m[1]!,
    prompt: m[2]!,
    profileSlug: m[3]!,
    permissionMode: m[4]!,
    maxUsd: m[5]!,
    maxTurns: m[6]!,
    timeoutSec: m[7]!,
    schedule: parseComposerSchedule(m[8]!),
  }));
}

/** The JSON side's `schedule` is `unknown` (TemplateFile, templates.ts) — narrowed here, test-only, for comparison. */
function jsonSchedule(schedule: unknown): { kind?: string; rrule?: string } {
  return (schedule ?? {}) as { kind?: string; rrule?: string };
}

describe('T4-7 composer/JSON template sync — the hand-mirrored duplicate stays honest', () => {
  const jsonTemplates = loadBundledTemplates(TEMPLATES_DIR);
  const composer = composerTemplates();

  it('parses at least one composer template (a guard on the guard)', () => {
    // If the extraction regex above ever stops matching — ComposerView.tsx's
    // object shape changed — every equality check below would vacuously pass
    // comparing [] to [], the classic empty-array false-green. Name that
    // failure here, separately, before the real checks run.
    expect(composer.length).toBeGreaterThan(0);
  });

  it('the JSON files and the composer quick-fill list the same COUNT of templates', () => {
    expect(
      composer.length,
      `resources/templates/*.json has ${jsonTemplates.length}, ComposerView.tsx's COMPOSER_TEMPLATES has ${composer.length} — ` +
        'a template added to one side without the other must fail here first.',
    ).toBe(jsonTemplates.length);
  });

  /**
   * ALLOW-LISTED, INTENDED divergence, pinned by name and count on BOTH
   * sides: the composer has no 'queue' schedule kind of its own (see
   * ComposerTemplate's doc comment in ComposerView.tsx), so exactly the
   * pre-release-changelog-draft template maps JSON 'queue' to composer
   * 'asap'. An intended divergence that is silent is indistinguishable from
   * drift — this makes it visible, and a SECOND template silently joining
   * the exception (in either direction) fails here first.
   */
  it('exactly one template uses the queue-→asap allow-listed mapping', () => {
    const jsonQueue = jsonTemplates.filter((t) => jsonSchedule(t.schedule).kind === 'queue').map((t) => t.name);
    const composerAsap = composer.filter((c) => c.schedule.kind === 'asap').map((c) => c.name);
    expect(jsonQueue, 'json templates with schedule.kind === "queue"').toEqual(['Pre-release changelog draft']);
    expect(composerAsap, 'composer templates with schedule.kind === "asap"').toEqual(['Pre-release changelog draft']);
  });

  it('every field that must not drift agrees between the two representations, by name — including cadence', () => {
    const byName = new Map(jsonTemplates.map((t) => [t.name, t]));
    const mismatches: string[] = [];

    for (const c of composer) {
      const j = byName.get(c.name);
      if (!j) {
        mismatches.push(`composer has "${c.name}" — no resources/templates/*.json file with that name`);
        continue;
      }
      if (c.prompt !== j.prompt) {
        mismatches.push(`${c.name}: prompt differs\n  json:     ${j.prompt}\n  composer: ${c.prompt}`);
      }
      if (c.profileSlug !== j.profileSlug) {
        mismatches.push(`${c.name}: profileSlug "${c.profileSlug}" (composer) != "${j.profileSlug}" (json)`);
      }
      if (c.permissionMode !== j.permissionMode) {
        mismatches.push(`${c.name}: permissionMode "${c.permissionMode}" (composer) != "${j.permissionMode}" (json)`);
      }
      // Budget is a STRING in the composer (it feeds a controlled <Input>
      // bound to form.maxUsd/maxTurns/timeoutSec) and a NUMBER in the JSON
      // file (Budget, shared/schemas.ts) — compared by numeric value, which
      // is the real invariant; the two representations are not expected to
      // share a wire format.
      if (Number(c.maxUsd) !== j.budget.maxUsd) {
        mismatches.push(`${c.name}: maxUsd ${c.maxUsd} (composer) != ${j.budget.maxUsd} (json)`);
      }
      if (Number(c.maxTurns) !== j.budget.maxTurns) {
        mismatches.push(`${c.name}: maxTurns ${c.maxTurns} (composer) != ${j.budget.maxTurns} (json)`);
      }
      if (Number(c.timeoutSec) !== j.budget.timeoutSec) {
        mismatches.push(`${c.name}: timeoutSec ${c.timeoutSec} (composer) != ${j.budget.timeoutSec} (json)`);
      }

      // Cadence — compared THROUGH THE REAL EMITTER (composeWeeklyRule /
      // composeDailyRule), never by rebuilding the rrule string here.
      const js = jsonSchedule(j.schedule);
      if (c.schedule.kind === 'asap') {
        // The allow-listed exception, asserted precisely: json must be
        // 'queue', or this IS drift (the composer says "no cadence, ASAP"
        // while the json side claims something else entirely).
        if (js.kind !== 'queue') {
          mismatches.push(`${c.name}: composer maps to 'asap' (allow-listed stand-in for 'queue') but json schedule.kind is "${js.kind}", not "queue"`);
        }
        continue;
      }
      if (js.kind !== 'rrule') {
        mismatches.push(`${c.name}: composer expects an 'rrule' schedule but json schedule.kind is "${js.kind}"`);
        continue;
      }
      const [hourStr, minuteStr] = c.schedule.rruleTime.split(':');
      const hour = Number(hourStr);
      const minute = Number(minuteStr);
      const expectedRrule =
        c.schedule.rruleFreq === 'WEEKLY'
          ? composeWeeklyRule(c.schedule.rruleByDay as Weekday[], hour, minute)
          : composeDailyRule(hour, minute);
      if (js.rrule !== expectedRrule) {
        mismatches.push(
          `${c.name}: rrule differs\n  json:                         ${js.rrule}\n  composer (via real emitter):  ${expectedRrule}`,
        );
      }
    }
    for (const j of jsonTemplates) {
      if (!composer.some((c) => c.name === j.name)) {
        mismatches.push(`resources/templates has "${j.name}" — no composer quick-fill card with that name`);
      }
    }

    expect(mismatches, `\n${mismatches.join('\n')}`).toEqual([]);
  });
});
