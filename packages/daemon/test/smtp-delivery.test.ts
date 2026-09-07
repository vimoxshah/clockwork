/**
 * SMTP / email delivery (T-310 / FR-18 / S-43), spoken with Node's standard
 * library only — `node:net` + `node:tls`. No mail dependency was added: the
 * submission path Clockwork needs (EHLO, opportunistic STARTTLS, AUTH
 * PLAIN/LOGIN, MAIL/RCPT/DATA, one plain-text UTF-8 body) is a line protocol,
 * and the part that makes a hand-rolled client wrong is the reply reader, so
 * that is what this suite hammers: a reply split across packets, a whole
 * multi-line 250- continuation arriving in one write, and a greeting cut
 * mid-word — all against a real socket.
 *
 * The server below is a real `net` server speaking real SMTP, not a mock of
 * the channel. What is NOT exercised here is `tls.connect` itself: the
 * STARTTLS test injects an identity upgrade through the constructor seam
 * (mirroring `TelegramChannel(apiBase)`), which proves the protocol either
 * side of the upgrade — command order, re-EHLO, AUTH-after-TLS — while leaving
 * the handshake to the standard library. A committed test keypair would be the
 * only way to close that last inch and it is not worth a private key in the
 * repo.
 */
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import {
  channelFor,
  dotStuff,
  encodeMimeSubject,
  maskSmtpUrl,
  parseSmtpUrl,
  SmtpChannel,
  withRetry,
  type ApprovalNotifyPayload,
  type RunReportPayload,
} from '../src/delivery.js';

// ---------------------------------------------------------------------------
// a real SMTP server, small enough to read
// ---------------------------------------------------------------------------

interface FakeSmtp {
  port: number;
  /** every command line the client sent, in order */
  log: string[];
  /** each accepted DATA payload, un-terminated */
  mail: string[];
  close: () => Promise<void>;
}

function startFakeSmtp(
  opts: {
    /** EHLO capability lines (after the greeting line) */
    caps?: string[];
    /** first matching prefix wins; the value is written verbatim */
    reply?: Array<[string, string]>;
    /** accept the connection and never send the 220 greeting */
    silentGreeting?: boolean;
  } = {},
): Promise<FakeSmtp> {
  const log: string[] = [];
  const mail: string[] = [];
  const caps = opts.caps ?? ['SIZE 10240000'];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    let buf = '';
    let inData = false;
    let dataBuf = '';
    let authStage: 'user' | 'pass' | null = null;
    const write = (s: string): void => void sock.write(s + '\r\n');

    const override = (line: string): string | null => {
      for (const [prefix, replyLine] of opts.reply ?? []) {
        if (line.toUpperCase().startsWith(prefix.toUpperCase())) return replyLine;
      }
      return null;
    };

    const handle = (line: string): void => {
      const forced = override(line);
      if (forced !== null) return write(forced);
      const upper = line.toUpperCase();
      if (authStage === 'user') {
        authStage = 'pass';
        return write('334 UGFzc3dvcmQ6');
      }
      if (authStage === 'pass') {
        authStage = null;
        return write('235 2.7.0 Authentication successful');
      }
      if (upper.startsWith('EHLO')) {
        write('250-fake.test at your service');
        for (const [i, c] of caps.entries()) write(i === caps.length - 1 ? `250 ${c}` : `250-${c}`);
        return;
      }
      if (upper.startsWith('HELO')) return write('250 fake.test');
      if (upper.startsWith('STARTTLS')) return write('220 2.0.0 Ready to start TLS');
      if (upper.startsWith('AUTH LOGIN')) {
        authStage = 'user';
        return write('334 VXNlcm5hbWU6');
      }
      if (upper.startsWith('AUTH PLAIN')) return write('235 2.7.0 Authentication successful');
      if (upper.startsWith('MAIL FROM')) return write('250 2.1.0 Ok');
      if (upper.startsWith('RCPT TO')) return write('250 2.1.5 Ok');
      if (upper.startsWith('DATA')) {
        inData = true;
        return write('354 End data with <CR><LF>.<CR><LF>');
      }
      if (upper.startsWith('QUIT')) {
        write('221 2.0.0 Bye');
        sock.end();
        return;
      }
      if (upper.startsWith('RSET') || upper.startsWith('NOOP')) return write('250 2.0.0 Ok');
      write('502 5.5.2 Command not implemented');
    };

    if (!opts.silentGreeting) write('220 fake.test ESMTP ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mail.push(dataBuf);
            dataBuf = '';
            write('250 2.0.0 Ok: queued as FAKE1');
          } else {
            dataBuf += line + '\r\n';
          }
          continue;
        }
        log.push(line);
        handle(line);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        log,
        mail,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Headers (unfolded, lowercased keys) + the decoded text body. */
