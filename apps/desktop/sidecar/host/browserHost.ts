/**
 * Registers the browser relay with every Chromium browser installed, so the
 * WorkspaceGPT Chrome extension in the user's own profile can reach this
 * sidecar (see sidecar/browser-relay.ts and the extension's
 * services/browser/browserBridge.ts).
 *
 * Chrome finds a native-messaging host by a JSON manifest in a per-browser
 * NativeMessagingHosts folder; the manifest names one executable and the
 * extension ids allowed to start it. The executable is a launcher script
 * written here, because Chrome starts hosts with a bare environment and no
 * arguments of ours: the script bakes in this sidecar's own Node binary, the
 * relay's path and the socket path. Everything is rewritten on every start,
 * since each of those paths can move between runs (app updates, --data-dir).
 *
 * Spike scope: macOS and Linux. Windows registers through the registry
 * (HKCU\Software\Google\Chrome\NativeMessagingHosts) and is not done yet.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const BROWSER_HOST_NAME = 'com.workspacegpt.bridge';

/** The Chrome Web Store listing's id. Unpacked dev builds get a path-derived id — add it via WGPT_BROWSER_EXTENSION_IDS. */
const STORE_EXTENSION_ID = 'gagogpeepmgaljpabdlpbcknjnbcaole';

/** Each browser's user-data root; a manifest is written only where that root exists. */
function browserRoots(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return [
      'Google/Chrome',
      'Google/Chrome Beta',
      'Google/Chrome Canary',
      'Chromium',
      'BraveSoftware/Brave-Browser',
      'Microsoft Edge',
      'Arc/User Data',
    ].map((p) => path.join(support, p));
  }
  if (process.platform === 'linux') {
    const config = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
    return ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].map((p) =>
      path.join(config, p)
    );
  }
  return [];
}

/** A Unix socket path must fit in sun_path (104 bytes on macOS); fall back to the temp dir when the data dir is too deep. */
export function browserSocketPath(dataRoot: string): string {
  const hash = crypto.createHash('sha256').update(dataRoot).digest('hex').slice(0, 12);
  if (process.platform === 'win32') return `\\\\.\\pipe\\workspacegpt-browser-${hash}`;
  const inRoot = path.join(dataRoot, 'browser.sock');
  return Buffer.byteLength(inRoot) < 100 ? inRoot : path.join(os.tmpdir(), `wgpt-browser-${hash}.sock`);
}

export interface BrowserHostRegistration {
  socketPath: string;
  /** Manifest files written this run. Empty means no supported browser was found. */
  manifests: string[];
}

export function registerBrowserHost(dataRoot: string, relayScript: string): BrowserHostRegistration {
  const socketPath = browserSocketPath(dataRoot);
  const manifests: string[] = [];
  if (process.platform === 'win32') {
    console.log('[browser-host] Windows registration is not implemented yet; browser tools stay off');
    return { socketPath, manifests };
  }
  if (!fs.existsSync(relayScript)) {
    console.warn(`[browser-host] relay missing at ${relayScript}; browser tools stay off`);
    return { socketPath, manifests };
  }

  const dir = path.join(dataRoot, 'browser');
  fs.mkdirSync(dir, { recursive: true });
  const launcher = path.join(dir, 'wgpt-browser-host');
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(launcher, `#!/bin/sh\nexec ${q(process.execPath)} ${q(relayScript)} ${q(socketPath)} "$@"\n`, { mode: 0o755 });

  const ids = [STORE_EXTENSION_ID, ...(process.env.WGPT_BROWSER_EXTENSION_IDS ?? '').split(',')]
    .map((id) => id.trim())
    .filter(Boolean);
  const manifest = {
    name: BROWSER_HOST_NAME,
    description: 'WorkspaceGPT Desktop browser bridge',
    path: launcher,
    type: 'stdio',
    allowed_origins: [...new Set(ids)].map((id) => `chrome-extension://${id}/`),
  };
  for (const root of browserRoots()) {
    if (!fs.existsSync(root)) continue;
    const hostsDir = path.join(root, 'NativeMessagingHosts');
    try {
      fs.mkdirSync(hostsDir, { recursive: true });
      const file = path.join(hostsDir, `${BROWSER_HOST_NAME}.json`);
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
      manifests.push(file);
    } catch (err) {
      console.warn(`[browser-host] could not register with ${root}:`, err);
    }
  }
  console.log(`[browser-host] registered with ${manifests.length} browser(s); socket ${socketPath}`);
  return { socketPath, manifests };
}
