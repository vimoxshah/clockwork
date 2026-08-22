/**
 * Clockwork desktop shell (T-121): native window onto the daemon-served UI at
 * 127.0.0.1:4747. The daemon is the product surface; this shell adds the
 * macOS window, dock presence, and best-effort daemon autolaunch.
 */

use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::Duration;

fn daemon_up() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:4747".parse().expect("valid addr"),
        Duration::from_millis(500),
    )
    .is_ok()
}

/// Best-effort: try the installed launcher, then a bare `node` fallback.
/// The UI itself shows "daemon down" honestly when neither works (T-125).
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
