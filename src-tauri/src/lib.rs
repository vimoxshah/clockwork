/**
 * Clockwork desktop shell (T-121): native window onto the daemon-served UI at
 * 127.0.0.1:4747.
 *
 * The .app now carries the daemon and its own Node (tools/stage-bundle.mjs),
 * so "installed" means the DMG and nothing else — no checkout, no pnpm, no
 * Node on the machine, no token to paste. This file is what makes that true at
 * runtime: it finds the bundled pair, hands them to launchd so scheduled runs
 * survive the window closing AND the reboot, and pairs the webview's token
 * itself.
 */
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

const DAEMON_ADDR: &str = "127.0.0.1:4747";
const DAEMON_URL: &str = "http://127.0.0.1:4747";
const LAUNCHD_LABEL: &str = "com.clockwork.daemon";
const PLIST_REL: &str = "Library/LaunchAgents/com.clockwork.daemon.plist";

fn daemon_up() -> bool {
    TcpStream::connect_timeout(
        &DAEMON_ADDR.parse().expect("valid addr"),
        Duration::from_millis(500),
    )
    .is_ok()
}

/// The Node and daemon this .app carries.
struct Bundle {
    node: PathBuf,
    /// `dist/main.js` — what launchd runs.
    entry: PathBuf,
    /// `dist/cli.js` — `clockworkd install|uninstall|doctor`.
    cli: PathBuf,
    /// `packages/daemon/package.json` — the version `/health` will report.
    daemon_pkg: PathBuf,
}

