/** `vscode.env`, `vscode.languages`, `vscode.extensions`. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runtime } from './runtime';
import { NotSupportedInDesktop, noteInert } from './notSupported';
import { Diagnostic, DiagnosticSeverity, Disposable, Uri } from './types';
import { toRange } from './commands';
import type { LspDiagnostic } from './runtime';

export const env = {
  get machineId(): string {
    return runtime.machineId;
  },
  get appName(): string {
    return runtime.appName;
  },
  clipboard: {
    writeText: (text: string) => runtime.clipboardWrite(text),
    readText: () => runtime.clipboardRead(),
  },
  openExternal: async (target: Uri): Promise<boolean> => runtime.openExternal(target.toString(true)),
};

export const languages = {
  /**
   * VS Code's problem list is fed by language servers the desktop does not
   * run. Returning [] would tell the agent "no problems" — a lie it would act
   * on — so it throws, and get_diagnostics reports the gap. Phase 2 replaces
   * this with a tsc/eslint runner.
   */
  /**
   * From typescript-language-server (JS/TS files the extension opened or
   * edited, as VS Code's TypeScript extension reports them). Throws while a
   * requested file is still being checked instead of answering "no problems".
   */
  getDiagnostics(uri?: Uri): any {
    const ls = runtime.languageService;
    if (!ls) throw new NotSupportedInDesktop('languages.getDiagnostics', 'the desktop host did not start a language service');
    const toDiagnostic = (d: LspDiagnostic) => {
      const out = new Diagnostic(toRange(d.range), d.message, Math.max(0, (d.severity ?? 1) - 1) as DiagnosticSeverity);
      out.source = d.source;
      out.code = d.code;
      return out;
    };
    if (uri) {
      if (uri.scheme !== 'file') return [];
      return (ls.diagnostics(uri.fsPath)[0]?.items ?? []).map(toDiagnostic);
    }
    return ls.diagnostics().map((f) => [Uri.file(f.fsPath), f.items.map(toDiagnostic)]);
  },
  /** Hunk lenses render inside a text editor; the desktop has none, so the provider is never asked. */
  registerCodeLensProvider: (_selector: unknown, _provider: unknown): Disposable => {
    noteInert('languages.registerCodeLensProvider');
    return new Disposable(() => undefined);
  },
};

let ownPackageJson: any;
function packageJson(): any {
  ownPackageJson ??= JSON.parse(fs.readFileSync(path.join(runtime.extensionDir, 'package.json'), 'utf8'));
  return ownPackageJson;
}

export const extensions = {
  /** Only the extension itself exists in the desktop. */
  getExtension(id: string) {
    const pkg = packageJson();
    if (id.toLowerCase() !== `${pkg.publisher}.${pkg.name}`.toLowerCase()) return undefined;
    return {
      id: `${pkg.publisher}.${pkg.name}`,
      extensionPath: runtime.extensionDir,
      extensionUri: Uri.file(runtime.extensionDir),
      packageJSON: pkg,
      isActive: true,
      exports: undefined,
    };
  },
};

export function ownExtension() {
  const pkg = packageJson();
  return extensions.getExtension(`${pkg.publisher}.${pkg.name}`)!;
}
