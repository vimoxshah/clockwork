/**
 * F9 proposed-events, PRODUCER side.
 *
 * `extractProposedEvents` is the only thing that ever writes
 * `report.proposedEvents`, and its input is a string a model produced — text
 * that may have been steered by a repository, a web page or an issue comment.
 * So the interesting tests here are not the happy path; they are the refusals:
 * a block that is not JSON, a block that is enormous, a hundred blocks, an
 * agent-chosen `key` that would collide with a real calendar entry's UID, a
 * control character aimed at the .ics writer's line folding.
 *
 * The contract every one of them shares: fewer events, never a throw, and
 * never a value `ProposedEvent.parse` would reject.
 */
import { describe, expect, it } from 'vitest';
import { ProposedEvent } from '@clockwork/shared';
import { extractProposedEvents, PROPOSED_EVENTS_FENCE } from '../src/proposed-events-parse.js';

const NOW = Date.UTC(2026, 8, 6, 9, 0, 0);

/** Wrap a body in the documented fence. */
function block(body: string): string {
  return ['```' + PROPOSED_EVENTS_FENCE, body, '```'].join('\n');
}

describe('extractProposedEvents — the happy path', () => {
  it('reads the documented block and returns schema-valid events', () => {
    const summary = ['Reviewed the queue and found two follow-ups.', '', block(JSON.stringify([
      { title: 'Review PR 42', durationMin: 10, notes: 'ci is red', suggestedAt: '2026-09-08T15:00:00Z' },
      { title: 'Pair on the flaky test' },
    ]))].join('\n');

    const out = extractProposedEvents(summary, NOW);

    expect(out.found).toBe(true);
    expect(out.reason).toBeNull();
    expect(out.rejected).toBe(0);
    expect(out.events).toEqual([
      { key: 'ev-1', title: 'Review PR 42', notes: 'ci is red', durationMin: 10, suggestedAt: Date.UTC(2026, 8, 8, 15, 0, 0) },
      { key: 'ev-2', title: 'Pair on the flaky test', notes: null, durationMin: 15, suggestedAt: null },
    ]);
    // Whatever it returns must survive the schema the read path re-validates with.
    for (const ev of out.events) expect(ProposedEvent.safeParse(ev).success).toBe(true);
  });

  it('strips the block from the prose, so no human reads raw JSON in their inbox', () => {
    const summary = ['Done.', block('[{"title":"Review PR 42"}]'), 'Nothing else to report.'].join('\n');
    const out = extractProposedEvents(summary, NOW);
    expect(out.text).toBe('Done.\nNothing else to report.');
    expect(out.text).not.toContain('Review PR 42');
  });

  it('accepts an epoch-ms number for suggestedAt', () => {
    const at = NOW + 3_600_000;
    const out = extractProposedEvents(block(JSON.stringify([{ title: 'T', suggestedAt: at }])), NOW);
    expect(out.events[0]?.suggestedAt).toBe(at);
  });

  it('accepts a longer fence and a differently-cased label', () => {
    const summary = ['````Clockwork-Events', '[{"title":"T"}]', '````'].join('\n');
    expect(extractProposedEvents(summary, NOW).events).toHaveLength(1);
  });

  it('leaves an ordinary summary completely alone', () => {
    const summary = 'Fixed the bug.\n\n```json\n{"not":"ours"}\n```\n';
    const out = extractProposedEvents(summary, NOW);
    expect(out).toEqual({ events: [], text: summary, found: false, rejected: 0, reason: null });
  });
});

