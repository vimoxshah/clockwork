/**
 * clockworkd CLI (T-108): service install/uninstall + `doctor` diagnostics.
 * launchd LaunchAgent: login-session scoped — starts at login, restarts on
 * crash. No logout survival claims (FR-20).
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const LABEL = 'com.clockwork.daemon';
const PLIST_DIR = `${homedir()}/Library/LaunchAgents`;
const PLIST_PATH = `${PLIST_DIR}/${LABEL}.plist`;

export function plistXml(nodeBin: string, daemonEntry: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${daemonEntry}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}.out</string>
  <key>StandardErrorPath</key><string>${logPath}.err</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

export function install(daemonEntry: string): void {
  if (process.platform !== 'darwin') {
    console.error('service install is macOS-only in v1');
    process.exit(1);
  }
  mkdirSync(PLIST_DIR, { recursive: true });
  const logDir = `${process.env.CLOCKWORK_HOME ?? homedir() + '/.clockwork'}`;
  mkdirSync(logDir, { recursive: true });
  const xml = plistXml(process.execPath, resolve_(daemonEntry), path.join(logDir, 'daemon.log'));
  writeFileSync(PLIST_PATH, xml);
  try {
    execFileSync('/bin/launchctl', ['bootout', `gui/${uid()}`, PLIST_PATH], { stdio: 'ignore' });
  } catch {}
  execFileSync('/bin/launchctl', ['bootstrap', `gui/${uid()}`, PLIST_PATH]);
  console.log(`installed ${PLIST_PATH} (starts at login, restarts on crash)`);
}

export function uninstall(): void {
  try {
    execFileSync('/bin/launchctl', ['bootout', `gui/${uid()}`, PLIST_PATH], { stdio: 'ignore' });
  } catch {}
  try {
    if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
  } catch {}
  console.log('uninstalled');
}

export interface DoctorFinding {
  check: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** `clockworkd doctor` — detects the six canned misconfigs incl. duplicate instance. */
export async function doctor(apiPort = 4747): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const dataDir = process.env.CLOCKWORK_HOME ?? `${homedir()}/.clockwork`;

  // 1. claude CLI present?
  const claudeV = safeVersion('claude', ['--version']);
  findings.push({
    check: 'claude CLI',
    ok: claudeV.ok,
    detail: claudeV.ok ? claudeV.out : 'not found in PATH',
    fix: 'Install Claude Code and run `claude` once to log in.',
  });

  // 2. auth state (absent-auth probe via empty config dir is expensive; check creds file/keychain presence)
  const credFile = `${homedir()}/.claude/.credentials.json`;
  findings.push({
    check: 'claude auth artifacts',
    ok: existsSync(credFile),
    detail: existsSync(credFile) ? 'credentials file present' : 'no credentials file (may use keychain)',
    fix: 'Run `claude` interactively once to authenticate.',
  });

  // 3. git present
  const gitV = safeVersion('git', ['--version']);
  findings.push({ check: 'git', ok: gitV.ok, detail: gitV.ok ? gitV.out : 'missing', fix: 'Install git (xcode-select --install).' });

  // 4. data dir writable
  let dirOk = false;
  try {
    mkdirSync(dataDir, { recursive: true });
    dirOk = true;
  } catch {}
  findings.push({ check: 'data directory', ok: dirOk, detail: dataDir, fix: 'Check permissions on ~.' });

  // 5. duplicate instance / port already bound (S-80)
  const portBusy = await portTaken(apiPort);
  const lockFile = `${dataDir}/daemon.lock`;
  let lockPid: number | null = null;
  try {
    lockPid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
  } catch {}
  findings.push({
    check: 'single instance',
    ok: !(portBusy && lockPid && pidAlive(lockPid) === false),
    detail: portBusy
      ? `API port ${apiPort} already serving${lockPid ? ` (pid ${lockPid} on record)` : ''}`
      : 'port free',
    fix: portBusy ? 'A daemon appears to be running — stop it or run `launchctl kickstart -k gui/$(id -u)/com.clockwork.daemon`.' : undefined,
  });

  // 6. service registered
  const plistExists = process.platform === 'darwin' ? existsSync(PLIST_PATH) : false;
  findings.push({
    check: 'login service',
    ok: plistExists,
    detail: plistExists ? PLIST_PATH : 'LaunchAgent not installed',
    fix: 'Run `clockworkd install`.',
  });

  return findings;
}

function uid(): number {
  return os.userInfo().uid;
}

function resolve_(p: string): string {
  return path.resolve(p);
}


function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function portTaken(port: number): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(false)));
  });
}

function safeVersion(bin: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(bin, args, { encoding: 'utf8' }).trim().split('\n')[0] ?? '' };
  } catch {
    const probe = spawnSync(bin, args, { encoding: 'utf8' });
    return { ok: probe.status === 0, out: probe.stdout?.split('\n')[0] ?? 'not found' };
  }
}
