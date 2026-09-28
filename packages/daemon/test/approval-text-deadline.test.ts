import { describe, it, expect } from 'vitest';
import { formatApprovalText } from '../src/delivery.js';

// Telegram and email carry this text verbatim. A raw ISO/UTC stamp there
// ("2026-09-29T01:45:56.095Z") made a person in IST do timezone arithmetic at
// 2am to know how long they had to answer.
describe('formatApprovalText deadline', () => {
  const now = Date.UTC(2026, 8, 28, 20, 0, 0);
  const base = {
    approvalId: 'a1', runId: 'r1', taskName: 'Monday dependency triage', engine: 'claude-code',
    tool: 'Bash', commandSummary: 'git push origin HEAD', timeoutAt: now + (2 * 60 + 5) * 60_000,
  };

  it('never prints the raw ISO timestamp', () => {
    expect(formatApprovalText(base, now)).not.toContain(new Date(base.timeoutAt).toISOString());
  });

  it('states how long is left and a local clock time with its zone', () => {
    const text = formatApprovalText(base, now);
    expect(text).toMatch(/Auto-denies in 2h 5m \(.+\) if nobody answers\./);
    const local = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(base.timeoutAt);
    expect(text).toContain(local);
  });

  it('says minutes only under an hour, and "now" once the deadline has passed', () => {
    expect(formatApprovalText({ ...base, timeoutAt: now + 45 * 60_000 }, now)).toMatch(/in 45m \(/);
    expect(formatApprovalText({ ...base, timeoutAt: now - 1000 }, now)).toMatch(/Auto-denies now \(/);
  });
});
