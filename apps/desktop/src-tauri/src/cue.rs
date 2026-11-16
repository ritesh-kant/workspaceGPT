//! The work-brief icon overlay: a small, always-on-top, transparent window in
//! the top-right corner (bridge/cue.html). Collapsed it is one round icon; a
//! click asks the shell to grow it into the ask panel through a cancelled
//! navigation (`workspacegpt://cue/expand` | `collapse`), as the main window
//! does for refresh-layout — no IPC.
//!
//! It is kept out of screen capture (`content_protected`), so people on a
//! call never see it while the user shares their screen.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

pub const CUE: &str = "cue";
pub const MENU_ID: &str = "cue-toggle";
pub const MENU_LABEL: &str = "Show Work Brief Icon";

/// Window sizes in logical pixels. The page draws a 36px icon with a 4px margin.
const ICON: f64 = 44.0;
const PANEL_W: f64 = 380.0;
const PANEL_H: f64 = 440.0;
/// From the screen's top-right corner (below the macOS menu bar).
const MARGIN_RIGHT: f64 = 16.0;
const MARGIN_TOP: f64 = 40.0;

/// Whether the icon is shown; kept across launches. On by default.
pub struct CueEnabled(pub Mutex<bool>);

fn pref_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("cue.json"))
}

pub fn load(app: &AppHandle) -> CueEnabled {
    let on = pref_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["enabled"].as_bool())
        .unwrap_or(true);
    CueEnabled(Mutex::new(on))
}

fn save(app: &AppHandle, on: bool) {
    if let Some(path) = pref_path(app) {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        let _ = std::fs::write(&path, serde_json::json!({ "enabled": on }).to_string());
    }
}

fn cue_url(port: u16) -> Url {
    Url::parse(&format!("http://127.0.0.1:{port}/__desktop/cue.html")).expect("loopback url")
}

/// Grow to the panel or shrink to the icon, keeping the right edge where it is.
fn resize(app: &AppHandle, expand: bool) {
    let Some(w) = app.get_webview_window(CUE) else { return };
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

/// Open the overlay on `port`, or point an open one at a restarted sidecar.
pub fn sync(app: &AppHandle, port: u16, token_script: &str, current_port: impl Fn() -> Option<u16> + Send + 'static) {
    if !*app.state::<CueEnabled>().0.lock().unwrap() {
        return;
    }
    if let Some(w) = app.get_webview_window(CUE) {
        let _ = w.navigate(cue_url(port));
        resize(app, false);
        return;
    }
    // Top-right of the primary screen.
    let (x, y) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.scale_factor();
            let (mx, my) = (m.position().x as f64 / s, m.position().y as f64 / s);
            (mx + m.size().width as f64 / s - ICON - MARGIN_RIGHT, my + MARGIN_TOP)
        })
        .unwrap_or((MARGIN_RIGHT, MARGIN_TOP));
    let nav_app = app.clone();
    let builder = WebviewWindowBuilder::new(app, CUE, WebviewUrl::External(cue_url(port)))
        .title("Ask about my work")
        .inner_size(ICON, ICON)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .content_protected(true)
        .focused(false)
        .initialization_script(token_script)
        .on_navigation(move |url| {
            if url.scheme() == "workspacegpt" && url.host_str() == Some("cue") {
                let expand = url.path() == "/expand";
                let app2 = nav_app.clone();
                let _ = nav_app.run_on_main_thread(move || resize(&app2, expand));
                return false;
            }
            let ours = url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == current_port();
            if !ours && (url.scheme() == "http" || url.scheme() == "https") {
                let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
            }
            ours || url.scheme() == "about"
        });
    if let Err(e) = builder.build() {
        eprintln!("[shell] could not open the work brief icon: {e}");
    }
}

/// The app-menu checkbox: show or hide the icon now and remember the choice.
pub fn menu_toggled(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>, open: impl FnOnce(&AppHandle)) {
    let on = item.is_checked().unwrap_or(true);
    *app.state::<CueEnabled>().0.lock().unwrap() = on;
    save(app, on);
    if on {
        open(app);
    } else if let Some(w) = app.get_webview_window(CUE) {
        let _ = w.close();
    }
}
