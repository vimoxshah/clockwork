import { describe, expect, it } from 'vitest';
import { buildLinuxSandboxArgv, envAfterBlocklist } from '../src/linux-sandbox.js';

describe('linux sandbox argv (R5-B)', () => {
  it('caps + denies present, never binds creds', () => {
    const { argv } = buildLinuxSandboxArgv({ worktree: '/tmp/wt-1', command: ['bash', 'eval.sh'] });
    const s = argv.join(' ');
    expect(s).toContain('MemoryMax=2G');
    expect(s).toContain('CPUQuota=200%');
    expect(s).toContain('TasksMax=128');
    expect(s).toContain('--unshare-net');
    expect(s).toContain('--die-with-parent');
    expect(s).not.toContain('.ssh');
    expect(s).not.toContain('.aws');
    expect(s).not.toContain('docker.sock');
  });

  it('strips credential env, keeps PATH/HOME-worktree', () => {
    const out = envAfterBlocklist({
      PATH: '/usr/bin',
      HOME: '/tmp/wt-1',
      SSH_AUTH_SOCK: '/run/sock',
      AWS_SECRET_ACCESS_KEY: 'x',
      GH_TOKEN: 'y',
      DOCKER_HOST: 'z',
    });
    expect(out.PATH).toBe('/usr/bin');
    expect(out).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(out).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(out).not.toHaveProperty('GH_TOKEN');
    expect(out).not.toHaveProperty('DOCKER_HOST');
  });

  it('refuses credential worktree', () => {
    expect(() => buildLinuxSandboxArgv({ worktree: '/home/u/.ssh', command: ['x'] })).toThrow();
  });
});
