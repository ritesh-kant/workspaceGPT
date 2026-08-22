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
function flexibleMatches(content, oldString) {
  const trimmed = oldString.trim();
  if (!trimmed)
    return [];
  const pattern = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  let re;
  try {
    re = new RegExp(pattern, "g");
  } catch {
    return [];
  }
  const matches = [];
  let m;
  while (m = re.exec(content)) {
    matches.push({ index: m.index, text: m[0] });
    if (matches.length > 8)
      break;
  }
  return matches;
}
function reflowReplacement(matchedText, oldString, newString) {
  const oldTokens = oldString.trim().split(/\s+/);
  const newTokens = newString.trim().split(/\s+/);
  if (newTokens.length !== oldTokens.length)
    return null;
  const differing = newTokens.filter((t, i) => t !== oldTokens[i]).length;
  if (differing > Math.max(1, Math.floor(newTokens.length / 2)))
    return null;
  let ti = 0;
  const rebuilt = matchedText.split(/(\s+)/).map((part) => part === "" || /^\s+$/.test(part) ? part : newTokens[ti++]).join("");
  return ti === newTokens.length ? rebuilt : null;
}
function occurrenceSnippets(content, needle, cap = 3) {
  const rawLines = content.split("\n");
  const needleLineCount = needle.split("\n").length;
  const out = [];
  let from = 0;
  for (let n = 0; n < cap; n++) {
    const idx = content.indexOf(needle, from);
    if (idx === -1)
      break;
    const startLine = content.slice(0, idx).split("\n").length - 1;
    let ctxStart = Math.max(0, startLine - 1);
    while (ctxStart > 0 && !rawLines[ctxStart].trim())
      ctxStart--;
    const endLine = startLine + needleLineCount - 1;
    out.push(rawLines.slice(ctxStart, endLine + 1).join("\n"));
    from = idx + needle.length;
  }
  return out;
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
    const flex = flexibleMatches(before, args.oldString);
    if (flex.length === 1) {
      const { index, text: matchedText } = flex[0];
      const replacement = reflowReplacement(matchedText, args.oldString, args.newString);
      if (replacement !== null && replacement !== matchedText) {
        const after2 = before.slice(0, index) + replacement + before.slice(index + matchedText.length);
        return {
          kind: "edit",
          displayPath,
          uri,
          before,
          after: after2,
          // Read by the model (tool result), the user (review card), and the
          // audit log alike — states plainly that the match was not verbatim.
          summary: `Edit ${displayPath} (1 replacement \u2014 oldString did not match the file's whitespace/line breaks verbatim; matched ignoring layout, applied with the file's original formatting preserved)`
        };
      }
      throw new Error(
        `oldString was not found verbatim, but exactly one region of the file matches it when whitespace is ignored. That region ACTUALLY reads:
\`\`\`
${matchedText}
\`\`\`
Retry with oldString copied EXACTLY from this snippet (same line breaks and indentation), and write newString as full lines in the same multi-line style.`
      );
    }
    if (flex.length > 1) {
      throw new Error(
        `oldString was not found verbatim, and ignoring whitespace it matches ${flex.length} places in the file \u2014 ambiguous. Re-read the file and copy a LONGER snippet EXACTLY (including line breaks and the line above your target) that identifies the ONE place you mean.`
      );
    }
    const oldLines = args.oldString.split("\n").map((l) => l.trim()).filter(Boolean);
    if (oldLines.length >= 2) {
      const rawFileLines = before.split("\n");
      const trimmedFileLines = rawFileLines.map((l) => l.trim());
      const positions = [];
      let cursor = 0;
      for (const ol of oldLines) {
        const idx = trimmedFileLines.indexOf(ol, cursor);
        if (idx === -1) {
          positions.length = 0;
          break;
        }
        positions.push(idx);
        cursor = idx + 1;
      }
      const hasContentBetween = (a, b) => {
        for (let j = a + 1; j < b; j++)
          if (trimmedFileLines[j])
            return true;
        return false;
      };
      if (positions.length === oldLines.length && positions.some((p, i) => i > 0 && hasContentBetween(positions[i - 1], p))) {
        let firstEnd = 0;
        while (firstEnd + 1 < positions.length && !hasContentBetween(positions[firstEnd], positions[firstEnd + 1]))
          firstEnd++;
        const firstRegion = rawFileLines.slice(positions[0], positions[firstEnd] + 1).join("\n");
        throw new Error(
          `oldString stitches together NON-ADJACENT parts of the file \u2014 its lines all exist, but the file has other code between them that your oldString skips over. Make a SEPARATE edit_file call for EACH contiguous region. The first region actually reads:
\`\`\`
${firstRegion}
\`\`\`
Start by editing exactly that, then make further edit_file calls for the other region(s).`
        );
      }
    }
    const snippet = closestSnippet(before, args.oldString);
    throw new Error(
      "oldString was not found in the file. It must match the current file content EXACTLY, including whitespace, indentation, and line breaks." + (snippet ? ` The closest matching region of the actual file is:
\`\`\`
${snippet}
\`\`\`
Copy oldString EXACTLY from this \u2014 including its line breaks.` : ` The text does not appear in ${displayPath} at all, even ignoring whitespace \u2014 you may be editing the WRONG FILE (e.g. trying to change a definition in a file that only imports it). Use search_codebase to find which file actually contains this text, then read_file THAT file and copy oldString exactly.`)
    );
  }
  if (occurrences > 1 && !args.replaceAll) {
    const snippets = occurrenceSnippets(before, args.oldString);
    throw new Error(
      `oldString appears ${occurrences} times in the file \u2014 ambiguous. To change ONE of them, retry with oldString set to the ENTIRE block below for the occurrence you mean (copied EXACTLY, all lines), and newString to that same block with your change applied:
` + snippets.map((s, i) => `${i + 1})
\`\`\`
${s}
\`\`\``).join("\n") + (occurrences > snippets.length ? `
(${occurrences - snippets.length} more occurrence(s) not shown)` : "") + "\nOnly if you genuinely intend to change every occurrence, pass replaceAll: true instead."
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