describe('extractProposedEvents — agent output is untrusted input', () => {
  it('ignores an agent-supplied key and assigns its own', () => {
    // key is the .ics UID component (<runId>-<key>@clockwork.local). A repeated
    // key would make a re-import overwrite one real calendar entry with another.
    const body = JSON.stringify([
      { key: 'same', title: 'One' },
      { key: 'same', title: 'Two' },
      { key: '../../etc/passwd', title: 'Three' },
    ]);
    const keys = extractProposedEvents(block(body), NOW).events.map((e) => e.key);
    expect(keys).toEqual(['ev-1', 'ev-2', 'ev-3']);
    expect(new Set(keys).size).toBe(3);
  });

  it('strips control characters aimed at the .ics writer', () => {
    const hostile = 'Review\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Injected';
    const out = extractProposedEvents(block(JSON.stringify([{ title: hostile, notes: 'a\u0000b\u001bc' }])), NOW);
    const ev = out.events[0]!;
    expect(ev.title).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    expect(ev.notes).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    expect(ev.notes).toBe('abc');
    expect(ev.title).toContain('END:VEVENT'); // text survives; only the line breaks die
    expect(ev.title).not.toContain('\r');
    expect(ev.title).not.toContain('\n');
  });

  it('masks a credential the agent pasted into a suggestion', () => {
    const key = `sk-ant-${'a'.repeat(40)}`;
    const out = extractProposedEvents(block(JSON.stringify([{ title: 'Rotate key', notes: `use ${key}` }])), NOW);
    expect(out.events[0]?.notes).toBe('use [ANTHROPIC-KEY-MASKED]');
    expect(out.events[0]?.notes).not.toContain(key);
  });

  it('keeps a long title that masking GREW back inside the schema bound', () => {
    // maskSecrets turns `token: <secret>` into `token=[MASKED]`, which is
    // LONGER. Clamping before masking would push this past max(200) and lose
    // the whole suggestion; clamping after keeps it.
    const title = `${'x'.repeat(190)} token: hunter2hunter2hunter2`;
    const out = extractProposedEvents(block(JSON.stringify([{ title }])), NOW);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.title.length).toBeLessThanOrEqual(200);
    expect(ProposedEvent.safeParse(out.events[0]).success).toBe(true);
  });

  it('caps the number of events at 20 and says it truncated', () => {
    // 60 short entries: comfortably over the 20-event cap, comfortably under
    // the 8 KB block cap, so this test proves the count cap and not the size one.
    const many = Array.from({ length: 60 }, (_, i) => ({ title: `T${i}` }));
    const out = extractProposedEvents(block(JSON.stringify(many)), NOW);
    expect(out.events).toHaveLength(20);
    expect(out.reason).toContain('only the first 20 suggestions were kept');
  });

  it('honours only the first block, however many the agent emits', () => {
    const summary = [
      block('[{"title":"First"}]'),
      'prose between',
      block('[{"title":"Second"}]'),
      block('[{"title":"Third"}]'),
    ].join('\n');
    const out = extractProposedEvents(summary, NOW);
    expect(out.events.map((e) => e.title)).toEqual(['First']);
    expect(out.reason).toContain('only the first clockwork-events block was read');
    // Every recognized block leaves the prose, not just the one that counted.
    expect(out.text).toBe('prose between');
  });

  it('refuses an oversized block whole rather than parsing part of it', () => {
    const fat = JSON.stringify([{ title: 'T', notes: 'n'.repeat(9_000) }]);
    const out = extractProposedEvents(block(fat), NOW);
    expect(out.events).toEqual([]);
    expect(out.reason).toContain('larger than 8000 bytes');
  });

  it('does not scan a summary past 256 KB, and admits it when a fence is in there', () => {
    const huge = 'x'.repeat(300_000) + '\n' + block('[{"title":"T"}]');
    const out = extractProposedEvents(huge, NOW);
    expect(out.events).toEqual([]);
    expect(out.reason).toBe('the summary was too large to scan for suggestions');
    expect(out.text).toBe(huge); // untouched, not truncated

    // …and stays quiet about an ordinary huge summary with no fence in it.
    const quiet = extractProposedEvents('y'.repeat(300_000), NOW);
    expect(quiet.found).toBe(false);
    expect(quiet.reason).toBeNull();
  });

  it('drops a suggestedAt in the wrong unit instead of booking 1970', () => {
    const seconds = Math.floor(NOW / 1000);
    const out = extractProposedEvents(block(JSON.stringify([{ title: 'T', suggestedAt: seconds }])), NOW);
    expect(out.events[0]?.suggestedAt).toBeNull();
  });

  it('drops an implausible or unparseable suggestedAt but keeps the suggestion', () => {
    const body = JSON.stringify([
      { title: 'far future', suggestedAt: NOW + 10 * 365 * 86_400_000 },
      { title: 'long past', suggestedAt: NOW - 10 * 365 * 86_400_000 },
      { title: 'nonsense', suggestedAt: 'next tuesday-ish' },
      { title: 'infinite', suggestedAt: 1e400 },
    ]);
    const out = extractProposedEvents(block(body), NOW);
    expect(out.events).toHaveLength(4);
    expect(out.events.map((e) => e.suggestedAt)).toEqual([null, null, null, null]);
  });

  it('clamps a hostile durationMin into the schema range', () => {
    const body = JSON.stringify([
      { title: 'a', durationMin: 0 },
      { title: 'b', durationMin: 999_999 },
      { title: 'c', durationMin: -5 },
      { title: 'd', durationMin: 30.7 },
      { title: 'e', durationMin: '45' },
      { title: 'f', durationMin: 'ten minutes' },
      { title: 'g', durationMin: null },
    ]);
    const out = extractProposedEvents(block(body), NOW);
    expect(out.events.map((e) => e.durationMin)).toEqual([1, 1_440, 1, 31, 45, 15, 15]);
    for (const ev of out.events) expect(ProposedEvent.safeParse(ev).success).toBe(true);
  });

  it('drops an entry with no usable title and keeps the rest', () => {
    const body = JSON.stringify([
      { title: 'good' },
      { title: '' },
      { title: '   ' },
      { title: 42 },
      { notes: 'no title at all' },
      null,
      'a bare string',
      ['nested'],
      { title: 'also good' },
    ]);
    const out = extractProposedEvents(block(body), NOW);
    expect(out.events.map((e) => e.title)).toEqual(['good', 'also good']);
    expect(out.events.map((e) => e.key)).toEqual(['ev-1', 'ev-2']); // keys stay contiguous
    expect(out.rejected).toBe(7);
    expect(out.reason).toContain('7 suggestions had an unusable shape');
  });

  it('drops an unusable notes without dropping the suggestion', () => {
    const out = extractProposedEvents(block(JSON.stringify([{ title: 'T', notes: { evil: true } }])), NOW);
    expect(out.events).toEqual([{ key: 'ev-1', title: 'T', notes: null, durationMin: 15, suggestedAt: null }]);
    expect(out.rejected).toBe(0);
  });
});

