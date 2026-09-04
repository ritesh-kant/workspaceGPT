import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { NamedRoot, WorkspaceRootRequiredError, resolveAgainstRoots } from '../codebase/codebaseTools';

/**
 * Deterministic verification (`run_checks`): the agent names a FILE and a kind
 * of check, and the host derives the command — nearest package, its package
 * manager, its test runner, the sibling test file — instead of the model
 * composing a shell line. Both live ticket runs so far stumbled here: one
 * command refused by the autonomous allowlist (a pipe), two failing with
 * pnpm's "node_modules missing" because they ran from the wrong directory.
 * A derived command cannot make either mistake, so autonomous runs execute
 * it without a gate (it is a test/lint/typecheck by construction).
 *
 * Recipes that succeeded are remembered per package in workspaceState and
 * injected into later prompts, so run two never rediscovers what run one
 * learned.
 */

export type CheckKind = 'test' | 'lint' | 'typecheck';

export interface RunChecksArgs {
  path: string;
  kind?: CheckKind;
}

export interface VerificationPlan {
  kind: CheckKind;
  command: string;
  /** Absolute directory the command runs in. */
  cwd: string;
  /** Workspace-relative (root-prefixed in multi-root) cwd for display. */
  displayCwd: string;
  /** Package name from package.json, or the directory name. */
  pkgName: string;
  /** Why this command — surfaced to the model so a failure is explainable. */
  rationale: string;
  /** Command with the target path replaced by {target}, for recipe storage. */
  template: string;
  /** Test/lint target relative to cwd, when the plan targets one file. */
  target?: string;
}

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

interface PackageInfo {
  dir: string;
  name: string;
  scripts: Record<string, string>;
  deps: Set<string>;
}

