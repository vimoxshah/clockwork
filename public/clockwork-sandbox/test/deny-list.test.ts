import { describe, expect, it } from 'vitest';
import { evaluateCommand, evaluatePathRead } from '../src/deny-list.js';

/**
 * S-55: deny-list floor. NOTE (ADR-012): this is POLICY UX, not containment —
 * the OS sandbox is the boundary. These tests pin the ergonomic layer only.
 */
describe('deny-list policy floor', () => {
  it('blocks force-push to protected branches as a hard floor', () => {
    expect(evaluateCommand('git push --force origin main')).toMatchObject({ denied: true, floor: true });
    expect(evaluateCommand('git push -f origin master')).toMatchObject({ denied: true, floor: true });
  });

  it('flags non-protected force-push as approvable denial', () => {
    const v = evaluateCommand('git push --force origin feature/x');
    expect(v.denied).toBe(true);
    expect(v.floor).toBe(false);
  });

  it('blocks package publish', () => {
    expect(evaluateCommand('npm publish')).toMatchObject({ denied: true, floor: true });
    expect(evaluateCommand('pnpm publish --access public')).toMatchObject({ denied: true, floor: true });
  });

  it('blocks credential path reads', () => {
    expect(evaluateCommand('cat ~/.ssh/id_ed25519')).toMatchObject({ denied: true, floor: true });
    expect(evaluateCommand('cp -r ~/.aws ./steal')).toMatchObject({ denied: true, floor: true });
    const p = evaluatePathRead('/Users/x/Library/Keychains/login.keychain-db');
    expect(p.denied).toBe(true);
  });

  it('blocks rm -rf / and disk destroyers', () => {
    expect(evaluateCommand('rm -rf /')).toMatchObject({ denied: true, floor: true });
    expect(evaluateCommand('dd if=/dev/zero of=/dev/disk0')).toMatchObject({ denied: true, floor: true });
  });

  it('allows normal development commands', () => {
    expect(evaluateCommand('npm test').denied).toBe(false);
    expect(evaluateCommand('git commit -m "fix"').denied).toBe(false);
    expect(evaluateCommand('rg "parseError" src').denied).toBe(false);
    expect(evaluatePathRead('/Users/x/repo/src/auth.ts').denied).toBe(false);
  });
});
