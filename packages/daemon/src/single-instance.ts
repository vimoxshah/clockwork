/**
 * Single-instance lock (S-80): lockfile + port bind. Loser exits 0 with a log
 * line; doctor reports duplicate instances.
 */
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';

export interface InstanceLock {
  release(): void;
  /** pid of the holder if we lost the race */
  existingPid?: number;
}

export function acquireInstanceLock(dataDir: string, port: number): Promise<InstanceLock & { won: boolean }> {
  return new Promise((resolve) => {
    const lockFile = `${dataDir}/daemon.lock`;
    // Port bind probe: if the API port is taken, someone else is serving.
    const probe = createServer();
    probe.once('error', () => {
      let existingPid: number | undefined;
      try {
        existingPid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
      } catch {}
      resolve({ won: false, existingPid, release() {} });
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => {
        try {
          if (existsSync(lockFile)) {
            // stale lockfile from a crashed daemon — verify pid liveness
            const oldPid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
            try {
              process.kill(oldPid, 0);
              resolve({ won: false, existingPid: oldPid, release() {} });
              return;
            } catch {
              unlinkSync(lockFile); // dead holder — take over
            }
          }
        } catch {}
        const fd = openSync(lockFile, 'w');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        resolve({
          won: true,
          release() {
            try {
              unlinkSync(lockFile);
            } catch {}
          },
        });
      });
    });
  });
}
