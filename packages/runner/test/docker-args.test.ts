import { describe, expect, it } from 'vitest';
import { buildDockerArgs } from '../src/docker-runner.js';

describe('docker argv caps (R6-B)', () => {
  it('defaults: none net, 2G/2cpu/256pids, no-new-priv, workspace-only bind', () => {
    const a = buildDockerArgs({ image: 'alpine:3.19', workspace: '/tmp/wt', command: 'echo hi' }).join(' ');
    expect(a).toContain('--network none');
    expect(a).toContain('--memory 2048m');
    expect(a).toContain('--cpus 2');
    expect(a).toContain('--pids-limit 256');
    expect(a).toContain('no-new-privileges');
    expect(a).toContain('/tmp/wt:/workspace');
    expect(a).not.toContain('/Users');
    expect(a).not.toContain('.ssh');
  });

  it('explicit env passes through, caller-controlled', () => {
    const a = buildDockerArgs({ image: 'alpine:3.19', workspace: '/tmp/wt', command: 'x', env: { SECRET_TOKEN: 'abc123' } });
    expect(a.join(' ')).toContain('SECRET_TOKEN=abc123');
  });
});
