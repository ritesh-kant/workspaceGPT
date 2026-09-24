#!/usr/bin/env node
/**
 * vscode.* usage in the extension host source ⊆ what the desktop compat module
 * covers.
 *
 * The desktop sidecar bundles apps/vscode-extensions/src with `vscode` aliased
 * to ./vscode-compat. Anything the extension starts calling that the compat
 * module does not define would otherwise surface as `undefined is not a
 * function` deep inside a user's run. This script finds that drift the day it
 * is introduced:
 *
 *   node sidecar/usage-check.mjs            # human report, exit 1 on drift
 *   node sidecar/usage-check.mjs --json     # machine-readable report
 *   node sidecar/usage-check.mjs --markdown # table for NOTES.md
 *
 * What counts:
 *   - value chains rooted at the `vscode` namespace import, e.g.
 *     `vscode.workspace.fs.readFile`, `vscode.Uri.file`, `new vscode.Range(...)`.
 *     Type-only uses (`vscode.ExtensionContext` in a type position, `implements
 *     vscode.WebviewViewProvider`) are erased by esbuild and need nothing.
 *   - string-literal command ids passed to `vscode.commands.executeCommand`,
 *     checked against the compat module's built-in command table and the
 *     extension's own `registerCommand` ids.
 *
 * Each chain is then resolved against the real compat module (bundled with
 * esbuild on the fly), so "covered" means the property really exists, not that
 * a list says it does. Members created by `notSupported(...)` are reported
 * separately: they are covered in the sense that calling them fails loudly with
 * NotSupportedInDesktop, which is the contract.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const esbuild = require('esbuild');

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.resolve(here, '../../vscode-extensions/src');
const COMPAT_ENTRY = path.join(here, 'vscode-compat/index.ts');

const args = new Set(process.argv.slice(2));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

/** Name bound by `import * as X from 'vscode'` in this file, if any. */
function vscodeNamespace(sf) {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier) || stmt.moduleSpecifier.text !== 'vscode') continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) return bindings.name.text;
    if (bindings && ts.isNamedImports(bindings)) {
      // Not used in the codebase today; flag it so the scanner gets extended
      // rather than silently missing a whole import style.
      throw new Error(`${sf.fileName}: named imports from 'vscode' are not scanned yet — extend usage-check.mjs`);
    }
  }
  return null;
}

function isTypePosition(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isHeritageClause(p)) return p.token === ts.SyntaxKind.ImplementsKeyword;
    if (ts.isExpressionWithTypeArguments(p)) continue;
    if (ts.isTypeNode(p)) return true;
    if (ts.isExpression(p) || ts.isStatement(p)) return false;
  }
  return false;
}

