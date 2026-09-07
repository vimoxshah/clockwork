/**
 * Slack delivery (T-310 / FR-18 / ADR-018 / S-43).
 *
 * The generic HMAC webhook could already be pointed at a Slack incoming
 * webhook, and that is what the roadmap item calls out as not good enough:
 * Slack renders `{"schema":"clockwork.run-report.v1",...}` as a wall of JSON.
 * This suite holds the Slack channel to Slack's own message contract.
 *
 * Why Block Kit rather than a text layout: an approval request has to be
 * *scannable* — who wants what, on which run, and when it auto-denies — and
 * Block Kit is the only Slack format that gives a header, key/value fields and
 * a locale-correct timestamp (`<!date^…>`) instead of one paragraph of UTC.
 * The `text` field is still populated, because that is what Slack shows in the
 * notification and to screen readers when blocks are present.
 *
 * What Block Kit deliberately does NOT get here: Approve/Deny buttons. Slack
 * interactivity needs a public HTTPS request URL to POST the click back to,
 * and the daemon binds loopback only, so a button would be a control that
 * silently does nothing. Telegram's inline keyboard works because the Bot API
 * is *polled* by us (telegram-approvals.ts) rather than calling in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  channelFor,
  escapeSlackText,
  formatApprovalText,
  formatReportText,
  maskSlackWebhookUrl,
  slackApprovalMessage,
  slackReportMessage,
  SlackApiError,
  SlackChannel,
  SLACK_TEST_MESSAGE,
  withRetry,
  type ApprovalNotifyPayload,
  type RunReportPayload,
  type SlackBlock,
} from '../src/delivery.js';

const HOOK = 'https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/ZzYyXxWwVvUuTtSsRrQq';
const CRED = { slackWebhookUrl: HOOK };

const report: RunReportPayload = {
  runId: '01JRUNSLACK0000000000000AA',
  taskName: 'nightly dependency surgery',
  state: 'completed',
  failureReason: null,
  summary: 'Bumped 4 packages. Tests green.',
  branch: 'clockwork/dep-surgeon/01JR',
  costUsd: 0.42,
  turns: 12,
  profile: { name: 'Dep Surgeon', slug: 'dep-surgeon' },
};

const approval: ApprovalNotifyPayload = {
  approvalId: '01JRAPPROVAL000000000000AA',
  runId: '01JRUNSLACK0000000000000AA',
  taskName: 'deploy-prod',
  engine: 'cli',
  tool: 'Bash',
  commandSummary: 'kubectl apply -f prod.yaml',
  timeoutAt: 1_800_000_000_000,
};

/** Every string Slack will render, flattened out of the block list. */
function texts(blocks: SlackBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.text) out.push(b.text.text);
    for (const f of b.fields ?? []) out.push(f.text);
    for (const e of b.elements ?? []) out.push(e.text);
  }
  return out;
}

function stubFetch(res: { ok: boolean; status: number; body?: string } | Error): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return { ok: res.ok, status: res.status, text: async () => res.body ?? '' };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the channel registry knows Slack', () => {
  it('hands out a slack channel by name', () => {
    const ch = channelFor('slack');
    expect(ch).not.toBeNull();
    expect(ch!.name).toBe('slack');
  });
});

