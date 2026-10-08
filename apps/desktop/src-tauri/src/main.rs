//! WorkspaceGPT Desktop — the Tauri shell.
//!
//! Deliberately thin (docs/design/desktop.md): a window, a menu, a tray, a
//! folder picker, and the sidecar supervisor. All product logic is the VS Code
//! extension's host code running in the Node sidecar; the window shows the
//! sidecar's loopback page, which reaches the sidecar over its own WebSocket
//! (no Tauri IPC — see capabilities/default.json).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod notify;
mod sidecar;
mod updater;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub(crate) const MAIN: &str = "main";

/// Port of the sidecar currently serving the page (changes on restart).
struct CurrentPort(Mutex<Option<u16>>);

fn page_url(port: u16) -> Url {
    Url::parse(&format!("http://127.0.0.1:{port}/")).expect("loopback url")
}

/// Hands the page its socket token. Runs before any page script on every load
/// in this window, but only a page served by our own loopback server gets it.
/// `chrome: 'overlay'` tells the shell page the content runs under the title
/// bar (macOS), so it leaves room for the traffic lights.
fn token_script(token: &str) -> String {
    let chrome = if cfg!(target_os = "macos") { "overlay" } else { "native" };
    format!(
        "(function(){{ if (location.protocol === 'http:' && location.hostname === '127.0.0.1') {{ \
         Object.defineProperty(window, '__WGPT_DESKTOP__', {{ value: Object.freeze({{ token: '{token}', chrome: '{chrome}' }}) }}); }} }})();"
    )
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Called from the sidecar's stdout thread when a (re)started sidecar is serving.
fn on_sidecar_ready(app: &AppHandle, port: u16) {
    *app.state::<CurrentPort>().0.lock().unwrap() = Some(port);
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window(MAIN) {
            // Restarted sidecar (crash, or Open Folder…): same token, new port.
            let _ = w.navigate(page_url(port));
            let _ = w.set_zoom(*app2.state::<Zoom>().0.lock().unwrap());
            return;
        }
        let token = app2.state::<sidecar::Supervisor>().token().to_string();
        let nav_app = app2.clone();
        let builder = WebviewWindowBuilder::new(&app2, MAIN, WebviewUrl::External(page_url(port)))
            .title("WorkspaceGPT")
            // Sidebar + chat column. Below 720px wide the shell folds the
            // sidebar away, so the old single-column size still works.
            .inner_size(1180.0, 800.0)
            .min_inner_size(420.0, 500.0)
            .initialization_script(&token_script(&token));
        // macOS: the page runs under a transparent title bar and draws its own
        // header; `data-tauri-drag-region` there moves the window
        // (capabilities/window-drag.json allows exactly that).
        #[cfg(target_os = "macos")]
        let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
        let built = builder
            // The window only ever shows our loopback page. Anything else
            // (a link the page didn't route through openExternal) goes to the
            // system browser instead of replacing the chat.
            .on_navigation(move |url| {
                let ours = url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.port() == *nav_app.state::<CurrentPort>().0.lock().unwrap();
                let internal = url.scheme() == "tauri" || url.scheme() == "about";
                if !ours && !internal && (url.scheme() == "http" || url.scheme() == "https") {
                    let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
                }
                ours || internal
            })
            .build();
        match built {
            Ok(w) => {
                let _ = w.set_zoom(*app2.state::<Zoom>().0.lock().unwrap());
            }
            Err(e) => eprintln!("[shell] could not open the window: {e}"),
        }
    });
}

fn open_folder(app: &AppHandle) {
    let app2 = app.clone();
    app.dialog().file().set_title("Open a folder for WorkspaceGPT").pick_folder(move |picked| {
        let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return };
        restart_on_folder(&app2, path);
    });
}

fn restart_on_folder(app: &AppHandle, path: PathBuf) {
    eprintln!("[shell] opening folder {}", path.display());
    let sup = app.state::<sidecar::Supervisor>().inner().clone();
    // Restarting blocks until the old sidecar is gone — keep it off the UI thread.
    std::thread::spawn(move || {
        if let Err(e) = sup.restart_with_workspace(path) {
            eprintln!("[shell] {e}");
        }
    });
}

