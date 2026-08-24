/**
 * DockerRunner (ADR-033): the first remote execution target.
 *
 * Runs agent commands inside an ephemeral container with:
 *  - workspace bind-mount only (host filesystem otherwise invisible)
 *  - no network by default (--network none); opt-in bridge
 *  - hard resource limits (memory / cpus / pids)
 *  - auto-remove on exit (--rm) → truly ephemeral
 *  - credentials injected via --env only at run time, never baked into images
 *
 * Fails fast when the Docker daemon is unavailable so callers can fall back
 * to local execution explicitly rather than silently changing location.
 */
import { spawn } from 'node:child_process';

export interface DockerExecOptions {
  image: string;
  /** Host directory mounted read-write at /workspace */
  workspace: string;
  command: string;
  env?: Record<string, string>;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  network?: 'none' | 'bridge';
  timeoutSec?: number;
  onLog?: (line: string) => void;
}

export interface DockerExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: 'docker_unavailable' | 'timeout';
}

export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

export function runInDocker(opts: DockerExecOptions): Promise<DockerExecResult> {
  const log = opts.onLog ?? (() => {});
  const args = [
    'run',
    '--rm',
    '--network', opts.network ?? 'none',
    '-v', `${opts.workspace}:/workspace`,
    '-w', '/workspace',
    '--memory', `${opts.memoryMb ?? 2048}m`,
    '--cpus', String(opts.cpus ?? 2),
    '--pids-limit', String(opts.pidsLimit ?? 256),
    '--security-opt', 'no-new-privileges',
  ];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
  // split shell command through sh for portability across images
  args.push(opts.image, '/bin/sh', '-c', opts.command);

  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log('[docker] timeout — killing container');
      child.kill('SIGKILL');
    }, (opts.timeoutSec ?? 600) * 1000);

    child.stdout.on('data', (d) => {
      const text = String(d);
      stdout += text;
      for (const line of text.split('\n')) if (line.trim()) log(`[docker] ${line}`);
    });
    child.stderr.on('data', (d) => { stderr += String(d); });

    child.on('error', (e) => {
      clearTimeout(timer);
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ ok: false, exitCode: null, stdout, stderr, error: 'docker_unavailable' });
      } else {
        resolve({ ok: false, exitCode: null, stdout, stderr, error: 'docker_unavailable' });
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, exitCode: code, stdout, stderr, error: 'timeout' });
      } else {
        resolve({ ok: code === 0, exitCode: code, stdout, stderr });
      }
    });
  });
}
