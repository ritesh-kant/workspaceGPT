/**
 * The `vscode` module, as the desktop sidecar provides it.
 *
 * esbuild aliases `vscode` to this file when bundling the extension host code
 * (sidecar/esbuild.config.mjs), so `import * as vscode from 'vscode'` in
 * apps/vscode-extensions/src lands here, unchanged.
 *
 * Coverage rule (docs/design/desktop.md, Decision 2): implement exactly what
 * usage-check.mjs finds the extension using. Everything else fails loudly —
 * a namespace member that isn't defined throws NotSupportedInDesktop on
 * access, and stubs made with notSupported() throw when called.
 */
import { NotSupportedInDesktop, apiHits, hit, recordNotSupported } from './notSupported';
import { workspace as workspaceImpl } from './workspace';
import { window as windowImpl } from './window';
import { commands as commandsImpl } from './commands';
import { env as envImpl, languages as languagesImpl, extensions as extensionsImpl } from './env';

// Keys that generic code (module interop, inspectors, promise checks) probes on
// any object; answering `undefined` for them is the normal JS contract.
const PROBE_KEYS = new Set(['then', 'toJSON', '__esModule', 'default', 'constructor', 'inspect', 'nodeType', '$$typeof', 'asymmetricMatch']);
const wrapped = new WeakMap<object, unknown>();

function strict<T extends object>(name: string, impl: T): T {
  const cached = wrapped.get(impl);
  if (cached) return cached as T;
  const proxy = new Proxy(impl, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (prop in target) {
        hit(`${name}.${prop}`);
        const value = Reflect.get(target, prop, receiver);
        // Nested namespaces (workspace.fs, env.clipboard, window.tabGroups) get the same treatment.
        if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
          return strict(`${name}.${prop}`, value);
        }
        return value;
      }
      if (PROBE_KEYS.has(prop)) return undefined;
      const api = `vscode.${name}.${prop}`;
      recordNotSupported(api);
      throw new NotSupportedInDesktop(api, 'not implemented by the desktop compat module (see sidecar/usage-check.mjs)');
    },
  });
  wrapped.set(impl, proxy);
  return proxy;
}

export const workspace = strict('workspace', workspaceImpl);
export const window = strict('window', windowImpl);
export const commands = strict('commands', commandsImpl);
export const env = strict('env', envImpl);
export const languages = strict('languages', languagesImpl);
export const extensions = strict('extensions', extensionsImpl);

/**
 * `vscode.lm` is the editor's language-model/MCP registry. The extension only
 * touches it behind `vscode.lm?.registerMcpServerDefinitionProvider`, to tell
 * Copilot about its MCP server — meaningless outside VS Code, so it is absent
 * by design and that branch is skipped.
 */
export const lm: undefined = undefined;

/** Tags analytics (`vscodeVersion`) so desktop events never mix with extension numbers. */
export const version = `desktop-${process.env.WGPT_DESKTOP_VERSION ?? 'dev'}`;

export {
  CancellationTokenSource,
  CodeLens,
  ConfigurationTarget,
  Diagnostic,
  DiagnosticSeverity,
  Disposable,
  EndOfLine,
  EventEmitter,
  ExtensionMode,
  FileType,
  Location,
  MarkdownString,
  McpStdioServerDefinition,
  Position,
  ProgressLocation,
  Range,
  RelativePattern,
  Selection,
  StatusBarAlignment,
  SymbolKind,
  TextEdit,
  TextEditorRevealType,
  ThemeColor,
  ThemeIcon,
  Uri,
  ViewColumn,
  WorkspaceEdit,
} from './types';
export { FileSystemError, TextDocument } from './workspace';

// ── For usage-check.mjs and the host (not part of the vscode API) ───────────
export { NOT_SUPPORTED_MARK, NotSupportedInDesktop } from './notSupported';
export { BUILTIN_COMMANDS } from './commands';
export { apiHits };
