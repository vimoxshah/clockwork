/**
 * The run environment is an ALLOWLIST, and that is load-bearing.
 *
 * Clockwork publishes the claim that ssh-agent, cloud credentials and provider
 * tokens are unreachable from inside a run. That claim is true, but NOT
 * because of the sandbox profile — the profile permits `system-socket` and the
 * agent socket lives outside every credential deny path. It is true because
 * buildRunEnv() constructs the child env from a fixed allowlist, so
 * SSH_AUTH_SOCK never reaches the process.
 *
 * An earlier audit of this very claim reached the WRONG conclusion by probing
 * the sandbox with the developer's own environment instead of the one a run
 * receives. So these tests feed buildRunEnv a deliberately hostile env and
 * assert what survives — no ambient state, no reading source as text.
 *
 * The previous version of this file string-sliced claude-cli-runner.ts between
 * two anchors and grepped it. That was brittle (anchors move), could not run
 * against a build, and covered ONE of four runners. The allowlist was
 * duplicated in all four, so a variable added to the codex runner would have
 * silently falsified a published claim while this file stayed green.
 */
import { describe, it, expect } from 'vitest';
import { buildRunEnv, RUN_ENV_ALLOWLIST } from '../src/run-env.js';

/** Every secret-bearing variable we can think of, all set. */
const HOSTILE_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/victim',
  LANG: 'en_US.UTF-8',
  USER: 'victim',
  LOGNAME: 'victim',
  // — none of the following may survive —
  SSH_AUTH_SOCK: '/private/tmp/ssh-agent.sock',
  SSH_AGENT_PID: '4242',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_SESSION_TOKEN: 'FwoGZXIvYXdzEJr...',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  OPENAI_API_KEY: 'sk-openai-secret',
  GITHUB_TOKEN: 'ghp_secret',
  GH_TOKEN: 'ghp_secret',
  GIT_ASKPASS: '/usr/local/bin/leak',
  GPG_AGENT_INFO: '/private/tmp/gpg.sock',
  KUBECONFIG: '/Users/victim/.kube/config',
  DOCKER_HOST: 'tcp://internal:2375',
  NPM_TOKEN: 'npm_secret',
  CLOCKWORK_API_TOKEN: 'control-plane-token',
  http_proxy: 'http://attacker:8080',
  HTTPS_PROXY: 'http://attacker:8080',
  NODE_OPTIONS: '--require /tmp/evil.js',
  LD_PRELOAD: '/tmp/evil.so',
  DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
};

describe('run environment allowlist', () => {
  it('drops every variable outside the allowlist', () => {
    const env = buildRunEnv({}, HOSTILE_ENV);
    const leaked = Object.keys(env).filter((k) => !RUN_ENV_ALLOWLIST.includes(k as never));
    expect(leaked, `these escaped the allowlist: ${leaked.join(', ')}`).toEqual([]);
  });

  it('leaks no secret VALUE, under any key', () => {
    // Key-name checks alone would miss a variable copied under a new name.
    const env = buildRunEnv({}, HOSTILE_ENV);
    const serialized = JSON.stringify(env);
    const secrets = [
      'ssh-agent.sock', 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI', 'sk-ant-secret',
      'sk-openai-secret', 'ghp_secret', 'npm_secret', 'control-plane-token',
      'attacker:8080', '/tmp/evil', '.kube/config', 'gpg.sock',
    ];
    const found = secrets.filter((s) => serialized.includes(s));
    expect(found, `secret values present in the run env: ${found.join(', ')}`).toEqual([]);
  });

  it('never inherits an injection vector even when the parent sets one', () => {
    // NODE_OPTIONS / LD_PRELOAD / DYLD_INSERT_LIBRARIES turn any child process
    // into arbitrary code execution. They are not credentials, so a
    // credential-only deny list would miss them.
    const env = buildRunEnv({}, HOSTILE_ENV);
    for (const k of ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_ASKPASS']) {
      expect(env[k], `${k} reached the run env`).toBeUndefined();
    }
  });

  it('still provides what a run genuinely needs', () => {
    const env = buildRunEnv({}, HOSTILE_ENV);
    expect(env.HOME).toBe('/Users/victim');
    expect(env.PATH).toContain('/usr/bin');
    expect(env.TERM).toBe('dumb');
    expect(env.NO_COLOR).toBe('1');
    // Required for the macOS keychain ACL check, per run-env.ts.
    expect(env.USER).toBe('victim');
    expect(env.LOGNAME).toBe('victim');
  });

  it('omits USER/LOGNAME rather than passing empty strings', () => {
    const env = buildRunEnv({}, { PATH: '/usr/bin', HOME: '/Users/x', USER: '', LOGNAME: '' });
    expect('USER' in env).toBe(false);
    expect('LOGNAME' in env).toBe(false);
  });

  it('lets a runner add its own literals without opening the allowlist', () => {
    // Engine extras are trusted literals from our own code, not inherited.
    const env = buildRunEnv({ HERMES_NONINTERACTIVE: '1' }, HOSTILE_ENV);
    expect(env.HERMES_NONINTERACTIVE).toBe('1');
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });
});
