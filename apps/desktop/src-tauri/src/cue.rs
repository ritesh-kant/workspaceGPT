//! The work-brief icon overlay: a small, always-on-top, transparent window in
//! the top-right corner (bridge/cue.html). Collapsed it is one round icon; a
//! click asks the shell to grow it into the ask panel through a cancelled
//! navigation (`workspacegpt://cue/expand` | `collapse`), as the main window
//! does for refresh-layout — no IPC.
//!
//! Settings → Ask about my work (beta) owns the preferences: show the icon,
//! hide it in screen shares, and a global hotkey that opens the panel from
//! any app. The page sends them through the sidecar (`apply`); the shell keeps
//! a copy in cue.json so the icon and hotkey are right before the page loads,
//! and answers with `{"type":"cue-status"}` (hotkey registered, or why not).
//!
//! Hidden in screen shares means kept out of all screen capture
//! (`content_protected`); macOS applies that to the user's own screenshots too.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;

pub const CUE: &str = "cue";
/// Opens the panel from any app. Settings can change it or turn it off.
pub const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+Space";

/// Window sizes in logical pixels. The page draws a 36px icon with a 4px margin.
const ICON: f64 = 44.0;
const PANEL_W: f64 = 400.0;
const PANEL_H: f64 = 540.0;
/// From the screen's top-right corner (below the macOS menu bar).
const MARGIN_RIGHT: f64 = 16.0;
const MARGIN_TOP: f64 = 40.0;

#[derive(Clone, PartialEq)]
pub struct Prefs {
    /// Show the icon. With it off the hotkey still opens the panel.
    pub enabled: bool,
    pub hide_in_shares: bool,
    /// A Tauri accelerator, or empty for no hotkey.
    pub hotkey: String,
}

pub struct CuePrefs(pub Mutex<Prefs>);

/// Whether the window is the panel (true) or the icon.
static EXPANDED: AtomicBool = AtomicBool::new(false);
/// Why the hotkey could not be registered, for Settings to show.
static HOTKEY_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn pref_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("cue.json"))
}

pub fn load(app: &AppHandle) -> CuePrefs {
    let v = pref_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    CuePrefs(Mutex::new(Prefs {
        enabled: v["enabled"].as_bool().unwrap_or(true),
        hide_in_shares: v["hideInShares"].as_bool().unwrap_or(true),
        hotkey: v["hotkey"].as_str().unwrap_or(DEFAULT_HOTKEY).to_string(),
    }))
}

fn save(app: &AppHandle, p: &Prefs) {
    if let Some(path) = pref_path(app) {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        let json = serde_json::json!({ "enabled": p.enabled, "hideInShares": p.hide_in_shares, "hotkey": p.hotkey });
        let _ = std::fs::write(&path, json.to_string());
    }
}

fn prefs(app: &AppHandle) -> Prefs {
    app.state::<CuePrefs>().0.lock().unwrap().clone()
}

fn cue_url(port: u16, open: bool) -> Url {
    let q = if open { "?open=1" } else { "" };
    Url::parse(&format!("http://127.0.0.1:{port}/__desktop/cue.html{q}")).expect("loopback url")
}

fn current_port(app: &AppHandle) -> Option<u16> {
    *app.state::<crate::CurrentPort>().0.lock().unwrap()
}

/// Grow to the panel or shrink to the icon, keeping the right edge where it is.
fn resize(app: &AppHandle, expand: bool) {
    let Some(w) = app.get_webview_window(CUE) else { return };
    EXPANDED.store(expand, Ordering::SeqCst);
    // Opened by the hotkey with the icon turned off: there is no icon to fold back to.
    if !expand && !prefs(app).enabled {
        let _ = w.close();
        return;
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    let (lw, lh) = if expand { (PANEL_W, PANEL_H) } else { (ICON, ICON) };
    if let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) {
        let right = pos.x + size.width as i32;
        let x = (right - (lw * scale).round() as i32).max(0);
        let _ = w.set_size(LogicalSize::new(lw, lh));
        let _ = w.set_position(PhysicalPosition::new(x, pos.y));
    } else {
        let _ = w.set_size(LogicalSize::new(lw, lh));
    }
    if expand {
        let _ = w.set_focus();
    }
}

