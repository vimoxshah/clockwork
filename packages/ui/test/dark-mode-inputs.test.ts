/**
 * Regression for the dark-mode "light-grey input" bug: several text/password
 * inputs fell through to the browser's default control styling because the
 * themed-input selector list in styles.css (around line 274) named specific
 * `input[type='...']` values and missed both `password` and typeless inputs
 * (an `<input>` with no `type` attribute at all — e.g. AgentPicker's agent
 * search box and SettingsView's ICS URL / label fields).
 *
 * This test reads the real selector out of styles.css (rather than hardcoding
 * a copy) so it fails again if the coverage regresses, and it also asserts
 * the rule does NOT reach into checkbox/radio/button inputs, which must keep
 * their native appearance.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css');

function themedInputSelector(): string {
  const css = readFileSync(CSS_PATH, 'utf8');
  // The themed-input rule is the one that paints inputs with var(--bg)/var(--fg)
  // and is anchored by input[type='text'] in its selector list.
  const match = css.match(/^([^{}]*input\[type='text'\][^{}]*)\{\s*\n\s*background:\s*var\(--bg\)/m);
  if (!match) throw new Error('Could not find the themed-input selector rule in styles.css');
  return match[1].trim();
}

describe('dark-mode themed input selector (styles.css)', () => {
  const selector = themedInputSelector();

  it('covers password inputs (e.g. SettingsView "Shared secret")', () => {
    const el = document.createElement('input');
    el.setAttribute('type', 'password');
    expect(el.matches(selector)).toBe(true);
  });

  // Same class of miss as `password`: SettingsView's SMTP "From address" and
  // "Send test email to" fields are type='email' (browser-validated), and an
  // unlisted type is the light-grey box this rule exists to prevent.
  it('covers email inputs (e.g. SettingsView SMTP From address / test recipient)', () => {
    const el = document.createElement('input');
    el.setAttribute('type', 'email');
    expect(el.matches(selector)).toBe(true);
  });

  it('covers typeless inputs (e.g. AgentPicker search box, SettingsView ICS URL/label)', () => {
    const el = document.createElement('input');
    expect(el.hasAttribute('type')).toBe(false);
    expect(el.matches(selector)).toBe(true);
  });

  it('still covers the previously-listed types', () => {
    for (const type of ['text', 'datetime-local', 'time', 'number']) {
      const el = document.createElement('input');
      el.setAttribute('type', type);
      expect(el.matches(selector)).toBe(true);
    }
  });

  it('still covers select and textarea', () => {
    expect(document.createElement('select').matches(selector)).toBe(true);
    expect(document.createElement('textarea').matches(selector)).toBe(true);
  });

  it('does not reach into checkbox, radio, or button inputs', () => {
    for (const type of ['checkbox', 'radio', 'button']) {
      const el = document.createElement('input');
      el.setAttribute('type', type);
      expect(el.matches(selector)).toBe(false);
    }
  });
});
