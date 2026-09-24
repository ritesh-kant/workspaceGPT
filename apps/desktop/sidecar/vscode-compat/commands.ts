/**
 * `vscode.commands`: the extension's own commands run from a registry; VS Code
 * built-ins are resolved from BUILTIN_COMMANDS, which says for each one what
 * the desktop does with it. An id in neither place throws — a typo or a new
 * built-in must not quietly do nothing.
 */
import { runtime } from './runtime';
import { NotSupportedInDesktop, noteInert, hit, recordNotSupported } from './notSupported';
import { Disposable, EventEmitter, Location, Position, Range, Uri } from './types';
import type { DesktopLanguageService, LspRange } from './runtime';

type Handler = (...args: any[]) => any;

export type BuiltinKind = 'implemented' | 'inert' | 'unsupported';
export interface BuiltinCommand {
  kind: BuiltinKind;
  why: string;
  run?: Handler;
}

/** `when`-clause context keys — the desktop title bar (host/titleActions.ts) evaluates them. */
export const contextKeys = new Map<string, unknown>();
export const contextKeysChanged = new EventEmitter<string>();

export function toRange(r: LspRange): Range {
  return new Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

function languageService(api: string): DesktopLanguageService {
  if (!runtime.languageService) throw new NotSupportedInDesktop(`command '${api}'`, 'the desktop host did not start a language service');
  return runtime.languageService;
}

async function locations(kind: 'definition' | 'references', uri: Uri, position: Position): Promise<Location[]> {
  const ls = languageService(kind === 'definition' ? 'vscode.executeDefinitionProvider' : 'vscode.executeReferenceProvider');
  if (uri.scheme !== 'file' || !ls.supports(uri.fsPath)) return [];
  const found = await ls.locations(kind, uri.fsPath, { line: position.line, character: position.character });
  return found.map((l) => new Location(Uri.file(l.fsPath), toRange(l.range)));
}

const workbenchLayout = (why: string): BuiltinCommand => ({ kind: 'inert', why });

export const BUILTIN_COMMANDS: Record<string, BuiltinCommand> = {
  setContext: {
    kind: 'implemented',
    why: 'context keys are stored and drive the desktop title-bar actions',
    run: (key: string, value: unknown) => {
      contextKeys.set(key, value);
      contextKeysChanged.fire(key);
    },
  },
  'vscode.open': {
    kind: 'implemented',
    why: 'http(s) → system browser; file → the user’s editor',
    run: async (target: Uri | string) => {
      const uri = typeof target === 'string' ? Uri.parse(target) : target;
      if (uri.scheme === 'file') await runtime.openInEditor(uri.fsPath);
      else await runtime.openExternal(uri.toString(true));
    },
  },
  // The desktop window is a single full-size chat: there is no sidebar to
  // collapse, no editor group to split or maximize, and no view container to
  // reveal. These are VS Code layout choreography with nothing to act on.
  'workbench.action.closeAuxiliaryBar': workbenchLayout('no auxiliary bar'),
  'workbench.action.closeGroup': workbenchLayout('no editor groups'),
  'workbench.action.closePanel': workbenchLayout('no panel'),
  'workbench.action.closeSidebar': workbenchLayout('no sidebar'),
  'workbench.action.focusActiveEditorGroup': workbenchLayout('no editor groups'),
  'workbench.action.maximizeEditorHideSidebar': workbenchLayout('window is already the chat'),
  'workbench.action.newGroupRight': workbenchLayout('no editor groups'),
  'workbench.action.toggleMaximizeEditorGroup': workbenchLayout('no editor groups'),
  'workbench.view.extension.workspacegpt-sidebar': workbenchLayout('the chat is always visible'),
  'workbench.extensions.installExtension': {
    kind: 'unsupported',
    why: 'the desktop app updates through its own updater (Phase 3)',
  },
  'vscode.executeWorkspaceSymbolProvider': {
    kind: 'implemented',
    why: 'typescript-language-server (JS/TS); other languages have no provider, as in a VS Code without their extension',
    run: async (query: string) => {
      const ls = languageService('vscode.executeWorkspaceSymbolProvider');
      return (await ls.workspaceSymbols(String(query ?? ''))).map((s) => ({
        name: s.name,
        kind: Math.max(0, s.kind - 1),
        containerName: s.containerName ?? '',
        location: new Location(Uri.file(s.fsPath), toRange(s.range)),
      }));
    },
  },
  'vscode.executeDefinitionProvider': {
    kind: 'implemented',
    why: 'typescript-language-server (JS/TS)',
    run: (uri: Uri, position: Position) => locations('definition', uri, position),
  },
  'vscode.executeReferenceProvider': {
    kind: 'implemented',
    why: 'typescript-language-server (JS/TS)',
    run: (uri: Uri, position: Position) => locations('references', uri, position),
  },
  'vscode.executeFormatDocumentProvider': {
    kind: 'unsupported',
    why: 'no formatter providers; format-on-save is off by default so this is only reached if the user enables it',
  },
  'vscode.diff': {
    kind: 'implemented',
    why: 'the review panel drawn over the chat (host/diffPanel.ts), with the hunk lenses’ keep/revert buttons',
    run: async (left: Uri, right: Uri, title?: string) => {
      if (!runtime.showDiff) throw new NotSupportedInDesktop("command 'vscode.diff'", 'the desktop host did not provide a diff panel');
      await runtime.showDiff(left, right, title);
    },
  },
};

const registry = new Map<string, Handler>();

function registerCommand(id: string, handler: Handler, thisArg?: unknown): Disposable {
  if (registry.has(id)) throw new Error(`command '${id}' already exists`);
  registry.set(id, thisArg ? handler.bind(thisArg) : handler);
  return new Disposable(() => registry.delete(id));
}

async function executeCommand<T = unknown>(id: string, ...args: any[]): Promise<T> {
  hit(`commands.executeCommand(${id})`);
  const own = registry.get(id);
  if (own) return own(...args);
  const builtin = BUILTIN_COMMANDS[id];
  if (!builtin) {
    notSupportedHitsFor(id);
    throw new NotSupportedInDesktop(`command '${id}'`, 'not a registered command and not in BUILTIN_COMMANDS');
  }
  if (builtin.kind === 'inert') {
    noteInert(`command ${id}`);
    return undefined as T;
  }
  if (builtin.kind === 'unsupported') {
    notSupportedHitsFor(id);
    throw new NotSupportedInDesktop(`command '${id}'`, builtin.why);
  }
  return builtin.run!(...args);
}

function notSupportedHitsFor(id: string): void {
  recordNotSupported(`command '${id}'`);
}

async function getCommands(): Promise<string[]> {
  return [...registry.keys(), ...Object.keys(BUILTIN_COMMANDS)];
}

export const commands = { registerCommand, executeCommand, getCommands };

/** Host-side: run an extension command (menu items, Tauri tray). */
export function hasCommand(id: string): boolean {
  return registry.has(id);
}