/// Open the overlay on the sidecar now serving, or point an open one at a
/// restarted sidecar. `open_panel` (the hotkey) opens it as the panel even
/// when the icon is turned off.
pub fn sync(app: &AppHandle, open_panel: bool) {
    let Some(port) = current_port(app) else { return };
    let p = prefs(app);
    if !p.enabled && !open_panel {
        return;
    }
    if let Some(w) = app.get_webview_window(CUE) {
        let _ = w.navigate(cue_url(port, open_panel));
        if !open_panel {
            resize(app, false);
        }
        return;
    }
    let token = app.state::<crate::sidecar::Supervisor>().token().to_string();
    let nav_app = app.clone();
    let builder = WebviewWindowBuilder::new(app, CUE, WebviewUrl::External(cue_url(port, open_panel)))
        .title("Ask about my work")
        .inner_size(ICON, ICON)
        .position(MARGIN_RIGHT, MARGIN_TOP)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .content_protected(p.hide_in_shares)
        .focused(false)
        // The first click on the icon opens the panel instead of only activating the app.
        .accept_first_mouse(true)
        .initialization_script(&crate::token_script(&token))
        .on_navigation(move |url| {
            if url.scheme() == "workspacegpt" && url.host_str() == Some("cue") {
                let expand = url.path() == "/expand";
                let app2 = nav_app.clone();
                let _ = nav_app.run_on_main_thread(move || resize(&app2, expand));
                return false;
            }
            let ours = url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == current_port(&nav_app);
            if !ours && (url.scheme() == "http" || url.scheme() == "https") {
                let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
            }
            ours || url.scheme() == "about"
        });
    if let Err(e) = builder.build() {
        eprintln!("[shell] could not open the work brief icon: {e}");
        return;
    }
    EXPANDED.store(false, Ordering::SeqCst);
    place(app);
    // The window-state plugin moves the main window to its saved screen after
    // it is created; place the icon again once that has happened.
    let later = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1200));
        let app2 = later.clone();
        let _ = later.run_on_main_thread(move || {
            if !EXPANDED.load(Ordering::SeqCst) {
                place(&app2);
            }
        });
    });
}

/// Top-right corner of the screen the main window is on (with two screens the
/// primary one may not be where the user is looking), else the primary screen.
/// Logical points: on macOS a monitor's physical position is its point origin
/// times its own scale, while a physical window position is divided by the
/// window's scale, so with a Retina and a 1x screen physical maths lands the
/// icon off every screen.
fn place(app: &AppHandle) {
    let Some(w) = app.get_webview_window(CUE) else { return };
    let monitor = app
        .get_webview_window(crate::MAIN)
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return };
    let s = m.scale_factor();
    let width = if EXPANDED.load(Ordering::SeqCst) { PANEL_W } else { ICON };
    let x = m.position().x as f64 / s + m.size().width as f64 / s - width - MARGIN_RIGHT;
    let y = m.position().y as f64 / s + MARGIN_TOP;
    let _ = w.set_position(LogicalPosition::new(x, y));
}

/// The main window moved (the window-state plugin restoring it after launch, or
/// the user dragging it): keep the icon on the same screen. A drag within that
/// screen leaves the icon where the user put it.
pub fn follow_main(app: &AppHandle) {
    if EXPANDED.load(Ordering::SeqCst) {
        return;
    }
    let (Some(cue), Some(main)) = (app.get_webview_window(CUE), app.get_webview_window(crate::MAIN)) else { return };
    let (Ok(Some(a)), Ok(Some(b))) = (cue.current_monitor(), main.current_monitor()) else { return };
    if a.position() != b.position() {
        place(app);
    }
}

/// The hotkey: open the panel from any app, or fold it back if it is open.
fn toggle(app: &AppHandle) {
    match app.get_webview_window(CUE) {
        // The page owns which view it draws; it asks for the resize itself.
        Some(w) => {
            let _ = w.eval("window.__cueToggle && window.__cueToggle()");
        }
        None => sync(app, true),
    }
}

fn register_hotkey(app: &AppHandle, old: &str, new: &str) {
    if !old.is_empty() {
        let _ = app.global_shortcut().unregister(old);
    }
    let error = if new.is_empty() {
        None
    } else {
        app.global_shortcut()
            .on_shortcut(new, |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || toggle(&app2));
                }
            })
            .inspect(|_| eprintln!("[shell] work brief hotkey {new} registered"))
            .err()
            .map(|e| {
                eprintln!("[shell] could not register the work brief hotkey {new}: {e}");
                format!("{e}")
            })
    };
    *HOTKEY_ERROR.lock().unwrap() = error;
}

/// At launch: the hotkey saved last time works before any page loads.
pub fn start(app: &AppHandle) {
    let p = prefs(app);
    register_hotkey(app, "", &p.hotkey);
}

/// Settings → Ask about my work changed (or the page loaded and said what is saved).
pub fn apply(app: &AppHandle, json: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return };
    let old = prefs(app);
    let new = Prefs {
        enabled: v["enabled"].as_bool().unwrap_or(old.enabled),
        hide_in_shares: v["hideInShares"].as_bool().unwrap_or(old.hide_in_shares),
        hotkey: v["hotkey"].as_str().map(str::to_string).unwrap_or_else(|| old.hotkey.clone()),
    };
    if new != old {
        *app.state::<CuePrefs>().0.lock().unwrap() = new.clone();
        save(app, &new);
        if let Some(w) = app.get_webview_window(CUE) {
            let _ = w.set_content_protected(new.hide_in_shares);
        }
        if new.enabled && !old.enabled {
            sync(app, false);
        } else if !new.enabled && !EXPANDED.load(Ordering::SeqCst) {
            if let Some(w) = app.get_webview_window(CUE) {
                let _ = w.close();
            }
        }
        if new.hotkey != old.hotkey {
            register_hotkey(app, &old.hotkey, &new.hotkey);
        }
    }
    let error = HOTKEY_ERROR.lock().unwrap().clone();
    app.state::<crate::sidecar::Supervisor>().send(serde_json::json!({
        "type": "cue-status",
        "hotkey": new.hotkey,
        "registered": !new.hotkey.is_empty() && error.is_none(),
        "error": error,
    }));
}
