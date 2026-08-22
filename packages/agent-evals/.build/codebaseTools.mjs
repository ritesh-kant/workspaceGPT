// src/headless/vscode-stub.mjs
import * as fs from "fs";
import * as fsp from "fs/promises";
var Uri = {
  file(p) {
    return { fsPath: p, scheme: "file", path: p, toString: () => `file://${p}` };
  }
};
var Position = class {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
};
function makeDocument(uri, content) {
  return {
    uri,
    getText: () => content,
    positionAt(offset) {
      const upTo = content.slice(0, offset);
      const line = (upTo.match(/\n/g) || []).length;
      const character = offset - (upTo.lastIndexOf("\n") + 1);
      return new Position(line, character);
    },
    save: async () => true
  };
}
var workspace = {
  async openTextDocument(uri) {
    const p = typeof uri === "string" ? uri : uri.fsPath;
    const content = await fsp.readFile(p, "utf8");
    return makeDocument(typeof uri === "string" ? Uri.file(uri) : uri, content);
  },
  fs: {
    async stat(uri) {
      const st = await fsp.stat(uri.fsPath);
      return { size: st.size };
    }
  },
  async applyEdit() {
    throw new Error("vscode-stub: applyEdit is not supported headlessly \u2014 apply PreparedWrite via fs in the harness.");
  },
  workspaceFolders: [],
  getConfiguration: () => ({ get: () => void 0 })
};
var commands = {
  executeCommand: async () => {
    throw new Error("vscode-stub: language-service commands are unavailable headlessly.");
  }
};
if (!fs.existsSync)
  throw new Error("vscode-stub: fs unavailable");

