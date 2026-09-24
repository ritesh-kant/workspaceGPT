/**
 * The seam between the compat module (what extension code calls) and the
 * desktop host (main.ts: the WebSocket, the app data dir, the Tauri shell).
 *
 * The compat module never imports the host. The host fills these hooks in at
 * startup, before the extension's activate() runs; until it does, the
 * defaults below make the gap visible instead of hiding it.
 */

export type MessageSeverity = 'info' | 'warning' | 'error';

export interface ShowMessageRequest {
  severity: MessageSeverity;
  message: string;
  detail?: string;
  modal: boolean;
  /** Button titles, in order. */
  items: string[];
}

export interface QuickPickRequest {
  items: { label: string; description?: string; detail?: string }[];
  placeHolder?: string;
  title?: string;
  canPickMany?: boolean;
}

export interface InputBoxRequest {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password?: boolean;
}

export interface DesktopUi {
  /** Resolves to the chosen button title, or undefined when dismissed / nobody is connected. */
  showMessage(req: ShowMessageRequest): Promise<string | undefined>;
  /** Resolves to the chosen item indexes, or undefined when dismissed. */
  showQuickPick(req: QuickPickRequest): Promise<number[] | undefined>;
  showInputBox(req: InputBoxRequest): Promise<string | undefined>;
}

/** LSP shapes (0-based lines, UTF-16 columns — the same as VS Code's). */
export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspLocation {
  fsPath: string;
  range: LspRange;
}
export interface LspSymbol extends LspLocation {
  name: string;
  /** LSP SymbolKind (1-based; vscode.SymbolKind is this minus one). */
  kind: number;
  containerName?: string;
}
export interface LspDiagnostic {
  range: LspRange;
  message: string;
  /** LSP DiagnosticSeverity (1 = error … 4 = hint; vscode's is this minus one). */
  severity?: number;
  source?: string;
  code?: string | number;
}

/** What VS Code's language extensions provide; host/languageService.ts implements it for JS/TS. */
export interface DesktopLanguageService {
  /** Whether a language server covers this file. */
  supports(fsPath: string): boolean;
  /** A document was opened or written: the server should see its current text. */
  touch(fsPath: string, edited: boolean): void;
  workspaceSymbols(query: string): Promise<LspSymbol[]>;
  locations(kind: 'definition' | 'references', fsPath: string, position: LspPosition): Promise<LspLocation[]>;
  /** Synchronous, like languages.getDiagnostics; throws while a requested file is still being checked. */
  diagnostics(fsPath?: string): { fsPath: string; items: LspDiagnostic[] }[];
}

export interface DesktopRuntime {
  appName: string;
  appVersion: string;
  machineId: string;
  /** Directory holding the extension's package.json, webview/dist, resources. */
  extensionDir: string;
  /** Absolute workspace folder paths, in order. Mutated through setWorkspaceFolders(). */
  workspaceFolders: string[];
  /** Persisted `workspace.getConfiguration()` overrides (section.key → value). */
  readSettings(): Record<string, unknown>;
  writeSettings(values: Record<string, unknown>): void;
  ui: DesktopUi;
  openExternal(target: string): Promise<boolean>;
  /** Open a file in the user's own editor (the desktop has no embedded editor). */
  openInEditor(file: string, line?: number): Promise<void>;
  clipboardWrite(text: string): Promise<void>;
  clipboardRead(): Promise<string>;
  /** Undefined until the host provides one; the compat APIs that need it then report the gap. */
  languageService?: DesktopLanguageService;
}

const logOnlyUi: DesktopUi = {
  async showMessage(req) {
    console.log(`[desktop:${req.severity}] ${req.message}${req.items.length ? ` [${req.items.join(' | ')}]` : ''}`);
    return undefined;
  },
  async showQuickPick(req) {
    console.log(`[desktop:quickpick] ${req.placeHolder ?? ''} — no UI connected, dismissed`);
    return undefined;
  },
  async showInputBox(req) {
    console.log(`[desktop:inputbox] ${req.prompt ?? ''} — no UI connected, dismissed`);
    return undefined;
  },
};

function unconfigured(name: string): never {
  throw new Error(`vscode-compat runtime.${name} used before the desktop host configured it`);
}

export const runtime: DesktopRuntime = {
  appName: 'WorkspaceGPT Desktop',
  appVersion: '0.0.0',
  machineId: '',
  extensionDir: '',
  workspaceFolders: [],
  readSettings: () => ({}),
  writeSettings: () => unconfigured('writeSettings'),
  ui: logOnlyUi,
  openExternal: async () => unconfigured('openExternal'),
  openInEditor: async () => unconfigured('openInEditor'),
  clipboardWrite: async () => unconfigured('clipboardWrite'),
  clipboardRead: async () => unconfigured('clipboardRead'),
};

export function configureRuntime(patch: Partial<DesktopRuntime>): void {
  Object.assign(runtime, patch);
}
