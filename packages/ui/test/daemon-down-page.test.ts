/**
 * What the fallback window says when the daemon does not answer.
 *
 * This page used to state "the app bundle does not contain the daemon" and
 * hand the reader `git clone && pnpm install`. Both were true once and stopped
 * being true when the daemon moved into Contents/Resources, and a failure page
 * that confidently explains the wrong system is worse than a blank one: it
 * sends people to rebuild something already sitting inside the .app.
 *
 * So the page now renders a cause the Rust shell observed
 * (src-tauri/src/lib.rs `diagnosis`), and these tests pin the three ways that
 * can go wrong: inventing a cause when there is none, showing an old crash as
 * if it were this one, and printing a command that does not apply.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HTML = readFileSync(
  path.resolve(__dirname, '../public/daemon-down.html'),
  'utf8',
);

/** Load the page into jsdom and run its inline script, as the webview would. */
function open(diagnosis: unknown | undefined): Document {
  document.documentElement.innerHTML = HTML.slice(HTML.indexOf('<head>'));
  if (diagnosis === undefined) {
    delete (window as unknown as Record<string, unknown>).__CLOCKWORK_DIAGNOSIS__;
  } else {
    (window as unknown as Record<string, unknown>).__CLOCKWORK_DIAGNOSIS__ = diagnosis;
  }
  const script = HTML.slice(HTML.indexOf('<script>') + '<script>'.length, HTML.indexOf('</script>'));
  new Function(script).call(window);
  return document;
}

const text = (id: string): string => document.getElementById(id)?.textContent ?? '';

describe('daemon-down.html', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('refused'))));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('names the cause the shell observed, with a command that fits it', () => {
    open({
      bundled: true,
      cause: 'the background service is not registered with launchd',
      logPath: '/Users/x/.clockwork/daemon.log.err',
      tail: '',
      logIsRecent: false,
    });
    expect(text('cause')).toBe('the background service is not registered with launchd.');
    expect(text('fix')).toContain('launchctl print gui/$(id -u)/com.clockwork.daemon');
  });

  it('never tells a bundled user to build from source', () => {
    open({ bundled: true, cause: 'the background service is registered but is not answering', logPath: '/l', tail: '', logIsRecent: false });
    expect(document.querySelector('main')?.textContent, 'page did not render').toContain('daemon');
    // <main>, not <body>: body.textContent includes the inline script, whose
    // comment quotes the very instructions this test exists to keep off the
    // page. Asserting on what the reader sees is also the honest scope.
    const body = document.querySelector('main')?.textContent ?? '';
    expect(body).not.toContain('git clone');
    expect(body).not.toContain('pnpm install');
    expect(body).not.toContain('pnpm build');
  });

  it('hides a crash log that is not from this launch', () => {
    // The err log accumulates every failure since install. Showing a stale
    // EADDRINUSE reads as today's cause and sends the reader after a bug that
    // was fixed weeks ago.
    open({
      bundled: true,
      cause: 'the background service is registered but is not answering',
      logPath: '/Users/x/.clockwork/daemon.log.err',
      tail: 'Error: listen EADDRINUSE 127.0.0.1:4747',
      logIsRecent: false,
    });
    expect(document.getElementById('log')?.hidden).toBe(true);
    expect(document.body.textContent).not.toContain('EADDRINUSE');
  });

  it('shows a crash log that IS from this launch', () => {
    open({
      bundled: true,
      cause: 'the background service started and exited — see the log below',
      logPath: '/Users/x/.clockwork/daemon.log.err',
      tail: 'Error: listen EADDRINUSE 127.0.0.1:4747',
      logIsRecent: true,
    });
    expect(document.getElementById('log')?.hidden).toBe(false);
    expect(text('log')).toContain('EADDRINUSE');
    expect(text('log-path')).toContain('/Users/x/.clockwork/daemon.log.err');
  });

  it('claims nothing when it was opened outside the app', () => {
    open(undefined);
    expect(text('cause')).toContain('opened outside the Clockwork app');
    expect(text('fix')).toBe('');
  });
});