/// The version the BUNDLED daemon will report on `/health`.
///
/// Read from the daemon's own package.json, not from `CARGO_PKG_VERSION`.
/// Those are two files — `src-tauri/Cargo.toml` and
/// `packages/daemon/package.json` — that nothing in this repo keeps in step.
/// Comparing the shell's version to the daemon's would mean that one missed
/// bump makes `restart_if_stale` fire `kickstart -k` on EVERY launch, killing
/// the daemon and any run in flight, and then waiting for it to come back.
fn bundled_daemon_version(b: &Bundle) -> Option<String> {
    let text = std::fs::read_to_string(&b.daemon_pkg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version")?.as_str().map(str::to_string)
}

/// Locate the bundled pair, or None when running unbundled (`tauri dev`).
///
/// Derived from `current_exe` rather than Tauri's resource resolver because
/// this runs before the Builder exists, and because the two halves live in
/// different places: `externalBin` puts Node next to the shell in
/// Contents/MacOS, `resources` puts the daemon in Contents/Resources.
fn bundle() -> Option<Bundle> {
    let exe = std::env::current_exe().ok()?;
    let macos_dir = exe.parent()?;
    let node = macos_dir.join("node");
    let daemon_dist = macos_dir
        .parent()?
        .join("Resources")
        .join("app")
        .join("packages")
        .join("daemon")
        .join("dist");
    let entry = daemon_dist.join("main.js");
    let cli = daemon_dist.join("cli.js");
    let daemon_pkg = daemon_dist.parent()?.join("package.json");
    if node.is_file() && entry.is_file() && cli.is_file() {
        Some(Bundle { node, entry, cli, daemon_pkg })
    } else {
        None
    }
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

/// One GET against the local daemon, returning the status code and the body.
///
/// Hand-rolled rather than pulling in an HTTP client. It started life reading
/// only `/health`, which `requiresAuth` leaves open precisely so a supervisor
/// can check on the daemon without holding a credential. The tray (T4-3) also
/// reads `/widget/snapshot` and `/runs`, which are behind the bearer token
/// (`packages/daemon/src/api.ts:633`), so the token is a parameter now.
///
/// The STATUS is returned, not discarded, and that is what the authenticated
/// caller needs: the auth hook answers a bad or missing token with a 200-shaped
/// `401 {"error":"unauthorized"}`, and a body-only reader would parse that as a
/// snapshot with every count absent — a tray that quietly says nothing needs
/// you. Unparseable status lines fail closed by returning None.
fn http_get_status(path: &str, token: Option<&str>) -> Option<(u16, String)> {
    let mut stream =
        TcpStream::connect_timeout(&DAEMON_ADDR.parse().ok()?, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let auth = match token {
        Some(t) => format!("Authorization: Bearer {t}\r\n"),
        None => String::new(),
    };
    write!(
        stream,
        "GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n{auth}Connection: close\r\n\r\n"
    )
    .ok()?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    let (head, body) = raw.split_once("\r\n\r\n")?;
    let status = parse_status_line(head)?;
    Some((status, body.to_string()))
}

/// The numeric status out of `HTTP/1.1 200 OK`.
///
/// Split out to be testable: nothing else in this file can reach a live socket
/// from `cargo test`.
fn parse_status_line(head: &str) -> Option<u16> {
    let first = head.lines().next()?;
    if !first.starts_with("HTTP/") {
        return None;
    }
    first.split_whitespace().nth(1)?.parse().ok()
}

/// One unauthenticated GET, body only, 200 only.
fn http_get(path: &str) -> Option<String> {
    match http_get_status(path, None)? {
        (200, body) => Some(body),
        _ => None,
    }
}

/// The version of the daemon PROCESS currently answering, which is not
/// necessarily the version on disk — a running LaunchAgent keeps serving the
/// old build after the .app is replaced.
fn running_daemon_version() -> Option<String> {
    let body = http_get("/health")?;
    let parsed: serde_json::Value = serde_json::from_str(&body).ok()?;
    parsed.get("daemonVersion")?.as_str().map(str::to_string)
}

/// `ProgramArguments[0]` out of the installed LaunchAgent, if there is one.
///
/// Text-scanned rather than plist-parsed: the file is written by
/// `packages/daemon/src/cli.ts:plistXml`, whose shape is fixed and whose first
/// `<string>` after the ProgramArguments key is the Node path by construction.
fn agent_node_path() -> Option<String> {
    parse_agent_node_path(&std::fs::read_to_string(home().join(PLIST_REL)).ok()?)
}

/// Split out from the file read so it is testable at all.
///
/// The comment here used to say the shape is fixed because
/// `packages/daemon/src/cli.ts:plistXml` writes it. That is not true of an
/// installed plist: launchd and `plutil` normalize the file — the one on this
/// machine came back tab-indented with alphabetized keys and each key on its
/// own line, none of which `plistXml` emits. So this parses the STRUCTURE
/// (the first `<string>` after the ProgramArguments key) rather than a
/// spelling, and the tests below feed it both shapes.
///
/// It still cannot read a binary plist. That failure is silent-ish rather than
/// silent: `ensure_launch_agent` re-installs, which is wasteful but correct,
/// and `diagnosis` would misreport the service as unregistered. Converting to
/// binary is not something anything in this repo does.
fn parse_agent_node_path(xml: &str) -> Option<String> {
    let after = xml.split_once("<key>ProgramArguments</key>")?.1;
    let open = after.find("<string>")? + "<string>".len();
    let close = after[open..].find("</string>")?;
    Some(after[open..open + close].to_string())
}

/// What `ensure_launch_agent` should do, given what it observed.
///
/// Pure, because the interesting part is the decision and the rest is three
/// `Command`s. The bug this encodes was a missing third case: the old code
/// asked only whether the plist named this bundle's Node and returned early
/// when it did, which is a question about a FILE, not about whether launchd
/// has the job.
#[derive(Debug, PartialEq, Eq)]
enum AgentAction {
    /// Plist names this bundle and launchd holds the job.
    Nothing,
    /// Plist is already right; launchd just does not know about it.
    Bootstrap,
    /// No plist, or it names a different Node — write it and load it.
    Install,
}

fn agent_action(recorded_node: Option<&str>, want_node: &str, loaded: bool) -> AgentAction {
    if recorded_node != Some(want_node) {
        return AgentAction::Install;
    }
    if loaded {
        AgentAction::Nothing
    } else {
        AgentAction::Bootstrap
    }
}

/// Does launchd hold this label in the user's GUI session right now?
///
/// `launchctl print` exits non-zero for a label the session does not know,
/// which is precisely the state reading the plist cannot detect.
fn launch_agent_loaded() -> bool {
    let Some(uid) = current_uid() else { return false };
    Command::new("/bin/launchctl")
        .args(["print", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Load a plist that is already correct. No `bootout` first: there is nothing
/// to unload, and booting out a job that does not exist is the one case where
/// launchctl's error is worth not provoking.
fn bootstrap_launch_agent() {
    let Some(uid) = current_uid() else { return };
    let plist = home().join(PLIST_REL);
    let _ = Command::new("/bin/launchctl")
        .args([
            "bootstrap",
            &format!("gui/{uid}"),
            &plist.to_string_lossy().to_string(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Install (or re-point, or merely re-load) the LaunchAgent so scheduled runs
/// outlive the window.
///
/// Automatic and unprompted, because the alternative reads as "installed" and
/// is not: a daemon that merely outlives the app still dies at the next
/// reboot, and a calendar for agents whose jobs stop overnight has lost the
/// thing it is for.
///
/// Re-pointed, not just installed, and that is the case a first-launch-only
/// install misses. The plist bakes an ABSOLUTE path to the Node inside the
/// bundle, so dragging Clockwork.app from Downloads to Applications leaves
/// launchd pointing at a binary that is no longer there — an app that worked
/// yesterday and is silently dead today. Comparing the recorded path to the
/// running bundle's on every launch costs one file read and closes it.
///
/// RE-LOADED is the third case, and it was missing. A correct plist and a
/// registered job are different facts: `launchctl bootout` leaves the file
/// untouched, and so does anything else that drops the job. The old early
/// return then did nothing, `wait_for_daemon` sat out its six seconds waiting
/// for a service nothing had started, and the app came up with no daemon
/// behind it. Reproduced by hand: boot the agent out, relaunch, and the
/// daemon never returns. Reachable without a terminal too — reinstalling the
/// same version over itself leaves the path identical, so a job launchd has
/// forgotten stays forgotten.
fn ensure_launch_agent(b: &Bundle) {
    let want = b.node.to_string_lossy().to_string();
    match agent_action(agent_node_path().as_deref(), &want, launch_agent_loaded()) {
        AgentAction::Nothing => {}
        AgentAction::Bootstrap => bootstrap_launch_agent(),
        AgentAction::Install => {
            // `install` pins `process.execPath` into the plist, so running the
            // CLI WITH the bundled Node is what makes the plist point at the
            // bundled Node. It boots out and bootstraps for itself
            // (packages/daemon/src/cli.ts), so it needs no help loading.
            let _ = Command::new(&b.node)
                .arg(&b.cli)
                .arg("install")
                .arg(&b.entry)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

fn wait_for_daemon(attempts: u32) -> bool {
    for _ in 0..attempts {
        if daemon_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    daemon_up()
}

/// Restart the LaunchAgent when the daemon answering is older than the one in
/// this bundle.
///
/// After an app update launchd is still running the PREVIOUS build out of
/// memory, and nothing restarts it — the user updates, sees the stale-page
/// notice, and has no way to act on it. `kickstart -k` is the same command
/// `clockworkd doctor` already prescribes for a wedged service.
fn restart_if_stale(b: &Bundle) {
    let (Some(running), Some(bundled)) = (running_daemon_version(), bundled_daemon_version(b)) else {
        return;
    };
    if running == bundled {
        return;
    }
    let Some(uid) = current_uid() else { return };
    let _ = Command::new("/bin/launchctl")
        .args(["kickstart", "-k", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    wait_for_daemon(20);
}

/// launchd addresses a login-session service as `gui/<uid>/<label>`, and the
/// uid has to come from somewhere. `id -u` rather than a libc binding: one
/// process at app start, no `unsafe`, no new crate.
fn current_uid() -> Option<String> {
    let out = Command::new("/usr/bin/id").arg("-u").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let uid = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if uid.is_empty() { None } else { Some(uid) }
}

/// Fallback for an unbundled build (`tauri dev`), where there is nothing to
/// supervise. Both branches are long shots on a machine that only installed
/// the .app, which is exactly why the bundled path above exists.
fn ensure_daemon_unbundled() {
    let home = home().to_string_lossy().to_string();
    let launcher = format!("{home}/.clockwork/bin/start-daemon.sh");
    let script = format!(
        "if [ -x {launcher} ]; then nohup {launcher} >/dev/null 2>&1 & \
         elif command -v node >/dev/null 2>&1; then cd \"$HOME\" && nohup node clockwork/daemon.mjs >/dev/null 2>&1 & fi",
        launcher = launcher
    );
    let _ = Command::new("/bin/sh")
        .arg("-c")
        .arg(&script)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    wait_for_daemon(10);
}

fn ensure_daemon() {
    match bundle() {
        Some(b) => {
            ensure_launch_agent(&b);
            if !daemon_up() {
                // launchd's RunAtLoad fires on bootstrap, but bootstrap is
                // asynchronous; give it the same grace the unbundled path got.
                wait_for_daemon(20);
            }
            restart_if_stale(&b);
        }
        None => {
            if !daemon_up() {
                ensure_daemon_unbundled();
            }
        }
    }
}

/// The daemon's own API token, read off disk as the user who owns it.
///
/// The token exists to stop a random web page driving the daemon, and reading
/// the file is not a way around that: this process already runs as the user
/// whose file it is. Pairing it here removes the one manual step left in
/// "install and start using it" — a paste out of ~/.clockwork/api-token that
/// the desktop app never had any reason to ask a human for.
fn api_token() -> Option<String> {
    let dir = std::env::var("CLOCKWORK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".clockwork"));
    let token = std::fs::read_to_string(dir.join("api-token")).ok()?;
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// JS that pairs this webview, and ONLY this webview.
///
/// An injection script runs in the app's own WKWebView before the page loads.
/// A browser tab pointed at 127.0.0.1:4747 is a different web view with its
/// own storage, so it gets no injection and still meets the pairing screen —
/// which is the behaviour we want kept, not a limitation. Doing this through a
/// Tauri IPC command instead would mean granting IPC to a remote origin, and
/// that grant would belong to every page the daemon serves. So the token
/// still travels this way, and should.
///
/// T1-19 grants that origin IPC anyway — for one command — and the sentence
/// above is exactly why it is one. `capabilities/check-for-updates.json`
/// names `check_for_updates_command` and nothing else: no arguments, one
/// hardcoded HTTPS GET to api.github.com, a version string back. What every
/// page the daemon serves gets is therefore the ability to learn which
/// Clockwork version is current — a fact GitHub's releases page already
/// publishes to anyone. A command that read this token would not have
/// survived that question, and the next command added must answer it again —
/// it inherits nothing, and needs its own permission and its own line in the
/// capability.
fn pairing_script(token: &str) -> String {
    // Guarded on the origin, for two reasons that both matter.
    //
    // An initialization script becomes a WKUserScript, and a user script re-runs
    // on EVERY navigation in the web view. That is what makes it work at all
    // here: daemon-down.html does `location.replace(DAEMON_URL)` once the port
    // answers, and without a script that survives that navigation the recovered
    // window lands on the pairing screen — the one manual step this removes.
    //
    // The same re-run is why the origin check is not decoration. Nothing in the
    // shipped UI navigates off 127.0.0.1:4747, but an unguarded script would
    // write a live bearer token into the localStorage of any origin the window
    // ever reached, and that would be true the day someone adds the first
    // external link rather than the day they notice.
    format!(
        "try{{if(location.origin==={}){{localStorage.setItem('clockwork.token',{});}}}}catch(e){{}}",
        serde_json::to_string(DAEMON_URL).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(token).unwrap_or_else(|_| "\"\"".into())
    )
}

/// What to tell the user when the daemon did not come up.
///
/// The fallback page used to say "the app bundle does not contain the daemon,
/// it is installed separately, from source" and then print `git clone`. That
/// stopped being true the moment the daemon moved inside the bundle, and a
/// failure page that explains the wrong system is worse than a blank one — it
/// sends the user off to fix something that is not broken. So the page now
/// gets the actual state of THIS install, gathered here where it is knowable.
fn diagnosis() -> String {
    let bundled = bundle().is_some();
    let agent = agent_node_path();
    // Same resolution as `api_token` and cli.ts:44. Hardcoding ~/.clockwork
    // here would print a path that does not exist whenever CLOCKWORK_HOME is
    // set, and `recent` would then always be false.
    let log = std::env::var("CLOCKWORK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".clockwork"))
        .join("daemon.log.err");
    // The tail, not the file: this log accumulates across every crash the
    // daemon has ever had, and the only interesting part is the last one.
    let tail = std::fs::read_to_string(&log)
        .map(|t| t.lines().rev().take(25).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    // "Fresh" means this launch, near enough. Five minutes is generous for a
    // crash that happened while the user was double-clicking the icon, and
    // tight enough that last month's failure cannot masquerade as this one.
    let recent = std::fs::metadata(&log)
        .and_then(|m| m.modified())
        .and_then(|t| t.elapsed().map_err(|e| std::io::Error::other(e)))
        .map(|age| age < Duration::from_secs(300))
        .unwrap_or(false);
    // Ordered by what is KNOWN before what is INFERRED. The log is the last
    // thing consulted and only when it is fresh: it accumulates across every
    // crash since install, so a months-old EADDRINUSE sitting at the bottom
    // would otherwise be reported as today's cause with full confidence.
    let cause = if !bundled {
        "this is a development build, which does not carry a daemon"
    } else if agent.is_none() {
        "the background service is not registered with launchd"
    } else if recent {
        // By RECENCY, not by a fixed order. KeepAlive appends every crash to
        // one file, so a 25-line tail can straddle two eras: an old ABI
        // crash-loop above today's EADDRINUSE. A fixed order would then name
        // the older cause and send the reader to file a bug about a native
        // module that is fine.
        match last_marker(&tail) {
            Some("NODE_MODULE_VERSION") => "the daemon's native database module was built for a different Node",
            Some("EADDRINUSE") => "another process already holds 127.0.0.1:4747",
            _ => "the background service started and exited — see the log below",
        }
    } else {
        "the background service is registered but is not answering"
    };
    serde_json::json!({
        "bundled": bundled,
        "agentNode": agent,
        "logPath": log.to_string_lossy(),
        "cause": cause,
        "tail": tail,
        "logIsRecent": recent,
        "version": env!("CARGO_PKG_VERSION"),
    })
    .to_string()
}

/// Whichever known failure marker appears LAST in the tail.
fn last_marker(tail: &str) -> Option<&'static str> {
    let mut found: Option<&'static str> = None;
    for line in tail.lines() {
        if line.contains("NODE_MODULE_VERSION") {
            found = Some("NODE_MODULE_VERSION");
        } else if line.contains("EADDRINUSE") {
            found = Some("EADDRINUSE");
        }
    }
    found
}

/// Hand the fallback page what this shell already knows, as a global rather
/// than over IPC — the page is local, static and read-only, and granting it an
/// IPC channel would grant one to every page the daemon serves.
fn diagnosis_script(diag: &str) -> String {
    format!("window.__CLOCKWORK_DIAGNOSIS__ = {diag};")
}

/// Just the one-line cause out of `diagnosis`, for the tray to say out loud.
///
/// Round-tripped through the JSON rather than re-deriving the cause, so the
/// tray and `daemon-down.html` can never name two different reasons for the
/// same outage. It re-reads `daemon.log.err`, so the caller must not run it on
/// every poll — `tray_loop` computes it once per healthy→down transition.
fn diagnosis_cause() -> String {
    serde_json::from_str::<serde_json::Value>(&diagnosis())
        .ok()
        .and_then(|v| v.get("cause").and_then(|c| c.as_str()).map(str::to_string))
        .unwrap_or_else(|| "the background service is not answering".to_string())
}

// ---------------------------------------------------------------------------
// T4-3 — the menu bar. The only surface Clockwork has while its window is shut.
//
// The product's promise is that runs happen while the app is closed, and a
// closed app is an invisible one: today you learn something needs you by
// noticing a notification you may already have missed. The README's own words
// for that are "an approval nobody sees is the same as a deny, just slower".
// Everything below exists to make the waiting approval visible without
// opening anything.
//
// Everything that DECIDES is a pure function of a parsed snapshot and a clock,
// and everything that TOUCHES Tauri is a thin consumer of that decision. Not
// tidiness: a tray cannot be exercised from `cargo test` at all, so the only
// way the daemon-down path is covered is if the daemon-down path is a value.
// ---------------------------------------------------------------------------

/// How often the tray re-reads the daemon.
///
/// Ten seconds, and the number sits between two clocks. The scheduler ticks
/// every 30s (`packages/daemon/src/scheduler.ts:74`), so nothing SCHEDULED can
/// appear sooner than that and polling faster buys a scheduled run nothing.
/// Approvals are the other clock, and they are the one this surface is for: a
/// run asks for permission mid-turn, at no particular moment, unrelated to the
/// tick. Sitting ON the tick would mean the badge is up to 30s behind the
/// event it exists to announce, so it has to sit under it.
///
/// Ten seconds costs six polls a minute and twelve requests — two small
/// count-only reads over loopback, `/health` and `/widget/snapshot`. The one
/// expensive read, `/runs`, is gated on the counts changing (`tray_loop`), so
/// an idle machine issues no unbounded query at all.
const TRAY_POLL: Duration = Duration::from_secs(10);

/// How many finished runs the menu lists. T4-3 says three.
const TRAY_RECENT: usize = 3;

/// Rows to ask `/runs` for before filtering. Headroom, because bookings sort
/// above history — see `parse_recent_runs`.
const TRAY_RUNS_LIMIT: usize = 12;

const TRAY_ID: &str = "clockwork-tray";
const ID_INBOX: &str = "tray.inbox";
const ID_OPEN: &str = "tray.open";
const ID_QUIT: &str = "tray.quit";
/// Prefix for the per-run rows; they all jump to the Inbox.
const ID_RUN_PREFIX: &str = "tray.run.";
/// T1-6 — runs the update check itself, natively, rather than opening
/// Settings and asking the page to do it. The first reason was that the
/// page could not be asked: this window is built with
/// `WebviewUrl::External(DAEMON_URL)` (below), which Tauri's own
/// `is_local_url` (tauri-2.11.5/src/webview/mod.rs:1698) does not consider
/// local — it matches neither the `tauri://` protocol nor a configured
/// `devUrl`/`frontendDist` URL nor a registered custom scheme — so the ACL
/// gate (`webview/mod.rs:1823`) rejected every `invoke()` from it.
///
/// T1-19 lifted that for this one command
/// (`capabilities/check-for-updates.json`), so Settings can now run its own
/// check. This one stays native, because the tray has to answer in two
/// states Settings cannot: with the window hidden, and with the daemon down
/// and the window showing `daemon-down.html`, which has no Settings screen
/// on it at all. See `run_update_check`.
const ID_CHECK_UPDATES: &str = "tray.check_updates";

/// The numbers the menu bar exists to show.
///
/// Assembled from two routes because no single one carries all three. The
/// widget snapshot (`api.ts:2389`) has next-fire WITH the task's name and the
/// needs-you count, but no running count — its `runsToday` counts runs BOOKED
/// today, which is a different number and would read as a lie the moment
/// yesterday's overnight job is still going. `/health` (`api.ts:737`) has
/// `activeRuns`. Neither is extended here: `packages/` belongs to other work.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct TrayCounts {
    /// Approvals nobody has answered yet. The needs-you badge.
    needs_you: u64,
    /// Runs in flight right now.
    running: u64,
    /// Runs holding for a slot.
    queued: u64,
    /// Epoch ms of the earliest enabled schedule.
    next_fire: Option<i64>,
    /// Whose fire it is. Only the widget snapshot knows the name.
    next_name: Option<String>,
    paused: bool,
    /// Reports landed in the last 24h. Carried only as a change detector.
    recent_reports: u64,
    /// Runs booked today. Carried only as a change detector.
    runs_today: u64,
}

/// What the tray knows, including the two ways it can know almost nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TrayState {
    /// Nothing is answering on 4747. The tray says so and says why.
    Down { cause: String },
    /// The daemon answers `/health` but will not answer `/widget/snapshot` —
    /// no token on disk yet, or a stale one. The counts `/health` gives are
    /// real and are shown; the needs-you count is UNKNOWN and is labelled
    /// unknown, because showing a confident zero is the failure this whole
    /// task is about.
    Unpaired(TrayCounts),
    Up(TrayCounts),
}

/// One finished (or in-flight) run, as the menu lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RecentRun {
    name: String,
    state: String,
    /// When it ended, started, or last changed — whichever is known.
    at: Option<i64>,
}

/// A line of the menu. Rendering produces these; Tauri consumes them.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TrayLine {
    Separator,
    /// Text only. Disabled in the native menu — the tray is a status surface
    /// before it is a control surface.
    Info(String),
    Action { id: String, label: String },
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `/health` — unauthenticated, so this works before the shell is paired.
fn parse_health(body: &str) -> Option<TrayCounts> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    if v.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return None;
    }
    Some(TrayCounts {
        running: v.get("activeRuns").and_then(serde_json::Value::as_u64).unwrap_or(0),
        queued: v.get("queuedRuns").and_then(serde_json::Value::as_u64).unwrap_or(0),
        next_fire: v.get("nextFire").and_then(serde_json::Value::as_i64),
        paused: v.get("paused").and_then(serde_json::Value::as_bool).unwrap_or(false),
        ..TrayCounts::default()
    })
}

/// `/widget/snapshot` folded onto what `/health` already told us.
///
/// Returns false when the body is not a snapshot — a 401 page, a truncated
/// read, anything. False means Unpaired, never "zero approvals".
fn merge_snapshot(counts: &mut TrayCounts, body: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    // needsYou is the field this whole surface exists for. Its ABSENCE is the
    // signal that we are not reading a snapshot, so it is the one field with
    // no default.
    let Some(needs) = v.get("needsYou").and_then(serde_json::Value::as_u64) else {
        return false;
    };
    counts.needs_you = needs;
    counts.recent_reports = v.get("recentReports").and_then(serde_json::Value::as_u64).unwrap_or(0);
    counts.runs_today = v.get("runsToday").and_then(serde_json::Value::as_u64).unwrap_or(0);
    match v.get("nextRun").filter(|n| !n.is_null()) {
        Some(next) => {
            counts.next_name = next.get("name").and_then(serde_json::Value::as_str).map(str::to_string);
            // Same row `/health` reduced to a MIN, so prefer this one: it is
            // the fire the NAME belongs to.
            if let Some(f) = next.get("next_fire").and_then(serde_json::Value::as_i64) {
                counts.next_fire = Some(f);
            }
        }
        None => counts.next_name = None,
    }
    true
}

/// The last few runs out of `GET /runs?limit=`.
///
/// `RunRepo.list` orders by `COALESCE(scheduled_for, state_changed_at) DESC`
/// (`packages/daemon/src/repo.ts:322`), which is "most recent first" only
/// while no row carries a FUTURE `scheduled_for`. A row that does is a
/// booking, and a booking printed under three lines of history reads as
/// "your last run was next Tuesday". So future-dated rows are dropped by
/// their timestamp rather than by a state blacklist: `queued` and `running`
/// rows are the most recent thing that happened and belong in the list.
fn parse_recent_runs(body: &str, want: usize, now: i64) -> Vec<RecentRun> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in rows {
        // A minute of slack: `scheduled_for` is written as `now` on insert
        // (`run-manager.ts:1082`) and the two clocks are the same machine's,
        // but rounding should not be able to hide a run that just started.
        if row
            .get("scheduled_for")
            .and_then(serde_json::Value::as_i64)
            .is_some_and(|s| s > now + 60_000)
        {
            continue;
        }
        let name = row
            .get("jobspec_json")
            .and_then(serde_json::Value::as_str)
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .and_then(|spec| spec.get("taskName").and_then(serde_json::Value::as_str).map(str::to_string))
            .unwrap_or_else(|| "(task)".to_string());
        out.push(RecentRun {
            name,
            state: row
                .get("state")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            at: ["ended_at", "started_at", "state_changed_at"]
                .iter()
                .find_map(|k| row.get(*k).and_then(serde_json::Value::as_i64)),
        });
        if out.len() == want {
            break;
        }
    }
    out
}

/// A duration in the words a glance can read. No date crate: the tray never
/// prints a wall-clock time, only a distance from now, so there is no
/// timezone to get wrong and nothing here that a machine's locale can break.
fn human_delta(ms: i64) -> String {
    let secs = ms.max(0) / 1000;
    if secs < 60 {
        return "less than a minute".to_string();
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins} min");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours} hr");
    }
    let days = hours / 24;
    if days == 1 { "1 day".to_string() } else { format!("{days} days") }
}

fn in_future(at: i64, now: i64) -> String {
    if at <= now { "due now".to_string() } else { format!("in {}", human_delta(at - now)) }
}

fn in_past(at: i64, now: i64) -> String {
    if at >= now { "just now".to_string() } else { format!("{} ago", human_delta(now - at)) }
}

/// One glyph for a run state, so three rows read as a column.
fn state_glyph(state: &str) -> &'static str {
    match state {
        "completed" => "✓",
        "failed" | "timed_out" | "budget_exceeded" => "✗",
        "cancelled" | "missed" => "–",
        "waiting_approval" | "awaiting_user" => "⚠",
        "running" | "preparing" | "finalizing" => "▶",
        _ => "·",
    }
}

/// The text beside the icon in the menu bar — the badge itself.
///
/// macOS is the only platform Tauri lets a status item carry text on
/// (`tauri-2.11.5/src/tray/mod.rs:531`: Windows unsupported, Linux at the
/// panel's discretion), and macOS is the only platform this shell ships on —
/// launchd, an entitlements plist, a dmg. The same facts lead the menu, so a
/// port to a platform without titles loses the glance, not the information.
///
/// Ordered by what blocks a human. A waiting approval outranks a running run
/// outranks a pause, because only the first one is waiting on YOU. `None` is
/// deliberate and is the common case: an idle Clockwork shows a bare icon, so
/// that any text at all in that slot means something changed.
fn tray_title(state: &TrayState) -> Option<String> {
    match state {
        TrayState::Down { .. } => Some("⚠ offline".to_string()),
        // Not zero, and not blank. We cannot see the approvals from here and
        // the badge must not imply we looked.
        TrayState::Unpaired(_) => Some("⚠ ?".to_string()),
        TrayState::Up(c) if c.needs_you > 0 => Some(format!("⚠ {}", c.needs_you)),
        TrayState::Up(c) if c.running > 0 => Some(format!("▶ {}", c.running)),
        TrayState::Up(c) if c.paused => Some("⏸".to_string()),
        TrayState::Up(_) => None,
    }
}

fn action(id: &str, label: impl Into<String>) -> TrayLine {
    TrayLine::Action { id: id.to_string(), label: label.into() }
}

/// The running/queued line, shared by the paired and unpaired states.
fn running_line(c: &TrayCounts) -> String {
    let head = match c.running {
        0 => "Nothing running".to_string(),
        1 => "▶ 1 run in progress".to_string(),
        n => format!("▶ {n} runs in progress"),
    };
    match c.queued {
        0 => head,
        1 => format!("{head} · 1 queued"),
        n => format!("{head} · {n} queued"),
    }
}

/// The next-fire line. A paused scheduler has a `next_fire` that will not
/// fire, so saying when it would have is worse than saying it is paused.
fn next_line(c: &TrayCounts, now: i64) -> String {
    if c.paused {
        return "⏸ Scheduling is paused".to_string();
    }
    match c.next_fire {
        None => "Next: nothing scheduled".to_string(),
        Some(at) => match &c.next_name {
            Some(name) => format!("Next: {name} {}", in_future(at, now)),
            None => format!("Next: {}", in_future(at, now)),
        },
    }
}

/// What the menu says before the first poll has answered. Never an empty menu.
fn starting_lines() -> Vec<TrayLine> {
    vec![
        TrayLine::Info("Checking the background service…".to_string()),
        TrayLine::Separator,
        action(ID_OPEN, "Open Clockwork"),
        action(ID_QUIT, "Quit Clockwork"),
    ]
}

/// The whole menu, as values.
fn tray_lines(state: &TrayState, recent: &[RecentRun], now: i64) -> Vec<TrayLine> {
    let mut lines = Vec::new();
    match state {
        TrayState::Down { cause } => {
            lines.push(TrayLine::Info("⚠ The background service is down".to_string()));
            lines.push(TrayLine::Info(format!("Why: {cause}")));
            lines.push(TrayLine::Info("No scheduled run will start until it is back".to_string()));
            lines.push(TrayLine::Separator);
            lines.push(action(ID_OPEN, "Open Clockwork"));
            lines.push(action(ID_CHECK_UPDATES, "Check for updates…"));
            // NOT "runs continue" — nothing is running to continue. The whole
            // point of this state is that the tray stops repeating the happy
            // path's sentences.
            lines.push(action(ID_QUIT, "Quit Clockwork"));
            return lines;
        }
        TrayState::Unpaired(c) => {
            lines.push(TrayLine::Info("⚠ Not paired — approvals unknown".to_string()));
            lines.push(TrayLine::Info(running_line(c)));
            lines.push(TrayLine::Info(next_line(c, now)));
            lines.push(TrayLine::Separator);
            lines.push(action(ID_OPEN, "Open Clockwork to pair"));
            lines.push(action(ID_CHECK_UPDATES, "Check for updates…"));
            lines.push(action(ID_QUIT, "Quit Clockwork (scheduled runs continue)"));
            return lines;
        }
        TrayState::Up(c) => {
            // The most important line is also the shortest route to acting on
            // it: needs-you IS the jump to the Inbox.
            lines.push(match c.needs_you {
                0 => TrayLine::Info("Nothing needs you".to_string()),
                1 => action(ID_INBOX, "⚠ 1 approval needs you"),
                n => action(ID_INBOX, format!("⚠ {n} approvals need you")),
            });
            lines.push(TrayLine::Info(running_line(c)));
            lines.push(TrayLine::Info(next_line(c, now)));
        }
    }
    lines.push(TrayLine::Separator);
    if recent.is_empty() {
        lines.push(TrayLine::Info("No runs yet".to_string()));
    } else {
        for (i, r) in recent.iter().enumerate() {
            let when = r.at.map(|t| in_past(t, now)).unwrap_or_else(|| "—".to_string());
            lines.push(action(
                &format!("{ID_RUN_PREFIX}{i}"),
                format!("{} {} · {when}", state_glyph(&r.state), r.name),
            ));
        }
    }
    lines.push(TrayLine::Separator);
    lines.push(action(ID_INBOX, "Open Inbox"));
    lines.push(action(ID_OPEN, "Open Clockwork"));
    lines.push(action(ID_CHECK_UPDATES, "Check for updates…"));
    // True because launchd owns the daemon, not this process
    // (`ensure_launch_agent`). Saying it here is the cheapest answer to the
    // fear that quitting the app cancels tonight's work.
    lines.push(action(ID_QUIT, "Quit Clockwork (scheduled runs continue)"));
    lines
}

/// Which of the three things a menu id means, or none of them.
#[derive(Debug, PartialEq, Eq)]
enum TrayAction {
    OpenWindow,
    OpenInbox,
    /// T1-6. Runs `check_for_updates()` natively and shows the result in
    /// the webview via `w.eval` — see `ID_CHECK_UPDATES`'s doc comment for
    /// why this does not go through `invoke()`.
    CheckForUpdates,
    Quit,
    Ignore,
}

fn tray_action(id: &str) -> TrayAction {
    if id == ID_QUIT {
        TrayAction::Quit
    } else if id == ID_OPEN {
        TrayAction::OpenWindow
    } else if id == ID_CHECK_UPDATES {
        TrayAction::CheckForUpdates
    } else if id == ID_INBOX || id.starts_with(ID_RUN_PREFIX) {
        // A run row cannot deep-link to its own report: the UI routes on a
        // hash that only names a tab (`packages/ui/src/App.tsx:35`), and
        // teaching it a run id would mean editing `packages/`. The Inbox lists
        // the run one row down, which is the honest near miss.
        TrayAction::OpenInbox
    } else {
        TrayAction::Ignore
    }
}

/// One poll: two cheap reads, and the honest answer when either fails.
///
/// `last_cause` caches the diagnosis across consecutive down polls, because
/// `diagnosis` reads `daemon.log.err` whole and that file accumulates every
/// crash since install. Re-reading it six times a minute for a string that
/// cannot change would be a real cost paid in the state where the machine is
/// already unwell.
fn read_tray_state(last_cause: &mut Option<String>) -> TrayState {
    // A port that answers with something other than a health object is a
    // daemon that is up and wrong, which for this surface is down.
    let Some(mut counts) = http_get("/health").as_deref().and_then(parse_health) else {
        if last_cause.is_none() {
            *last_cause = Some(diagnosis_cause());
        }
        return TrayState::Down { cause: last_cause.clone().unwrap_or_default() };
    };
    // Healthy: forget the cached cause so the NEXT outage is diagnosed fresh.
    *last_cause = None;
    // Re-read every poll rather than once at launch: on a first install the
    // daemon writes `api-token` after this shell has already started, and
    // `rotateToken` can replace it at any time.
    let Some(token) = api_token() else {
        return TrayState::Unpaired(counts);
    };
    match http_get_status("/widget/snapshot", Some(&token)) {
        Some((200, body)) if merge_snapshot(&mut counts, &body) => TrayState::Up(counts),
        _ => TrayState::Unpaired(counts),
    }
}

/// The last few runs, or None when the read itself failed.
///
/// The distinction matters on the menu: an empty Vec renders "No runs yet",
/// and printing that because a request timed out would be the same class of
/// lie as printing a stale count. None means "keep what you had and try
/// again" (`poll_loop`).
fn fetch_recent_runs(now: i64) -> Option<Vec<RecentRun>> {
    let token = api_token()?;
    match http_get_status(&format!("/runs?limit={TRAY_RUNS_LIMIT}"), Some(&token))? {
        (200, body) => Some(parse_recent_runs(&body, TRAY_RECENT, now)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// T1-6 — "check for updates", user-initiated only.
//
// docs/architecture/update-delivery.md's finding: nothing in this app ever
// asks whether a newer release exists. Two real security fixes shipped in
// one session and neither could reach an installed user. This is the
// cheapest item on that document's own options list — ask GitHub, but only
// when clicked. No timer, no check-on-launch, no "check daily" preference:
// the Settings button (`SettingsView.tsx`'s `UpdateCheckCard`) and the tray
// item above are the only two triggers, and both are a direct click.
//
// Same split as the tray section above and `http_get`/`parse_status_line`:
// the DECISION (`evaluate_update`) is a pure function of a version string
// and a fetch result, and is what `cargo test` exercises for all four
// outcomes below. The IO (`fetch_latest_release`) is not exercised by
// `cargo test` — nothing in this file can reach a live socket from a test
// binary, TLS or not.
// ---------------------------------------------------------------------------

/// `vimoxshah/clockwork` — the same repo `README.md`'s checksum-verification
/// command and `git clone` line already point at.
const GITHUB_RELEASES_URL: &str = "https://api.github.com/repos/vimoxshah/clockwork/releases/latest";

/// Strips a single leading `v`/`V`. GitHub tags one; `CARGO_PKG_VERSION`
/// never does.
fn strip_v(s: &str) -> &str {
    s.strip_prefix(['v', 'V']).unwrap_or(s)
}

/// Just the two fields this feature reads out of GitHub's release object.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReleaseInfo {
    /// e.g. `"v0.11.2"` — GitHub's `tag_name`, leading `v` and all.
    tag: String,
    /// GitHub's `html_url` — the release NOTES page, not the API URL.
    notes_url: String,
}

/// A MAJOR.MINOR.PATCH version, parsed and ordered numerically.
///
/// Not the `semver` crate. Every version this repo has ever cut —
/// `Cargo.toml`'s own `version`, `tauri.conf.json`'s, the release
/// workflow's tag — is three plain integers with an optional leading `v`
/// and nothing else: no pre-release suffix, no build metadata. A second
/// dependency to parse a grammar nothing here ever emits would not be
/// "minimal", it would be a different unused feature. `Ord` is derived
/// field-by-field, which IS semver precedence for the shape this repo
/// actually produces: `(0,9,0) < (0,11,2)`, where a STRING compare gets it
/// backwards ("0.9.0" > "0.11.2" lexically, because '9' > '1') — the case
/// the acceptance test is named for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct SemVer(u64, u64, u64);

fn parse_semver(raw: &str) -> Option<SemVer> {
    let mut parts = strip_v(raw).split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None; // a fourth component is not a shape this repo emits
    }
    Some(SemVer(major, minor, patch))
}

/// GitHub's release JSON, reduced to what this feature needs. `None` for
/// anything missing EITHER field as a string — a release with no notes link
/// cannot honour "a link to the release notes", so it is treated the same
/// as a response with no `tag_name` at all: malformed, not partial.
fn parse_release(body: &str) -> Option<ReleaseInfo> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    Some(ReleaseInfo {
        tag: v.get("tag_name")?.as_str()?.to_string(),
        notes_url: v.get("html_url")?.as_str()?.to_string(),
    })
}

/// What clicking "Check for updates" tells the user. Four variants, because
/// silence reads as "nothing to report" — the exact defect
/// `docs/architecture/update-delivery.md` exists to close. A check that
/// found nothing newer must SAY SO (`UpToDate`), and a check that could not
/// run must never be spelled the same as "you are up to date" — the
/// `sleptThroughKeepAwake: false` class of bug, answering "no" for "we
/// could not tell".
#[derive(Debug, Clone, PartialEq, Eq)]
enum UpdateCheck {
    /// Checked. Nothing newer. Stated, not implied by a quiet screen.
    UpToDate { current: String },
    NewerAvailable { current: String, latest: String, notes_url: String },
    /// The request itself failed — offline, DNS, TLS, timeout, a non-2xx
    /// status. Never collapsed into `UpToDate`.
    NetworkError { reason: String },
    /// GitHub answered (2xx) but the body was not a release this code can
    /// read — not JSON, no `tag_name`/`html_url`, or a `tag_name` that is
    /// not a version. Kept apart from `NetworkError` so a test — and a
    /// reader — can tell "GitHub did not answer" from "GitHub answered
    /// something this build does not understand".
    Malformed { reason: String },
}

/// The decision, given the network's answer as a value rather than a call.
/// `current` is `env!("CARGO_PKG_VERSION")` at the one real call site
/// (`check_for_updates` below) — threaded in as a parameter so a test can
/// supply any pair without touching the environment or a socket.
fn evaluate_update(current: &str, fetched: Result<String, String>) -> UpdateCheck {
    let body = match fetched {
        Ok(b) => b,
        Err(reason) => return UpdateCheck::NetworkError { reason },
    };
    let Some(release) = parse_release(&body) else {
        return UpdateCheck::Malformed {
            reason: "GitHub's response did not look like a release".to_string(),
        };
    };
    let Some(latest) = parse_semver(&release.tag) else {
        return UpdateCheck::Malformed {
            reason: format!("could not read a version out of \"{}\"", release.tag),
        };
    };
    let Some(cur) = parse_semver(current) else {
        // This build's own version failed to parse — not the network's
        // fault, but still a Malformed, never a false "up to date".
        return UpdateCheck::Malformed {
            reason: format!("could not read this build's own version (\"{current}\")"),
        };
    };
    if latest > cur {
        UpdateCheck::NewerAvailable {
            current: current.to_string(),
            latest: strip_v(&release.tag).to_string(),
            notes_url: release.notes_url,
        }
    } else {
        UpdateCheck::UpToDate { current: current.to_string() }
    }
}

/// The one real network call this feature makes, and only on a click —
/// never on a timer, never on launch (see the section banner above). A
/// `User-Agent` is not optional: GitHub's REST API 403s an anonymous
/// request that omits one. Ten seconds is generous for one small JSON
/// response over a real internet connection and short enough that a dead
/// network fails the click rather than hanging it.
fn fetch_latest_release() -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();
    agent
        .get(GITHUB_RELEASES_URL)
        .header("User-Agent", "clockwork-app")
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())
}

fn check_for_updates() -> UpdateCheck {
    evaluate_update(env!("CARGO_PKG_VERSION"), fetch_latest_release())
}

/// One line, for the tray's alert (`run_update_check`, below `mod tray`)
/// AND for `update_check_json`'s `"message"` field. Kept in exactly one
/// place so the two surfaces cannot describe the same outcome differently.
/// Carries no URL: Settings renders `notesUrl` as a real link
/// (`safeHttpsUrl` in `SettingsView.tsx`), and the tray appends the raw URL
/// itself, on its own line — an `alert()` has no concept of a link.
fn update_check_message(u: &UpdateCheck) -> String {
    match u {
        UpdateCheck::UpToDate { current } => format!("You're on the latest version ({current})."),
        UpdateCheck::NewerAvailable { current, latest, .. } => {
            format!("Clockwork {latest} is available — you're on {current}.")
        }
        UpdateCheck::NetworkError { reason } => format!("Couldn't reach GitHub to check for updates: {reason}"),
        UpdateCheck::Malformed { reason } => format!("GitHub answered, but the response didn't make sense: {reason}"),
    }
}

/// The `w.eval(...)` script `run_update_check` shows the result with.
/// Split out to be testable, the same reason `parse_status_line` is split
/// out of `http_get_status`: `mod tray` cannot be exercised from `cargo
/// test`. JSON string-encoding `text` is what makes this safe regardless
/// of what it contains — `text` can carry GitHub's own strings (a
/// release's tag, its notes URL) by the time it gets here, and a quote or
/// backslash in either must not be able to break out of the JS string
/// literal and run something else inside that `alert(...)` call.
fn update_alert_script(text: &str) -> String {
    let escaped = serde_json::to_string(text).unwrap_or_else(|_| "\"Update check failed.\"".to_string());
    format!("alert({escaped});")
}

/// The shape `SettingsView.tsx`'s `UpdateCheckCard` reads, over the IPC
/// grant described on `check_for_updates_command`. A `status` string
/// rather than an HTTP-style error,
/// because a network failure and a malformed response are both legitimate
/// ANSWERS to "did you check" — not IPC failures — so `invoke()` on the JS
/// side always resolves (when it resolves at all), and `status` carries
/// which of the four outcomes this is.
fn update_check_json(u: &UpdateCheck) -> serde_json::Value {
    let message = update_check_message(u);
    match u {
        UpdateCheck::UpToDate { current } => serde_json::json!({
            "status": "up_to_date",
            "current": current,
            "message": message,
        }),
        UpdateCheck::NewerAvailable { current, latest, notes_url } => serde_json::json!({
            "status": "newer_available",
            "current": current,
            "latest": latest,
            "notesUrl": notes_url,
            "message": message,
        }),
        UpdateCheck::NetworkError { .. } | UpdateCheck::Malformed { .. } => serde_json::json!({
            "status": "check_failed",
            "message": message,
        }),
    }
}

/// Registered in `run()` below, reachable from `cargo test` (Rust can call
/// any function directly), and — since T1-19 — reachable from
/// `SettingsView.tsx`'s "Check for updates" button. That last one needed a
/// capability file, and needed it to stay as small as the paragraphs below.
///
/// `run()`'s `setup` builds the main window on `WebviewUrl::External(
/// DAEMON_URL)` — the daemon-served UI at `http://127.0.0.1:4747`, not
/// this bundle's `frontendDist`. Tauri's own `is_local_url`
/// (tauri-2.11.5/src/webview/mod.rs:1698, read from the vendored source,
/// not assumed) tests three things: the `tauri://` protocol, a URL
/// *relative to* `get_app_url()` (which for this config is
/// `tauri://localhost`, because `frontendDist` here is a directory, not a
/// `FrontendDist::Url` — `manager/mod.rs:353`), and a registered custom URI
/// scheme. `http://127.0.0.1:4747` matches none of the three, so
/// `is_local` is `false` for this window on every navigation, which trips
/// `!is_local` in the IPC ACL gate (`webview/mod.rs:1823`) regardless of
/// `invoke.acl` — the "bare app command needs no capability" rule this
/// comment used to (wrongly) rely on only holds when `is_local` is true.
/// Tauri closed that door deliberately in 2.11.1, whose release notes file
/// it under security fixes: remote origins used to reach custom commands
/// with no manifest at all. The only way through it now is an explicit
/// grant, which is what T1-19 adds.
///
/// The grant is `capabilities/check-for-updates.json`, plus the permission
/// it names in `permissions/check-for-updates.json` (an app command has to
/// come from a permission file — `tauri-build`'s `validate_capabilities`
/// rejects any identifier that no manifest defines, and the app manifest is
/// built from `src-tauri/permissions/**/*`). It is the smallest grant that
/// works: one window (`main`), one origin (`remote.urls` is
/// `["http://127.0.0.1:4747"]`, `local` is `false`), one command, no
/// `core:default`. `the_ipc_grant_is_one_command_from_one_origin` below
/// asserts that through Tauri's own resolver rather than by reading the
/// files, so widening it fails a test rather than a review.
///
/// What makes the exception safe is this function's shape, not the
/// capability: no arguments, one hardcoded HTTPS URL, a version string
/// back. No filesystem, no shell, no token, no writes. The worst case is an
/// attacker who already controls the daemon-served page learning which
/// Clockwork version is current. `pairing_script`'s doc comment argues
/// against giving that page IPC in general and still holds — the token
/// still goes by injection, and the next command added here has to earn its
/// own line in the capability.
///
/// The line numbers above are real, read from `~/.cargo/registry/src/…/
/// tauri-2.11.5/`, not inferred from the public docs. Unaffected by any of
/// it: `run_update_check` below, which runs this same function natively
/// from the tray, no IPC involved.
///
/// The frontend calls this via `window.__TAURI_INTERNALS__.invoke(...)`
/// rather than `@tauri-apps/api` (absent from `packages/ui`'s
/// `package.json`, lockfile and `node_modules` — checked, not assumed —
/// and adding it was out of touch set); see `SettingsView.tsx`'s
/// `tauriInvoke` for that half. That choice is orthogonal to the ACL
/// question: the gate reads the PAGE'S ORIGIN, not how the call reaches
/// the bridge, so `@tauri-apps/api`'s `invoke()` was rejected before this
/// grant and is allowed after it, exactly like the internals call.
#[tauri::command]
fn check_for_updates_command() -> serde_json::Value {
    update_check_json(&check_for_updates())
}

#[cfg(desktop)]
mod tray {
    use super::*;
    use tauri::Manager;

    /// Show the window this shell already built, wherever it went.
    pub(super) fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }

    fn open_inbox<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
        show_main_window(app);
        if let Some(w) = app.get_webview_window("main") {
            // A hash assignment, not a navigation: the UI is a single page
            // that routes on `location.hash` (`packages/ui/src/App.tsx:35`),
            // so this changes the tab without a reload — and without a reload
            // the pairing script does not have to run again.
            let _ = w.eval("try{if(location.hash!=='#/inbox')location.hash='#/inbox';}catch(e){}");
        }
    }

    /// T1-6, tray half — see `ID_CHECK_UPDATES`'s doc comment for why this
    /// runs the check itself rather than opening Settings and asking the
    /// page to. Since T1-19 the page CAN reach
    /// `check_for_updates_command`, but the tray must answer with the
    /// window hidden and with the daemon down, and neither state has a
    /// Settings screen to ask.
    ///
    /// Off the main thread, the same shape `install()` already uses for
    /// `poll_loop`: `fetch_latest_release` is a blocking network call with
    /// a 10s timeout, and `on_menu_event` fires on the main event loop
    /// thread — blocking it for up to 10s on every click would freeze the
    /// whole app's UI for as long as the request takes, not just this menu.
    ///
    /// The window is shown FIRST, before the network call starts: `alert()`
    /// inside a hidden webview (this app hides rather than destroys its
    /// window on close — see `run()`'s `CloseRequested` handler) has
    /// nothing to show itself against, so a check that finished while the
    /// window was hidden would answer a question the user cannot see the
    /// answer to.
    fn run_update_check<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
        show_main_window(app);
        let app = app.clone();
        std::thread::spawn(move || {
            let outcome = check_for_updates();
            let mut text = update_check_message(&outcome);
            if let UpdateCheck::NewerAvailable { notes_url, .. } = &outcome {
                text.push('\n');
                text.push_str(notes_url);
            }
            let Some(w) = app.get_webview_window("main") else { return };
            // `w.eval` runs trusted, Rust-composed script in the ALREADY
            // OPEN webview — the same one-way channel `pairing_script` and
            // `diagnosis_script` already use. It is not the direction the
            // IPC ACL gate checks: that gate examines messages FROM the
            // page TO Rust (`webview/mod.rs`'s `on_message`), and this is
            // Rust telling the page something, not the page asking Rust
            // for anything, so none of the `check_for_updates_command`
            // rejection applies here.
            let _ = w.eval(&update_alert_script(&text));
        });
    }

    fn on_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
        match tray_action(id) {
            TrayAction::OpenWindow => show_main_window(app),
            TrayAction::OpenInbox => open_inbox(app),
            TrayAction::CheckForUpdates => run_update_check(app),
            // Quits the APP. The daemon is a LaunchAgent, so the scheduler and
            // anything running outlive this, which is what the label promises.
            TrayAction::Quit => app.exit(0),
            TrayAction::Ignore => {}
        }
    }

    /// Rebuild the native menu from the rendered lines.
    ///
    /// Safe from the poll thread: every `Menu`/`MenuItem` call marshals itself
    /// onto the main thread and blocks (`run_main_thread!`), and
    /// `send_user_message` runs inline when the caller already is the main
    /// thread — so this is correct from `setup` too.
    ///
    /// Returns whether the repaint landed, so a failed one is retried on the
    /// next poll instead of being recorded as painted.
    fn apply<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        tray: &tauri::tray::TrayIcon<R>,
        title: Option<&str>,
        lines: &[TrayLine],
    ) -> bool {
        let Ok(menu) = tauri::menu::Menu::new(app) else { return false };
        for line in lines {
            let appended = match line {
                TrayLine::Separator => tauri::menu::PredefinedMenuItem::separator(app)
                    .and_then(|i| menu.append(&i)),
                TrayLine::Info(text) => tauri::menu::MenuItem::new(app, text, false, None::<&str>)
                    .and_then(|i| menu.append(&i)),
                TrayLine::Action { id, label } => {
                    tauri::menu::MenuItem::with_id(app, id.as_str(), label, true, None::<&str>)
                        .and_then(|i| menu.append(&i))
                }
            };
            if appended.is_err() {
                return false; // a half-built menu is worse than the last good one
            }
        }
        tray.set_menu(Some(menu)).is_ok() && tray.set_title(title).is_ok()
    }

    /// Poll, render, and repaint only when the RENDERED text differs.
    ///
    /// Comparing the rendered lines rather than the raw counts is what keeps
    /// "in 4 min" honest: the counts do not change while a schedule waits, but
    /// the sentence about it does, once a minute. Comparing the counts is what
    /// gates the one expensive read — `/runs` is an unindexed sort over the
    /// whole table (`COALESCE` defeats `idx_runs_task_time`), so it runs when
    /// something actually happened and not otherwise.
    fn poll_loop<R: tauri::Runtime>(app: tauri::AppHandle<R>, tray: tauri::tray::TrayIcon<R>) {
        let mut last_counts: Option<TrayCounts> = None;
        let mut last_cause: Option<String> = None;
        let mut recent: Vec<RecentRun> = Vec::new();
        let mut painted: Option<(Option<String>, Vec<TrayLine>)> = None;
        loop {
            let now = now_ms();
            let state = read_tray_state(&mut last_cause);
            let counts = match &state {
                TrayState::Up(c) | TrayState::Unpaired(c) => Some(c.clone()),
                TrayState::Down { .. } => None,
            };
            if counts != last_counts {
                match &state {
                    // A failed read leaves the old list and does NOT record
                    // the new counts, so the next poll tries again.
                    TrayState::Up(_) => {
                        if let Some(list) = fetch_recent_runs(now) {
                            recent = list;
                            last_counts = counts;
                        }
                    }
                    // Down or unpaired: no list at all beats a stale one.
                    _ => {
                        recent = Vec::new();
                        last_counts = counts;
                    }
                }
            }
            let next = (tray_title(&state), tray_lines(&state, &recent, now));
            if painted.as_ref() != Some(&next) && apply(&app, &tray, next.0.as_deref(), &next.1) {
                painted = Some(next);
            }
            std::thread::sleep(TRAY_POLL);
        }
    }

    pub(super) fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
        let mut builder = tauri::tray::TrayIconBuilder::with_id(TRAY_ID)
            .tooltip("Clockwork")
            .on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
        // The app icon, in raw RGBA, is already in the binary — tauri-codegen
        // bakes `icons/32x32.png` as `default_window_icon` on every non-Windows
        // target (tauri-codegen-2.6.3/src/context.rs:232). No new asset, and no
        // `image-png` feature to decode one at runtime. Not marked as a
        // template image: the app icon is colour, and template mode would
        // flatten it to a silhouette.
        if let Some(icon) = app.default_window_icon().cloned() {
            builder = builder.icon(icon);
        }
        let tray = builder.build(app)?;
        apply(app, &tray, None, &starting_lines());
        let handle = app.clone();
        std::thread::spawn(move || poll_loop(handle, tray));
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_daemon();
    tauri::Builder::default()
        // T1-6. The only command this shell exposes over IPC today.
        .invoke_handler(tauri::generate_handler![check_for_updates_command])
        .setup(|app| {
            // The window used to carry `url: http://127.0.0.1:4747` in
            // tauri.conf.json, which meant a dead daemon produced a WHITE
            // EMPTY WINDOW: the webview had no document, the bundled
            // frontendDist was never consulted because an absolute `url`
            // overrides it, and the daemon-down notice the UI carries could
            // not appear — that notice is served BY the daemon, so it exists
            // only once the thing it reports on is already working.
            //
            // Deciding the URL here instead keeps the happy path identical
            // (straight to the daemon, no flash of a placeholder) and gives
            // the failure an explanation the user can act on.
            let up = daemon_up();
            let url = if up {
                tauri::WebviewUrl::External(DAEMON_URL.parse().expect("valid daemon url"))
            } else {
                tauri::WebviewUrl::App("daemon-down.html".into())
            };
            let mut builder = tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("Clockwork")
                .inner_size(1280.0, 820.0)
                .min_inner_size(940.0, 600.0);
            // Pairing goes in whether or not the daemon is up right now.
            // daemon-down.html navigates to the daemon as soon as the port
            // answers, and that navigation is where the token is needed; the
            // origin guard inside the script is what makes it safe to always
            // carry. Injecting it only on the happy path meant a cold start
            // slower than the ~6s wait below ended on the paste screen.
            if let Some(token) = api_token() {
                builder = builder.initialization_script(&pairing_script(&token));
            }
            if !up {
                builder = builder.initialization_script(&diagnosis_script(&diagnosis()));
            }
            #[cfg(not(desktop))]
            builder.build()?;
            // CLOSE-TO-TRAY (T4-3). The red button now HIDES the window; it
            // used to destroy it, and destroying the last window ends the
            // process, which would take the tray with it — a menu bar item
            // that vanishes the moment you close the window is not a menu bar
            // item. So this is a deliberate change of behaviour, and the
            // smallest one that makes the surface exist.
            //
            // Quit is untouched: ⌘Q and the app menu still end the process,
            // because they raise ExitRequested rather than CloseRequested and
            // nothing here intercepts that. What quitting does NOT do is stop
            // the scheduler — launchd owns the daemon (`ensure_launch_agent`),
            // so tonight's runs survive both the close and the quit. The tray's
            // Quit item says so out loud, since the fear is reasonable and
            // otherwise unanswered.
            //
            // The Dock icon stays. An app that keeps running with no window
            // and no Dock presence is the surprising one; leaving it there
            // means "still running" is visible in two places, and the Reopen
            // handler below makes clicking it bring the window back.
            #[cfg(desktop)]
            {
                let window = builder.build()?;
                let hidden = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hidden.hide();
                    }
                });
                tray::install(app.handle())?;
            }
            Ok(())
        })
        // `.build().run(closure)` rather than `.run(context)`: the closure is
        // the only place RunEvent::Reopen is observable, and Reopen is what a
        // Dock click sends when every window is hidden.
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(all(desktop, target_os = "macos"))]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = _event {
                if !has_visible_windows {
                    tray::show_main_window(_app);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_script_escapes_the_token() {
        // base64url tokens carry no quotes, but the script is built by string
        // formatting and a token that did would break out of the literal.
        let js = pairing_script("a\"b\\c");
        assert!(js.contains(r#""a\"b\\c""#), "token must be JSON-escaped: {js}");
    }

    #[test]
    fn pairing_script_targets_the_key_the_ui_reads() {
        // packages/ui/src/api.ts: TOKEN_KEY = 'clockwork.token'.
        assert!(pairing_script("tok").contains("'clockwork.token'"));
    }


    #[test]
    fn diagnosis_is_json_the_page_can_read() {
        let d = diagnosis();
        let v: serde_json::Value = serde_json::from_str(&d).expect("diagnosis must be JSON");
        assert!(v.get("cause").and_then(|c| c.as_str()).is_some());
        assert!(v.get("logPath").and_then(|c| c.as_str()).is_some());
        assert_eq!(v.get("bundled").and_then(|b| b.as_bool()), Some(false), "the test binary is not a bundle");
    }

    #[test]
    fn diagnosis_names_the_dev_build_rather_than_blaming_launchd() {
        // Running unbundled, the honest cause is "this is a development
        // build", not "the service is not registered" — the old page's
        // failure was exactly this kind of confident wrong explanation.
        let v: serde_json::Value = serde_json::from_str(&diagnosis()).unwrap();
        assert_eq!(
            v["cause"], "this is a development build, which does not carry a daemon",
        );
    }

    #[test]
    fn diagnosis_script_defines_the_global_the_page_reads() {
        let js = diagnosis_script("{\"cause\":\"x\"}");
        assert!(js.starts_with("window.__CLOCKWORK_DIAGNOSIS__ = {"));
        assert!(js.ends_with(";"));
    }


    #[test]
    fn parses_a_plist_that_launchd_normalized() {
        // Not the spelling `plistXml` emits: tab-indented, keys alphabetized,
        // key and string on separate lines. This is what the installed file
        // actually looked like on a real machine, and the old comment claiming
        // the shape is fixed was wrong about it.
        let xml = "<dict>\n\t<key>KeepAlive</key>\n\t<true/>\n\t<key>Label</key>\n\t<string>com.clockwork.daemon</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/Applications/Clockwork.app/Contents/MacOS/node</string>\n\t\t<string>/Applications/Clockwork.app/Contents/Resources/app/packages/daemon/dist/main.js</string>\n\t</array>\n</dict>";
        assert_eq!(
            parse_agent_node_path(xml).as_deref(),
            Some("/Applications/Clockwork.app/Contents/MacOS/node"),
        );
    }

    #[test]
    fn parses_the_shape_cli_ts_actually_writes() {
        let xml = "<dict>\n  <key>Label</key><string>com.clockwork.daemon</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/A/Clockwork.app/Contents/MacOS/node</string>\n    <string>/A/main.js</string>\n  </array>\n</dict>";
        assert_eq!(parse_agent_node_path(xml).as_deref(), Some("/A/Clockwork.app/Contents/MacOS/node"));
    }

    #[test]
    fn does_not_mistake_the_label_for_the_first_program_argument() {
        // Label comes FIRST in the file cli.ts writes, and it is a <string>.
        let xml = "<key>Label</key><string>com.clockwork.daemon</string>\
<key>ProgramArguments</key><array><string>/n/node</string></array>";
        assert_eq!(parse_agent_node_path(xml).as_deref(), Some("/n/node"));
    }

    #[test]
    fn a_plist_without_program_arguments_is_none_not_a_guess() {
        assert_eq!(parse_agent_node_path("<dict><key>Label</key><string>x</string></dict>"), None);
        assert_eq!(parse_agent_node_path(""), None);
    }

    #[test]
    fn the_last_failure_in_the_log_wins_not_the_first() {
        // One file accumulates every crash since install, so a 25-line tail can
        // straddle two eras. Naming the older one sends the reader to file a
        // bug about a native module that is fine.
        let tail = "Error: NODE_MODULE_VERSION 137 requires 147\nrestarting\nError: listen EADDRINUSE 127.0.0.1:4747";
        assert_eq!(last_marker(tail), Some("EADDRINUSE"));
        let other = "Error: listen EADDRINUSE\nrestarting\nError: NODE_MODULE_VERSION 137";
        assert_eq!(last_marker(other), Some("NODE_MODULE_VERSION"));
        assert_eq!(last_marker("nothing familiar here"), None);
    }

    #[test]
    fn the_pairing_script_only_writes_on_the_daemon_origin() {
        // A WKUserScript re-runs on every navigation, including one to a remote
        // origin. Without this guard the token would be written into whatever
        // origin the window reached.
        let js = pairing_script("tok");
        assert!(js.contains("location.origin===\"http://127.0.0.1:4747\""), "{js}");
        assert!(js.contains("localStorage.setItem('clockwork.token'"), "{js}");
    }

    #[test]
    fn bundle_is_none_outside_an_app_bundle() {
        // The dev binary lives in target/debug, not Contents/MacOS, so the
        // unbundled fallback is what runs — this is the guard that keeps
        // `tauri dev` working.
        assert!(bundle().is_none());
    }

    #[test]
    fn bundle_paths_hang_off_the_executable() {
        let exe = std::path::Path::new("/Apps/Clockwork.app/Contents/MacOS/Clockwork");
        let macos = exe.parent().unwrap();
        assert_eq!(macos.join("node"), std::path::Path::new("/Apps/Clockwork.app/Contents/MacOS/node"));
        assert_eq!(
            macos.parent().unwrap().join("Resources").join("app").join("packages").join("daemon").join("dist").join("main.js"),
            std::path::Path::new("/Apps/Clockwork.app/Contents/Resources/app/packages/daemon/dist/main.js")
        );
    }

    /// The bug: a correct plist and a registered job are different facts, and
    /// the old code only ever checked the first. Booting the agent out leaves
    /// the file untouched, so it kept returning "nothing to do" while no
    /// daemon existed.
    #[test]
    fn a_forgotten_job_with_a_correct_plist_is_bootstrapped_not_ignored() {
        let want = "/Applications/Clockwork.app/Contents/MacOS/node";
        assert_eq!(
            agent_action(Some(want), want, false),
            AgentAction::Bootstrap,
            "plist already names this bundle, so re-installing is wasteful — but it must still be LOADED",
        );
    }

    #[test]
    fn a_correct_plist_launchd_already_holds_is_left_alone() {
        let want = "/Applications/Clockwork.app/Contents/MacOS/node";
        assert_eq!(agent_action(Some(want), want, true), AgentAction::Nothing);
    }

    #[test]
    fn a_plist_naming_another_node_is_reinstalled_even_when_loaded() {
        // The moved-bundle case: launchd is happily running a job whose Node
        // no longer exists at that path. Loaded is not the same as correct.
        assert_eq!(
            agent_action(
                Some("/Users/me/Downloads/Clockwork.app/Contents/MacOS/node"),
                "/Applications/Clockwork.app/Contents/MacOS/node",
                true,
            ),
            AgentAction::Install,
        );
    }

    #[test]
    fn no_plist_at_all_is_an_install() {
        assert_eq!(
            agent_action(None, "/Applications/Clockwork.app/Contents/MacOS/node", false),
            AgentAction::Install,
        );
        // Even if launchd somehow claims the label, an unreadable or missing
        // plist means we cannot prove it points here — write the one we want.
        assert_eq!(
            agent_action(None, "/Applications/Clockwork.app/Contents/MacOS/node", true),
            AgentAction::Install,
        );
    }

    // -----------------------------------------------------------------------
    // T4-3 — the tray. None of the native surface is reachable from here, so
    // everything that decides WHAT the tray says is a value and is tested;
    // what remains untested is the drawing, and only the drawing.
    // -----------------------------------------------------------------------

    /// A real `/widget/snapshot` body (packages/daemon/src/api.ts:2389).
    const SNAPSHOT: &str = r#"{"runsToday":4,"needsYou":2,"recentReports":3,
        "nextRun":{"next_fire":1757500000000,"name":"Weekly dep triage"},"paused":false}"#;
    /// A real `/health` body (packages/daemon/src/api.ts:765).
    const HEALTH: &str = r#"{"ok":true,"apiVersion":3,"daemonVersion":"0.11.2",
        "installedVersion":"0.11.2","versionSkew":false,"paused":false,
        "activeRuns":1,"queuedRuns":2,"nextFire":1757500000000}"#;

    fn labels(lines: &[TrayLine]) -> Vec<String> {
        lines
            .iter()
            .map(|l| match l {
                TrayLine::Separator => "---".to_string(),
                TrayLine::Info(t) => t.clone(),
                TrayLine::Action { label, .. } => label.clone(),
            })
            .collect()
    }

    fn up(needs_you: u64, running: u64) -> TrayState {
        TrayState::Up(TrayCounts { needs_you, running, ..TrayCounts::default() })
    }

    #[test]
    fn health_carries_the_running_count_the_snapshot_does_not() {
        // The reason the tray reads two routes. `/widget/snapshot` has
        // `runsToday`, which counts runs BOOKED today — not runs in flight.
        let c = parse_health(HEALTH).expect("health must parse");
        assert_eq!(c.running, 1);
        assert_eq!(c.queued, 2);
        assert_eq!(c.next_fire, Some(1_757_500_000_000));
        assert!(!c.paused);
        assert_eq!(c.needs_you, 0, "health cannot know this; it must not invent it");
    }

    #[test]
    fn the_snapshot_supplies_needs_you_and_the_name_of_the_next_fire() {
        let mut c = parse_health(HEALTH).unwrap();
        assert!(merge_snapshot(&mut c, SNAPSHOT));
        assert_eq!(c.needs_you, 2);
        assert_eq!(c.next_name.as_deref(), Some("Weekly dep triage"));
        assert_eq!(c.next_fire, Some(1_757_500_000_000));
        assert_eq!(c.running, 1, "the health counts must survive the merge");
    }

    #[test]
    fn a_snapshot_with_no_next_run_clears_the_name() {
        let mut c = TrayCounts { next_name: Some("stale".into()), ..TrayCounts::default() };
        assert!(merge_snapshot(&mut c, r#"{"needsYou":0,"nextRun":null,"paused":false}"#));
        assert_eq!(c.next_name, None);
        assert_eq!(next_line(&c, 0), "Next: nothing scheduled");
    }

    #[test]
    fn an_unauthorized_body_is_not_a_snapshot() {
        // The failure this guards: the auth hook answers with
        // `{"error":"unauthorized"}` (api.ts:634), which is valid JSON. A
        // parser that defaulted the missing counts to zero would render
        // "Nothing needs you" over a full approval queue.
        let mut c = parse_health(HEALTH).unwrap();
        assert!(!merge_snapshot(&mut c, r#"{"error":"unauthorized"}"#));
        assert!(!merge_snapshot(&mut c, "<html>nope</html>"));
        assert_eq!(c.needs_you, 0, "left untouched, and the caller must go Unpaired");
    }

    #[test]
    fn the_parsers_read_the_bodies_a_live_daemon_actually_sent() {
        // Captured verbatim from clockworkd 0.11.2 on 2026-09-10 by writing the
        // exact bytes `http_get_status` writes to 127.0.0.1:4747. The constants
        // above are hand-built and could drift from the daemon; these cannot.
        // A fresh install is the shape they show — no runs, no approvals — and
        // that is the shape a first launch has to render without inventing
        // anything.
        let health = r#"{"ok":true,"apiVersion":1,"daemonVersion":"0.11.2","installedVersion":"0.11.2","versionSkew":false,"paused":false,"activeRuns":0,"queuedRuns":0,"nextFire":null}"#;
        let snapshot = r#"{"runsToday":0,"needsYou":0,"recentReports":0,"nextRun":null,"paused":false}"#;
        let mut c = parse_health(health).expect("the live /health body must parse");
        assert!(merge_snapshot(&mut c, snapshot), "the live snapshot must parse");
        assert_eq!(c, TrayCounts::default(), "a fresh install is all zeroes and no next fire");
        let state = TrayState::Up(c);
        assert_eq!(tray_title(&state), None, "an idle install wears no badge");
        assert_eq!(
            labels(&tray_lines(&state, &parse_recent_runs("[]", TRAY_RECENT, 0), 0)),
            vec![
                "Nothing needs you",
                "Nothing running",
                "Next: nothing scheduled",
                "---",
                "No runs yet",
                "---",
                "Open Inbox",
                "Open Clockwork",
                // T1-6: added below "Open Clockwork" and above Quit in every
                // tray state — see the ID_CHECK_UPDATES doc comment.
                "Check for updates…",
                "Quit Clockwork (scheduled runs continue)",
            ],
        );
    }

    #[test]
    fn parse_status_line_reads_the_code_and_refuses_garbage() {
        assert_eq!(parse_status_line("HTTP/1.1 200 OK\r\nContent-Type: x"), Some(200));
        assert_eq!(parse_status_line("HTTP/1.0 401 Unauthorized"), Some(401));
        assert_eq!(parse_status_line("garbage"), None);
        assert_eq!(parse_status_line(""), None);
    }

    #[test]
    fn a_daemon_that_is_down_says_so_and_says_why() {
        // The state daemon-down.html was built for, on the surface where it is
        // first noticed. Not a stale count, not an empty menu.
        let state = TrayState::Down { cause: "another process already holds 127.0.0.1:4747".into() };
        assert_eq!(tray_title(&state).as_deref(), Some("⚠ offline"));
        let lines = labels(&tray_lines(&state, &[], 0));
        assert!(lines.iter().any(|l| l.contains("background service is down")), "{lines:?}");
        assert!(
            lines.iter().any(|l| l.contains("another process already holds 127.0.0.1:4747")),
            "the cause from `diagnosis` must reach the menu: {lines:?}",
        );
        assert!(lines.len() >= 4, "never an empty menu: {lines:?}");
        // No counts at all — a number here would be last poll's, and last
        // poll's number is the lie this state exists to avoid.
        assert!(
            !lines.iter().any(|l| l.contains("need you") || l.contains("in progress") || l.contains("Next:")),
            "{lines:?}",
        );
    }

    #[test]
    fn a_dead_daemon_does_not_promise_that_runs_continue() {
        // The happy-path Quit label is a true statement about launchd. Repeated
        // while launchd is not running the daemon, it is a false one.
        let down = tray_lines(&TrayState::Down { cause: "x".into() }, &[], 0);
        assert!(labels(&down).contains(&"Quit Clockwork".to_string()), "{:?}", labels(&down));
        let alive = tray_lines(&up(0, 0), &[], 0);
        assert!(
            labels(&alive).contains(&"Quit Clockwork (scheduled runs continue)".to_string()),
            "{:?}",
            labels(&alive),
        );
    }

    #[test]
    fn an_unpaired_shell_says_approvals_are_unknown_not_zero() {
        // No token on disk yet. `/health` is open, so the running count is
        // real; the approval count is not knowable and must not read as none.
        let state = TrayState::Unpaired(parse_health(HEALTH).unwrap());
        assert_eq!(tray_title(&state).as_deref(), Some("⚠ ?"));
        let lines = labels(&tray_lines(&state, &[], 0));
        assert!(lines.iter().any(|l| l.contains("approvals unknown")), "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("1 run in progress")), "{lines:?}");
        assert!(!lines.iter().any(|l| l.contains("Nothing needs you")), "{lines:?}");
    }

    #[test]
    fn the_needs_you_badge_outranks_the_running_count_and_the_pause() {
        // Ordered by what is waiting on a HUMAN. Only the first one is.
        assert_eq!(tray_title(&up(2, 3)).as_deref(), Some("⚠ 2"));
        assert_eq!(tray_title(&up(0, 3)).as_deref(), Some("▶ 3"));
        let paused = TrayState::Up(TrayCounts { paused: true, ..TrayCounts::default() });
        assert_eq!(tray_title(&paused).as_deref(), Some("⏸"));
    }

    #[test]
    fn an_idle_clockwork_shows_no_title_at_all() {
        // So that any text beside the icon means something changed.
        assert_eq!(tray_title(&up(0, 0)), None);
    }

    #[test]
    fn the_needs_you_line_is_itself_the_jump_to_the_inbox() {
        let lines = tray_lines(&up(1, 0), &[], 0);
        match &lines[0] {
            TrayLine::Action { id, label } => {
                assert_eq!(id, ID_INBOX);
                assert_eq!(label, "⚠ 1 approval needs you");
            }
            other => panic!("the first line must be actionable when someone is waiting: {other:?}"),
        }
        // And plain text when it is not, so a click cannot land on nothing.
        assert_eq!(tray_lines(&up(0, 0), &[], 0)[0], TrayLine::Info("Nothing needs you".into()));
    }

    #[test]
    fn the_menu_lists_the_last_three_runs_and_a_jump_to_the_inbox() {
        let now = 1_757_500_000_000;
        let recent = vec![
            RecentRun { name: "Dep triage".into(), state: "completed".into(), at: Some(now - 600_000) },
            RecentRun { name: "Docs drift".into(), state: "failed".into(), at: Some(now - 7_200_000) },
            RecentRun { name: "Flaky sweep".into(), state: "running".into(), at: Some(now - 30_000) },
        ];
        let lines = labels(&tray_lines(&up(0, 1), &recent, now));
        assert!(lines.iter().any(|l| l == "✓ Dep triage · 10 min ago"), "{lines:?}");
        assert!(lines.iter().any(|l| l == "✗ Docs drift · 2 hr ago"), "{lines:?}");
        assert!(lines.iter().any(|l| l == "▶ Flaky sweep · less than a minute ago"), "{lines:?}");
        assert!(lines.iter().any(|l| l == "Open Inbox"), "{lines:?}");
        // An empty history says so rather than leaving a gap.
        assert!(labels(&tray_lines(&up(0, 0), &[], now)).iter().any(|l| l == "No runs yet"));
    }

    #[test]
    fn a_future_booking_is_not_a_recent_run() {
        // `RunRepo.list` orders by COALESCE(scheduled_for, state_changed_at)
        // DESC (repo.ts:322), so a row scheduled for next week sorts ABOVE
        // everything that has actually happened. Printed under "recent" it
        // reads as "your last run was next Tuesday".
        let now = 1_757_500_000_000;
        let body = format!(
            r#"[{{"id":"r1","state":"scheduled","scheduled_for":{},"state_changed_at":{},"jobspec_json":"{{\"taskName\":\"Next week\"}}"}},
                {{"id":"r2","state":"completed","scheduled_for":{},"ended_at":{},"jobspec_json":"{{\"taskName\":\"Yesterday\"}}"}}]"#,
            now + 7 * 86_400_000,
            now,
            now - 86_400_000,
            now - 86_000_000,
        );
        let runs = parse_recent_runs(&body, TRAY_RECENT, now);
        assert_eq!(runs.len(), 1, "the booking must not appear: {runs:?}");
        assert_eq!(runs[0].name, "Yesterday");
    }

    #[test]
    fn a_queued_run_is_recent_because_it_is_the_newest_thing_that_happened() {
        // The filter is on the CLOCK, not on a state blacklist: `queued` rows
        // are written with scheduled_for = now (run-manager.ts:1082), and a
        // run you just booked is exactly what you want to see.
        let now = 1_757_500_000_000;
        let body = format!(
            r#"[{{"id":"r1","state":"queued","scheduled_for":{now},"state_changed_at":{now},"jobspec_json":"{{\"taskName\":\"Just booked\"}}"}}]"#,
        );
        let runs = parse_recent_runs(&body, TRAY_RECENT, now);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].name, "Just booked");
    }

    #[test]
    fn a_run_takes_its_name_from_the_jobspec_and_never_goes_blank() {
        let now = 1_757_500_000_000;
        let body = r#"[{"id":"r1","state":"completed","jobspec_json":"{}","state_changed_at":1},
                       {"id":"r2","state":"completed","jobspec_json":"not json","state_changed_at":2},
                       {"id":"r3","state":"completed","state_changed_at":3}]"#;
        let runs = parse_recent_runs(body, 9, now);
        assert_eq!(runs.len(), 3);
        assert!(runs.iter().all(|r| r.name == "(task)"), "{runs:?}");
        // And the timestamp falls back through ended_at → started_at → state_changed_at.
        assert_eq!(runs[0].at, Some(1));
        // A body that is not a list of runs yields nothing, never a panic.
        assert!(parse_recent_runs(r#"{"error":"unauthorized"}"#, 3, now).is_empty());
        assert!(parse_recent_runs("", 3, now).is_empty());
    }

    #[test]
    fn only_three_runs_however_many_come_back() {
        let now = 1_757_500_000_000;
        let rows: Vec<String> = (0..TRAY_RUNS_LIMIT)
            .map(|i| format!(r#"{{"id":"r{i}","state":"completed","state_changed_at":{i},"jobspec_json":"{{}}"}}"#))
            .collect();
        let runs = parse_recent_runs(&format!("[{}]", rows.join(",")), TRAY_RECENT, now);
        assert_eq!(runs.len(), TRAY_RECENT);
    }

    #[test]
    fn human_delta_crosses_the_minute_hour_and_day_boundaries() {
        assert_eq!(human_delta(0), "less than a minute");
        assert_eq!(human_delta(59_999), "less than a minute");
        assert_eq!(human_delta(60_000), "1 min");
        assert_eq!(human_delta(59 * 60_000), "59 min");
        assert_eq!(human_delta(3_600_000), "1 hr");
        assert_eq!(human_delta(23 * 3_600_000), "23 hr");
        assert_eq!(human_delta(86_400_000), "1 day");
        assert_eq!(human_delta(3 * 86_400_000), "3 days");
        // A clock that ran backwards must not print a negative distance.
        assert_eq!(human_delta(-5_000), "less than a minute");
        assert_eq!(in_future(100, 200), "due now");
        assert_eq!(in_past(200, 100), "just now");
    }

    #[test]
    fn a_paused_scheduler_does_not_advertise_a_next_fire() {
        // `next_fire` is still populated while paused, and it will not fire.
        // Printing "Next: in 4 min" over a paused scheduler is a wrong promise.
        let c = TrayCounts {
            paused: true,
            next_fire: Some(1_000_000),
            next_name: Some("Weekly dep triage".into()),
            ..TrayCounts::default()
        };
        assert_eq!(next_line(&c, 0), "⏸ Scheduling is paused");
        let running = TrayCounts { next_fire: Some(240_000), ..TrayCounts::default() };
        assert_eq!(next_line(&running, 0), "Next: in 4 min");
        let named = TrayCounts { next_name: Some("Dep triage".into()), ..running.clone() };
        assert_eq!(next_line(&named, 0), "Next: Dep triage in 4 min");
    }

    #[test]
    fn the_running_line_counts_runs_and_the_queue_behind_them() {
        assert_eq!(running_line(&TrayCounts::default()), "Nothing running");
        assert_eq!(running_line(&TrayCounts { running: 1, ..TrayCounts::default() }), "▶ 1 run in progress");
        assert_eq!(
            running_line(&TrayCounts { running: 2, queued: 3, ..TrayCounts::default() }),
            "▶ 2 runs in progress · 3 queued",
        );
        assert_eq!(running_line(&TrayCounts { queued: 1, ..TrayCounts::default() }), "Nothing running · 1 queued");
    }

    #[test]
    fn every_clickable_line_in_every_state_maps_to_an_action() {
        // The failure this catches is a menu item that does nothing when
        // clicked, which is indistinguishable from a hung app.
        let now = 1_757_500_000_000;
        let recent = vec![RecentRun { name: "x".into(), state: "completed".into(), at: Some(now) }];
        let states = [
            TrayState::Down { cause: "x".into() },
            TrayState::Unpaired(TrayCounts::default()),
            up(2, 1),
        ];
        let mut menus: Vec<Vec<TrayLine>> = states
            .iter()
            .map(|s| tray_lines(s, &recent, now))
            .collect();
        menus.push(starting_lines());
        for menu in &menus {
            assert!(!menu.is_empty(), "no state may render an empty menu");
            for line in menu {
                if let TrayLine::Action { id, label } = line {
                    assert_ne!(tray_action(id), TrayAction::Ignore, "dead menu item: {label} ({id})");
                }
            }
            // Every state offers a way out of the app and a way into it.
            let ids: Vec<&str> = menu
                .iter()
                .filter_map(|l| match l {
                    TrayLine::Action { id, .. } => Some(id.as_str()),
                    _ => None,
                })
                .collect();
            assert!(ids.contains(&ID_OPEN), "{ids:?}");
            assert!(ids.contains(&ID_QUIT), "{ids:?}");
        }
    }

    #[test]
    fn a_run_row_opens_the_inbox_and_an_unknown_id_does_nothing() {
        assert_eq!(tray_action(ID_QUIT), TrayAction::Quit);
        assert_eq!(tray_action(ID_OPEN), TrayAction::OpenWindow);
        assert_eq!(tray_action(ID_INBOX), TrayAction::OpenInbox);
        assert_eq!(tray_action("tray.run.2"), TrayAction::OpenInbox);
        assert_eq!(tray_action("something.else"), TrayAction::Ignore);
    }

    #[test]
    fn the_glyph_column_covers_every_state_the_fsm_can_reach() {
        // packages/shared/src/states.ts:5 — RUN_STATES. A state with no glyph
        // falls to "·", which is fine, but a terminal FAILURE that renders as
        // a neutral dot is not.
        for s in ["failed", "timed_out", "budget_exceeded"] {
            assert_eq!(state_glyph(s), "✗", "{s}");
        }
        assert_eq!(state_glyph("completed"), "✓");
        assert_eq!(state_glyph("waiting_approval"), "⚠");
        assert_eq!(state_glyph("running"), "▶");
        assert_eq!(state_glyph("scheduled"), "·");
    }

    // -----------------------------------------------------------------------
    // T1-6 — "check for updates". `evaluate_update` is where every honesty
    // requirement lives, so it is what these tests drive, never the network.
    // -----------------------------------------------------------------------

    /// A trimmed but real shape: GitHub's actual `/releases/latest` body
    /// carries dozens of fields (`assets`, `author`, `draft`, `prerelease`,
    /// `published_at`, …); `parse_release` must read its two fields out of
    /// the real document, not a hand-built stub that only ever has them.
    fn release_body(tag: &str) -> String {
        format!(
            r#"{{"url":"https://api.github.com/repos/vimoxshah/clockwork/releases/1","html_url":"https://github.com/vimoxshah/clockwork/releases/tag/{tag}","tag_name":"{tag}","name":"Clockwork {tag}","draft":false,"prerelease":false,"created_at":"2026-09-10T00:00:00Z","published_at":"2026-09-10T00:05:00Z","assets":[],"body":"Release notes go here."}}"#
        )
    }

    #[test]
    fn parse_semver_reads_major_minor_patch_and_strips_a_leading_v() {
        assert_eq!(parse_semver("0.11.2"), Some(SemVer(0, 11, 2)));
        assert_eq!(parse_semver("v0.11.2"), Some(SemVer(0, 11, 2)));
        assert_eq!(parse_semver("V1.0.0"), Some(SemVer(1, 0, 0)));
    }

    #[test]
    fn parse_semver_rejects_anything_that_is_not_exactly_three_numbers() {
        assert_eq!(parse_semver(""), None);
        assert_eq!(parse_semver("v1"), None, "one component");
        assert_eq!(parse_semver("1.2"), None, "two components");
        assert_eq!(parse_semver("1.2.3.4"), None, "four components");
        assert_eq!(parse_semver("1.2.x"), None, "non-numeric component");
        assert_eq!(parse_semver("1..3"), None, "empty component");
        assert_eq!(parse_semver("1.2.3-beta"), None, "pre-release suffix");
    }

    #[test]
    fn semver_orders_numerically_not_lexically() {
        // The exact case the acceptance criteria names: "0.9.0" sorts ABOVE
        // "0.11.2" as strings (the '9' vs '1' first-differing byte), which is
        // precisely the bug a naive string compare would ship.
        assert!(SemVer(0, 9, 0) < SemVer(0, 11, 2), "numeric compare must not read minor as a string");
        assert!("0.9.0" > "0.11.2", "sanity check: string compare really does get this backwards");
    }

    #[test]
    fn a_lexically_smaller_but_numerically_newer_version_is_reported_as_newer() {
        // 0.9.0 running against a github tag of 0.11.2 — the exact pair the
        // acceptance criteria names. A string compare says "0.9.0" > "0.11.2"
        // and this must not agree with it.
        let outcome = evaluate_update("0.9.0", Ok(release_body("v0.11.2")));
        assert_eq!(
            outcome,
            UpdateCheck::NewerAvailable {
                current: "0.9.0".to_string(),
                latest: "0.11.2".to_string(),
                notes_url: "https://github.com/vimoxshah/clockwork/releases/tag/v0.11.2".to_string(),
            },
        );
    }

    #[test]
    fn an_equal_version_is_reported_up_to_date_not_silently() {
        let outcome = evaluate_update("0.11.2", Ok(release_body("v0.11.2")));
        assert_eq!(outcome, UpdateCheck::UpToDate { current: "0.11.2".to_string() });
        // The wording must SAY checked-and-current, never say nothing.
        let json = update_check_json(&outcome);
        assert_eq!(json["status"], "up_to_date");
        assert!(json["message"].as_str().unwrap().to_lowercase().contains("latest"), "{json}");
    }

    #[test]
    fn a_local_build_ahead_of_the_latest_tag_is_also_up_to_date() {
        // A dev build newer than the last published tag must not claim a
        // release "newer" than itself exists.
        let outcome = evaluate_update("0.12.0", Ok(release_body("v0.11.2")));
        assert_eq!(outcome, UpdateCheck::UpToDate { current: "0.12.0".to_string() });
    }

    #[test]
    fn a_network_failure_is_reported_as_failed_never_as_up_to_date() {
        let outcome = evaluate_update("0.11.2", Err("connection refused".to_string()));
        assert_eq!(outcome, UpdateCheck::NetworkError { reason: "connection refused".to_string() });
        // This is the honesty requirement stated directly: a failed check
        // must never render as "you are up to date" — the
        // `sleptThroughKeepAwake: false` class of bug.
        let json = update_check_json(&outcome);
        assert_ne!(json["status"], "up_to_date", "{json}");
        assert_eq!(json["status"], "check_failed");
        assert!(json["message"].as_str().unwrap().contains("connection refused"), "{json}");
    }

    #[test]
    fn a_response_that_is_not_json_is_malformed_never_up_to_date() {
        let outcome = evaluate_update("0.11.2", Ok("<html>rate limited</html>".to_string()));
        assert_eq!(
            outcome,
            UpdateCheck::Malformed { reason: "GitHub's response did not look like a release".to_string() },
        );
        assert_ne!(update_check_json(&outcome)["status"], "up_to_date");
    }

    #[test]
    fn a_response_missing_tag_name_or_notes_url_is_malformed() {
        let no_tag = evaluate_update("0.11.2", Ok(r#"{"html_url":"https://x"}"#.to_string()));
        assert!(matches!(no_tag, UpdateCheck::Malformed { .. }), "{no_tag:?}");
        let no_url = evaluate_update("0.11.2", Ok(r#"{"tag_name":"v0.12.0"}"#.to_string()));
        assert!(matches!(no_url, UpdateCheck::Malformed { .. }), "{no_url:?}");
    }

    #[test]
    fn a_tag_that_is_not_a_version_is_malformed_not_a_crash() {
        let outcome = evaluate_update("0.11.2", Ok(release_body("latest")));
        assert!(matches!(outcome, UpdateCheck::Malformed { .. }), "{outcome:?}");
    }

    #[test]
    fn parse_release_reads_the_two_fields_out_of_a_realistic_github_body() {
        let release = parse_release(&release_body("v0.11.3")).expect("must parse a real release shape");
        assert_eq!(release.tag, "v0.11.3");
        assert_eq!(release.notes_url, "https://github.com/vimoxshah/clockwork/releases/tag/v0.11.3");
    }

    #[test]
    fn update_check_json_carries_the_notes_link_for_a_newer_release() {
        let outcome = evaluate_update("0.9.0", Ok(release_body("v0.11.2")));
        let json = update_check_json(&outcome);
        assert_eq!(json["status"], "newer_available");
        assert_eq!(json["current"], "0.9.0");
        assert_eq!(json["latest"], "0.11.2");
        assert_eq!(json["notesUrl"], "https://github.com/vimoxshah/clockwork/releases/tag/v0.11.2");
    }

    #[test]
    fn the_check_updates_menu_item_runs_the_check_and_is_never_ignored() {
        assert_eq!(tray_action(ID_CHECK_UPDATES), TrayAction::CheckForUpdates);
    }

    #[test]
    fn the_tray_and_settings_message_wording_is_one_function_not_two() {
        // `update_check_message` backs both `update_check_json`'s
        // `"message"` field and the tray's alert text — this pins that the
        // two are the SAME string for the same outcome, not independently
        // maintained copy that could drift apart.
        let up_to_date = UpdateCheck::UpToDate { current: "0.11.2".to_string() };
        assert_eq!(update_check_message(&up_to_date), "You're on the latest version (0.11.2).");
        assert_eq!(update_check_json(&up_to_date)["message"], "You're on the latest version (0.11.2).");

        let newer = UpdateCheck::NewerAvailable {
            current: "0.9.0".to_string(),
            latest: "0.11.2".to_string(),
            notes_url: "https://github.com/vimoxshah/clockwork/releases/tag/v0.11.2".to_string(),
        };
        assert_eq!(update_check_message(&newer), "Clockwork 0.11.2 is available — you're on 0.9.0.");
        // The tray's message deliberately omits the URL (see the doc
        // comment) — it must not silently reappear in the shared string.
        assert!(!update_check_message(&newer).contains("http"), "{}", update_check_message(&newer));

        let net_err = UpdateCheck::NetworkError { reason: "timed out".to_string() };
        assert_eq!(update_check_message(&net_err), "Couldn't reach GitHub to check for updates: timed out");
        assert_eq!(update_check_json(&net_err)["message"], "Couldn't reach GitHub to check for updates: timed out");

        let malformed = UpdateCheck::Malformed { reason: "no tag_name".to_string() };
        assert_eq!(update_check_message(&malformed), "GitHub answered, but the response didn't make sense: no tag_name");
    }

    #[test]
    fn the_update_alert_script_json_escapes_whatever_the_message_contains() {
        // Same reasoning as `pairing_script_escapes_the_token`: `text` can
        // carry GitHub's own strings by the time it reaches here, and a
        // quote or backslash in it must not be able to break out of the JS
        // string literal `alert(...)` is called with.
        let script = update_alert_script("a\"b\\c");
        assert!(script.contains(r#""a\"b\\c""#), "message must be JSON-escaped: {script}");
        assert!(script.starts_with("alert("));
        assert!(script.trim_end().ends_with(");"));
    }

    // ---- T1-19: the IPC grant, resolved rather than read -----------------
    //
    // `Resolved::resolve` is the same function `tauri-codegen` runs to bake
    // the `RuntimeAuthority` into the binary, and `allowed_commands` is the
    // very map `resolve_access` consults on every `invoke()`
    // (tauri-2.11.5/src/ipc/authority.rs:454). Resolving the checked-in
    // files here therefore answers "what does the window actually get",
    // which reading the JSON does not.
    //
    // Deliberately resolved against the APP manifest ALONE — no core plugin
    // manifests in the map. The day someone adds `core:default`, or any
    // plugin permission, to that capability, resolution fails and these
    // tests go red instead of the grant quietly widening.
    fn resolve_the_grant() -> tauri::utils::acl::resolved::Resolved {
        use tauri::utils::acl::{
            capability::Capability,
            manifest::{Manifest, PermissionFile},
        };
        use std::collections::BTreeMap;

        let permission: PermissionFile =
            serde_json::from_str(include_str!("../permissions/check-for-updates.json"))
                .expect("permissions/check-for-updates.json must be a Tauri PermissionFile");
        let capability: Capability =
            serde_json::from_str(include_str!("../capabilities/check-for-updates.json"))
                .expect("capabilities/check-for-updates.json must be a Tauri Capability");

        let mut acl = BTreeMap::new();
        acl.insert(
            tauri::utils::acl::APP_ACL_KEY.to_string(),
            Manifest::new(vec![permission], None),
        );
        let mut capabilities = BTreeMap::new();
        capabilities.insert(capability.identifier.clone(), capability);

        tauri::utils::acl::resolved::Resolved::resolve(
            &acl,
            capabilities,
            tauri::utils::platform::Target::current(),
        )
        .expect("the capability must resolve against the app manifest alone")
    }

    #[test]
    fn the_ipc_grant_is_one_command_from_one_origin() {
        let resolved = resolve_the_grant();

        assert_eq!(
            resolved.allowed_commands.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["check_for_updates_command"],
            "the app window must be able to call exactly one command",
        );
        assert!(resolved.denied_commands.is_empty(), "nothing to deny — nothing else is allowed");
        assert!(resolved.command_scope.is_empty(), "the command takes no arguments, so it takes no scope");
        assert!(resolved.global_scope.is_empty(), "no global scope is granted to anything");

        let contexts = &resolved.allowed_commands["check_for_updates_command"];
        assert_eq!(
            contexts.len(),
            1,
            "one execution context: `local` is false, so no local grant rides along — {contexts:?}",
        );
        let granted = &contexts[0];
        assert_eq!(
            granted.windows.iter().map(|w| w.as_str()).collect::<Vec<_>>(),
            vec!["main"],
            "only the window `run()` builds",
        );
        assert!(granted.webviews.is_empty(), "no webview-label grant");
        match &granted.context {
            tauri::utils::acl::ExecutionContext::Remote { url } => assert_eq!(
                url.as_str(),
                DAEMON_URL,
                "the grant must name the origin this shell actually loads",
            ),
            other => panic!("the grant must be remote-only, got {other:?}"),
        }
    }

    #[test]
    fn the_grant_covers_the_pages_the_daemon_serves_and_no_other_origin() {
        // `RemoteUrlPattern::test` is what `Origin::matches` calls
        // (authority.rs:62), so this is the runtime comparison, not a
        // paraphrase of it. The UI is one page that routes on
        // `location.hash` (packages/ui/src/App.tsx), and Settings is a hash
        // route — the pattern has to survive that and still refuse a
        // neighbour port.
        let resolved = resolve_the_grant();
        let tauri::utils::acl::ExecutionContext::Remote { url } =
            &resolved.allowed_commands["check_for_updates_command"][0].context
        else {
            panic!("asserted remote in the test above");
        };
        let matches = |u: &str| url.test(&u.parse::<tauri::Url>().expect("valid url"));

        assert!(matches("http://127.0.0.1:4747/"), "the UI's own root");
        assert!(matches("http://127.0.0.1:4747/#/settings"), "the tab the button lives on");
        assert!(!matches("http://127.0.0.1:4748/"), "a neighbour port is a different program");
        assert!(!matches("http://localhost:4747/"), "not the origin this shell loads");
        assert!(!matches("https://clockwork.sh/"), "no page off this machine");
    }

    #[test]
    fn shipping_an_app_manifest_makes_every_future_command_fail_closed() {
        // Side effect worth pinning: with an app ACL manifest present,
        // `has_app_acl_manifest` is true at runtime, so EVERY app command
        // needs a permission and a capability — local origins included
        // (webview/mod.rs:1823). A command added later is denied until it
        // is granted, rather than exposed until someone notices.
        assert!(resolve_the_grant().has_app_acl);
    }
}
