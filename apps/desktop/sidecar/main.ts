/**
 * WorkspaceGPT Desktop sidecar.
 *
 * Runs the VS Code extension's host code — unchanged — under plain Node:
 * `vscode` is aliased to ./vscode-compat at bundle time, the real activate()
 * gets a desktop ExtensionContext, and the chat webview view is served to a
 * browser page / Tauri window over a loopback WebSocket.
 *
 *   node dist/sidecar/main.js --workspace ~/code/repo --open     # headless: opens your browser
 *   node dist/sidecar/main.js --parent-stdio                      # under Tauri (see src-tauri)
 *
 * Flags:
 *   --workspace <dir>     folder the agent works in (default: last used, else none)
 *   --port <n>            fixed port (default: random)
 *   --data-dir <dir>      app data dir (default: ~/Library/Application Support/WorkspaceGPT Desktop)
 *   --extension-dir <dir> extension package root (default: ../vscode-extensions in the repo)
 *   --open                open the chat in the default browser once ready
 *   --parent-stdio        run as a child of the Tauri shell: print one READY line on
 *                         stdout, take JSON commands on stdin, exit when stdin closes
 *   --allow-origin <o>    extra Origin allowed on the socket (repeatable)
 *   --detached            headless: keep running after the launching process exits
 *                         (default: shut down with it, so no sidecar is orphaned)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as compat from './vscode-compat';
import { configureRuntime } from './vscode-compat/runtime';
import { onDidChangeWorkspaceFolders, setWorkspaceFolders } from './vscode-compat/workspace';
import { runtime } from './vscode-compat/runtime';
import { createLanguageService } from './host/languageService';
import { createDiffPanel } from './host/diffPanel';
import { webviewViewProviders, window as compatWindow } from './vscode-compat/window';
import { apiHits, inertHits, notSupportedHits } from './vscode-compat/notSupported';
import { contextKeys, contextKeysChanged } from './vscode-compat/commands';
import { computeTitleActions } from './host/titleActions';
import { installWorkerTrace } from './host/workerTrace';
import { executeCommand as runExtensionCommand } from 'workspacegpt-extension-commands';
import { JsonStore, loadMachineId, resolveAppPaths } from './host/stores';
import { acquireProfileLock, PROFILE_IN_USE_PREFIX, ProfileInUseError } from './host/profileLock';
import { createExtensionContext } from './host/extensionContext';
import { createViewSurface, type ViewSurface } from './host/webviewHost';
import { watchForAttention } from './host/notifier';
import { registerBrowserHost } from './host/browserHost';
import { startBrowserBridge } from 'workspacegpt-extension-browser';
import { recordOriginalContent } from 'workspacegpt-extension-diff';
import { startServer, type DesktopServer } from './host/server';
import { mergeLoginShellPath, type ShellPathResult } from './host/shellEnv';
import { clipboardRead, clipboardWrite, openExternal, openInEditor } from './host/opener';
import { installProcessReaper, killChildrenSync, liveChildren, reapChildren } from './host/processReaper';
// Aliased in esbuild.config.mjs to apps/vscode-extensions/src/extension.ts.
import * as extension from 'workspacegpt-extension-host';

export const READY_PREFIX = '@@WGPT_READY@@ ';
/** src-tauri/src/sidecar.rs: the user picked Restart Now on the update notice. */
const UPDATE_RESTART_PREFIX = '@@WGPT_UPDATE_RESTART@@';
/** src-tauri/src/notify.rs: a run needs the user (approval, question) or finished. */
const NOTIFY_PREFIX = '@@WGPT_NOTIFY@@ ';
const CHAT_VIEW_ID = 'workspacegpt.chatView';
/**
 * In VS Code this list sits in the primary sidebar while the chat is
 * maximized in an editor tab; the desktop shell shows it that way all the time.
 */
const SESSIONS_VIEW_ID = 'workspacegpt.sessionsView';
const APP_VERSION = process.env.WGPT_DESKTOP_VERSION ?? 'dev';