describe('Slack report formatting is Slack-shaped', () => {
  it('leads with a header block a human can read at a glance', () => {
    const msg = slackReportMessage(report);
    expect(msg.blocks[0]!.type).toBe('header');
    expect(msg.blocks[0]!.text!.type).toBe('plain_text');
    expect(msg.blocks[0]!.text!.text).toContain('nightly dependency surgery');
    expect(msg.blocks[0]!.text!.text).toContain('completed');
  });

  it('carries cost, turns, branch and profile as scannable fields', () => {
    const msg = slackReportMessage(report);
    const fieldBlock = msg.blocks.find((b) => b.type === 'section' && b.fields);
    expect(fieldBlock, 'no field section in the report message').toBeTruthy();
    const joined = (fieldBlock!.fields ?? []).map((f) => f.text).join('\n');
    expect(joined).toContain('$0.42');
    expect(joined).toContain('12');
    expect(joined).toContain('clockwork/dep-surgeon/01JR');
    expect(joined).toContain('dep-surgeon');
    expect((fieldBlock!.fields ?? []).length).toBeLessThanOrEqual(10); // Slack's cap
  });

  it('keeps the summary in the message body', () => {
    const msg = slackReportMessage(report);
    expect(texts(msg.blocks).join('\n')).toContain('Bumped 4 packages. Tests green.');
  });

  it('names the failure reason when there is one', () => {
    const msg = slackReportMessage({ ...report, state: 'failed', failureReason: 'budget_exceeded' });
    expect(texts(msg.blocks).join('\n')).toContain('budget_exceeded');
  });

  it('sets the text fallback Slack uses for the notification and for screen readers', () => {
    const msg = slackReportMessage(report);
    expect(msg.text).toBe(escapeSlackText(formatReportText(report)));
    expect(msg.text.length).toBeGreaterThan(20);
  });

  it('stays inside Slack block limits on a huge summary', () => {
    const msg = slackReportMessage({
      ...report,
      taskName: 'T'.repeat(400),
      summary: 'S'.repeat(12_000),
      branch: 'b'.repeat(5_000),
    });
    expect(msg.blocks[0]!.text!.text.length).toBeLessThanOrEqual(150); // header: plain_text max 150
    for (const t of texts(msg.blocks)) expect(t.length).toBeLessThanOrEqual(3000); // section text max 3000
    for (const b of msg.blocks) {
      for (const f of b.fields ?? []) expect(f.text.length).toBeLessThanOrEqual(2000); // fields item max 2000
    }
  });

  it('escapes the three characters Slack treats as markup', () => {
    const msg = slackReportMessage({ ...report, summary: 'diff <script> a && b > c' });
    const body = texts(msg.blocks).join('\n');
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('&amp;&amp;');
    expect(body).toContain('&gt; c');
    expect(body).not.toContain('<script>');
  });
});

describe('a Slack approval request is readable at a glance', () => {
  it('says who wants what, on which run, and when it auto-denies', () => {
    const msg = slackApprovalMessage(approval);
    const body = texts(msg.blocks).join('\n');
    expect(msg.blocks[0]!.type).toBe('header');
    expect(msg.blocks[0]!.text!.text).toContain('deploy-prod');
    expect(body).toContain('Bash');
    expect(body).toContain('kubectl apply -f prod.yaml');
    expect(body).toContain('cli');
    expect(body).toContain(approval.runId);
    expect(body).toContain(approval.approvalId);
  });

  it('renders the deadline in each reader local time, not one UTC string', () => {
    const msg = slackApprovalMessage(approval);
    const body = texts(msg.blocks).join('\n');
    // Slack's date token: <!date^epochSeconds^format|fallback>
    expect(body).toContain(`<!date^${Math.floor(approval.timeoutAt / 1000)}^`);
    expect(body).toContain(new Date(approval.timeoutAt).toISOString()); // the fallback text
  });

  it('offers no button, because an incoming webhook has nowhere to send the click', () => {
    const msg = slackApprovalMessage(approval);
    expect(msg.blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(JSON.stringify(msg.blocks)).not.toContain('"button"');
    expect(texts(msg.blocks).join('\n')).toContain('Clockwork');
  });

  it('keeps the same one-payload-per-channel text as its fallback', () => {
    const msg = slackApprovalMessage(approval);
    expect(msg.text).toBe(escapeSlackText(formatApprovalText(approval)));
  });

  it('escapes a command summary that contains Slack markup', () => {
    const msg = slackApprovalMessage({ ...approval, commandSummary: 'curl <http://x> && echo >f' });
    const body = texts(msg.blocks).join('\n');
    expect(body).toContain('&lt;http://x&gt;');
    expect(body).toContain('&amp;&amp;');
  });
});

describe('posting to the incoming webhook', () => {
  it('sends the report to the URL held in the credential store', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, body: 'ok' });
    await channelFor('slack')!.send(report, '', CRED);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(HOOK);
    const init = fetchMock.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(init.body));
    expect(body.blocks[0].type).toBe('header');
    expect(body.text).toContain('nightly dependency surgery');
  });

  it('ignores any per-task target, so no Slack credential can live in a task row', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, body: 'ok' });
    await channelFor('slack')!.send(report, 'https://hooks.slack.com/services/SOMEONE/ELSE/XYZ', CRED);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(HOOK);
  });

  it('sends the approval blocks on the approval path', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, body: 'ok' });
    await channelFor('slack')!.sendApproval(approval, '', CRED);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(JSON.stringify(body)).toContain('01JRAPPROVAL000000000000AA');
    expect(body.blocks[0].text.text).toContain('deploy-prod');
  });

  it('sends a fixed short message for the settings self-test', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, body: 'ok' });
    await new SlackChannel().sendTest(CRED);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.text).toBe(SLACK_TEST_MESSAGE);
  });

  it('refuses to send with no webhook URL configured', async () => {
    stubFetch({ ok: true, status: 200, body: 'ok' });
    await expect(channelFor('slack')!.send(report, '', {})).rejects.toThrow(/missing slack webhook url/i);
  });

  it('refuses a non-https webhook URL', async () => {
    stubFetch({ ok: true, status: 200, body: 'ok' });
    await expect(
      channelFor('slack')!.send(report, '', { slackWebhookUrl: 'http://hooks.slack.com/services/A/B/C' }),
    ).rejects.toThrow(/https/i);
  });

  it('reports Slack own error text on a rejected post', async () => {
    stubFetch({ ok: false, status: 403, body: 'invalid_token' });
    await expect(channelFor('slack')!.send(report, '', CRED)).rejects.toThrow(/invalid_token/);
    try {
      await channelFor('slack')!.send(report, '', CRED);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlackApiError);
      expect((e as SlackApiError).status).toBe(403);
      expect((e as SlackApiError).description).toBe('invalid_token');
    }
  });
});