/// Page zoom, kept across launches in the app config dir.
struct Zoom(Mutex<f64>);

fn zoom_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("zoom.json"))
}

fn load_zoom(app: &AppHandle) -> f64 {
    zoom_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["zoom"].as_f64())
        .map_or(1.0, |z| z.clamp(0.5, 3.0))
}

/// `delta` of None resets to 100%.
fn change_zoom(app: &AppHandle, delta: Option<f64>) {
    let z = {
        let state = app.state::<Zoom>();
        let mut cur = state.0.lock().unwrap();
        *cur = delta.map_or(1.0, |d| ((*cur + d) * 100.0).round() / 100.0).clamp(0.5, 3.0);
        *cur
    };
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.set_zoom(z);
    }
    if let Some(path) = zoom_path(app) {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        let _ = std::fs::write(&path, serde_json::json!({ "zoom": z }).to_string());
    }
}

/// The app-menu checkbox for notifications, kept so a click can read its new state.
struct NotifyToggle(CheckMenuItem<tauri::Wry>);

fn build_menu(app: &AppHandle) -> tauri::Result<(Menu<tauri::Wry>, MenuItem<tauri::Wry>, CheckMenuItem<tauri::Wry>)> {
    let new_chat = MenuItem::with_id(app, "new-chat", "New Chat", true, Some("CmdOrCtrl+N"))?;
    let history = MenuItem::with_id(app, "history", "Chat History", true, Some("CmdOrCtrl+Y"))?;
    let open = MenuItem::with_id(app, "open-folder", "Open Folder…", true, Some("CmdOrCtrl+O"))?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let check_updates = MenuItem::with_id(app, updater::MENU_ID, updater::MENU_IDLE, true, None::<&str>)?;
    let notify_toggle = CheckMenuItem::with_id(
        app,
        notify::MENU_ID,
        notify::MENU_LABEL,
        true,
        app.state::<notify::Notifications>().enabled(),
        None::<&str>,
    )?;
    let reload = MenuItem::with_id(app, "reload", "Reload Window", true, Some("CmdOrCtrl+R"))?;

    let app_menu = Submenu::with_items(
        app,
        "WorkspaceGPT",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About WorkspaceGPT"), Some(AboutMetadata::default()))?,
            &check_updates,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &notify_toggle,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Hide WorkspaceGPT"))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit WorkspaceGPT"))?,
        ],
    )?;
    let file = Submenu::with_items(app, "File", true, &[&new_chat, &history, &PredefinedMenuItem::separator(app)?, &open])?;
    // Without an Edit menu, macOS routes no Cmd+C / Cmd+V / Cmd+A to the webview.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let zoom_in = MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset = MenuItem::with_id(app, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &reload,
            &PredefinedMenuItem::separator(app)?,
            &zoom_in,
            &zoom_out,
            &zoom_reset,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::close_window(app, None)?],
    )?;
    let menu = Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])?;
    Ok((menu, check_updates, notify_toggle))
}

fn handle_menu(app: &AppHandle, id: &str) {
    let sup = app.state::<sidecar::Supervisor>();
    match id {
        "new-chat" => sup.run_command("workspacegpt.newChat"),
        "history" => sup.run_command("workspacegpt.history"),
        "settings" => sup.run_command("workspacegpt.settings"),
        "open-folder" => open_folder(app),
        "reload" => {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.eval("location.reload()");
            }
        }
        "zoom-in" => change_zoom(app, Some(0.1)),
        "zoom-out" => change_zoom(app, Some(-0.1)),
        "zoom-reset" => change_zoom(app, None),
        updater::MENU_ID => updater::menu_clicked(app),
        notify::MENU_ID => notify::menu_toggled(app, &app.state::<NotifyToggle>().0),
        "tray-show" => show_main(app),
        "tray-quit" => app.exit(0),
        _ => {}
    }
    if matches!(id, "new-chat" | "history" | "settings") {
        show_main(app);
    }
}

