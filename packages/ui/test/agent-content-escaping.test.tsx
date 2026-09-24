/**
 * Agent-authored content must never become HTML.
 *
 * Reports, summaries and transcripts are written by an LLM that reads
 * repository contents, so their text is attacker-reachable via prompt
 * injection. The UI holds the daemon token in localStorage, so script
 * execution in this document would hand over the control plane — a path the
 * sandbox fix does NOT close, because it bypasses the filesystem entirely.
 *
 * The audit found no injection point: no dangerouslySetInnerHTML, no
 * innerHTML, no markdown renderer, no dynamic href/src, and a CSP of
 * script-src 'self' with no unsafe-inline. These tests keep it that way — the
 * value here is locking in a null result, not fixing a defect.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor, waitForText } from './helpers/dom';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TAURI_CONF = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src-tauri/tauri.conf.json');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
};

describe('agent-authored content cannot become HTML', () => {
  const files = walk(SRC);

  it('no component injects raw HTML', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const pat of ['dangerouslySetInnerHTML', '.innerHTML', '.outerHTML', 'insertAdjacentHTML']) {
        if (src.includes(pat)) bad.push(`${f.replace(SRC, 'src')}: ${pat}`);
      }
    }
    expect(bad, `raw HTML injection points:\n${bad.join('\n')}`).toEqual([]);
  });

  it('no element takes a dynamic href or src', () => {
    // A javascript: URL in a dynamic href is the one XSS vector React does
    // NOT escape away.
    //
    // One exception, documented rather than hidden: the Open-PR result link
    // in InboxView renders href={result.url}, where the URL arrives from the
    // daemon's GitHub API response (data). It is permitted ONLY behind the
    // prUrlOk shape check (exact github.com/.../pull/<n> form, anything else
    // degrades to inert text) — the assertion below fails closed: remove the
    // guard and this exception stops applying, tripping the scan again.
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = f.replace(SRC, 'src');
      const guarded =
        rel === 'src/components/InboxView.tsx' && src.includes('prUrlOk') && src.includes('github');
      const hits = [...src.matchAll(/\b(href|src)=\{/g)].map((m) => `${rel}: ${m[1]}={...}`);
      // The exception covers exactly ONE dynamic href (the guarded PR link);
      // a second one trips the scan like anywhere else.
      if (guarded && hits.filter((h) => h.includes('href')).length === 1) {
        const i = hits.findIndex((h) => h.includes('href'));
        hits.splice(i, 1);
      }
      bad.push(...hits);
      if (guarded && !src.match(/\bhref=\{/)) {
        bad.push(`${rel}: prUrlOk guard present but no dynamic href left — remove the exception`);
      }
    }
    expect(bad, `dynamic URL attributes need scheme validation:\n${bad.join('\n')}`).toEqual([]);
  });

  it('React escapes a report summary containing markup', async () => {
    // Same jsdom + createRoot approach the existing UI test uses; no new dep.
    const { createRoot } = await import('react-dom/client');
    const payload = '<img src=x onerror="globalThis.__pwned=1"><script>globalThis.__pwned=1</script>';
    const container = document.createElement('div');
    document.body.appendChild(container);
    createRoot(container).render(<div className="summary-block">{payload}</div>);
    // The escaped payload is the positive anchor: "no <script> element" is
    // trivially true of a container React has not committed into yet, so the
    // three negatives below only mean something once the text is on screen.
    await waitForText(container, '<script>');

    expect(container.querySelector('script'), 'a script element was created from agent text').toBeNull();
    expect(container.querySelector('img'), 'an img element was created from agent text').toBeNull();
    expect((globalThis as Record<string, unknown>).__pwned, 'agent text executed').toBeUndefined();
    expect(container.textContent, 'payload should render as literal text').toContain('<script>');

    // The assertions above would be a tautology on their own — React always
    // escapes. This proves they can tell the two paths apart: the SAME payload
    // through the unsafe path really does build an <img> element, so the
    // checks are measuring something rather than restating React's contract.
    const unsafe = document.createElement('div');
    document.body.appendChild(unsafe);
    createRoot(unsafe).render(<div dangerouslySetInnerHTML={{ __html: payload }} />);
    await waitFor(() => unsafe.querySelector('img'), 'the control render to build an <img> from the raw payload', {
      describe: () => `unsafe html = ${unsafe.innerHTML}`,
    });
    expect(unsafe.querySelector('img'), 'control failed: the unsafe path did not build an element, so this test proves nothing').not.toBeNull();
  });

  it('the shipped CSP forbids inline script', () => {
    // Defence in depth: even a future injection point cannot run inline JS.
    const csp = String(JSON.parse(readFileSync(TAURI_CONF, 'utf8')).app.security.csp);
    expect(csp).toMatch(/script-src [^;]*'self'/);
    expect(csp, 'CSP would allow inline script').not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(csp, 'CSP would allow eval').not.toMatch(/script-src [^;]*'unsafe-eval'/);
    expect(csp).toMatch(/object-src 'none'/);
  });
});
