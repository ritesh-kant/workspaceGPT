/**
 * The extension's entry point, as the sidecar imports it. esbuild aliases this
 * module to apps/vscode-extensions/src/extension.ts; tsc sees only this shape,
 * so the desktop's type-check never type-checks extension source against the
 * compat module (that contract is usage-check.mjs's job).
 */
declare module 'workspacegpt-extension-host' {
  export function activate(context: unknown): Promise<void>;
  export function deactivate(): Promise<void> | void;
}
declare module 'workspacegpt-extension-commands' {
  export function executeCommand(command: string, cwd: string, timeoutSec?: number): Promise<{ exitCode: number | null }>;
}
declare module 'workspacegpt-extension-history' {
  export class HistoryService {
    constructor(context: unknown);
    getHistoryList(): Promise<Array<{ id: string; title: string; updatedAt: number; assistantMode: 'chat' | 'work' }>>;
  }
}
declare module 'workspacegpt-extension-hunks' {
  /** Line ranges are [start, end), 0-based. */
  export function computeHunks(original: string, current: string): Array<{ origStart: number; origEnd: number; curStart: number; curEnd: number }>;
}
declare module 'workspacegpt-extension-diff' {
  export function recordOriginalContent(fsPath: string, content: string): void;
}
declare module 'workspacegpt-extension-browser' {
  export function startBrowserBridge(socketPath: string): void;
}
declare module 'posthog-node-real';
