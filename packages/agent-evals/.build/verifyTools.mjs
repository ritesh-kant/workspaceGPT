// ../../apps/vscode-extensions/src/services/agent/verifyTools.ts
import * as fs2 from "fs";
import * as path from "path";

// src/headless/vscode-stub.mjs
import * as fs from "fs";
if (!fs.existsSync)
  throw new Error("vscode-stub: fs unavailable");

// ../../apps/vscode-extensions/src/services/codebase/codebaseTools.ts
var MAX_FILE_SIZE_BYTES = 512 * 1024;
var MAX_READ_BYTES = 20 * 1024;
var WorkspaceRootRequiredError = class extends Error {
  constructor() {
    super("No workspace folder is open \u2014 codebase tools are unavailable.");
  }
};
function resolveAgainstRoots(roots, relOrDisambiguated) {
  const normalized = relOrDisambiguated.replace(/^\.?\//, "");
  if (roots.length > 1) {
    for (const root of roots) {
      const prefix = `${root.name}/`;
      if (normalized.startsWith(prefix)) {
        return { root, relPath: normalized.slice(prefix.length) };
      }
    }
  }
  return { root: roots[0], relPath: normalized };
}

// ../../apps/vscode-extensions/src/services/agent/verifyTools.ts
var RECIPES_KEY = "wgpt.verifyRecipes";
var TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
function readJson(file) {
  try {
    return JSON.parse(fs2.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function findUp(start, stop, names) {
  let dir = start;
  for (; ; ) {
    for (const name of names) {
      if (fs2.existsSync(path.join(dir, name)))
        return { dir, name };
    }
    if (dir === stop || !dir.startsWith(stop))
      return null;
    const parent = path.dirname(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}
function nearestPackage(startDir, rootDir) {
  const hit = findUp(startDir, rootDir, ["package.json"]);
  if (!hit)
    return null;
  const pkg = readJson(path.join(hit.dir, "package.json")) ?? {};
  const deps = /* @__PURE__ */ new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {})
  ]);
  return { dir: hit.dir, name: pkg.name || path.basename(hit.dir), scripts: pkg.scripts ?? {}, deps };
}
function detectPackageManager(pkgDir, rootDir, pkgJson) {
  const declared = String(pkgJson?.packageManager ?? "").split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm")
    return declared;
  const lock = findUp(pkgDir, rootDir, ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"]);
  switch (lock?.name) {
    case "pnpm-lock.yaml":
      return "pnpm";
    case "yarn.lock":
      return "yarn";
    case "bun.lockb":
    case "bun.lock":
      return "bun";
    default:
      return "npm";
  }
}
function execPrefix(pm) {
  switch (pm) {
    case "pnpm":
      return "pnpm exec";
    case "yarn":
      return "yarn";
    case "bun":
      return "bunx";
    default:
      return "npx --no-install";
  }
}
function runScript(pm, script, extra) {
  const base = pm === "npm" ? `npm run ${script}` : `${pm} run ${script}`;
  return extra ? `${base} -- ${extra}` : base;
}
function locateTestFile(absFile) {
  if (TEST_FILE_RE.test(absFile))
    return fs2.existsSync(absFile) ? absFile : null;
  const dir = path.dirname(absFile);
  const ext = path.extname(absFile);
  const base = path.basename(absFile, ext);
  const exts = [ext, ".ts", ".tsx", ".js", ".jsx", ".mjs"];
  const candidates = [];
  for (const e of exts) {
    for (const infix of [".test", ".spec"]) {
      candidates.push(path.join(dir, `${base}${infix}${e}`));
      candidates.push(path.join(dir, "__tests__", `${base}${infix}${e}`));
      candidates.push(path.join(dir, "__tests__", `${base}${e}`));
    }
  }
  return candidates.find((c) => fs2.existsSync(c)) ?? null;
}
function shellQuote(p) {
  return /^[\w./@:+=-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}
function hasFile(dir, name) {
  return fs2.existsSync(path.join(dir, name));
}
function planVerification(roots, args) {
  if (!roots.length)
    throw new WorkspaceRootRequiredError();
  if (!args?.path)
    throw new Error("path is required: the source or test file whose checks should run.");
  const kind = args.kind ?? "test";
  const resolved = resolveAgainstRoots(roots, args.path);
  if (!resolved)
    throw new Error(`Could not resolve "${args.path}" against the workspace roots.`);
  const rootDir = resolved.root.uri.fsPath;
  const absPath = path.resolve(rootDir, resolved.relPath);
  if (!absPath.startsWith(rootDir))
    throw new Error("path resolves outside the workspace.");
  const startDir = fs2.existsSync(absPath) && fs2.statSync(absPath).isDirectory() ? absPath : path.dirname(absPath);
  const display = (dir) => {
    const rel = path.relative(rootDir, dir) || ".";
    return roots.length > 1 ? `${resolved.root.name}/${rel}` : rel;
  };
  const jsHit = findUp(startDir, rootDir, ["package.json"]);
  const otherHit = findUp(startDir, rootDir, ["go.mod", "Cargo.toml", "pyproject.toml", "pytest.ini", "setup.cfg"]);
  const preferOther = !!otherHit && (!jsHit || otherHit.dir.length > jsHit.dir.length);
  const pkg = preferOther ? null : nearestPackage(startDir, rootDir);
  if (!pkg) {
    const py = findUp(startDir, rootDir, ["pyproject.toml", "pytest.ini", "setup.cfg", "requirements.txt"]);
    if (py && kind === "test") {
      const target = path.relative(py.dir, absPath);
      return { kind, command: `python -m pytest ${shellQuote(target)} -q`, cwd: py.dir, displayCwd: display(py.dir), pkgName: path.basename(py.dir), rationale: `Python project (${py.name}) \u2014 pytest on the file`, template: "python -m pytest {target} -q", target };
    }
    const go = findUp(startDir, rootDir, ["go.mod"]);
    if (go) {
      const cmd = kind === "test" ? `go test ./${path.relative(go.dir, startDir) || "."}/...` : kind === "lint" ? "go vet ./..." : "go build ./...";
      return { kind, command: cmd, cwd: go.dir, displayCwd: display(go.dir), pkgName: path.basename(go.dir), rationale: "Go module (go.mod)", template: cmd };
    }
    const cargo = findUp(startDir, rootDir, ["Cargo.toml"]);
    if (cargo) {
      const cmd = kind === "test" ? "cargo test" : kind === "lint" ? "cargo clippy" : "cargo check";
      return { kind, command: cmd, cwd: cargo.dir, displayCwd: display(cargo.dir), pkgName: path.basename(cargo.dir), rationale: "Rust crate (Cargo.toml)", template: cmd };
    }
    throw new Error(
      `No package.json, pyproject.toml, go.mod or Cargo.toml found above ${args.path} \u2014 cannot derive a ${kind} command. Use run_command with an explicit command and cwd if you know how this project runs its checks.`
    );
  }
  const pkgJson = readJson(path.join(pkg.dir, "package.json"));
  const pm = detectPackageManager(pkg.dir, rootDir, pkgJson);
  const exec = execPrefix(pm);
  const cwd = pkg.dir;
  const displayCwd = display(cwd);
  const base = { cwd, displayCwd, pkgName: pkg.name };
  if (kind === "test") {
    const testFile = fs2.existsSync(absPath) && !fs2.statSync(absPath).isDirectory() ? locateTestFile(absPath) : null;
    const target = testFile ? path.relative(cwd, testFile) : void 0;
    const scope = target ? `tests for ${path.basename(absPath)} (${target})` : `the whole package (no sibling test file found for ${path.basename(absPath)})`;
    if (pkg.deps.has("vitest")) {
      const template = `${exec} vitest run {target}`;
      return { kind, ...base, target, command: target ? template.replace("{target}", shellQuote(target)) : `${exec} vitest run`, rationale: `vitest is a dependency of ${pkg.name} (${pm}); running ${scope}`, template };
    }
    if (pkg.deps.has("jest")) {
      const template = `${exec} jest {target}`;
      return { kind, ...base, target, command: target ? template.replace("{target}", shellQuote(target)) : `${exec} jest`, rationale: `jest is a dependency of ${pkg.name} (${pm}); running ${scope}`, template };
    }
    if (pkg.scripts.test) {
      const template = runScript(pm, "test", "{target}");
      return { kind, ...base, target, command: target ? template.replace("{target}", shellQuote(target)) : runScript(pm, "test"), rationale: `"${pkg.scripts.test}" is ${pkg.name}'s test script (${pm}); running ${scope}`, template };
    }
    throw new Error(
      `${pkg.name} (${displayCwd}) has no jest/vitest dependency and no "test" script \u2014 nothing to run. If tests live in another package, call run_checks with a path inside that package.`
    );
  }
  if (kind === "lint") {
    const target = fs2.existsSync(absPath) && !fs2.statSync(absPath).isDirectory() ? path.relative(cwd, absPath) : void 0;
    if (pkg.deps.has("eslint") || findUp(pkg.dir, rootDir, ["eslint.config.js", "eslint.config.mjs", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc"])) {
      const template = `${exec} eslint {target}`;
      return { kind, ...base, target, command: template.replace("{target}", target ? shellQuote(target) : "."), rationale: `eslint configured for ${pkg.name} (${pm})`, template };
    }
    if (pkg.scripts.lint) {
      const cmd = runScript(pm, "lint");
      return { kind, ...base, command: cmd, rationale: `"${pkg.scripts.lint}" is ${pkg.name}'s lint script`, template: cmd };
    }
    throw new Error(`${pkg.name} (${displayCwd}) has no eslint dependency/config and no "lint" script.`);
  }
  const scriptName = ["typecheck", "type-check", "tsc", "check-types", "types"].find((s) => pkg.scripts[s]);
  if (scriptName) {
    const cmd = runScript(pm, scriptName);
    return { kind, ...base, command: cmd, rationale: `"${pkg.scripts[scriptName]}" is ${pkg.name}'s ${scriptName} script`, template: cmd };
  }
  if (hasFile(pkg.dir, "tsconfig.json")) {
    const cmd = `${exec} tsc --noEmit -p tsconfig.json`;
    return { kind, ...base, command: cmd, rationale: `${pkg.name} has a tsconfig.json (${pm})`, template: cmd };
  }
  throw new Error(`${pkg.name} (${displayCwd}) has no typecheck script and no tsconfig.json.`);
}
function rememberRecipe(context, plan) {
  const store = { ...context.workspaceState.get(RECIPES_KEY) ?? {} };
  store[`${plan.displayCwd}::${plan.kind}`] = { template: plan.template, cwd: plan.displayCwd, lastOk: (/* @__PURE__ */ new Date()).toISOString() };
  const entries = Object.entries(store).sort((a, b) => b[1].lastOk.localeCompare(a[1].lastOk)).slice(0, 40);
  return context.workspaceState.update(RECIPES_KEY, Object.fromEntries(entries));
}
function verificationRecipesBlock(context) {
  const store = context.workspaceState.get(RECIPES_KEY) ?? {};
  const entries = Object.entries(store);
  if (!entries.length)
    return void 0;
  const lines = entries.sort((a, b) => b[1].lastOk.localeCompare(a[1].lastOk)).slice(0, 12).map(([key, r]) => {
    const kind = key.split("::")[1];
    return `- ${r.cwd}: ${kind} \u2192 \`${r.template}\` (run from that directory; {target} = file relative to it)`;
  });
  return "Verification commands that have succeeded before in this workspace \u2014 prefer `run_checks` (it derives these automatically); use them with run_command only if run_checks cannot find a runner:\n" + lines.join("\n");
}
export {
  planVerification,
  rememberRecipe,
  verificationRecipesBlock
};
