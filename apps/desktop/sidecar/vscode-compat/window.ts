/**
 * `vscode.window`: notifications and pickers go to the desktop UI (the bridge
 * draws them over the chat); the chat webview view is handed to the host,
 * which binds it to the WebSocket; editor-shaped APIs hand off to the user's
 * own editor, because the desktop has none.
 */
import { runtime } from './runtime';
import { notSupported, noteInert } from './notSupported';
import { Disposable, EventEmitter, Position, Range, Selection, ThemeColor, Uri, neverEvent } from './types';
import type { TextDocument } from './workspace';

// ── Messages ────────────────────────────────────────────────────────────────

type MessageItem = string | { title: string; isCloseAffordance?: boolean };

function showMessage(severity: 'info' | 'warning' | 'error') {
  return async (message: string, ...rest: any[]): Promise<any> => {
    let options: { modal?: boolean; detail?: string } = {};
    if (rest.length && rest[0] && typeof rest[0] === 'object' && !('title' in rest[0])) options = rest.shift();
    const items = rest.filter((i): i is MessageItem => i !== undefined && i !== null);
    const titles = items.map((i) => (typeof i === 'string' ? i : i.title));
    const chosen = await runtime.ui.showMessage({
      severity,
      message,
      detail: options.detail,
      modal: !!options.modal,
      items: titles,
    });
    if (chosen === undefined) return undefined;
    return items[titles.indexOf(chosen)];
  };
}

async function showQuickPick(itemsOrPromise: any, options?: { placeHolder?: string; title?: string; canPickMany?: boolean }): Promise<any> {
  const items: any[] = await itemsOrPromise;
  const normalized = items.map((i) => (typeof i === 'string' ? { label: i } : { label: i.label, description: i.description, detail: i.detail }));
  const picked = await runtime.ui.showQuickPick({
    items: normalized,
    placeHolder: options?.placeHolder,
    title: options?.title,
    canPickMany: options?.canPickMany,
  });
  if (!picked) return undefined;
  return options?.canPickMany ? picked.map((i) => items[i]) : items[picked[0]!];
}

async function showInputBox(options?: {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password?: boolean;
  validateInput?: (v: string) => any;
}): Promise<string | undefined> {
  // Re-ask until the extension's own validator accepts, as VS Code's box does.
  let value = options?.value;
  let prompt = options?.prompt;
  for (;;) {
    const answer = await runtime.ui.showInputBox({ ...options, value, prompt });
    if (answer === undefined) return undefined;
    const problem = await options?.validateInput?.(answer);
    const text = typeof problem === 'string' ? problem : problem?.message;
    if (!text) return answer;
    value = answer;
    prompt = `${options?.prompt ?? ''}\n⚠ ${text}`.trim();
  }
}

// ── Webview views (the chat surface) ────────────────────────────────────────

export interface RegisteredWebviewView {
  provider: { resolveWebviewView(view: any, context: any, token: any): any };
  options?: { webviewOptions?: { retainContextWhenHidden?: boolean } };
}

/** The host (main.ts) looks providers up here and binds them to the socket. */
export const webviewViewProviders = new Map<string, RegisteredWebviewView>();
const providerRegistered = new EventEmitter<string>();
export const onWebviewViewProviderRegistered = providerRegistered.event;

function registerWebviewViewProvider(viewId: string, provider: RegisteredWebviewView['provider'], options?: RegisteredWebviewView['options']): Disposable {
  webviewViewProviders.set(viewId, { provider, options });
  providerRegistered.fire(viewId);
  return new Disposable(() => webviewViewProviders.delete(viewId));
}

// ── Editor hand-off ─────────────────────────────────────────────────────────

/**
 * The desktop has no editor, so "show this document" opens the file in the
 * user's own editor. The extension sets `selection` / calls `revealRange`
 * right after the await, so the hand-off waits one macrotask to learn the line.
 */
async function showTextDocument(docOrUri: TextDocument | Uri, _options?: unknown) {
  const uri = docOrUri instanceof Uri ? docOrUri : docOrUri.uri;
  let line: number | undefined;
  let selection = new Selection(new Position(0, 0), new Position(0, 0));
  setImmediate(() => {
    void runtime.openInEditor(uri.fsPath, line).catch((err) => console.error('[vscode-compat] openInEditor failed:', err));
  });
  return {
    document: docOrUri instanceof Uri ? undefined : docOrUri,
    get selection() {
      return selection;
    },
    set selection(s: Selection) {
      selection = s;
      line = s.active.line + 1;
    },
    selections: [] as Selection[],
    revealRange(range: Range) {
      line ??= range.start.line + 1;
    },
    edit: notSupported('TextEditor.edit', 'edits go through workspace.applyEdit in the desktop'),
  };
}

// ── Output channels, status bar ─────────────────────────────────────────────

function createOutputChannel(name: string, _languageOrOptions?: unknown) {
  const tag = `[output:${name}]`;
  let partial = '';
  const flush = (text: string) => {
    partial += text;
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const l of lines) console.log(tag, l);
  };
  const log = (level: string) => (msg: string, ...args: unknown[]) => console.log(tag, level, msg, ...args);
  return {
    name,
    append: flush,
    appendLine: (line: string) => flush(`${line}\n`),
    replace: (text: string) => flush(`${text}\n`),
    clear: () => undefined,
    show: () => noteInert('OutputChannel.show'),
    hide: () => undefined,
    dispose: () => undefined,
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}

/** No status bar in the desktop window; the item keeps its state so callers can read it back. */
function createStatusBarItem(_alignment?: number, _priority?: number) {
  noteInert('window.createStatusBarItem');
  return {
    text: '',
    tooltip: undefined as string | undefined,
    color: undefined as string | ThemeColor | undefined,
    command: undefined as string | undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  };
}

// ── Namespace ───────────────────────────────────────────────────────────────

export const window = {
  showInformationMessage: showMessage('info'),
  showWarningMessage: showMessage('warning'),
  showErrorMessage: showMessage('error'),
  showQuickPick,
  showInputBox,
  registerWebviewViewProvider,
  showTextDocument,
  createOutputChannel,
  createStatusBarItem,
  /** "Open chat in editor" moves the chat into a VS Code editor tab; the desktop window already is the chat. */
  createWebviewPanel: notSupported('window.createWebviewPanel', 'the desktop window already shows the chat full-size'),
  /** No editor tab groups exist, so there is nothing to list or close. */
  tabGroups: {
    get all() {
      noteInert('window.tabGroups.all');
      return [] as unknown[];
    },
    close: async () => {
      noteInert('window.tabGroups.close');
      return true;
    },
    onDidChangeTabs: neverEvent<unknown>(),
  },
};
