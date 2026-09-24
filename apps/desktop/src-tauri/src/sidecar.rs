//! Spawns and supervises the Node sidecar (apps/desktop/sidecar/main.ts).
//!
//! Contract with the sidecar (`--parent-stdio`):
//!   shell → sidecar, stdin, one JSON object per line:
//!     {"type":"hello","token":"…"}   first line, always
//!     {"type":"command","id":"workspacegpt.newChat"}
//!     {"type":"shutdown"}
//!     {"type":"update-ready","version":"…"}   (updater.rs: a download is ready)
//!   sidecar → shell, stdout: one `@@WGPT_READY@@ {"port":…}` line once the
//!   page is being served; `@@WGPT_UPDATE_RESTART@@ {}` when the user picks
//!   Restart Now on the update notice; `@@WGPT_NOTIFY@@ {…}` when a run needs
//!   the user or finished (notify.rs); everything else is log output, echoed here.
//!
//! No orphans (DESKTOP-TAURI-PLAN.md challenge #6):
//!   - the sidecar is its own process-group leader, and anything left in that
//!     group is SIGKILLed after it exits;
//!   - the shell holds the sidecar's stdin, so if the shell dies (force-quit),
//!     the pipe closes and the sidecar's watchdog shuts everything down —
//!     including `detached` command children outside the group, which the
//!     sidecar tracks itself (sidecar/host/processReaper.ts).

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const READY_PREFIX: &str = "@@WGPT_READY@@ ";
/// host/profileLock.ts: another sidecar holds the profile.
const PROFILE_IN_USE_PREFIX: &str = "@@WGPT_PROFILE_IN_USE@@ ";
const UPDATE_RESTART_PREFIX: &str = "@@WGPT_UPDATE_RESTART@@";
const NOTIFY_PREFIX: &str = "@@WGPT_NOTIFY@@ ";
const MAX_RESTARTS_PER_MINUTE: usize = 3;

pub type ReadyCallback = Arc<dyn Fn(u16) + Send + Sync>;
pub type ExitCallback = Arc<dyn Fn(String) + Send + Sync>;
pub type RestartCallback = Arc<dyn Fn() + Send + Sync>;
pub type NotifyCallback = Arc<dyn Fn(&str) + Send + Sync>;

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    generation: u64,
}

struct State {
    running: Option<Running>,
    workspace: Option<PathBuf>,
    shutting_down: bool,
    generation: u64,
    restarts: Vec<Instant>,
    /// Set when the sidecar reported that another instance holds the profile:
    /// restarting can't help, so the shell says so instead.
    fatal: Option<String>,
}

#[derive(Clone)]
pub struct Supervisor {
    state: Arc<Mutex<State>>,
    token: String,
    on_ready: ReadyCallback,
    on_gave_up: ExitCallback,
    on_update_restart: RestartCallback,
    on_notify: NotifyCallback,
}

/// 32 random bytes, hex — goes to the sidecar over stdin and to the page via
/// the window's initialization script. Never argv, env, or a URL.
pub fn new_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("OS random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn node_binary() -> String {
    // Dev: scripts/dev-tauri.mjs passes the node running pnpm. Phase 3 bundles one.
    std::env::var("WGPT_NODE").unwrap_or_else(|_| "node".into())
}

fn sidecar_entry() -> PathBuf {
    std::env::var("WGPT_SIDECAR_MAIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../dist/sidecar/main.js")))
}

