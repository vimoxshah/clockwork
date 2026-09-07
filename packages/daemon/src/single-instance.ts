/**
 * Single-instance lock (S-80): lockfile + port bind. Loser exits 0 with a log
 * line; doctor reports duplicate instances.
 *
 * The port is the authority, never the pid. A lockfile outlives the daemon
 * that wrote it — across a crash, and across a reboot that hands the recorded
 * pid to an unrelated process — so a live pid alone must never keep a daemon
 * from starting. Refusing on pid liveness turns a stale file into a permanent
 * outage, which is a worse failure than the duplicate instance it prevents.
 */
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';

/**
 * How long a lockfile written by a live pid counts as "a daemon that is still
 * binding". Inside the window we defer (a genuine startup race); outside it,
 * a free port proves the holder is not serving and we reclaim the lock.
 */
const STARTUP_RACE_MS = 60_000;

/** What a daemon records about itself in the lockfile. */
export interface HolderRecord {
  pid?: number;
  /** daemon version the holder was running — the version-skew signal */
  version?: string;
  port?: number;
  startedAt?: number;
}

export type LostReason =
  /** something is already serving the port we want */
  | 'port-in-use'
  /** a live daemon owns this data directory on a different port */
  | 'other-port'
  /** another daemon claimed the lock seconds ago and is still binding */
  | 'startup-race';

export interface InstanceLock {
  release(): void;
  /** pid of the holder if we lost the race */
  existingPid?: number;
  /** everything the holder recorded, for the diagnostic the loser prints */
  holder?: HolderRecord;
  /** why we lost; undefined when we won */
  reason?: LostReason;
  /** set when we reclaimed a lockfile whose holder is no longer serving */
  tookOverFrom?: HolderRecord;
}

/**
 * Claim the machine's daemon slot for `dataDir` + `port`.
 *
 * Call this before opening the database: a daemon that loses the race must not
 * run its migrations against the database the winner is serving.
 *
 * @param dataDir Clockwork data directory (created when missing).
 * @param port loopback API port this daemon intends to bind.
 * @param version daemon version recorded for the next process to read.
 * @returns the lock, plus `won` and — when `won` is false — why and who holds it.
 */
export async function acquireInstanceLock(
  dataDir: string,
  port: number,
  version?: string,
): Promise<InstanceLock & { won: boolean }> {
  const lockFile = `${dataDir}/daemon.lock`;
  const holder = readHolder(lockFile);
  const lost = (reason: LostReason): InstanceLock & { won: boolean } => ({
    won: false,
    reason,
    existingPid: holder?.pid,
    holder,
    release() {},
  });

  if (await portTaken(port)) return lost('port-in-use');

  // The port is free, so nothing is serving here. Only evidence of a live
  // daemon keeps us out.
  let tookOverFrom: HolderRecord | undefined;
  if (holder !== undefined) {
    if (holder.pid !== undefined && pidAlive(holder.pid)) {
      const otherPort = holder.port !== undefined && holder.port !== port ? holder.port : undefined;
      if (otherPort !== undefined && (await portTaken(otherPort))) return lost('other-port');
      if (otherPort === undefined && writtenWithin(lockFile, STARTUP_RACE_MS)) return lost('startup-race');
    }
    // Dead pid, recycled pid, or a holder that never got as far as binding:
    // reclaim the file. Nothing is killed here — see main.ts, which reports
    // the takeover rather than doing it silently.
    tookOverFrom = holder;
    try {
      unlinkSync(lockFile);
    } catch {}
  }

  mkdirSync(dataDir, { recursive: true });
  const mine: HolderRecord = { pid: process.pid, version, port, startedAt: Date.now() };
  const fd = openSync(lockFile, 'w');
  // Line 1 stays a bare pid: `clockworkd doctor` parses it with parseInt (cli.ts).
  writeSync(fd, `${process.pid}\n${JSON.stringify(mine)}\n`);
  closeSync(fd);

  return {
    won: true,
    tookOverFrom,
    release() {
      // Only remove a lockfile that is still ours. After a lost bind race the
      // file on disk may already belong to the daemon that won.
      if (readHolder(lockFile)?.pid !== process.pid) return;
      try {
        unlinkSync(lockFile);
      } catch {}
    },
  };
}

/** Read what the current lockfile holder recorded, or undefined when there is no lockfile. */
export function readInstanceLockHolder(dataDir: string): HolderRecord | undefined {
  return readHolder(`${dataDir}/daemon.lock`);
}

function readHolder(lockFile: string): HolderRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockFile, 'utf8');
  } catch {
    return undefined;
  }
  const [firstLine, ...rest] = raw.split('\n');
  const pid = parseInt((firstLine ?? '').trim(), 10);
  let meta: { version?: unknown; port?: unknown; startedAt?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(rest.join('\n').trim() || '{}');
    if (parsed !== null && typeof parsed === 'object') meta = parsed;
  } catch {}
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
    version: typeof meta.version === 'string' ? meta.version : undefined,
    port: typeof meta.port === 'number' ? meta.port : undefined,
    startedAt: typeof meta.startedAt === 'number' ? meta.startedAt : undefined,
  };
}

/** Was the lockfile written within `ms`? Its mtime is the moment its holder claimed the slot. */
function writtenWithin(lockFile: string, ms: number): boolean {
  try {
    return Date.now() - statSync(lockFile).mtimeMs < ms;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, it just is not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Probe-bind loopback. Note the inherent race: the probe must release the port
 * before fastify can take it, so the caller still has to handle EADDRINUSE.
 */
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}
