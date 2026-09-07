/**
 * Clockwork desktop shell (T-121): native window onto the daemon-served UI at
 * 127.0.0.1:4747. The daemon is the product surface; this shell adds the
 * macOS window, dock presence, and best-effort daemon autolaunch.
 */

use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::Duration;

const DAEMON_ADDR: &str = "127.0.0.1:4747";
const DAEMON_URL: &str = "http://127.0.0.1:4747";

fn daemon_up() -> bool {
    TcpStream::connect_timeout(
        &DAEMON_ADDR.parse().expect("valid addr"),
        Duration::from_millis(500),
    )
    .is_ok()
}

/// Best-effort: try the installed launcher, then a bare `node` fallback.
///
/// Both branches are long shots on a machine that only installed the .app. The
/// launcher exists only after `clockworkd install` (packages/daemon/src/cli.ts),
/// which needs a source checkout; `~/clockwork/daemon.mjs` is a path nothing in
/// this repo writes, so it answers only for someone who placed it there. And a
/// GUI process launched from Finder inherits launchd's PATH, not a shell's, so
/// `command -v node` misses Homebrew and nvm installs even when Node is
/// genuinely present. When neither branch lands, the window falls back to
/// `daemon-down.html` (see `run`) rather than showing nothing.
fn ensure_daemon() {
    if daemon_up() {
        return;
    }
    let home = std::env::var("HOME").unwrap_or_default();
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
    // give it a moment; the UI polls health anyway
    for _ in 0..10 {
        if daemon_up() {
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
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
            let url = if daemon_up() {
                tauri::WebviewUrl::External(DAEMON_URL.parse().expect("valid daemon url"))
            } else {
                tauri::WebviewUrl::App("daemon-down.html".into())
            };
            tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("Clockwork")
                .inner_size(1280.0, 820.0)
                .min_inner_size(940.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