function scan() {
  const chains = new Map(); // chain -> [{file,line}]
  const commandIds = new Map(); // id -> [{file,line}]
  const dynamicCommands = [];
  const registeredCommands = new Set();

  const note = (map, key, sf, node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const where = `${path.relative(path.resolve(EXT_SRC, '..'), sf.fileName)}:${line + 1}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(where);
  };

  for (const file of walk(EXT_SRC)) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const ns = vscodeNamespace(sf);
    if (!ns) continue;

    const visit = (node) => {
      // Outermost property-access chain rooted at the namespace identifier.
      if (
        ts.isPropertyAccessExpression(node) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
      ) {
        const parts = [];
        let cur = node;
        while (ts.isPropertyAccessExpression(cur)) {
          parts.unshift(cur.name.text);
          cur = cur.expression;
        }
        if (ts.isIdentifier(cur) && cur.text === ns && !isTypePosition(node)) {
          note(chains, parts.join('.'), sf, node);
        }
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression.getText(sf);
        const first = node.arguments[0];
        if (callee === `${ns}.commands.executeCommand` && first) {
          if (ts.isStringLiteralLike(first)) note(commandIds, first.text, sf, node);
          else {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            dynamicCommands.push(`${path.relative(path.resolve(EXT_SRC, '..'), sf.fileName)}:${line + 1} ${first.getText(sf)}`);
          }
        }
        if (callee === `${ns}.commands.registerCommand` && first && ts.isStringLiteralLike(first)) {
          registeredCommands.add(first.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { chains, commandIds, dynamicCommands, registeredCommands };
}

async function loadCompat() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-compat-')), 'compat.cjs');
  await esbuild.build({
    entryPoints: [COMPAT_ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'error',
  });
  return require(out);
}

function resolveChain(compat, chain) {
  let obj = compat;
  for (const part of chain.split('.')) {
    // An export that exists with the value `undefined` (e.g. `lm`) is absent by
    // design: the extension reaches it only through `?.`, so that branch skips.
    if (obj === undefined && chain.split('.')[0] in compat) return { found: true, stub: false, absent: true };
    if (obj == null || !(part in Object(obj))) return { found: false };
    obj = obj[part];
  }
  return { found: true, stub: !!(obj && obj[compat.NOT_SUPPORTED_MARK]) };
}

const { chains, commandIds, dynamicCommands, registeredCommands } = scan();
const compat = await loadCompat();

const rows = [...chains.entries()]
  .map(([chain, uses]) => ({ chain, uses, ...resolveChain(compat, chain) }))
  .sort((a, b) => b.uses.length - a.uses.length || a.chain.localeCompare(b.chain));

const commandRows = [...commandIds.entries()].map(([id, uses]) => {
  const builtin = compat.BUILTIN_COMMANDS?.[id];
  const status = registeredCommands.has(id) || id.startsWith('workspacegpt.')
    ? 'extension'
    : builtin?.kind ?? 'missing';
  return { id, uses, status };
});

const missing = rows.filter((r) => !r.found);
const stubs = rows.filter((r) => r.found && r.stub);
const absent = rows.filter((r) => r.absent);
const missingCommands = commandRows.filter((r) => r.status === 'missing');

if (args.has('--json')) {
  console.log(JSON.stringify({ chains: rows, commands: commandRows, dynamicCommands }, null, 2));
} else if (args.has('--markdown')) {
  console.log('| API | uses | desktop |');
  console.log('|---|---|---|');
  for (const r of rows) {
    console.log(`| \`vscode.${r.chain}\` | ${r.uses.length} | ${!r.found ? '**MISSING**' : r.absent ? 'absent by design' : r.stub ? 'NotSupported' : 'implemented'} |`);
  }
  console.log('\n| executeCommand id | uses | desktop |');
  console.log('|---|---|---|');
  for (const r of commandRows) console.log(`| \`${r.id}\` | ${r.uses.length} | ${r.status} |`);
} else {
  console.log(`vscode.* value chains in apps/vscode-extensions/src: ${rows.length}`);
  console.log(`  implemented: ${rows.length - missing.length - stubs.length - absent.length}`);
  console.log(`  absent by design (only reached through ?.): ${absent.map((r) => 'vscode.' + r.chain).join(', ') || 'none'}`);
  console.log(`  NotSupportedInDesktop stubs: ${stubs.length}`);
  for (const r of stubs) console.log(`    - vscode.${r.chain}  (${r.uses[0]}${r.uses.length > 1 ? ` +${r.uses.length - 1}` : ''})`);
  console.log(`  MISSING from compat: ${missing.length}`);
  for (const r of missing) console.log(`    ✗ vscode.${r.chain}  (${r.uses.join(', ')})`);
  console.log(`executeCommand literal ids: ${commandRows.length}, missing: ${missingCommands.length}`);
  for (const r of missingCommands) console.log(`    ✗ '${r.id}'  (${r.uses.join(', ')})`);
  if (dynamicCommands.length) {
    console.log(`executeCommand with non-literal ids (checked at runtime only): ${dynamicCommands.length}`);
    for (const d of dynamicCommands) console.log(`    ~ ${d}`);
  }
}

process.exit(missing.length || missingCommands.length ? 1 : 0);
