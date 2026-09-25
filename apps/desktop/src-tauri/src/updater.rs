//! Auto-update (tauri-plugin-updater; docs/design/desktop.md challenge #15).
//!
//!   1. 30 s after launch, then every 6 h, and on "Check for Updates…", fetch
//!      `latest.json` from the endpoint in tauri.conf.json.
//!   2. A newer version is downloaded in the background. The plugin checks
//!      its minisign signature against the pubkey in tauri.conf.json.
//!      Nothing is installed yet.
//!   3. The user is told once per version, with a notice in the chat pane
//!      (sent through the sidecar). The app menu item changes to
//!      "Restart to Update to vX…".
//!   4. The update is installed in the exit path, from Restart Now or the
//!      next ordinary quit. By then `Supervisor::shutdown` has stopped the
//!      sidecar and whatever an agent run started. A background update
//!      never interrupts a run: only the user's own restart or quit does.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::sidecar;

const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
pub const MENU_ID: &str = "check-updates";
pub const MENU_IDLE: &str = "Check for Updates…";

/// A downloaded, signature-checked update waiting for the exit path.
struct Ready {
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct Updates {
    ready: Mutex<Option<Ready>>,
    checking: AtomicBool,
    /// Set by Restart Now: the exit path installs and the app comes back.
    restarting: AtomicBool,
    menu: Mutex<Option<MenuItem<Wry>>>,
}

enum Outcome {
    UpToDate,
    /// This version is already downloaded (the user was already told about it).
    AlreadyReady(String),
    Downloaded(String),
}

pub fn start(app: &AppHandle, menu: MenuItem<Wry>) {
    *app.state::<Updates>().menu.lock().unwrap() = Some(menu);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            check(&app, false);
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

/// The app-menu item: checks now, or offers the restart once a download is ready.
pub fn menu_clicked(app: &AppHandle) {
    if cfg!(debug_assertions) {
        message(app, "Updates are off in development builds.");
        return;
    }
    if let Some(version) = ready_version(app) {
        offer_restart(app, &version);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || check(&app, true));
}

/// Restart Now (the dialog, or the notice in the chat pane via the sidecar).
pub fn restart_now(app: &AppHandle) {
    if ready_version(app).is_none() {
        return;
    }
    app.state::<Updates>().restarting.store(true, Ordering::SeqCst);
    // Goes through RunEvent::Exit (sidecar shutdown, then install_on_exit)
    // and relaunches from the same path, which now holds the new version.
    app.request_restart();
}

/// RunEvent::Exit, after the sidecar has stopped.
pub fn install_on_exit(app: &AppHandle) {
    let st = app.state::<Updates>();
    let Some(ready) = st.ready.lock().unwrap().take() else { return };
    let version = ready.update.version.clone();
    // Windows: the installer relaunches the app only for Restart Now, not for a quit.
    let update = ready.update.restart_after_install(st.restarting.load(Ordering::SeqCst));
    eprintln!("[updater] installing v{version}");
    match update.install(&ready.bytes) {
        Ok(()) => eprintln!("[updater] installed v{version}"),
        // The current version keeps running. Next launch checks and downloads again.
        Err(e) => eprintln!("[updater] could not install v{version}: {e}"),
    }
}

fn check(app: &AppHandle, manual: bool) {
    let st = app.state::<Updates>();
    if st.checking.swap(true, Ordering::SeqCst) {
        if manual {
            message(app, "Already checking for updates.");
        }
        return;
    }
    let result = tauri::async_runtime::block_on(fetch(app));
    st.checking.store(false, Ordering::SeqCst);
    match result {
        Ok(Outcome::Downloaded(version)) => {
            set_menu(app, &format!("Restart to Update to v{version}…"), true);
            if manual {
                offer_restart(app, &version);
            } else {
                app.state::<sidecar::Supervisor>()
                    .send(serde_json::json!({ "type": "update-ready", "version": version }));
            }
        }
        Ok(Outcome::AlreadyReady(version)) => {
            if manual {
                offer_restart(app, &version);
            }
        }
        Ok(Outcome::UpToDate) => {
            if manual {
                message(app, &format!("You're on the latest version (v{}).", app.package_info().version));
            }
        }
        Err(e) => {
            eprintln!("[updater] {e}");
            if let Some(version) = ready_version(app) {
                set_menu(app, &format!("Restart to Update to v{version}…"), true);
            } else {
                set_menu(app, MENU_IDLE, true);
            }
            if manual {
                message(app, &format!("Couldn't check for updates.\n\n{e}"));
            }
        }
    }
}

async fn fetch(app: &AppHandle) -> Result<Outcome, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(Outcome::UpToDate);
    };
    let version = update.version.clone();
    if ready_version(app).as_deref() == Some(version.as_str()) {
        return Ok(Outcome::AlreadyReady(version));
    }
    set_menu(app, &format!("Downloading v{version}…"), false);
    eprintln!("[updater] v{version} available (running v{}); downloading {}", update.current_version, update.download_url);
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| format!("download of v{version} failed: {e}"))?;
    eprintln!("[updater] v{version} downloaded ({} bytes, signature ok)", bytes.len());
    // A newer release replaces one that was downloaded earlier and never installed.
    *app.state::<Updates>().ready.lock().unwrap() = Some(Ready { update, bytes });
    Ok(Outcome::Downloaded(version))
}

fn ready_version(app: &AppHandle) -> Option<String> {
    app.state::<Updates>().ready.lock().unwrap().as_ref().map(|r| r.update.version.clone())
}

fn set_menu(app: &AppHandle, text: &str, enabled: bool) {
    if let Some(item) = app.state::<Updates>().menu.lock().unwrap().as_ref() {
        let _ = item.set_text(text);
        let _ = item.set_enabled(enabled);
    }
}

fn offer_restart(app: &AppHandle, version: &str) {
    let app2 = app.clone();
    app.dialog()
        .message(format!(
            "WorkspaceGPT v{version} has been downloaded.\n\nRestart now to install it, or keep working: it installs the next time you quit."
        ))
        .title("Update ready")
        .buttons(MessageDialogButtons::OkCancelCustom("Restart Now".into(), "Later".into()))
        .show(move |restart| {
            if restart {
                restart_now(&app2);
            }
        });
}

fn message(app: &AppHandle, text: &str) {
    app.dialog().message(text).title("WorkspaceGPT").show(|_| {});
}