function parseMail(raw: string): { headers: Record<string, string>; body: string } {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split);
  const bodyRaw = raw.slice(split + 4);
  const unfolded: string[] = [];
  for (const l of head.split('\r\n')) {
    if (/^[ \t]/.test(l) && unfolded.length > 0) unfolded[unfolded.length - 1] += l;
    else unfolded.push(l);
  }
  const headers: Record<string, string> = {};
  for (const l of unfolded) {
    const c = l.indexOf(':');
    if (c > 0) headers[l.slice(0, c).toLowerCase()] = l.slice(c + 1).trim();
  }
  return { headers, body: Buffer.from(bodyRaw.replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

/** RFC 2047 B-encoded words back to text; adjacent words join with nothing. */
function decodeHeader(v: string): string {
  return v
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const m = /^=\?UTF-8\?B\?(.*)\?=$/i.exec(w);
      return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : w;
    })
    .join('');
}

const report: RunReportPayload = {
  runId: '01JRUNMAIL00000000000000AA',
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
  runId: '01JRUNMAIL00000000000000AA',
  taskName: 'deploy-prod',
  engine: 'cli',
  tool: 'Bash',
  commandSummary: 'kubectl apply -f prod.yaml',
  timeoutAt: 1_800_000_000_000,
};

let srv: FakeSmtp | null = null;

afterEach(async () => {
  await srv?.close();
  srv = null;
});

const FROM = { smtpFrom: 'clockwork@example.test' };

describe('the channel registry knows email', () => {
  it('hands out an email channel by name', () => {
    const ch = channelFor('email');
    expect(ch).not.toBeNull();
    expect(ch!.name).toBe('email');
  });
});

