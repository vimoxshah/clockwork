import { describe, expect, it } from 'vitest';
import { classifyError, fold, newAccumulator, parseStreamLine } from '../src/stream-parser.js';

describe('stream-json parser (R-2 tolerance contract)', () => {
  it('parses system init and captures session id', () => {
    const ev = parseStreamLine('{"type":"system","subtype":"init","session_id":"sess-1"}');
    expect(ev?.sessionId).toBe('sess-1');
  });

  it('parses assistant usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 's1',
      message: { usage: { input_tokens: 1000, output_tokens: 500 } },
    });
    const ev = parseStreamLine(line);
    expect(ev?.usage).toBeDefined();
    expect(ev?.usage?.turns).toBe(1);
  });

  it('parses result event with cumulative cost and turns', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'All done.',
      session_id: 's1',
      num_turns: 7,
      total_cost_usd: 0.42,
    });
    const ev = parseStreamLine(line);
    expect(ev?.resultSummary).toBe('All done.');
    expect(ev?.usage?.costUsd).toBeCloseTo(0.42);
    expect(ev?.usage?.turns).toBe(7);
  });

  it('returns null on non-JSON chatter instead of throwing', () => {
    expect(parseStreamLine('Loading claude code...')).toBeNull();
    expect(parseStreamLine('')).toBeNull();
  });

  it('never throws on unknown event shapes (R-2)', () => {
    const ev = parseStreamLine('{"type":"brand_new_event","weird":{"nested":true}}');
    expect(ev?.rawType).toBe('brand_new_event');
  });

  it('classifies error taxonomy per T-004', () => {
    expect(classifyError('Invalid API key provided')).toBe('auth');
    expect(classifyError('Rate limit exceeded (429)')).toBe('rate_limited');
    expect(classifyError('API is overloaded (529)')).toBe('capacity');
    expect(classifyError('fetch failed: ENOTFOUND api.anthropic.com')).toBe('offline');
    expect(classifyError('model claude-opus-0 not found')).toBe('model_unknown');
    expect(classifyError('something else entirely')).toBe('other');
  });
});

describe('accumulator folding', () => {
  it('tracks cumulative cost from result totals', () => {
    const acc = newAccumulator();
    const e1 = parseStreamLine(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100 } } }));
    fold(acc, e1!);
    const e2 = parseStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.5, num_turns: 3 }),
    );
    fold(acc, e2!);
    expect(acc.totalCostUsd).toBeCloseTo(0.5);
    expect(acc.turns).toBe(3);
    expect(acc.lastResult).toBeUndefined();
  });

  it('captures last error class for the mapper (T-106)', () => {
    const acc = newAccumulator();
    const e = parseStreamLine(
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Unauthorized' }),
    );
    fold(acc, e!);
    expect(acc.lastError?.class).toBe('auth');
  });
});

describe('T-004 regression: subscription spend-limit errors', () => {
  it('classifies weekly spend-limit exhaustion as capacity (S-47), not internal', () => {
    const acc = newAccumulator();
    const e = parseStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: "You've hit your individual spend limit · your weekly limit resets Aug 27",
      }),
    );
    fold(acc, e!);
    expect(acc.lastError?.class).toBe('capacity');
  });
});
