//! Native notifications for "a run needs you" and "a run finished".
//!
//! The sidecar decides *what* happened (sidecar/host/notifier.ts watches the
//! chat's own messages) and prints one `@@WGPT_NOTIFY@@ {…}` line per moment.
//! The shell decides *whether to interrupt*: only it knows if the window is in
//! front. A focused window already showing that session gets nothing — the
//! card or the answer is on screen. Anything else posts a notification and
//! bumps the Dock badge, which clears the next time the window takes focus.
//!
//! On/off is a checkbox in the app menu, kept in `<app config dir>/notifications.json`.

use serde::Deserialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

pub const MENU_ID: &str = "notifications-toggle";
pub const MENU_LABEL: &str = "Notify When a Run Needs Me or Finishes";

#[derive(Deserialize)]
struct Attention {
    kind: String,
    title: String,
    body: String,
    /// The chat is showing this run's session right now.
    #[serde(default)]
    visible: bool,
}

pub struct Notifications {
    enabled: AtomicBool,
    unseen: AtomicI64,
}

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("notifications.json"))
}

impl Notifications {
    pub fn load(app: &AppHandle) -> Self {
        let enabled = prefs_path(app)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v["enabled"].as_bool())
            .unwrap_or(true);
        Notifications { enabled: AtomicBool::new(enabled), unseen: AtomicI64::new(0) }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
}

/// The app-menu checkbox was clicked (its checked state has already flipped).
pub fn menu_toggled(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let enabled = item.is_checked().unwrap_or(true);
    app.state::<Notifications>().enabled.store(enabled, Ordering::Relaxed);
    if let Some(path) = prefs_path(app) {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        if let Err(e) = std::fs::write(&path, serde_json::json!({ "enabled": enabled }).to_string()) {
            eprintln!("[shell] could not save the notification setting: {e}");
        }
    }
    if !enabled {
        clear_badge(app);
    }
}

/// One `@@WGPT_NOTIFY@@` line from the sidecar (called on its stdout thread).
pub fn from_sidecar(app: &AppHandle, json: &str) {
    let Ok(a) = serde_json::from_str::<Attention>(json) else {
        eprintln!("[shell] unreadable NOTIFY line from sidecar");
        return;
    };
    let state = app.state::<Notifications>();
    if !state.enabled() {
        return;
    }
    let looking = app
        .get_webview_window(crate::MAIN)
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false);
    if looking && a.visible {
        return;
    }
    eprintln!("[shell] notifying ({}): {}", a.kind, a.title);
    if let Err(e) = app.notification().builder().title(&a.title).body(&a.body).show() {
        eprintln!("[shell] could not show a notification: {e}");
    }
    if !looking {
        let n = state.unseen.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(w) = app.get_webview_window(crate::MAIN) {
            let _ = w.set_badge_count(Some(n));
        }
    }
}

/// The window took focus: whatever the badge counted is now in front of the user.
pub fn clear_badge(app: &AppHandle) {
    let state = app.state::<Notifications>();
    if state.unseen.swap(0, Ordering::Relaxed) != 0 {
        if let Some(w) = app.get_webview_window(crate::MAIN) {
            let _ = w.set_badge_count(None);
        }
    }
}
