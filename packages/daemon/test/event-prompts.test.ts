/**
 * Event prompt materialization (adversarial review fix): {{event.*}} placeholders
 * must actually render — previously documented but never implemented.
 */
import { describe, expect, it } from 'vitest';
import { renderEventPrompt } from '../src/templates.js';

const ev = {
  source: 'github',
  at: 1756000000000,
  payload: {
    action: 'opened',
    pull_request: { number: 7, user: { login: 'octocat' }, title: 'Add feature' },
  },
};

describe('renderEventPrompt', () => {
  it('renders simple and nested paths', () => {
    const out = renderEventPrompt('PR {{event.pull_request.number}} was {{event.action}} by {{event.pull_request.user.login}}', ev);
    expect(out).toBe('PR 7 was opened by octocat');
  });

  it('passes prompts without placeholders through untouched', () => {
    expect(renderEventPrompt('plain prompt', null)).toBe('plain prompt');
    expect(renderEventPrompt('plain prompt', ev)).toBe('plain prompt');
  });

  it('missing paths resolve to (missing), never corrupt the prompt', () => {
    expect(renderEventPrompt('ref: {{event.pull_request.head.ref}}', ev)).toBe('ref: (missing)');
    expect(renderEventPrompt('x: {{event.nothing}}', null)).toBe('x: (missing)');
  });

  it('non-string scalars are JSON-encoded; strings stay raw', () => {
    expect(renderEventPrompt('n={{event.pull_request.number}}', ev)).toBe('n=7');
    expect(renderEventPrompt('t={{event.pull_request.title}}', ev)).toBe('t=Add feature');
  });

  it('handles scalar payloads via the payload root', () => {
    expect(renderEventPrompt('v={{event.value}}', { source: 'webhook', at: 0, payload: 'bare' })).toBe('v=(missing)');
    const objEv = { source: 'webhook', at: 0, payload: { value: 42 } };
    expect(renderEventPrompt('v={{event.value}}', objEv)).toBe('v=42');
  });
});
