//! `logs/shell.log`: the shell's own events and the sidecar's raw stderr.
//!
//! A packaged app has no terminal, so `eprintln!` goes nowhere. The sidecar
//! writes its console output to `logs/sidecar.log` itself; what only the shell
//! sees is what a dying Node prints straight to stderr (V8's out-of-memory
//! abort, a native crash) and the restart decisions. Same folder and rotation
//! as the sidecar's (the profile root is the one `sidecar/host/stores.ts` picks).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 2 * 1024 * 1024;
const KEEP: u32 = 3;

static FILE: Mutex<Option<(PathBuf, u64)>> = Mutex::new(None);

fn profile_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("WGPT_DESKTOP_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    #[cfg(target_os = "macos")]
    return std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/WorkspaceGPT Desktop"));
    #[cfg(target_os = "windows")]
    return std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("WorkspaceGPT Desktop"));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .map(|c| c.join("workspacegpt-desktop"));
}

fn rotate(path: &PathBuf) {
    for i in (1..KEEP).rev() {
        let _ = fs::rename(format!("{}.{i}", path.display()), format!("{}.{}", path.display(), i + 1));
    }
    let _ = fs::rename(path, format!("{}.1", path.display()));
}

pub fn log_dir() -> Option<PathBuf> {
    profile_root().map(|r| r.join("logs"))
}

/// Append one line (with a timestamp and source tag); never fails the caller.
pub fn line(source: &str, text: &str) {
    let mut guard = FILE.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let Some(dir) = log_dir() else { return };
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("shell.log");
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        *guard = Some((path, size));
    }
    let (path, size) = guard.as_mut().unwrap();
    if *size > MAX_BYTES {
        rotate(path);
        *size = 0;
    }
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let entry = format!("{secs} {source} {text}\n");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&*path) {
        if f.write_all(entry.as_bytes()).is_ok() {
            *size += entry.len() as u64;
        }
    }
}
