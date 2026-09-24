#!/usr/bin/env node
/**
 * Phase 2 smoke test: the extension's own agent tools (find_symbol,
 * go_to_definition, find_references, get_diagnostics), unchanged, running
 * through the compat module against the desktop language service.
 *
 *   node scripts/lsp-smoke.mjs            # a throwaway TS project (hermetic)
 *   node scripts/lsp-smoke.mjs <dir>      # also: symbols in a real repo
 *
 * Exits 1 on the first wrong answer.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDesktopTools } from './desktop-tools.mjs';

const m = await loadDesktopTools();

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** get_diagnostics as the model sees it: retry while the server says "pending". */
async function diagnosticsSettled(args, roots) {
  const t0 = Date.now();
  let pendingSeen = 0;
  for (;;) {
    try {
      const r = await m.getDiagnostics(args, roots);
      return { ...r, pendingSeen, ms: Date.now() - t0 };
    } catch (err) {
      if (!/still being computed/.test(err.message) || Date.now() - t0 > 60_000) throw err;
      pendingSeen++;
      await sleep(250);
    }
  }
}

// ── fixture ──
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-lsp-proj-'));
fs.mkdirSync(path.join(proj, 'src'));
fs.writeFileSync(path.join(proj, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'commonjs', noEmit: true }, include: ['src'] }));
fs.writeFileSync(path.join(proj, 'src/math.ts'), 'export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n\nexport class Calculator {\n  total = 0;\n}\n');
fs.writeFileSync(path.join(proj, 'src/main.ts'), "import { addNumbers } from './math';\n\nconst sum = addNumbers(1, 2);\nconsole.log(sum, addNumbers(3, 4));\n");

const ls = m.createLanguageService({ nodePath: process.execPath, workspaceFolders: () => m.runtime.workspaceFolders });
m.configureRuntime({ languageService: ls });
m.setWorkspaceFolders([proj]);
const roots = [{ name: path.basename(proj), uri: m.vscode.Uri.file(proj) }];

try {
  let t = Date.now();
  const sym = await m.findSymbol({ query: 'addNumbers' }, roots);
  const hit = sym.symbols.find((s) => s.name === 'addNumbers');
  check('find_symbol addNumbers', hit && hit.file.endsWith('src/math.ts') && hit.line === 1 && hit.kind === 'Function', `${JSON.stringify(sym.symbols)} (${Date.now() - t} ms, cold)`);

  const cls = await m.findSymbol({ query: 'Calculator' }, roots);
  check('find_symbol Calculator is a Class', cls.symbols.some((s) => s.name === 'Calculator' && s.kind === 'Class'), JSON.stringify(cls.symbols));

  t = Date.now();
  const def = await m.goToDefinition({ path: 'src/main.ts', line: 3, symbol: 'addNumbers' }, roots);
  check('go_to_definition → math.ts:1', def.locations.length === 1 && def.locations[0].file.endsWith('src/math.ts') && def.locations[0].line === 1, `${JSON.stringify(def.locations)} (${Date.now() - t} ms)`);

  const refs = await m.findReferences({ path: 'src/math.ts', line: 1, symbol: 'addNumbers' }, roots);
  const refLines = refs.locations.map((l) => `${path.basename(l.file)}:${l.line}`).sort();
  check('find_references (decl + import + 2 calls)', refs.locations.length === 4, refLines.join(', '));

  const clean = await diagnosticsSettled({ path: 'src/main.ts' }, roots);
  check('get_diagnostics clean file → 0 problems', clean.totalProblems === 0, `pending ${clean.pendingSeen}× then ${clean.ms} ms`);

  // The agent's write path: WorkspaceEdit → applyEdit, then get_diagnostics.
  const edit = new m.vscode.WorkspaceEdit();
  edit.replace(m.vscode.Uri.file(path.join(proj, 'src/main.ts')), new m.vscode.Range(2, 0, 2, 29), "const sum: string = addNumbers(1, 'two');");
  check('applyEdit writes the file', await m.vscode.workspace.applyEdit(edit));
  let firstRead;
  try {
    firstRead = await m.getDiagnostics({ path: 'src/main.ts' }, roots);
  } catch (err) {
    firstRead = err;
  }
  check('read right after the edit says "pending", not "0 problems"', firstRead instanceof Error && /still being computed/.test(firstRead.message), firstRead instanceof Error ? firstRead.message : JSON.stringify(firstRead));
  const broken = await diagnosticsSettled({ path: 'src/main.ts' }, roots);
  check('get_diagnostics after a type error → 2 errors', broken.totalProblems === 2 && broken.diagnostics.every((d) => d.severity === 'error' && d.line === 3), JSON.stringify(broken.diagnostics.map((d) => d.message.slice(0, 60))));

  // Changed on disk behind the compat module's back (a run_command, a formatter).
  fs.writeFileSync(path.join(proj, 'src/main.ts'), "import { addNumbers } from './math';\n\nconsole.log(addNumbers(1, 2));\n");
  const fixed = await diagnosticsSettled({}, roots);
  check('workspace-wide get_diagnostics sees an out-of-band fix', fixed.totalProblems === 0 && fixed.pendingSeen > 0, `pending ${fixed.pendingSeen}×, ${fixed.ms} ms`);

  const md = path.join(proj, 'README.md');
  fs.writeFileSync(md, '# hi\n');
  const none = await m.getDiagnostics({ path: 'README.md' }, roots);
  check('non-JS/TS file → no provider, empty (not an error)', none.totalProblems === 0);

  const real = process.argv[2];
  if (real) {
    m.setWorkspaceFolders([path.resolve(real)]);
    ls.restart(); // main.ts does this on onDidChangeWorkspaceFolders
    const realRoots = [{ name: path.basename(real), uri: m.vscode.Uri.file(path.resolve(real)) }];
    t = Date.now();
    const r = await m.findSymbol({ query: process.argv[3] ?? 'activate' }, realRoots);
    check(`real repo find_symbol ${process.argv[3] ?? 'activate'}`, r.symbols.length > 0, `${r.symbols.length} hits, ${Date.now() - t} ms cold: ${r.symbols.slice(0, 3).map((s) => `${s.file}:${s.line}`).join(', ')}`);
  }
} catch (err) {
  check('no exception', false, err.stack);
} finally {
  ls.dispose();
  setTimeout(() => {
    fs.rmSync(proj, { recursive: true, force: true });
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
  }, 800);
}
