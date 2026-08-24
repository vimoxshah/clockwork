/**
 * Event triggers (goal #27): signature verification, filters, firing.
 */
import { describe, expect, it } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import {
  hashSecret,
  verifyGithubSignature,
  verifyWebhookSecret,
  matchesFilter,
} from '../src/triggers.js';

describe('trigger auth primitives', () => {
  it('hashSecret is deterministic sha256 (never stores plaintext)', () => {
    expect(hashSecret('my-secret-123')).toBe(createHash('sha256').update('my-secret-123').digest('hex'));
    expect(hashSecret('a')).not.toBe('a');
  });

  it('GitHub HMAC-SHA256 verification: valid, invalid, malformed', () => {
    const secret = 'whsec_github_test';
    const body = JSON.stringify({ action: 'opened', pull_request: { number: 7 } });
    const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyGithubSignature(body, good, secret)).toBe(true);
    expect(verifyGithubSignature(body, 'sha256=' + '0'.repeat(64), secret)).toBe(false);
    expect(verifyGithubSignature(body, undefined, secret)).toBe(false);
    expect(verifyGithubSignature(body, 'garbage', secret)).toBe(false);
    // tampered body
    const other = 'sha256=' + createHmac('sha256', secret).update('{"action":"closed"}').digest('hex');
    expect(verifyGithubSignature(body, other, secret)).toBe(false);
  });

  it('webhook bearer-style secret verifies against stored hash only', () => {
    const storedHash = hashSecret('clockwork-hook-key');
    expect(verifyWebhookSecret('clockwork-hook-key', storedHash)).toBe(true);
    expect(verifyWebhookSecret('wrong', storedHash)).toBe(false);
    expect(verifyWebhookSecret(undefined, storedHash)).toBe(false);
  });
});

describe('dot-path filter matching', () => {
  const payload = {
    action: 'opened',
    pull_request: { number: 7, user: { login: 'octocat' }, draft: false },
  };

  it('null filter matches everything', () => {
    expect(matchesFilter(payload, null)).toBe(true);
  });

  it('single-level and nested paths match', () => {
    expect(matchesFilter(payload, '{"action":"opened"}')).toBe(true);
    expect(matchesFilter(payload, '{"pull_request.user.login":"octocat"}')).toBe(true);
    expect(matchesFilter(payload, '{"pull_request.number":7}')).toBe(true);
  });

  it('non-matching values reject', () => {
    expect(matchesFilter(payload, '{"action":"closed"}')).toBe(false);
    expect(matchesFilter(payload, '{"pull_request.draft":true}')).toBe(false);
  });

  it('multiple conditions are ANDed', () => {
    expect(matchesFilter(payload, '{"action":"opened","pull_request.user.login":"octocat"}')).toBe(true);
    expect(matchesFilter(payload, '{"action":"opened","pull_request.user.login":"someone"}')).toBe(false);
  });

  it('missing paths resolve to undefined and never match', () => {
    expect(matchesFilter(payload, '{"pull_request.merged":true}')).toBe(false);
  });

  it('invalid filter JSON is fail-closed', () => {
    expect(matchesFilter(payload, '{not json')).toBe(false);
  });
});
