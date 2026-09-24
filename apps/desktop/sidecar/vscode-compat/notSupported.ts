/**
 * The compat module's one rule: an API the desktop does not implement fails
 * loudly, by name, the moment it is used. Never `undefined`, never a silent
 * no-op that makes a tool return an empty answer the model then trusts.
 */

/** Marks a stub so usage-check.mjs can report it as "NotSupported" rather than "implemented". */
export const NOT_SUPPORTED_MARK = Symbol.for('wgpt.desktop.notSupported');

/** Every NotSupported API that was actually hit this run, for NOTES.md and Diagnostics. */
export const notSupportedHits = new Map<string, number>();

export class NotSupportedInDesktop extends Error {
  readonly api: string;
  constructor(api: string, reason?: string) {
    super(
      `${api} is not supported in WorkspaceGPT Desktop yet` +
        (reason ? ` — ${reason}` : '') +
        '. (Thrown by the desktop vscode-compat module.)'
    );
    this.name = 'NotSupportedInDesktop';
    this.api = api;
  }
}

export function recordNotSupported(api: string): void {
  notSupportedHits.set(api, (notSupportedHits.get(api) ?? 0) + 1);
  console.warn(`[vscode-compat] NotSupportedInDesktop: ${api}`);
}

/** A function that throws NotSupportedInDesktop(api) when called. */
export function notSupported(api: string, reason?: string): (...args: any[]) => never {
  const fn = (..._args: any[]): never => {
    recordNotSupported(api);
    throw new NotSupportedInDesktop(api, reason);
  };
  (fn as any)[NOT_SUPPORTED_MARK] = true;
  return fn;
}

/** A class whose constructor throws NotSupportedInDesktop(api). */
export function notSupportedClass(api: string, reason?: string): new (...args: any[]) => never {
  const cls = class {
    constructor(..._args: any[]) {
      recordNotSupported(api);
      throw new NotSupportedInDesktop(api, reason);
    }
  };
  (cls as any)[NOT_SUPPORTED_MARK] = true;
  return cls as any;
}

/** Record a hit on an API that is implemented but deliberately inert in the desktop. */
export const inertHits = new Map<string, number>();
export function noteInert(api: string): void {
  const n = (inertHits.get(api) ?? 0) + 1;
  inertHits.set(api, n);
  if (n === 1) console.log(`[vscode-compat] inert in desktop (no editor/workbench): ${api}`);
}

/** Every compat API touched at runtime — the "APIs hit" list in NOTES.md. */
export const apiHits = new Map<string, number>();
export function hit(api: string): void {
  apiHits.set(api, (apiHits.get(api) ?? 0) + 1);
}
