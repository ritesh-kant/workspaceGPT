/**
 * Where the desktop keeps its data, and the JSON stores behind
 * `context.globalState` / `workspaceState` / `workspace.getConfiguration()`.
 *
 * Deliberately NOT the VS Code extension's globalStorage directory: two
 * processes writing the same chats/*.json is exactly the stale-history
 * overwrite bug (DESKTOP-TAURI-PLAN.md, challenge #11).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface AppPaths {
  root: string;
  stateFile: string;
  settingsFile: string;
  storageDir: string;
  workspaceStateDir: string;
  logDir: string;
  machineIdFile: string;
}

export function resolveAppPaths(override?: string): AppPaths {
  const root =
    override ??
    process.env.WGPT_DESKTOP_DATA_DIR ??
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'WorkspaceGPT Desktop')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'WorkspaceGPT Desktop')
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'workspacegpt-desktop'));
  const paths: AppPaths = {
    root,
    stateFile: path.join(root, 'state.json'),
    settingsFile: path.join(root, 'settings.json'),
    storageDir: path.join(root, 'storage'),
    workspaceStateDir: path.join(root, 'workspace-state'),
    logDir: path.join(root, 'logs'),
    machineIdFile: path.join(root, 'machine-id'),
  };
  for (const dir of [root, paths.storageDir, paths.workspaceStateDir, paths.logDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/** A random id saved on first run — `vscode.env.machineId` for the desktop (challenge #13). */
export function loadMachineId(paths: AppPaths): string {
  try {
    const existing = fs.readFileSync(paths.machineIdFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const id = crypto.randomUUID();
  fs.writeFileSync(paths.machineIdFile, id);
  return id;
}

export function workspaceStateFile(paths: AppPaths, folder: string | undefined): string {
  const key = folder ? crypto.createHash('sha1').update(path.resolve(folder)).digest('hex').slice(0, 16) : 'no-folder';
  return path.join(paths.workspaceStateDir, `${key}.json`);
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * A JSON object persisted with write-to-temp + rename, writes coalesced so a
 * burst of `globalState.update` calls (indexing progress) costs one write.
 *
 * Values are held by reference like VS Code's Memento: code that mutates the
 * object it got from `get()` and passes it back to `update()` sees its change.
 */
export class JsonStore {
  private data: Record<string, unknown>;
  private timer: NodeJS.Timeout | undefined;
  private waiters: (() => void)[] = [];

  constructor(readonly file: string) {
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        // Keep the unreadable file for forensics rather than overwriting it.
        const aside = `${file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(file, aside);
        } catch {
          /* ignore */
        }
        console.error(`[desktop] ${file} was unreadable (${err?.message}); moved to ${aside}`);
      }
      this.data = {};
    }
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return key in this.data ? (this.data[key] as T) : defaultValue;
  }

  keys(): readonly string[] {
    return Object.keys(this.data);
  }

  all(): Record<string, unknown> {
    return this.data;
  }

  replaceAll(next: Record<string, unknown>): void {
    this.data = next;
    this.flushSync();
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    return this.scheduleWrite();
  }

  private scheduleWrite(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.timer ??= setTimeout(() => this.flushSync(), 50);
    });
  }

  flushSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      writeAtomic(this.file, JSON.stringify(this.data, null, 1));
    } catch (err) {
      console.error(`[desktop] could not write ${this.file}:`, err);
    }
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }
}

/** `vscode.Memento` over a JsonStore. */
export function memento(store: JsonStore) {
  return {
    get: <T>(key: string, defaultValue?: T) => store.get<T>(key, defaultValue),
    update: (key: string, value: unknown) => store.update(key, value),
    keys: () => store.keys(),
    setKeysForSync: (_keys: readonly string[]) => undefined,
  };
}