impl Supervisor {
    pub fn new(
        token: String,
        on_ready: ReadyCallback,
        on_gave_up: ExitCallback,
        on_update_restart: RestartCallback,
        on_notify: NotifyCallback,
    ) -> Self {
        Supervisor {
            state: Arc::new(Mutex::new(State {
                running: None,
                workspace: None,
                shutting_down: false,
                generation: 0,
                restarts: Vec::new(),
                fatal: None,
            })),
            token,
            on_ready,
            on_gave_up,
            on_update_restart,
            on_notify,
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn start(&self) -> Result<(), String> {
        let mut st = self.state.lock().unwrap();
        if st.running.is_some() || st.shutting_down {
            return Ok(());
        }
        st.generation += 1;
        let generation = st.generation;

        let mut cmd = Command::new(node_binary());
        cmd.arg(sidecar_entry()).arg("--parent-stdio");
        if let Some(ws) = &st.workspace {
            cmd.arg("--workspace").arg(ws);
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        // Windows: a Job Object with KILL_ON_JOB_CLOSE belongs here (Phase 2,
        // untested on this machine). Until then the stdin watchdog is the net.

        let mut child = cmd.spawn().map_err(|e| format!("could not start the sidecar ({}): {e}", node_binary()))?;
        let mut stdin = child.stdin.take();
        if let Some(pipe) = stdin.as_mut() {
            let hello = serde_json::json!({ "type": "hello", "token": self.token });
            writeln!(pipe, "{hello}").map_err(|e| format!("sidecar stdin: {e}"))?;
        }
        let stdout = child.stdout.take().expect("piped stdout");
        eprintln!("[shell] sidecar started (pid {}, generation {generation})", child.id());
        st.running = Some(Running { child, stdin, generation });
        drop(st);

        let me = self.clone();
        std::thread::spawn(move || me.pump_stdout(stdout, generation));
        Ok(())
    }

    fn pump_stdout(&self, stdout: std::process::ChildStdout, generation: u64) {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(json) = line.strip_prefix(READY_PREFIX) {
                match serde_json::from_str::<serde_json::Value>(json).ok().and_then(|v| v["port"].as_u64()) {
                    Some(port) => (self.on_ready)(port as u16),
                    None => eprintln!("[shell] unreadable READY line from sidecar"),
                }
            } else if let Some(json) = line.strip_prefix(NOTIFY_PREFIX) {
                (self.on_notify)(json);
            } else if line.starts_with(UPDATE_RESTART_PREFIX) {
                (self.on_update_restart)();
            } else if let Some(json) = line.strip_prefix(PROFILE_IN_USE_PREFIX) {
                let v = serde_json::from_str::<serde_json::Value>(json).unwrap_or_default();
                let why = format!(
                    "Another WorkspaceGPT Desktop (pid {}) is already using this profile:\n{}\n\nQuit it first. Two copies on one profile overwrite each other's settings.",
                    v["pid"],
                    v["dir"].as_str().unwrap_or("?")
                );
                self.state.lock().unwrap().fatal = Some(why);
            } else {
                println!("[sidecar] {line}");
            }
        }
        // stdout closed: the sidecar is gone (or going). Reap it and decide.
        let (status, restart) = {
            let mut st = self.state.lock().unwrap();
            let status = match st.running.take() {
                Some(mut r) if r.generation == generation => {
                    let s = r.child.wait().ok();
                    kill_group(r.child.id(), true);
                    s
                }
                other => {
                    st.running = other; // a newer generation is already running
                    return;
                }
            };
            let now = Instant::now();
            st.restarts.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
            let restart = !st.shutting_down && st.restarts.len() < MAX_RESTARTS_PER_MINUTE;
            if restart {
                st.restarts.push(now);
            }
            (status, restart && !st.shutting_down)
        };
        let (shutting_down, fatal) = {
            let mut st = self.state.lock().unwrap();
            (st.shutting_down, st.fatal.take())
        };
        if shutting_down {
            return;
        }
        if let Some(why) = fatal {
            (self.on_gave_up)(why);
            return;
        }
        eprintln!("[shell] sidecar exited unexpectedly ({status:?})");
        if restart {
            eprintln!("[shell] restarting sidecar");
            if let Err(e) = self.start() {
                (self.on_gave_up)(e);
            }
        } else {
            (self.on_gave_up)(format!("the sidecar exited {MAX_RESTARTS_PER_MINUTE} times in a minute ({status:?})"));
        }
    }

    pub fn send(&self, message: serde_json::Value) {
        let mut st = self.state.lock().unwrap();
        if let Some(pipe) = st.running.as_mut().and_then(|r| r.stdin.as_mut()) {
            if let Err(e) = writeln!(pipe, "{message}") {
                eprintln!("[shell] could not write to sidecar: {e}");
            }
        }
    }

    pub fn run_command(&self, id: &str) {
        self.send(serde_json::json!({ "type": "command", "id": id }));
    }

    /// Ask the sidecar to shut down, then make sure it and its group are gone.
    fn stop_running(&self, grace: Duration) {
        let running = self.state.lock().unwrap().running.take();
        let Some(mut r) = running else { return };
        if let Some(mut pipe) = r.stdin.take() {
            let _ = writeln!(pipe, "{}", serde_json::json!({ "type": "shutdown" }));
            drop(pipe); // EOF too: the watchdog path, in case the line is missed
        }
        let deadline = Instant::now() + grace;
        loop {
            match r.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    eprintln!("[shell] sidecar did not stop in {grace:?}; killing its process group");
                    kill_group(r.child.id(), false);
                    let _ = r.child.kill();
                    let _ = r.child.wait();
                    break;
                }
            }
        }
        // Anything still in the group (a forked worker the sidecar missed) goes too.
        kill_group(r.child.id(), true);
    }

    /// Quit: stop for good.
    pub fn shutdown(&self) {
        {
            let mut st = self.state.lock().unwrap();
            if st.shutting_down {
                return;
            }
            st.shutting_down = true;
        }
        self.stop_running(Duration::from_secs(8));
        eprintln!("[shell] sidecar stopped");
    }

    /// Open Folder…: like VS Code, a new folder means a new extension host.
    pub fn restart_with_workspace(&self, workspace: PathBuf) -> Result<(), String> {
        self.state.lock().unwrap().workspace = Some(workspace);
        {
            // Mark as intentional so the stdout pump doesn't count it as a crash.
            let mut st = self.state.lock().unwrap();
            st.shutting_down = true;
        }
        self.stop_running(Duration::from_secs(8));
        self.state.lock().unwrap().shutting_down = false;
        self.start()
    }
}

#[cfg(unix)]
fn kill_group(pid: u32, only_stragglers: bool) {
    let pgid = pid as libc::pid_t;
    unsafe {
        if !only_stragglers {
            libc::killpg(pgid, libc::SIGTERM);
            std::thread::sleep(Duration::from_millis(500));
        }
        libc::killpg(pgid, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: u32, _only_stragglers: bool) {}