describe('a run report reaches a plain local relay', () => {
  it('walks the whole submission conversation and queues one message', async () => {
    srv = await startFakeSmtp();
    await channelFor('email')!.send(report, 'dana@example.test, marcus@example.test', {
      smtpUrl: `smtp://127.0.0.1:${srv.port}`,
      ...FROM,
    });

    expect(srv.log[0]).toMatch(/^EHLO /);
    expect(srv.log.join('\n')).toContain('MAIL FROM:<clockwork@example.test>');
    expect(srv.log.join('\n')).toContain('RCPT TO:<dana@example.test>');
    expect(srv.log.join('\n')).toContain('RCPT TO:<marcus@example.test>');
    expect(srv.log).toContain('DATA');
    expect(srv.log).toContain('QUIT');
    expect(srv.mail.length).toBe(1);
  });

  it('sends a MIME message a mail client can actually render', async () => {
    srv = await startFakeSmtp();
    await channelFor('email')!.send(report, 'dana@example.test', { smtpUrl: `smtp://127.0.0.1:${srv.port}`, ...FROM });

    const { headers, body } = parseMail(srv.mail[0]!);
    expect(headers['mime-version']).toBe('1.0');
    expect(headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(headers['content-transfer-encoding']).toBe('base64');
    expect(headers['from']).toContain('clockwork@example.test');
    expect(headers['to']).toBe('dana@example.test');
    expect(headers['date']).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
    expect(headers['message-id']).toMatch(/^<[^<>@\s]+@[^<>@\s]+>$/);
    expect(headers['x-clockwork-schema']).toBe('clockwork.run-report.v1');
    expect(decodeHeader(headers['subject']!)).toContain('nightly dependency surgery');
    // the body is the same one-payload text every channel gets, emoji intact
    expect(body).toContain('Bumped 4 packages. Tests green.');
    expect(body).toContain('⏰');
    expect(body).toContain('$0.42');
  });

  it('sends an approval request whose subject says a human is needed', async () => {
    srv = await startFakeSmtp();
    await channelFor('email')!.sendApproval(approval, 'dana@example.test', {
      smtpUrl: `smtp://127.0.0.1:${srv.port}`,
      ...FROM,
    });

    const { headers, body } = parseMail(srv.mail[0]!);
    expect(decodeHeader(headers['subject']!)).toBe('[Clockwork] Approval needed: deploy-prod');
    expect(headers['x-clockwork-schema']).toBe('clockwork.approval-request.v1');
    expect(body).toContain('Bash');
    expect(body).toContain('kubectl apply -f prod.yaml');
    expect(body).toContain('01JRAPPROVAL000000000000AA');
    expect(body).toContain(new Date(approval.timeoutAt).toISOString());
  });

  it('reads a reply split across packets and a multi-line reply delivered in one', async () => {
    // The greeting is split mid-word, the RCPT reply is split right after its
    // code, and the whole multi-line EHLO answer arrives in a single write: a
    // reader that treats one 'data' event as one reply gets all three wrong.
    const log: string[] = [];
    const mail: string[] = [];
    const server = net.createServer((sock) => {
      let buf = '';
      let inData = false;
      let dataBuf = '';
      sock.write('220 fake.te');
      setTimeout(() => sock.write('st ESMTP ready\r\n'), 25);
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (;;) {
          const i = buf.indexOf('\r\n');
          if (i < 0) break;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              mail.push(dataBuf);
              sock.write('250 Ok: queued\r\n');
            } else dataBuf += line + '\r\n';
            continue;
          }
          log.push(line);
          if (/^EHLO/i.test(line)) sock.write('250-fake.test\r\n250-PIPELINING\r\n250 SIZE 1000000\r\n');
          else if (/^MAIL FROM/i.test(line)) sock.write('250 2.1.0 Ok\r\n');
          else if (/^RCPT TO/i.test(line)) {
            sock.write('250 '); // code now, the rest of the line later
            setTimeout(() => sock.write('2.1.5 Ok\r\n'), 15);
          } else if (/^DATA/i.test(line)) {
            inData = true;
            sock.write('354 go ahead\r\n');
          } else if (/^QUIT/i.test(line)) {
            sock.write('221 Bye\r\n');
            sock.end();
          } else sock.write('250 Ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      await channelFor('email')!.send(report, 'dana@example.test', { smtpUrl: `smtp://127.0.0.1:${port}`, ...FROM });
      expect(mail.length).toBe(1);
      expect(log.filter((l) => /^EHLO/i.test(l)).length).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('credentials on the wire', () => {
  it('never sends AUTH over an unencrypted connection', async () => {
    srv = await startFakeSmtp({ caps: ['AUTH PLAIN LOGIN'] });
    await expect(
      channelFor('email')!.send(report, 'dana@example.test', {
        smtpUrl: `smtp://dana:hunter2@127.0.0.1:${srv.port}`,
        ...FROM,
      }),
    ).rejects.toThrow(/unencrypted/i);
    expect(srv.log.some((l) => /^AUTH/i.test(l))).toBe(false);
    expect(srv.mail.length).toBe(0);
  });

  it('sends AUTH PLAIN when the operator opts in for a trusted local relay', async () => {
    srv = await startFakeSmtp({ caps: ['AUTH PLAIN LOGIN'] });
    await channelFor('email')!.send(report, 'dana@example.test', {
      smtpUrl: `smtp://dana:hunter2@127.0.0.1:${srv.port}?allowInsecureAuth=1`,
      ...FROM,
    });
    const auth = srv.log.find((l) => /^AUTH PLAIN /i.test(l));
    expect(auth, 'no AUTH PLAIN sent').toBeTruthy();
    const payload = Buffer.from(auth!.split(' ')[2]!, 'base64').toString('utf8');
    expect(payload).toBe('\u0000dana\u0000hunter2');
    expect(srv.mail.length).toBe(1);
  });

  it('falls back to AUTH LOGIN when that is all the server offers', async () => {
    srv = await startFakeSmtp({ caps: ['AUTH LOGIN'] });
    await channelFor('email')!.send(report, 'dana@example.test', {
      smtpUrl: `smtp://dana:hunter2@127.0.0.1:${srv.port}?allowInsecureAuth=1`,
      ...FROM,
    });
    expect(srv.log.some((l) => /^AUTH LOGIN$/i.test(l))).toBe(true);
    const b64 = srv.log.filter((l) => !/^(EHLO|AUTH|MAIL|RCPT|DATA|QUIT)/i.test(l));
    expect(b64.map((l) => Buffer.from(l, 'base64').toString('utf8'))).toEqual(['dana', 'hunter2']);
    expect(srv.mail.length).toBe(1);
  });

  it('upgrades with STARTTLS when offered, re-greets, and only then authenticates', async () => {
    srv = await startFakeSmtp({ caps: ['STARTTLS', 'AUTH PLAIN'] });
    // Identity upgrade: the protocol is under test here, tls.connect is not.
    const ch = new SmtpChannel({ tlsUpgrade: async (socket) => socket });
    await ch.send(report, 'dana@example.test', { smtpUrl: `smtp://dana:hunter2@127.0.0.1:${srv.port}`, ...FROM });

    const verbs = srv.log.map((l) => l.split(/[ :]/)[0]!.toUpperCase());
    expect(verbs.slice(0, 4)).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'AUTH']);
    expect(srv.mail.length).toBe(1); // no ?allowInsecureAuth needed: the channel is secure
  });

  it('refuses rather than downgrade when the relay takes none of the AUTH mechanisms it speaks', async () => {
    // A configured credential that would be silently dropped is worse than a
    // receipt saying so: the operator typed a password expecting it to be used.
    // An anonymous local relay is configured by leaving the userinfo out.
    srv = await startFakeSmtp({ caps: ['AUTH CRAM-MD5 XOAUTH2'] });
    await expect(
      channelFor('email')!.send(report, 'dana@example.test', {
        smtpUrl: `smtp://dana:hunter2@127.0.0.1:${srv.port}?allowInsecureAuth=1`,
        ...FROM,
      }),
    ).rejects.toThrow(/no AUTH mechanism/i);
    expect(srv.mail.length).toBe(0);
  });

  it('keeps the password out of the error when the server rejects it', async () => {
    srv = await startFakeSmtp({
      caps: ['AUTH PLAIN'],
      reply: [['AUTH', '535 5.7.8 Error: authentication failed']],
    });
    const receipt = await withRetry(() =>
      channelFor('email')!.send(report, 'dana@example.test', {
        smtpUrl: `smtp://dana:hunter2@127.0.0.1:${srv!.port}?allowInsecureAuth=1`,
        ...FROM,
      }),
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.attempts).toBe(3);
    expect(receipt.error).toContain('535');
    expect(receipt.error).not.toContain('hunter2');
  });

  it('masks the endpoint for display without the password', () => {
    const masked = maskSmtpUrl('smtp://dana:hunter2@smtp.example.test:587');
    expect(masked).toContain('smtp.example.test');
    expect(masked).toContain('587');
    expect(masked).not.toContain('hunter2');
    expect(() => maskSmtpUrl('not a url')).not.toThrow();
  });
});

describe('refusals and failures never take the run with them (S-43)', () => {
  it('reports a receipt instead of throwing when the relay rejects a recipient', async () => {
    srv = await startFakeSmtp({ reply: [['RCPT TO', '550 5.1.1 No such user here']] });
    const receipt = await withRetry(() =>
      channelFor('email')!.send(report, 'ghost@example.test', { smtpUrl: `smtp://127.0.0.1:${srv!.port}`, ...FROM }),
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.attempts).toBe(3);
    expect(receipt.error).toContain('550');
    expect(srv.mail.length).toBe(0);
  });

  it('gives up on a relay that accepts the socket and then says nothing', async () => {
    srv = await startFakeSmtp({ silentGreeting: true });
    const ch = new SmtpChannel({ timeoutMs: 250 });
    const t0 = Date.now();
    await expect(
      ch.send(report, 'dana@example.test', { smtpUrl: `smtp://127.0.0.1:${srv.port}`, ...FROM }),
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('refuses with a clear message when no SMTP endpoint is configured', async () => {
    await expect(channelFor('email')!.send(report, 'dana@example.test', {})).rejects.toThrow(/missing smtp url/i);
  });

  it('refuses when no From address can be established', async () => {
    srv = await startFakeSmtp();
    await expect(
      channelFor('email')!.send(report, 'dana@example.test', { smtpUrl: `smtp://127.0.0.1:${srv.port}` }),
    ).rejects.toThrow(/from address/i);
  });

  it('uses the SMTP username as the From address when it is an email and none is configured', async () => {
    // The relay must offer AUTH here: a URL that carries credentials the relay
    // will not take is refused rather than downgraded (see the AUTH tests).
    srv = await startFakeSmtp({ caps: ['AUTH PLAIN'] });
    await channelFor('email')!.send(report, 'dana@example.test', {
      smtpUrl: `smtp://bot%40example.test:x@127.0.0.1:${srv.port}?allowInsecureAuth=1`,
    });
    expect(srv.log.join('\n')).toContain('MAIL FROM:<bot@example.test>');
  });

  it('refuses a recipient list with nothing usable in it', async () => {
    srv = await startFakeSmtp();
    await expect(
      channelFor('email')!.send(report, '  , ', { smtpUrl: `smtp://127.0.0.1:${srv.port}`, ...FROM }),
    ).rejects.toThrow(/recipient/i);
  });
});

describe('a task name is data, not headers', () => {
  it('cannot inject a header through the subject', async () => {
    srv = await startFakeSmtp();
    await channelFor('email')!.send(
      { ...report, taskName: 'ok\r\nBcc: attacker@evil.test\r\nX-Evil: 1' },
      'dana@example.test',
      { smtpUrl: `smtp://127.0.0.1:${srv.port}`, ...FROM },
    );
    const raw = srv.mail[0]!;
    const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
    expect(head.toLowerCase()).not.toContain('bcc:');
    expect(head.toLowerCase()).not.toContain('x-evil');
    expect(decodeHeader(parseMail(raw).headers['subject']!)).not.toMatch(/[\r\n]/);
  });

  it('cannot inject an extra RCPT through the recipient list', async () => {
    srv = await startFakeSmtp();
    await expect(
      channelFor('email')!.send(report, 'dana@example.test\r\nRCPT TO:<attacker@evil.test>', {
        smtpUrl: `smtp://127.0.0.1:${srv.port}`,
        ...FROM,
      }),
    ).rejects.toThrow(/recipient/i);
    expect(srv.log.join('\n')).not.toContain('attacker@evil.test');
  });
});

describe('the protocol pieces on their own', () => {
  it('parses the two schemes and their default ports', () => {
    expect(parseSmtpUrl('smtp://mail.example.test')).toMatchObject({
      host: 'mail.example.test',
      port: 587,
      implicitTls: false,
    });
    expect(parseSmtpUrl('smtps://mail.example.test')).toMatchObject({ port: 465, implicitTls: true });
    expect(parseSmtpUrl('smtp://mail.example.test:2525')).toMatchObject({ port: 2525 });
  });

  it('percent-decodes a username and password that contain URL punctuation', () => {
    const ep = parseSmtpUrl('smtp://bot%40example.test:p%40ss%3Aw%2Frd@mail.example.test');
    expect(ep.user).toBe('bot@example.test');
    expect(ep.pass).toBe('p@ss:w/rd');
  });

  it('rejects a scheme it does not speak', () => {
    expect(() => parseSmtpUrl('https://mail.example.test')).toThrow(/scheme/i);
    expect(() => parseSmtpUrl('nonsense')).toThrow();
  });

  it('reads the insecure-auth opt-in off the URL', () => {
    expect(parseSmtpUrl('smtp://a:b@h').allowInsecureAuth).toBe(false);
    expect(parseSmtpUrl('smtp://a:b@h?allowInsecureAuth=1').allowInsecureAuth).toBe(true);
  });

  it('encodes a subject as one RFC 2047 word, and folds a long one without splitting a character', () => {
    expect(encodeMimeSubject('hi')).toBe('=?UTF-8?B?aGk=?=');
    const long = '⏰ '.repeat(40) + 'end';
    const folded = encodeMimeSubject(long);
    for (const line of folded.split('\r\n')) expect(line.trimStart().length).toBeLessThanOrEqual(75);
    expect(decodeHeader(folded.replace(/\r\n/g, ' '))).toBe(long);
  });

  it('dot-stuffs a body line that would otherwise end the message', () => {
    expect(dotStuff('a\r\n.\r\nb')).toBe('a\r\n..\r\nb');
    expect(dotStuff('.hidden\r\nplain')).toBe('..hidden\r\nplain');
    expect(dotStuff('nothing to do')).toBe('nothing to do');
  });
});