describe('the webhook URL is itself the credential, so it never appears in an error', () => {
  it('scrubs the URL out of a transport error message', async () => {
    stubFetch(new Error(`request to ${HOOK} failed, reason: ECONNRESET`));
    const receipt = await withRetry(() => channelFor('slack')!.send(report, '', CRED));
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toContain('[redacted]');
    expect(receipt.error).not.toContain('ZzYyXxWwVvUuTtSsRrQq');
    expect(receipt.error).not.toContain('B02GHIJKL');
  });

  it('scrubs the URL out of an error cause as well', async () => {
    const err = new Error('fetch failed');
    (err as Error & { cause?: unknown }).cause = new Error(`connect ECONNREFUSED for ${HOOK}`);
    stubFetch(err);
    const receipt = await withRetry(() => channelFor('slack')!.send(report, '', CRED));
    expect(receipt.error).not.toContain('ZzYyXxWwVvUuTtSsRrQq');
  });

  it('masks the URL for display without ever printing the token', () => {
    const masked = maskSlackWebhookUrl(HOOK);
    expect(masked).toContain('hooks.slack.com');
    expect(masked).not.toContain('ZzYyXxWwVvUuTtSsRrQq');
    expect(masked).not.toContain('B02GHIJKL');
    // never throws on a short or malformed value
    expect(() => maskSlackWebhookUrl('x')).not.toThrow();
    expect(() => maskSlackWebhookUrl('https://hooks.slack.com')).not.toThrow();
  });
});

describe('Slack failures behave like every other channel (S-43)', () => {
  it('retries three times with the shared wrapper and reports a receipt, never throwing out', async () => {
    const fetchMock = stubFetch({ ok: false, status: 500, body: 'server_error' });
    const receipt = await withRetry(() => channelFor('slack')!.send(report, '', CRED));
    expect(fetchMock.mock.calls.length).toBe(3);
    expect(receipt.ok).toBe(false);
    expect(receipt.attempts).toBe(3);
    expect(receipt.error).toContain('500');
  });
});