describe('extractProposedEvents — a bad block costs the suggestions, never the run', () => {
  const cases: Array<[name: string, summary: string, reason: string]> = [
    ['invalid JSON', block('{not json at all'), 'the block was not valid JSON'],
    ['an empty body', block(''), 'the block was not valid JSON'],
    ['a JSON object instead of an array', block('{"title":"T"}'), 'the block was not a JSON array'],
    ['a bare JSON string', block('"just a string"'), 'the block was not a JSON array'],
    ['a block that is never closed', '```' + PROPOSED_EVENTS_FENCE + '\n[{"title":"T"}]', 'the block was never closed'],
  ];

  for (const [name, summary, reason] of cases) {
    it(`returns no events and an honest reason for ${name}`, () => {
      const out = extractProposedEvents(summary, NOW);
      expect(out.events).toEqual([]);
      expect(out.found).toBe(true);
      expect(out.reason).toContain(reason);
    });
  }

  it('leaves the prose intact when the block was never closed', () => {
    // Removing an unterminated block would swallow every line after a stray fence.
    const summary = ['Done.', '```' + PROPOSED_EVENTS_FENCE, 'oops', 'important prose'].join('\n');
    expect(extractProposedEvents(summary, NOW).text).toBe(summary);
  });

  it('never throws, on any input', () => {
    // The caller is `finalize()`, which passes `outcome.summary` — declared
    // `string | undefined` on RunOutcome. The non-string cases below are real,
    // not paranoia, so the loose view of the signature is the honest one.
    const loose = extractProposedEvents as (summary: unknown, nowMs?: number) => ReturnType<typeof extractProposedEvents>;
    const inputs: unknown[] = [
      '',
      '```' + PROPOSED_EVENTS_FENCE,
      '```' + PROPOSED_EVENTS_FENCE + '\n'.repeat(5_000) + '```',
      block('[' + '['.repeat(2_000)),
      block(JSON.stringify([{ title: 'x'.repeat(5_000) }])),
      block('null'),
      block('[null,null,null]'),
      '`'.repeat(10_000),
      block('[{"title":"T","notes":"' + '\\u0000'.repeat(500) + '"}]'),
      undefined,
      null,
      42,
      { summary: 'an object, not a string' },
    ];
    for (const input of inputs) {
      expect(() => loose(input, NOW), `threw on: ${String(input).slice(0, 40)}`).not.toThrow();
      const out = loose(input, NOW);
      expect(typeof out.text).toBe('string'); // finalize() feeds this straight to maskSecrets
      for (const ev of out.events) expect(ProposedEvent.safeParse(ev).success).toBe(true);
    }
  });

  it('defaults nowMs to the real clock when the caller passes none', () => {
    const out = extractProposedEvents(block(JSON.stringify([{ title: 'T', suggestedAt: Date.now() + 60_000 }])));
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.suggestedAt).not.toBeNull();
  });
});
