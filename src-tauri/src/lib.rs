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

/// One unauthenticated GET against the local daemon, returning the body.
///
/// Hand-rolled rather than pulling in an HTTP client: the only endpoint this
/// shell reads is `/health`, which `requiresAuth` leaves open precisely so a
/// supervisor can check on the daemon without holding a credential.
fn http_get(path: &str) -> Option<String> {
    let mut stream =
        TcpStream::connect_timeout(&DAEMON_ADDR.parse().ok()?, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    write!(
        stream,
        "GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    let (_, body) = raw.split_once("\r\n\r\n")?;
    Some(body.to_string())
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

/// Install (or re-point) the LaunchAgent so scheduled runs outlive the window.
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
fn ensure_launch_agent(b: &Bundle) {
    let want = b.node.to_string_lossy().to_string();
    if agent_node_path().as_deref() == Some(want.as_str()) {
        return;
    }
    // `install` pins `process.execPath` into the plist, so running the CLI
    // WITH the bundled Node is what makes the plist point at the bundled Node.
    let _ = Command::new(&b.node)
        .arg(&b.cli)
        .arg("install")
        .arg(&b.entry)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
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
/// that grant would belong to every page the daemon serves.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_daemon();
    tauri::Builder::default()
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
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
}