interface Args {
  workspace?: string;
  port: number;
  dataDir?: string;
  extensionDir?: string;
  open: boolean;
  parentStdio: boolean;
  detached: boolean;
  allowOrigins: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { port: 0, open: false, parentStdio: false, detached: false, allowOrigins: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--workspace':
        a.workspace = path.resolve(next());
        break;
      case '--port':
        a.port = Number(next());
        break;
      case '--data-dir':
        a.dataDir = path.resolve(next());
        break;
      case '--extension-dir':
        a.extensionDir = path.resolve(next());
        break;
      case '--open':
        a.open = true;
        break;
      case '--parent-stdio':
        a.parentStdio = true;
        break;
      case '--allow-origin':
        a.allowOrigins.push(next());
        break;
      case '--detached':
        a.detached = true;
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return a;
}

/**
 * First line from the Tauri shell: {"type":"hello","token":"…"}. Read with a
 * one-shot listener so the command loop set up later sees every later line.
 */
let stdinBuffered = '';
/**
 * Parent-death watchdog: the Tauri shell holds our stdin, so when it quits —
 * cleanly or by force-quit — the pipe closes. Armed right after the hello, so
 * a shell that dies while we're still activating is caught too; main() swaps
 * in the full shutdown once it exists.
 */
let onParentGone: () => void = () => {
  killChildrenSync();
  process.exit(0);
};
let stdinLineHandler: ((line: string) => void) | undefined;
function drainStdin(): void {
  if (!stdinLineHandler) return;
  let nl: number;
  while ((nl = stdinBuffered.indexOf('\n')) !== -1) {
    const line = stdinBuffered.slice(0, nl).trim();
    stdinBuffered = stdinBuffered.slice(nl + 1);
    if (line) stdinLineHandler(line);
  }
}
function armWatchdog(): void {
  process.stdin.on('end', () => onParentGone());
  process.stdin.on('close', () => onParentGone());
}
function readShellHello(timeoutMs = 10_000): Promise<string> {
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no hello from the shell on stdin')), timeoutMs);
    const onData = (chunk: string) => {
      stdinBuffered += chunk;
      const nl = stdinBuffered.indexOf('\n');
      if (nl === -1) return;
      const line = stdinBuffered.slice(0, nl);
      stdinBuffered = stdinBuffered.slice(nl + 1);
      process.stdin.off('data', onData);
      clearTimeout(timer);
      // Keep reading so EOF is seen even before main() takes over; lines are
      // held until main() installs its handler.
      process.stdin.on('data', (more: string) => {
        stdinBuffered += more;
        drainStdin();
      });
      armWatchdog();
      try {
        const hello = JSON.parse(line);
        if (hello.type !== 'hello' || typeof hello.token !== 'string' || hello.token.length < 32) throw new Error('bad hello');
        resolve(hello.token);
      } catch (err) {
        reject(err);
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

// VS Code's extension host logs a stray rejection and keeps going; a desktop
// sidecar that dies on one would take every chat down with it.
process.on('unhandledRejection', (reason) => console.error('[desktop] unhandled rejection:', reason));
// Once the shell is gone our stdout pipe is too; a log line must not become
// an EPIPE exception while the watchdog is shutting down.
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);
process.on('uncaughtException', (err) => console.error('[desktop] uncaught exception:', err));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  installProcessReaper();
  installWorkerTrace();

  const paths = resolveAppPaths(args.dataDir);
  try {
    acquireProfileLock(paths.root);
  } catch (err) {
    if (!(err instanceof ProfileInUseError)) throw err;
    // The shell reads this line and says so instead of restarting us.
    if (args.parentStdio) process.stdout.write(`${PROFILE_IN_USE_PREFIX}${JSON.stringify({ pid: err.pid, dir: err.dir })}\n`);
    console.error(
      `\n  ✖ WorkspaceGPT Desktop is already running on this profile (pid ${err.pid}).\n` +
        `    ${err.dir}\n` +
        `    Two copies on one profile overwrite each other's settings, so this one won't start.\n` +
        `    Quit the other copy (or: kill ${err.pid}), or give this one its own profile with --data-dir <dir>.\n`
    );
    process.exit(75);
  }
  const desktopPrefs = new JsonStore(path.join(paths.root, 'desktop.json'));

  // Before anything spawns: Finder-launched apps have a bare PATH. A slow rc
  // file (nvm, conda) can take seconds, so the first launch waits for the
  // probe and saves the result; later launches use the saved PATH at once and
  // refresh it in the background for next time.
  const cachedPath = desktopPrefs.get<string>('loginShellPath');
  let shellPath: ShellPathResult;
  if (cachedPath) {
    const before = process.env.PATH ?? '';
    process.env.PATH = [...new Set([...cachedPath.split(path.delimiter), ...before.split(path.delimiter)].filter(Boolean))].join(path.delimiter);
    shellPath = { shell: process.env.SHELL ?? '', merged: true, added: [], path: process.env.PATH, error: 'from cache; refreshing' };
    void mergeLoginShellPath(10_000).then((fresh) => {
      if (fresh.merged) void desktopPrefs.update('loginShellPath', fresh.path);
    });
    console.log('[desktop] login-shell PATH merged from cache (refreshing in background)');
  } else {
    shellPath = await mergeLoginShellPath(8000);
    if (shellPath.merged) void desktopPrefs.update('loginShellPath', shellPath.path);
    console.log(
      shellPath.merged
        ? `[desktop] login-shell PATH merged from ${shellPath.shell} (+${shellPath.added.length} entries)`
        : `[desktop] login-shell PATH not merged (${shellPath.error ?? 'n/a'}); using inherited PATH`
    );
  }
  // Packaged (scripts/stage-runtime.mjs): runtime/extension sits next to runtime/sidecar. Dev: the repo checkout.
  const packagedExtension = path.resolve(__dirname, '../extension');
  const extensionDir =
    args.extensionDir ??
    process.env.WGPT_EXTENSION_DIR ??
    (fs.existsSync(path.join(packagedExtension, 'package.json')) ? packagedExtension : path.resolve(__dirname, '../../../vscode-extensions'));
  if (!fs.existsSync(path.join(extensionDir, 'package.json'))) {
    throw new Error(`extension package not found at ${extensionDir} (pass --extension-dir)`);
  }
  if (!fs.existsSync(path.join(extensionDir, 'webview', 'dist', 'index.html'))) {
    throw new Error(`webview build missing at ${extensionDir}/webview/dist — run \`pnpm --filter workspacegpt-extension build\``);
  }
  if (!fs.existsSync(path.join(__dirname, 'workers'))) {
    throw new Error(`${__dirname}/workers missing — run \`pnpm --filter desktop build\` after building the extension`);
  }

  const workspace = args.workspace ?? desktopPrefs.get<string>('lastWorkspace');
  const folders = workspace && fs.existsSync(workspace) ? [workspace] : [];
  if (folders[0]) void desktopPrefs.update('lastWorkspace', folders[0]);

  const settings = new JsonStore(paths.settingsFile);
  // Starts typescript-language-server on first use, not here.
  const languageService = createLanguageService({ nodePath: process.execPath, workspaceFolders: () => runtime.workspaceFolders });
  onDidChangeWorkspaceFolders(() => languageService.restart());
  configureRuntime({
    languageService,
    appName: 'WorkspaceGPT Desktop',
    appVersion: APP_VERSION,
    machineId: loadMachineId(paths),
    extensionDir,
    readSettings: () => settings.all(),
    writeSettings: (values) => settings.replaceAll(values),
    openExternal,
    openInEditor,
    clipboardWrite,
    clipboardRead,
  });
  setWorkspaceFolders(folders);

  // The server must be listening before the view resolves: asWebviewUri and
  // cspSource are built from its port.
  let server: DesktopServer | undefined;
  const origin = () => server?.origin ?? 'http://127.0.0.1';
  const surface = createViewSurface(CHAT_VIEW_ID, origin, () => [extensionDir]);
  const sessionsSurface = createViewSurface(SESSIONS_VIEW_ID, origin, () => [extensionDir]);
  const surfaces = new Map<string, ViewSurface>([
    [CHAT_VIEW_ID, surface],
    [SESSIONS_VIEW_ID, sessionsSurface],
  ]);
  // Notifications and questions show over the chat, the main pane.
  configureRuntime({ ui: surface.ui });
  // Under the shell, the token comes from the shell (first stdin line) so it
  // outlives a sidecar restart: the window's initialization script keeps
  // working and only the port changes. Headless mints its own.
  const token = args.parentStdio ? await readShellHello() : crypto.randomBytes(32).toString('base64url');
  server = await startServer({
    port: args.port,
    token,
    surfaces,
    desktopAssetsDir: path.join(__dirname, '..', 'bridge'),
    extraOrigins: ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', ...args.allowOrigins],
    log: (l) => console.log(l),
  });

  const ctx = createExtensionContext({ paths, extensionDir, workspaceFolder: folders[0] });
  console.log(`[desktop] data dir ${paths.root}; secrets in ${ctx.secretsBackend}; workspace ${folders[0] ?? '(none)'}`);
  // McpUiManager's first-run toast offers "Connect MCP", which writes the host
  // editor's mcp.json; the desktop has no editor (and no MCP Server page), so
  // it would greet a new user over the onboarding card with a dead end.
  // Marking it shown is the extension's own opt-out.
  if (!ctx.globalState.get('workspacegpt.mcp_welcome_shown')) void ctx.globalState.update('workspacegpt.mcp_welcome_shown', true);

  await extension.activate(ctx.context);
  const activatedAt = Date.now();
  // The Chrome extension in the user's own profile reaches the agent through
  // this (sidecar/browser-relay.ts). Failing here only means no browser tools.
  try {
    startBrowserBridge(registerBrowserHost(paths.root, path.join(__dirname, 'browser-relay.js')).socketPath);
  } catch (err) {
    console.warn('[desktop] browser bridge not started:', err);
  }

  const chat = webviewViewProviders.get(CHAT_VIEW_ID);
  if (!chat) throw new Error(`activate() registered no provider for ${CHAT_VIEW_ID}`);
  await chat.provider.resolveWebviewView(surface.view, { state: undefined }, new compat.CancellationTokenSource().token);
  // The Sessions list is optional: an extension build without it still gets a
  // working chat, and the shell falls back to the chat's own History button.
  const sessions = webviewViewProviders.get(SESSIONS_VIEW_ID);
  if (sessions) {
    // As in VS Code, the list follows the chat's Chat/Work switch (the two
    // keep separate histories), and Work sessions are grouped by folder.
    await sessions.provider.resolveWebviewView(sessionsSurface.view, { state: undefined }, new compat.CancellationTokenSource().token);
  } else {
    surfaces.delete(SESSIONS_VIEW_ID);
  }
  console.log(`[desktop] activated in ${activatedAt - startedAt} ms; chat view resolved${sessions ? ', sessions view resolved' : ''}`);
  // Review-panel test only: record <file>'s current text as the agent's
  // pre-edit original, as agentWriteTools does before its first write, so an
  // edit made by hand afterwards shows up in the files-changed review.
  if (process.env.WGPT_DESKTOP_TEST_DIFF) {
    const file = path.resolve(process.env.WGPT_DESKTOP_TEST_DIFF);
    recordOriginalContent(file, fs.readFileSync(file, 'utf8'));
    console.warn(`[desktop] WGPT_DESKTOP_TEST_DIFF: recorded the original of ${file}`);
  }

  // Approval waiting / question asked / run finished → the shell, which
  // posts a native notification when the window isn't in front. Headless
  // has no shell to ask, so it only logs.
  watchForAttention(surface, (attention) => {
    if (args.parentStdio) process.stdout.write(`${NOTIFY_PREFIX}${JSON.stringify(attention)}\n`);
    else console.log(`[desktop] notify (${attention.kind}): ${attention.title} — ${attention.body.replace(/\n/g, ' · ')}`);
  });

  // Title-bar actions (New Chat, History, Settings) — VS Code draws these
  // outside the webview, so the bridge draws them here.
  let titleActions = computeTitleActions(extensionDir, CHAT_VIEW_ID, contextKeys);
  const pushToolbar = () => surface.sendControl({ t: 'toolbar', items: titleActions });
  surface.attached.event(pushToolbar);
  contextKeysChanged.event(() => {
    titleActions = computeTitleActions(extensionDir, CHAT_VIEW_ID, contextKeys);
    pushToolbar();
  });
  // vscode.diff → the review panel the chat frame draws.
  const diffPanel = createDiffPanel(surface, () => runtime.workspaceFolders);
  configureRuntime({ showDiff: diffPanel.show });
  surface.diffActionRequested.event(({ file, action, idx }) => {
    diffPanel.act(file, action, idx).catch((err) => console.error(`[desktop] diff ${action} failed:`, err));
  });

  surface.commandRequested.event((id) => {
    if (!titleActions.some((a) => a.command === id)) {
      console.warn(`[desktop] page asked for command ${id}, which is not a title action — ignored`);
      return;
    }
    compat.commands.executeCommand(id).catch((err) => console.error(`[desktop] ${id} failed:`, err));
  });
  pushToolbar();

  // ── Shutdown ──
  let shuttingDown = false;
  const writeDiagnostics = () => {
    const diag = {
      at: new Date().toISOString(),
      uptimeMs: Date.now() - startedAt,
      rssBytes: process.memoryUsage().rss,
      apiHits: Object.fromEntries([...apiHits].sort((a, b) => b[1] - a[1])),
      notSupportedHits: Object.fromEntries(notSupportedHits),
      inertHits: Object.fromEntries(inertHits),
      contextKeys: Object.fromEntries(contextKeys),
      liveChildren: liveChildren(),
      messages: Object.fromEntries([...surfaces].map(([id, s]) => [id, s.stats])),
      shellPath,
      secrets: ctx.secretsBackend,
    };
    fs.writeFileSync(path.join(paths.logDir, 'compat-hits.json'), JSON.stringify(diag, null, 2));
    return diag;
  };
  const shutdown = async (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[desktop] shutting down (${why})`);
    const hardStop = setTimeout(() => {
      killChildrenSync();
      process.exit(1);
    }, 8000);
    hardStop.unref();
    try {
      writeDiagnostics();
    } catch (err) {
      console.error('[desktop] could not write diagnostics:', err);
    }
    for (const s of surfaces.values()) s.dispose();
    languageService.dispose();
    await Promise.race([Promise.resolve(extension.deactivate?.()).catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
    await Promise.race([ctx.dispose(), new Promise((r) => setTimeout(r, 2000))]);
    const reaped = await reapChildren();
    // After a force-quit nobody reads our stdout; leave the evidence on disk.
    try {
      fs.writeFileSync(path.join(paths.logDir, 'last-shutdown.json'), JSON.stringify({ at: new Date().toISOString(), why, reaped }, null, 2));
    } catch {
      /* best effort */
    }
    desktopPrefs.flushSync();
    settings.flushSync();
    await server?.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  process.on('exit', () => killChildrenSync());
  // Diagnostics on demand: `kill -USR2 <pid>` writes logs/compat-hits.json.
  process.on('SIGUSR2', () => console.log('[desktop] diagnostics:', JSON.stringify(writeDiagnostics())));

  if (args.parentStdio) {
    onParentGone = () => void shutdown('parent closed stdin');
    // Commands from the shell's menu / tray, one JSON object per line.
    const handleLine = (line: string) => {
      try {
        const cmd = JSON.parse(line);
        if (cmd.type === 'shutdown') void shutdown('shell asked');
        else if (cmd.type === 'update-ready' && typeof cmd.version === 'string') {
          // src-tauri/src/updater.rs downloaded and verified an update; the shell
          // installs it when the app exits, so this notice only offers doing it now.
          void compatWindow
            .showInformationMessage(
              `WorkspaceGPT v${cmd.version} is ready. Restart to install it, or keep working: it installs the next time you quit.`,
              'Restart Now',
              'Later'
            )
            .then((choice) => {
              if (choice === 'Restart Now') process.stdout.write(`${UPDATE_RESTART_PREFIX} {}\n`);
            });
        } else if (cmd.type === 'diagnostics') console.log('[desktop] diagnostics:', JSON.stringify(writeDiagnostics()));
        else if (cmd.type === 'command' && typeof cmd.id === 'string' && titleActions.some((a) => a.command === cmd.id)) {
          compat.commands.executeCommand(cmd.id).catch((err) => console.error(`[desktop] ${cmd.id} failed:`, err));
        } else console.warn('[desktop] unknown shell command', cmd.type);
      } catch {
        console.warn('[desktop] bad line from shell on stdin');
      }
    };
    stdinLineHandler = handleLine;
    drainStdin();
    // Test automation only: lets a browser tab (or a probe) join the socket
    // the Tauri window uses. Opt-in, 0600, and loudly logged.
    if (process.env.WGPT_DESKTOP_DEBUG_TOKEN_FILE) {
      fs.writeFileSync(process.env.WGPT_DESKTOP_DEBUG_TOKEN_FILE, `${server.origin}/#t=${token}\n`, { mode: 0o600 });
      console.warn(`[desktop] WGPT_DESKTOP_DEBUG_TOKEN_FILE set: socket link written to ${process.env.WGPT_DESKTOP_DEBUG_TOKEN_FILE}`);
    }
    // Orphan test only: start a long command through the extension's own
    // run_command spawn path (detached process group), so a force-quit can
    // be tested mid-command without depending on what the model decides.
    if (process.env.WGPT_DESKTOP_TEST_COMMAND) {
      const cmd = process.env.WGPT_DESKTOP_TEST_COMMAND;
      console.warn(`[desktop] WGPT_DESKTOP_TEST_COMMAND: running "${cmd}" via commandTools.executeCommand`);
      void runExtensionCommand(cmd, folders[0] ?? process.cwd(), 600).then((r) => console.log(`[desktop] test command exited ${r.exitCode}`));
    }
    // The one line the shell parses. The token already went the other way
    // over this pipe; it is never in argv, env or a URL.
    process.stdout.write(`${READY_PREFIX}${JSON.stringify({ port: server.port, pid: process.pid, workspace: folders[0] ?? null })}\n`);
  } else {
    // Headless: the token rides in the fragment, which browsers never send to
    // the server; the bridge moves it to sessionStorage and strips it.
    const url = `${server.origin}/#t=${token}`;
    console.log(`\n  WorkspaceGPT Desktop (headless) is running\n  → ${url}\n  workspace: ${folders[0] ?? '(none — pass --workspace <dir>)'}\n`);
    if (args.open) void openExternal(url);
    // Headless has no stdin watchdog, so a launcher that dies without
    // signalling us (terminal closed, kill -9 of pnpm) would leave this
    // sidecar — and its search worker, and the profile lock — behind.
    // Reparenting is the tell: follow the launcher out.
    const launcher = process.ppid;
    if (!args.detached && launcher > 1) {
      setInterval(() => {
        if (process.ppid !== launcher) void shutdown(`the process that started it (pid ${launcher}) exited`);
      }, 2000).unref();
    }
  }
}

main().catch((err) => {
  console.error('[desktop] failed to start:', err);
  killChildrenSync();
  process.exit(1);
});