// ../../apps/vscode-extensions/src/services/codebase/codebaseTools.ts
import * as path from "path";
import { execFile } from "child_process";
var MAX_CANDIDATE_FILES = 500;
var MAX_MATCHES = 50;
var MAX_FILE_SIZE_BYTES = 512 * 1024;
var MAX_READ_LINES = 400;
var MAX_READ_BYTES = 20 * 1024;
var CONTEXT_LINES = 2;
var MAX_CONTEXT_CHARS = 500;
var RIPGREP_TIMEOUT_MS = 1e4;
var WorkspaceRootRequiredError = class extends Error {
  constructor() {
    super("No workspace folder is open \u2014 codebase tools are unavailable.");
  }
};
function getNamedRoots(workspaceRoots) {
  return workspaceRoots.map((f) => ({ name: f.name, uri: f.uri }));
}
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
function isLikelyBinary(buffer) {
  const sampleLength = Math.min(buffer.length, 8e3);
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0)
      return true;
  }
  return false;
}
var SEARCH_STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "all",
  "there",
  "what",
  "how",
  "does",
  "do",
  "section",
  "check",
  "can",
  "you",
  "please"
]);
function tokenize(query) {
  return [...new Set(
    query.split(/[^a-zA-Z0-9_]+/).map((t) => t.trim()).filter((t) => t.length >= 3 && !SEARCH_STOPWORDS.has(t.toLowerCase()))
  )];
}
function expandTokens(tokens) {
  const out = new Set(tokens);
  for (const t of tokens) {
    if (/ies$/i.test(t) && t.length >= 5)
      out.add(t.slice(0, -3) + "y");
    else if (/(x|s|z|ch|sh)es$/i.test(t))
      out.add(t.slice(0, -2));
    else if (/s$/i.test(t) && !/ss$/i.test(t) && t.length >= 4)
      out.add(t.slice(0, -1));
  }
  return [...out];
}
var rankingDisabledForEval = () => process.env.WGPT_DISABLE_CODEBASE_RANKING === "1";
function rankTokenMatches(matches, tokens) {
  if (rankingDisabledForEval())
    return matches;
  const lowered = tokens.map((t) => t.toLowerCase());
  const score = (m) => {
    const path2 = m.file.toLowerCase();
    const line = m.text.toLowerCase();
    const context = (m.context ?? "").toLowerCase();
    let s = 0;
    for (const t of lowered) {
      if (path2.includes(t))
        s += 3;
      if (line.includes(t))
        s += 2;
      else if (context.includes(t))
        s += 1;
    }
    return s;
  };
  return matches.map((m, i) => ({ m, i, s: score(m) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.m);
}
function rankTokenFiles(files, tokens) {
  if (rankingDisabledForEval())
    return files;
  const lowered = tokens.map((t) => t.toLowerCase());
  return files.map((f, i) => ({
    f,
    i,
    s: lowered.reduce((acc, t) => acc + (f.toLowerCase().includes(t) ? 1 : 0), 0)
  })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.f);
}
function normalizeGlob(glob) {
  const negated = glob.startsWith("!");
  let g = (negated ? glob.slice(1) : glob).replace(/^\.?\//, "");
  if (g.includes("/") && !g.startsWith("**"))
    g = `**/${g}`;
  return negated ? `!${g}` : g;
}
function zeroHitNote(args, triedTokens) {
  const tokenPart = triedTokens?.length ? ` (also tried keywords: ${triedTokens.join(", ")})` : "";
  const globPart = args.glob ? ` The glob "${args.glob}" limited which files were searched \u2014 retry WITHOUT the glob, or verify the directory exists with list_directory/find_files.` : " Try different keywords or synonyms, find_symbol for symbol names, or find_files for file-name patterns.";
  return `No matches for "${args.query}"${tokenPart}.${globPart}`;
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function escapeForLiteralOrRegex(query) {
  const looksLikeRegex = /[.*+?^${}()|[\]\\]/.test(query);
  return looksLikeRegex ? query : escapeRegExp(query);
}
function buildContext(lines, centerIdx) {
  const start = Math.max(0, centerIdx - CONTEXT_LINES);
  const end = Math.min(lines.length - 1, centerIdx + CONTEXT_LINES);
  const joined = lines.slice(start, end + 1).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
  return joined.length > MAX_CONTEXT_CHARS ? joined.slice(0, MAX_CONTEXT_CHARS) : joined;
}
var ripgrepPathPromise = null;
function resolveRipgrepPath() {
  if (!ripgrepPathPromise) {
    ripgrepPathPromise = import("/Users/ritesh/codebase/ritesh-codebase/workspaceGPT/node_modules/.pnpm/@vscode+ripgrep@1.18.0/node_modules/@vscode/ripgrep/lib/index.js").then((mod) => mod.rgPath).catch(() => null);
  }
  return ripgrepPathPromise;
}
function runRipgrepRaw(rgPath, pattern, opts, roots) {
  const args = ["--json", "--context", String(CONTEXT_LINES), "--max-count", "200", "--max-filesize", String(MAX_FILE_SIZE_BYTES)];
  if (!opts.caseSensitive)
    args.push("--ignore-case");
  if (opts.glob)
    args.push("-g", normalizeGlob(opts.glob));
  args.push("--", pattern, ...roots.map((r) => r.uri.fsPath));
  return new Promise((resolve2) => {
    execFile(
      rgPath,
      args,
      { maxBuffer: 20 * 1024 * 1024, timeout: RIPGREP_TIMEOUT_MS, cwd: roots[0].uri.fsPath },
      (error, stdout) => {
        if (error && error.code !== 1) {
          resolve2(null);
          return;
        }
        resolve2(stdout ?? "");
      }
    );
  });
}
function parseRipgrepJson(stdout, roots) {
  const entries = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim())
      continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "match" && obj.type !== "context")
      continue;
    const absPath = obj.data?.path?.text;
    const lineText = obj.data?.lines?.text;
    if (!absPath || lineText === void 0)
      continue;
    entries.push({
      file: displayPathFor(Uri.file(absPath), roots),
      line: obj.data.line_number,
      text: lineText.replace(/\n$/, ""),
      isMatch: obj.type === "match"
    });
  }
  return entries;
}
function toMatchesWithContext(entries) {
  const byFile = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const arr = byFile.get(e.file) ?? [];
    arr.push(e);
    byFile.set(e.file, arr);
  }
  const matches = [];
  for (const e of entries) {
    if (!e.isMatch)
      continue;
    const fileEntries = byFile.get(e.file) ?? [];
    const nearby = fileEntries.filter((o) => Math.abs(o.line - e.line) <= CONTEXT_LINES).sort((a, b) => a.line - b.line);
    const context = nearby.map((o) => `${o.line}: ${o.text}`).join("\n").slice(0, MAX_CONTEXT_CHARS);
    matches.push({ file: e.file, line: e.line, text: e.text.trim().slice(0, 500), context });
  }
  return matches;
}
function runRipgrepFilesOnly(rgPath, pattern, opts, roots) {
  const args = ["-l", "--max-filesize", String(MAX_FILE_SIZE_BYTES)];
  if (!opts.caseSensitive)
    args.push("--ignore-case");
  if (opts.glob)
    args.push("-g", normalizeGlob(opts.glob));
  args.push("--", pattern, ...roots.map((r) => r.uri.fsPath));
  return new Promise((resolve2) => {
    execFile(
      rgPath,
      args,
      { maxBuffer: 20 * 1024 * 1024, timeout: RIPGREP_TIMEOUT_MS, cwd: roots[0].uri.fsPath },
      (error, stdout) => {
        if (error && error.code !== 1) {
          resolve2(null);
          return;
        }
        const files = (stdout ?? "").split("\n").filter(Boolean).map((p) => displayPathFor(Uri.file(p), roots));
        resolve2(files);
      }
    );
  });
}
async function searchCodebaseViaRipgrep(args, roots) {
  const rgPath = await resolveRipgrepPath();
  if (!rgPath)
    return null;
  if (args.outputMode === "files_with_matches") {
    const files = await runRipgrepFilesOnly(rgPath, escapeForLiteralOrRegex(args.query), args, roots);
    if (files === null)
      return null;
    if (files.length > 0) {
      return {
        matches: [],
        files: files.slice(0, 100),
        truncated: files.length > 100,
        totalMatches: files.length
      };
    }
    const tokens2 = expandTokens(tokenize(args.query));
    const tokenPattern2 = tokens2.map(escapeRegExp).join("|");
    if (tokens2.length > 0 && tokenPattern2.toLowerCase() !== escapeForLiteralOrRegex(args.query).toLowerCase()) {
      const tokenFiles = await runRipgrepFilesOnly(rgPath, tokenPattern2, args, roots);
      if (tokenFiles && tokenFiles.length > 0) {
        return {
          matches: [],
          files: rankTokenFiles(tokenFiles, tokens2).slice(0, 100),
          truncated: tokenFiles.length > 100,
          totalMatches: tokenFiles.length,
          note: `No exact match for "${args.query}" \u2014 files matching any of: ${tokens2.join(", ")}.`
        };
      }
    }
    return { matches: [], files: [], truncated: false, totalMatches: 0, note: zeroHitNote(args, tokens2) };
  }
  const phraseStdout = await runRipgrepRaw(rgPath, escapeForLiteralOrRegex(args.query), args, roots);
  if (phraseStdout === null)
    return null;
  const phraseMatches = toMatchesWithContext(parseRipgrepJson(phraseStdout, roots));
  if (phraseMatches.length > 0) {
    const truncated = phraseMatches.length > MAX_MATCHES;
    return {
      matches: phraseMatches.slice(0, MAX_MATCHES),
      truncated,
      totalMatches: phraseMatches.length
    };
  }
  const tokens = expandTokens(tokenize(args.query));
  const tokenPattern = tokens.map(escapeRegExp).join("|");
  if (tokens.length === 0 || tokenPattern.toLowerCase() === escapeForLiteralOrRegex(args.query).toLowerCase()) {
    return { matches: [], truncated: false, totalMatches: 0, note: zeroHitNote(args) };
  }
  const tokenStdout = await runRipgrepRaw(rgPath, tokenPattern, args, roots);
  if (tokenStdout === null)
    return { matches: [], truncated: false, totalMatches: 0, note: zeroHitNote(args, tokens) };
  const tokenMatches = toMatchesWithContext(parseRipgrepJson(tokenStdout, roots));
  if (tokenMatches.length === 0) {
    return { matches: [], truncated: false, totalMatches: 0, note: zeroHitNote(args, tokens) };
  }
  return {
    matches: rankTokenMatches(tokenMatches, tokens).slice(0, MAX_MATCHES),
    truncated: tokenMatches.length > MAX_MATCHES,
    totalMatches: tokenMatches.length,
    note: `No exact match for "${args.query}" \u2014 showing lines matching any of: ${tokens.join(", ")}, ranked by how many keywords each hit.`
  };
}
async function searchCodebaseViaJsScan(args, roots) {
  const flags = args.caseSensitive ? "g" : "gi";
  let phrasePattern;
  try {
    phrasePattern = new RegExp(escapeForLiteralOrRegex(args.query), flags);
  } catch {
    phrasePattern = new RegExp(escapeRegExp(args.query), flags);
  }
  const tokens = expandTokens(tokenize(args.query));
  const tokenPattern = tokens.length > 0 ? new RegExp(tokens.map(escapeRegExp).join("|"), flags) : null;
  const phraseMatches = [];
  const tokenMatches = [];
  let phraseTotalMatches = 0;
  let phraseTruncated = false;
  let tokenTruncated = false;
  const files = await workspace.findFiles(
    args.glob ?? "**/*",
    void 0,
    MAX_CANDIDATE_FILES
  );
  for (const uri of files) {
    if (phraseMatches.length >= MAX_MATCHES && tokenMatches.length >= MAX_MATCHES) {
      break;
    }
    let stat2;
    try {
      stat2 = await workspace.fs.stat(uri);
    } catch {
      continue;
    }
    if (stat2.type !== (void 0).File || stat2.size > MAX_FILE_SIZE_BYTES) {
      continue;
    }
    let bytes;
    try {
      bytes = await workspace.fs.readFile(uri);
    } catch {
      continue;
    }
    if (isLikelyBinary(bytes))
      continue;
    const text = Buffer.from(bytes).toString("utf8");
    const lines = text.split("\n");
    const displayPath = displayPathFor(uri, roots);
    for (let i = 0; i < lines.length; i++) {
      phrasePattern.lastIndex = 0;
      if (phrasePattern.test(lines[i])) {
        phraseTotalMatches++;
        if (phraseMatches.length < MAX_MATCHES) {
          phraseMatches.push({
            file: displayPath,
            line: i + 1,
            text: lines[i].trim().slice(0, 500),
            context: buildContext(lines, i)
          });
        } else {
          phraseTruncated = true;
        }
      }
      if (tokenPattern) {
        tokenPattern.lastIndex = 0;
        if (tokenPattern.test(lines[i])) {
          if (tokenMatches.length < MAX_MATCHES) {
            tokenMatches.push({
              file: displayPath,
              line: i + 1,
              text: lines[i].trim().slice(0, 500),
              context: buildContext(lines, i)
            });
          } else {
            tokenTruncated = true;
          }
        }
      }
    }
  }
  if (phraseMatches.length > 0) {
    return { matches: phraseMatches, truncated: phraseTruncated, totalMatches: phraseTotalMatches };
  }
  if (tokenMatches.length > 0) {
    return {
      matches: rankTokenMatches(tokenMatches, tokens),
      truncated: tokenTruncated,
      totalMatches: tokenMatches.length,
      note: `No exact match for "${args.query}" \u2014 showing lines matching any of: ${tokens.join(", ")}, ranked by how many keywords each hit.`
    };
  }
  return { matches: [], truncated: false, totalMatches: 0, note: zeroHitNote(args, tokens) };
}
async function searchCodebase(args, roots) {
  if (!roots.length)
    throw new WorkspaceRootRequiredError();
  const viaRipgrep = await searchCodebaseViaRipgrep(args, roots);
  if (viaRipgrep)
    return viaRipgrep;
  const jsResult = await searchCodebaseViaJsScan(args, roots);
  if (args.outputMode === "files_with_matches") {
    const files = [...new Set(jsResult.matches.map((m) => m.file))];
    return { matches: [], files, truncated: jsResult.truncated, totalMatches: files.length, note: jsResult.note };
  }
  return jsResult;
}
async function readFile2(args, roots) {
  if (!roots.length)
    throw new WorkspaceRootRequiredError();
  const resolved = resolveAgainstRoots(roots, args.path);
  if (!resolved) {
    throw new Error(`Could not resolve path "${args.path}" against any workspace root.`);
  }
  const rootFsPath = resolved.root.uri.fsPath;
  const absPath = path.resolve(rootFsPath, resolved.relPath);
  if (absPath !== rootFsPath && !absPath.startsWith(rootFsPath + path.sep)) {
    throw new Error("Path resolves outside the workspace root \u2014 refusing to read.");
  }
  const uri = Uri.file(absPath);
  const stat2 = await workspace.fs.stat(uri);
  if (stat2.type !== (void 0).File) {
    throw new Error(`"${args.path}" is not a file.`);
  }
  if (stat2.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`"${args.path}" is too large to read (${stat2.size} bytes, cap ${MAX_FILE_SIZE_BYTES}).`);
  }
  const bytes = await workspace.fs.readFile(uri);
  if (isLikelyBinary(bytes)) {
    throw new Error(`"${args.path}" appears to be a binary file \u2014 cannot read as text.`);
  }
  const allLines = Buffer.from(bytes).toString("utf8").split("\n");
  const start = Math.max(1, args.startLine ?? 1) - 1;
  const requestedEnd = args.endLine ?? allLines.length;
  const cappedEnd = Math.min(requestedEnd, start + MAX_READ_LINES, allLines.length);
  let content = allLines.slice(start, cappedEnd).join("\n");
  let truncated = cappedEnd < requestedEnd || cappedEnd < allLines.length;
  if (content.length > MAX_READ_BYTES) {
    content = content.slice(0, MAX_READ_BYTES);
    truncated = true;
  }
  return { content, totalLines: allLines.length, truncated };
}
async function listDirectory(args, roots) {
  if (!roots.length)
    throw new WorkspaceRootRequiredError();
  const resolved = resolveAgainstRoots(roots, args.path ?? "");
  if (!resolved) {
    throw new Error(`Could not resolve path "${args.path}" against any workspace root.`);
  }
  const rootFsPath = resolved.root.uri.fsPath;
  const absPath = resolved.relPath ? path.resolve(rootFsPath, resolved.relPath) : rootFsPath;
  if (absPath !== rootFsPath && !absPath.startsWith(rootFsPath + path.sep)) {
    throw new Error("Path resolves outside the workspace root \u2014 refusing to list.");
  }
  const uri = Uri.file(absPath);
  const entries = await workspace.fs.readDirectory(uri);
  return {
    entries: entries.map(([name, type]) => ({
      name,
      type: type === (void 0).Directory ? "directory" : "file"
    }))
  };
}
async function findFiles(args, roots) {
  if (!roots.length)
    throw new WorkspaceRootRequiredError();
  const uris = await workspace.findFiles(args.pattern, void 0, MAX_CANDIDATE_FILES);
  const withMtime = await Promise.all(
    uris.map(async (u) => {
      try {
        const stat2 = await workspace.fs.stat(u);
        return { u, mtime: stat2.mtime };
      } catch {
        return { u, mtime: 0 };
      }
    })
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return {
    files: withMtime.map(({ u }) => displayPathFor(u, roots)),
    truncated: uris.length >= MAX_CANDIDATE_FILES
  };
}
var MAX_SYMBOL_RESULTS = 30;
var SYMBOL_KIND_NAMES = [
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "EnumMember",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter"
];
function symbolKindName(kind) {
  return SYMBOL_KIND_NAMES[kind] ?? "Symbol";
}
async function findSymbol(args, roots) {
  if (!roots.length)
    throw new WorkspaceRootRequiredError();
  const symbols = await commands.executeCommand(
    "vscode.executeWorkspaceSymbolProvider",
    args.query
  );
  if (!symbols || symbols.length === 0) {
    return { symbols: [], truncated: false };
  }
  const inWorkspace = symbols.filter(
    (s) => roots.some((r) => s.location.uri.fsPath.startsWith(r.uri.fsPath + path.sep))
  );
  return {
    symbols: inWorkspace.slice(0, MAX_SYMBOL_RESULTS).map((s) => ({
      name: s.name,
      kind: symbolKindName(s.kind),
      file: displayPathFor(s.location.uri, roots),
      line: s.location.range.start.line + 1,
      container: s.containerName || void 0
    })),
    truncated: inWorkspace.length > MAX_SYMBOL_RESULTS
  };
}
async function resolveSymbolPosition(args, roots) {
  const resolved = resolveAgainstRoots(roots, args.path);
  if (!resolved) {
    throw new Error(`Could not resolve path "${args.path}" against any workspace root.`);
  }
  const rootFsPath = resolved.root.uri.fsPath;
  const absPath = path.resolve(rootFsPath, resolved.relPath);
  if (absPath !== rootFsPath && !absPath.startsWith(rootFsPath + path.sep)) {
    throw new Error("Path resolves outside the workspace root \u2014 refusing to open.");
  }
  const doc = await workspace.openTextDocument(Uri.file(absPath));
  const lineIdx = Math.min(Math.max(1, args.line), doc.lineCount) - 1;
  const lineText = doc.lineAt(lineIdx).text;
  const col = lineText.indexOf(args.symbol);
  if (col === -1) {
    throw new Error(`Symbol "${args.symbol}" not found on line ${args.line} of ${args.path}. The line reads: ${lineText.trim().slice(0, 200)}`);
  }
  return { doc, position: new Position(lineIdx, col) };
}
async function locationsFromProvider(command, args, roots) {
  if (!roots.length)
    throw new WorkspaceRootRequiredError();
  const { doc, position } = await resolveSymbolPosition(args, roots);
  const raw = await commands.executeCommand(command, doc.uri, position);
  if (!raw || raw.length === 0) {
    return { locations: [], truncated: false };
  }
  const normalized = raw.map(
    (l) => "targetUri" in l ? { uri: l.targetUri, range: l.targetRange } : { uri: l.uri, range: l.range }
  );
  const capped = normalized.slice(0, MAX_SYMBOL_RESULTS);
  const locations = [];
  for (const loc of capped) {
    let preview = "";
    try {
      const targetDoc = await workspace.openTextDocument(loc.uri);
      preview = targetDoc.lineAt(loc.range.start.line).text.trim().slice(0, 200);
    } catch {
    }
    locations.push({
      file: displayPathFor(loc.uri, roots),
      line: loc.range.start.line + 1,
      preview
    });
  }
  return { locations, truncated: normalized.length > MAX_SYMBOL_RESULTS };
}
function goToDefinition(args, roots) {
  return locationsFromProvider("vscode.executeDefinitionProvider", args, roots);
}
function findReferences(args, roots) {
  return locationsFromProvider("vscode.executeReferenceProvider", args, roots);
}
var ORIENTATION_EXCLUDED_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  "venv",
  ".venv",
  "__pycache__",
  ".turbo",
  ".idea",
  ".vscode-test"
]);
var ORIENTATION_MAX_LINES = 150;
var ORIENTATION_README_CHARS = 1500;
async function listTreeLevel(uri, indent, depthLeft, lines) {
  if (lines.length >= ORIENTATION_MAX_LINES)
    return;
  let entries;
  try {
    entries = await workspace.fs.readDirectory(uri);
  } catch {
    return;
  }
  entries.sort(([aName, aType], [bName, bType]) => {
    if (aType !== bType)
      return bType - aType;
    return aName.localeCompare(bName);
  });
  for (const [name, type] of entries) {
    if (lines.length >= ORIENTATION_MAX_LINES) {
      lines.push(`${indent}\u2026`);
      return;
    }
    if (name.startsWith(".") || ORIENTATION_EXCLUDED_DIRS.has(name))
      continue;
    if (type === (void 0).Directory) {
      lines.push(`${indent}${name}/`);
      if (depthLeft > 1) {
        await listTreeLevel(Uri.joinPath(uri, name), indent + "  ", depthLeft - 1, lines);
      }
    } else {
      lines.push(`${indent}${name}`);
    }
  }
}
async function buildRepoOrientation(roots) {
  if (!roots.length)
    return "";
  const sections = [];
  for (const root of roots) {
    const lines = [];
    await listTreeLevel(root.uri, "  ", 2, lines);
    const header = roots.length > 1 ? `Workspace root "${root.name}":` : "Workspace structure (top 2 levels):";
    sections.push(`${header}
${lines.join("\n")}`);
    for (const readmeName of ["README.md", "readme.md", "Readme.md"]) {
      try {
        const bytes = await workspace.fs.readFile(Uri.joinPath(root.uri, readmeName));
        const head = Buffer.from(bytes).toString("utf8").slice(0, ORIENTATION_README_CHARS);
        sections.push(`${readmeName} (first ${ORIENTATION_README_CHARS} chars):
${head}`);
        break;
      } catch {
      }
    }
  }
  return sections.join("\n\n");
}
function displayPathFor(uri, roots) {
  for (const root of roots) {
    const rel = path.relative(root.uri.fsPath, uri.fsPath);
    if (!rel.startsWith("..")) {
      return roots.length > 1 ? `${root.name}/${rel}` : rel;
    }
  }
  return uri.fsPath;
}
export {
  WorkspaceRootRequiredError,
  buildRepoOrientation,
  findFiles,
  findReferences,
  findSymbol,
  getNamedRoots,
  goToDefinition,
  listDirectory,
  readFile2 as readFile,
  resolveAgainstRoots,
  searchCodebase
};
