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
var Range = class {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
};
var WorkspaceEdit = class {
  constructor() {
    this.ops = [];
  }
  createFile(uri, opts) {
    this.ops.push({ kind: "create", uri, opts });
  }
  deleteFile(uri) {
    this.ops.push({ kind: "delete", uri });
  }
  insert(uri, pos, text) {
    this.ops.push({ kind: "insert", uri, pos, text });
  }
  replace(uri, range, text) {
    this.ops.push({ kind: "replace", uri, range, text });
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
if (!fs.existsSync)
  throw new Error("vscode-stub: fs unavailable");

// ../../apps/vscode-extensions/src/services/agent/agentWriteTools.ts
import * as path from "path";

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

// ../../apps/vscode-extensions/src/services/agent/agentWriteTools.ts
var MAX_WRITE_BYTES = 1024 * 1024;
var SECRET_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\..*)?$/i,
  /^credentials.*\.json$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^secrets?\.(json|ya?ml|toml)$/i
];
function assertWritable(roots, relOrPrefixed) {
  if (!roots.length)
    throw new WorkspaceRootRequiredError();
  const resolved = resolveAgainstRoots(roots, relOrPrefixed);
  if (!resolved)
    throw new Error(`Cannot resolve path "${relOrPrefixed}" against the workspace.`);
  const rootFsPath = resolved.root.uri.fsPath;
  const absPath = path.resolve(rootFsPath, resolved.relPath);
  if (absPath !== rootFsPath && !absPath.startsWith(rootFsPath + path.sep)) {
    throw new Error("Path resolves outside the workspace root \u2014 refusing to write.");
  }
  if (absPath.split(path.sep).includes(".git")) {
    throw new Error("Refusing to write inside a .git directory.");
  }
  const base = path.basename(absPath);
  if (SECRET_FILE_PATTERNS.some((re) => re.test(base))) {
    throw new Error(`Refusing to write "${base}" \u2014 secret/credential files are blocked for agent writes.`);
  }
  return { uri: Uri.file(absPath), displayPath: relOrPrefixed.replace(/^\.?\//, "") };
}
async function documentText(uri) {
  const doc = await workspace.openTextDocument(uri);
  return doc.getText();
}
var countOccurrences = (haystack, needle) => needle === "" ? 0 : haystack.split(needle).length - 1;
function closestSnippet(content, oldString) {
  const firstTarget = oldString.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  if (!firstTarget)
    return null;
  const targetTokens = new Set(firstTarget.split(/\W+/).filter((w) => w.length > 2));
  const fileLines = content.split("\n");
  let bestIdx = -1;
  let bestScore = 0;
  fileLines.forEach((line, i) => {
    const t = line.trim();
    if (!t)
      return;
    let score = 0;
    if (t === firstTarget)
      score = 1e3;
    else
      for (const w of t.split(/\W+/))
        if (targetTokens.has(w))
          score++;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });
  if (bestIdx < 0 || bestScore < 2)
    return null;
  const targetLineCount = oldString.split("\n").length;
  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(fileLines.length, bestIdx + Math.max(targetLineCount + 2, 5));
  return fileLines.slice(start, end).join("\n");
}
function describeOccurrences(content, needle, cap = 5) {
  const lines = [];
  let from = 0;
  for (let n = 1; n <= cap; n++) {
    const idx = content.indexOf(needle, from);
    if (idx === -1)
      break;
    const lineNo = content.slice(0, idx).split("\n").length;
    const allLines = content.split("\n");
    let precedingText = "";
    for (let i = lineNo - 2; i >= 0; i--) {
      if (allLines[i].trim()) {
        precedingText = allLines[i].trim().slice(0, 80);
        break;
      }
    }
    lines.push(`  ${n}) line ${lineNo}${precedingText ? `, preceded by: "${precedingText}"` : ""}`);
    from = idx + needle.length;
  }
  return lines.join("\n");
}
async function prepareEditFile(args, roots) {
  if (!args.oldString)
    throw new Error("oldString must be non-empty. To create a new file use create_file.");
  if (args.oldString === args.newString)
    throw new Error("oldString and newString are identical \u2014 nothing to change.");
  const { uri, displayPath } = assertWritable(roots, args.path);
  let before;
  try {
    before = await documentText(uri);
  } catch {
    throw new Error(`File not found: ${args.path}. Use create_file for new files, or check the path with list_directory.`);
  }
  if (Buffer.byteLength(before, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`File exceeds the ${MAX_WRITE_BYTES / 1024}KB agent-edit limit.`);
  }
  const occurrences = countOccurrences(before, args.oldString);
  if (occurrences === 0) {
    const snippet = closestSnippet(before, args.oldString);
    throw new Error(
      "oldString was not found in the file. It must match the current file content EXACTLY, including whitespace, indentation, and line breaks." + (snippet ? ` The closest matching region of the actual file is:
\`\`\`
${snippet}
\`\`\`
Copy oldString EXACTLY from this \u2014 including its line breaks.` : " Re-read the file and copy the text verbatim.")
    );
  }
  if (occurrences > 1 && !args.replaceAll) {
    throw new Error(
      `oldString appears ${occurrences} times in the file:
${describeOccurrences(before, args.oldString)}
Extend oldString to ALSO include the preceding line of the ONE occurrence you mean (copied EXACTLY from the file). Only if you genuinely intend to change every occurrence, pass replaceAll: true instead.`
    );
  }
  const after = args.replaceAll ? before.split(args.oldString).join(args.newString) : before.replace(args.oldString, args.newString);
  const n = args.replaceAll ? occurrences : 1;
  return {
    kind: "edit",
    displayPath,
    uri,
    before,
    after,
    summary: `Edit ${displayPath} (${n} replacement${n === 1 ? "" : "s"})`
  };
}
async function prepareCreateFile(args, roots) {
  const { uri, displayPath } = assertWritable(roots, args.path);
  if (Buffer.byteLength(args.content ?? "", "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`Content exceeds the ${MAX_WRITE_BYTES / 1024}KB agent-write limit.`);
  }
  let exists = true;
  try {
    await workspace.fs.stat(uri);
  } catch {
    exists = false;
  }
  if (exists) {
    throw new Error(`File already exists: ${args.path}. Use edit_file to modify it.`);
  }
  return {
    kind: "create",
    displayPath,
    uri,
    before: "",
    after: args.content ?? "",
    summary: `Create ${displayPath} (${(args.content ?? "").split("\n").length} lines)`
  };
}
async function prepareDeleteFile(args, roots) {
  const { uri, displayPath } = assertWritable(roots, args.path);
  let before;
  try {
    before = await documentText(uri);
  } catch {
    throw new Error(`File not found: ${args.path}.`);
  }
  return {
    kind: "delete",
    displayPath,
    uri,
    before,
    after: "",
    summary: `Delete ${displayPath}`
  };
}
async function applyWrite(w) {
  const edit = new WorkspaceEdit();
  if (w.kind === "create") {
    edit.createFile(w.uri, { ignoreIfExists: false });
    edit.insert(w.uri, new Position(0, 0), w.after);
  } else if (w.kind === "delete") {
    edit.deleteFile(w.uri);
  } else {
    const doc = await workspace.openTextDocument(w.uri);
    if (doc.getText() !== w.before) {
      throw new Error(`${w.displayPath} changed since the edit was prepared \u2014 re-read the file and try again.`);
    }
    const fullRange = new Range(doc.positionAt(0), doc.positionAt(w.before.length));
    edit.replace(w.uri, fullRange, w.after);
  }
  const ok = await workspace.applyEdit(edit);
  if (!ok)
    throw new Error(`VS Code rejected the workspace edit for ${w.displayPath}.`);
  if (w.kind !== "delete") {
    const doc = await workspace.openTextDocument(w.uri);
    await doc.save();
  }
}
export {
  applyWrite,
  prepareCreateFile,
  prepareDeleteFile,
  prepareEditFile
};
