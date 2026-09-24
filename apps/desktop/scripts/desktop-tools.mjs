/**
 * The extension's own language-backed agent tools (find_symbol,
 * go_to_definition, find_references, get_diagnostics), bundled with `vscode`
 * aliased to the desktop compat module and served by the desktop language
 * service — the exact code path the desktop app runs, minus the window.
 *
 * Used by scripts/lsp-smoke.mjs and by packages/agent-evals'
 * `agent-smoke.mjs --host desktop`, which swaps these in for the harness's
 * regex stubs so an eval run measures the desktop's real tools.
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.resolve(root, '../vscode-extensions');

let loaded;

/** Bundle once per process; returns the module (compat runtime, vscode, tool functions). */
export async function loadDesktopTools() {
  if (loaded) return loaded;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-desktop-tools-'));
  const entry = path.join(outDir, 'entry.ts');
  const q = (p) => JSON.stringify(p);
  fs.writeFileSync(
    entry,
    `
import { configureRuntime, runtime } from ${q(path.join(root, 'sidecar/vscode-compat/runtime.ts'))};
import { setWorkspaceFolders } from ${q(path.join(root, 'sidecar/vscode-compat/workspace.ts'))};
import { createLanguageService } from ${q(path.join(root, 'sidecar/host/languageService.ts'))};
import * as vscode from 'vscode';
import { findSymbol, goToDefinition, findReferences } from ${q(path.join(extDir, 'src/services/codebase/codebaseTools.ts'))};
import { getDiagnostics } from ${q(path.join(extDir, 'src/services/agent/inspectTools.ts'))};
export { configureRuntime, runtime, setWorkspaceFolders, createLanguageService, vscode, findSymbol, goToDefinition, findReferences, getDiagnostics };
`
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, 'bundle.cjs'),
    logLevel: 'error',
    nodePaths: [path.join(root, 'node_modules'), path.join(extDir, 'node_modules')],
    alias: { vscode: path.join(root, 'sidecar/vscode-compat/index.ts') },
    external: ['typescript-language-server', 'typescript'],
  });
  // The bundle resolves the language server from apps/desktop/node_modules, as the sidecar does.
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(outDir, 'node_modules'));
  const m = createRequire(import.meta.url)(path.join(outDir, 'bundle.cjs'));
  m.configureRuntime({ extensionDir: extDir });
  process.once('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));
  loaded = m;
  return m;
}

/**
 * Point the desktop tools at `ws` (one language server per call; dispose it
 * when the run ends). Returns the four tools keyed by their agent tool names,
 * taking the model's arguments exactly as the extension's executeCodebaseTool does.
 */
export async function createDesktopToolHost(ws) {
  const m = await loadDesktopTools();
  m.runtime.languageService?.dispose?.();
  const ls = m.createLanguageService({ nodePath: process.execPath, workspaceFolders: () => m.runtime.workspaceFolders });
  m.configureRuntime({ languageService: ls });
  m.setWorkspaceFolders([ws]);
  const roots = [{ name: path.basename(ws), uri: m.vscode.Uri.file(ws) }];
  return {
    module: m,
    roots,
    languageService: ls,
    tools: {
      find_symbol: (args) => m.findSymbol(args, roots),
      go_to_definition: (args) => m.goToDefinition(args, roots),
      find_references: (args) => m.findReferences(args, roots),
      get_diagnostics: (args) => m.getDiagnostics(args ?? {}, roots),
    },
    dispose: () => ls.dispose(),
  };
}