fn main() {
    let token = sidecar::new_token();
    let handle_slot: Arc<Mutex<Option<AppHandle>>> = Arc::new(Mutex::new(None));

    let ready_slot = handle_slot.clone();
    let gave_up_slot = handle_slot.clone();
    let update_slot = handle_slot.clone();
    let notify_slot = handle_slot.clone();
    let open_folder_slot = handle_slot.clone();
    let supervisor = sidecar::Supervisor::new(
        token,
        Arc::new(move |port| {
            if let Some(app) = ready_slot.lock().unwrap().as_ref() {
                on_sidecar_ready(app, port);
            }
        }),
        Arc::new(move |why| {
            eprintln!("[shell] giving up on the sidecar: {why}");
            if let Some(app) = gave_up_slot.lock().unwrap().as_ref() {
                let app2 = app.clone();
                app.dialog()
                    .message(format!("WorkspaceGPT's background process stopped and could not be restarted.\n\n{why}"))
                    .title("WorkspaceGPT")
                    .show(move |_| app2.exit(1));
            }
        }),
        Arc::new(move || {
            if let Some(app) = update_slot.lock().unwrap().as_ref() {
                updater::restart_now(app);
            }
        }),
        Arc::new(move |json| {
            if let Some(app) = notify_slot.lock().unwrap().as_ref() {
                notify::from_sidecar(app, json);
            }
        }),
        // The chat's folder chip (vscode.openFolder in vscode-compat).
        Arc::new(move |path| {
            if let Some(app) = open_folder_slot.lock().unwrap().as_ref() {
                match path {
                    Some(path) => restart_on_folder(app, path),
                    None => {
                        let app2 = app.clone();
                        let _ = app.run_on_main_thread(move || open_folder(&app2));
                    }
                }
            }
        }),
    );

    let app = tauri::Builder::default()
        // A second launch focuses this window instead of starting a second
        // app (and a second sidecar on the same profile). Registered first,
        // as the plugin requires.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(CurrentPort(Mutex::new(None)))
        .manage(updater::Updates::default())
        .manage(supervisor.clone())
        .setup(move |app| {
            app.manage(notify::Notifications::load(app.handle()));
            app.manage(Zoom(Mutex::new(load_zoom(app.handle()))));
            *handle_slot.lock().unwrap() = Some(app.handle().clone());
            let (menu, check_updates, notify_toggle) = build_menu(app.handle())?;
            app.manage(NotifyToggle(notify_toggle));
            app.set_menu(menu)?;

            let tray_menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "tray-show", "Show WorkspaceGPT", true, None::<&str>)?,
                    &MenuItem::with_id(app, "new-chat", "New Chat", true, None::<&str>)?,
                    &MenuItem::with_id(app, "open-folder", "Open Folder…", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "tray-quit", "Quit WorkspaceGPT", true, None::<&str>)?,
                ],
            )?;
            let mut tray = TrayIconBuilder::with_id("main").menu(&tray_menu).tooltip("WorkspaceGPT");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // `kill <pid>`, logout, Ctrl-C under `tauri dev`: take the normal
            // quit path so the sidecar is asked to stop rather than orphaned.
            #[cfg(unix)]
            {
                use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
                let mut signals = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP])?;
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Some(sig) = signals.forever().next() {
                        eprintln!("[shell] signal {sig}: quitting");
                        app_handle.exit(0);
                    }
                });
            }

            supervisor.start().map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            // Release builds only: a `tauri dev` binary isn't in a bundle to replace.
            if !cfg!(debug_assertions) {
                updater::start(app.handle(), check_updates);
            }
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            // Closing the window hides it (the tray and Dock bring it back);
            // Quit is Cmd+Q or the tray. Keeps a running agent alive.
            if let tauri::WindowEvent::Focused(true) = event {
                if window.label() == MAIN {
                    notify::clear_badge(window.app_handle());
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Tauri app");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        RunEvent::Exit => {
            app.state::<sidecar::Supervisor>().shutdown();
            // After the sidecar is gone: nothing runs from the bundle being replaced.
            updater::install_on_exit(app);
        }
        _ => {}
    });
}