const RECIPES_KEY = 'wgpt.verifyRecipes';
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Walk up from `start` (inclusive) to `stop` (inclusive) looking for a file. */
function findUp(start: string, stop: string, names: string[]): { dir: string; name: string } | null {
  let dir = start;
  for (;;) {
    for (const name of names) {
      if (fs.existsSync(path.join(dir, name))) return { dir, name };
    }
    if (dir === stop || !dir.startsWith(stop)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function nearestPackage(startDir: string, rootDir: string): PackageInfo | null {
  const hit = findUp(startDir, rootDir, ['package.json']);
  if (!hit) return null;
  const pkg = readJson(path.join(hit.dir, 'package.json')) ?? {};
  const deps = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  return { dir: hit.dir, name: pkg.name || path.basename(hit.dir), scripts: pkg.scripts ?? {}, deps };
}

function detectPackageManager(pkgDir: string, rootDir: string, pkgJson: any): PackageManager {
  const declared = String(pkgJson?.packageManager ?? '').split('@')[0];
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') return declared;
  const lock = findUp(pkgDir, rootDir, ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json']);
  switch (lock?.name) {
    case 'pnpm-lock.yaml':
      return 'pnpm';
    case 'yarn.lock':
      return 'yarn';
    case 'bun.lockb':
    case 'bun.lock':
      return 'bun';
    default:
      return 'npm';
  }
}

/** "run this locally-installed binary" per package manager. */
function execPrefix(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm exec';
    case 'yarn':
      return 'yarn';
    case 'bun':
      return 'bunx';
    default:
      return 'npx --no-install';
  }
}

function runScript(pm: PackageManager, script: string, extra?: string): string {
  const base = pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
  return extra ? `${base} -- ${extra}` : base;
}

/** The test file for a source file: itself, a sibling .test/.spec, or __tests__/. */
function locateTestFile(absFile: string): string | null {
  if (TEST_FILE_RE.test(absFile)) return fs.existsSync(absFile) ? absFile : null;
  const dir = path.dirname(absFile);
  const ext = path.extname(absFile);
  const base = path.basename(absFile, ext);
  const exts = [ext, '.ts', '.tsx', '.js', '.jsx', '.mjs'];
  const candidates: string[] = [];
  for (const e of exts) {
    for (const infix of ['.test', '.spec']) {
      candidates.push(path.join(dir, `${base}${infix}${e}`));
      candidates.push(path.join(dir, '__tests__', `${base}${infix}${e}`));
      candidates.push(path.join(dir, '__tests__', `${base}${e}`));
    }
  }
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function shellQuote(p: string): string {
  return /^[\w./@:+=-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

function hasFile(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, name));
}

/**
 * Derive the verification command for a file. Throws with a model-actionable
 * message when no runner can be identified.
 */
export function planVerification(roots: NamedRoot[], args: RunChecksArgs): VerificationPlan {
  if (!roots.length) throw new WorkspaceRootRequiredError();
  if (!args?.path) throw new Error('path is required: the source or test file whose checks should run.');
  const kind: CheckKind = args.kind ?? 'test';
  const resolved = resolveAgainstRoots(roots, args.path);
  if (!resolved) throw new Error(`Could not resolve "${args.path}" against the workspace roots.`);
  const rootDir = resolved.root.uri.fsPath;
  const absPath = path.resolve(rootDir, resolved.relPath);
  if (!absPath.startsWith(rootDir)) throw new Error('path resolves outside the workspace.');
  const startDir = fs.existsSync(absPath) && fs.statSync(absPath).isDirectory() ? absPath : path.dirname(absPath);
  const display = (dir: string) => {
    const rel = path.relative(rootDir, dir) || '.';
    return roots.length > 1 ? `${resolved.root.name}/${rel}` : rel;
  };

  // The nearest ecosystem marker wins: a go.mod / Cargo.toml / pyproject
  // closer to the file than the monorepo's root package.json means this is
  // not a JS package, whatever the repo root says.
  const jsHit = findUp(startDir, rootDir, ['package.json']);
  const otherHit = findUp(startDir, rootDir, ['go.mod', 'Cargo.toml', 'pyproject.toml', 'pytest.ini', 'setup.cfg']);
  const preferOther = !!otherHit && (!jsHit || otherHit.dir.length > jsHit.dir.length);
  const pkg = preferOther ? null : nearestPackage(startDir, rootDir);
  if (!pkg) {
    // Non-JS ecosystems: one well-known runner each.
    const py = findUp(startDir, rootDir, ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'requirements.txt']);
    if (py && kind === 'test') {
      const target = path.relative(py.dir, absPath);
      return { kind, command: `python -m pytest ${shellQuote(target)} -q`, cwd: py.dir, displayCwd: display(py.dir), pkgName: path.basename(py.dir), rationale: `Python project (${py.name}) — pytest on the file`, template: 'python -m pytest {target} -q', target };
    }
    const go = findUp(startDir, rootDir, ['go.mod']);
    if (go) {
      const cmd = kind === 'test' ? `go test ./${path.relative(go.dir, startDir) || '.'}/...` : kind === 'lint' ? 'go vet ./...' : 'go build ./...';
      return { kind, command: cmd, cwd: go.dir, displayCwd: display(go.dir), pkgName: path.basename(go.dir), rationale: 'Go module (go.mod)', template: cmd };
    }
    const cargo = findUp(startDir, rootDir, ['Cargo.toml']);
    if (cargo) {
      const cmd = kind === 'test' ? 'cargo test' : kind === 'lint' ? 'cargo clippy' : 'cargo check';
      return { kind, command: cmd, cwd: cargo.dir, displayCwd: display(cargo.dir), pkgName: path.basename(cargo.dir), rationale: 'Rust crate (Cargo.toml)', template: cmd };
    }
    throw new Error(
      `No package.json, pyproject.toml, go.mod or Cargo.toml found above ${args.path} — cannot derive a ${kind} command. ` +
        'Use run_command with an explicit command and cwd if you know how this project runs its checks.'
    );
  }

  const pkgJson = readJson(path.join(pkg.dir, 'package.json'));
  const pm = detectPackageManager(pkg.dir, rootDir, pkgJson);
  const exec = execPrefix(pm);
  const cwd = pkg.dir;
  const displayCwd = display(cwd);
  const base = { cwd, displayCwd, pkgName: pkg.name };

  if (kind === 'test') {
    // No runner at all is the first thing to say — "no test file for X" would
    // be true but beside the point in a package that cannot run tests anyway.
    const runner = pkg.deps.has('vitest') ? 'vitest' : pkg.deps.has('jest') ? 'jest' : pkg.scripts.test ? 'script' : null;
    if (!runner) {
      throw new Error(
        `${pkg.name} (${displayCwd}) has no jest/vitest dependency and no "test" script — nothing to run. ` +
          'If tests live in another package, call run_checks with a path inside that package.'
      );
    }
    const exists = fs.existsSync(absPath);
    const isDir = exists && fs.statSync(absPath).isDirectory();
    const testFile = exists && !isDir ? locateTestFile(absPath) : null;
    // A file runs its own test file; a sub-directory scopes the run to itself
    // (jest and vitest both take a path pattern). Nothing ever widens to the
    // package: the earlier "no sibling test → run the whole suite" fallback
    // ran `pnpm exec jest` over a 500-file Next.js app — eleven jsdom workers,
    // 20GB, the machine swapping, the run dead on the stall timer. A missing
    // test is a fact to report, not a reason to run everything.
    const target = testFile
      ? path.relative(cwd, testFile)
      : isDir && absPath !== cwd
        ? path.relative(cwd, absPath)
        : undefined;
    if (!target) {
      throw new Error(
        isDir
          ? `${args.path} is ${pkg.name}'s package directory — running it means the whole suite. Call run_checks with a changed file or a sub-directory instead.`
          : `No test file found for ${path.basename(absPath)} (looked for a .test/.spec sibling and under __tests__/). ` +
            `Not running ${pkg.name}'s whole suite in its place. If this file's tests live elsewhere, call run_checks with that test file's path; ` +
            `if none exist, say so in the report ("no tests cover ${path.basename(absPath)}") and rely on lint + typecheck.`
      );
    }
    const scope = `tests for ${path.basename(absPath)} (${target})`;
    if (runner === 'vitest') {
      const template = `${exec} vitest run {target}`;
      return { kind, ...base, target, command: template.replace('{target}', shellQuote(target)), rationale: `vitest is a dependency of ${pkg.name} (${pm}); running ${scope}`, template };
    }
    if (runner === 'jest') {
      const template = `${exec} jest {target}`;
      return { kind, ...base, target, command: template.replace('{target}', shellQuote(target)), rationale: `jest is a dependency of ${pkg.name} (${pm}); running ${scope}`, template };
    }
    const template = runScript(pm, 'test', '{target}');
    return { kind, ...base, target, command: template.replace('{target}', shellQuote(target)), rationale: `"${pkg.scripts.test}" is ${pkg.name}'s test script (${pm}); running ${scope}`, template };
  }

  if (kind === 'lint') {
    const target = fs.existsSync(absPath) && !fs.statSync(absPath).isDirectory() ? path.relative(cwd, absPath) : undefined;
    if (pkg.deps.has('eslint') || findUp(pkg.dir, rootDir, ['eslint.config.js', 'eslint.config.mjs', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc'])) {
      const template = `${exec} eslint {target}`;
      return { kind, ...base, target, command: template.replace('{target}', target ? shellQuote(target) : '.'), rationale: `eslint configured for ${pkg.name} (${pm})`, template };
    }
    if (pkg.scripts.lint) {
      const cmd = runScript(pm, 'lint');
      return { kind, ...base, command: cmd, rationale: `"${pkg.scripts.lint}" is ${pkg.name}'s lint script`, template: cmd };
    }
    throw new Error(`${pkg.name} (${displayCwd}) has no eslint dependency/config and no "lint" script.`);
  }

  // typecheck
  const scriptName = ['typecheck', 'type-check', 'tsc', 'check-types', 'types'].find((s) => pkg.scripts[s]);
  if (scriptName) {
    const cmd = runScript(pm, scriptName);
    return { kind, ...base, command: cmd, rationale: `"${pkg.scripts[scriptName]}" is ${pkg.name}'s ${scriptName} script`, template: cmd };
  }
  if (hasFile(pkg.dir, 'tsconfig.json')) {
    const cmd = `${exec} tsc --noEmit -p tsconfig.json`;
    return { kind, ...base, command: cmd, rationale: `${pkg.name} has a tsconfig.json (${pm})`, template: cmd };
  }
  throw new Error(`${pkg.name} (${displayCwd}) has no typecheck script and no tsconfig.json.`);
}

// ── Remembered recipes ──

interface Recipe {
  template: string;
  cwd: string;
  lastOk: string;
}
type RecipeStore = Record<string, Recipe>; // key: `${displayCwd}::${kind}`

export function rememberRecipe(context: vscode.ExtensionContext, plan: VerificationPlan): Thenable<void> {
  const store = { ...(context.workspaceState.get<RecipeStore>(RECIPES_KEY) ?? {}) };
  store[`${plan.displayCwd}::${plan.kind}`] = { template: plan.template, cwd: plan.displayCwd, lastOk: new Date().toISOString() };
  // Bound the store — a monorepo can have hundreds of packages.
  const entries = Object.entries(store).sort((a, b) => b[1].lastOk.localeCompare(a[1].lastOk)).slice(0, 40);
  return context.workspaceState.update(RECIPES_KEY, Object.fromEntries(entries));
}

/** Prompt block listing the verification commands that have worked in this workspace. */
export function verificationRecipesBlock(context: vscode.ExtensionContext): string | undefined {
  const store = context.workspaceState.get<RecipeStore>(RECIPES_KEY) ?? {};
  const entries = Object.entries(store);
  if (!entries.length) return undefined;
  const lines = entries
    .sort((a, b) => b[1].lastOk.localeCompare(a[1].lastOk))
    .slice(0, 12)
    .map(([key, r]) => {
      const kind = key.split('::')[1];
      return `- ${r.cwd}: ${kind} → \`${r.template}\` (run from that directory; {target} = file relative to it)`;
    });
  return (
    'Verification commands that have succeeded before in this workspace — prefer `run_checks` (it derives these automatically); ' +
    'use them with run_command only if run_checks cannot find a runner:\n' +
    lines.join('\n')
  );
}
