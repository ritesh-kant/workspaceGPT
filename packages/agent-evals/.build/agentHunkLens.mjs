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
var languages = {
  getDiagnostics: () => []
};
var commands = {
  executeCommand: async () => {
    throw new Error("vscode-stub: language-service commands are unavailable headlessly.");
  }
};
if (!fs.existsSync)
  throw new Error("vscode-stub: fs unavailable");

// ../../apps/vscode-extensions/src/services/agent/agentDiffProvider.ts
var originals = /* @__PURE__ */ new Map();
var changed = null;
var emitter = () => changed ??= new (void 0)();
function onOriginalsChanged(listener) {
  return emitter().event(listener);
}
function hasOriginal(fsPath) {
  return originals.has(fsPath);
}
function getOriginalContent(fsPath) {
  return originals.get(fsPath);
}
function setOriginalContent(fsPath, content) {
  originals.set(fsPath, content);
  changed?.fire(fsPath);
}

// ../../apps/vscode-extensions/src/services/agent/agentHunkLens.ts
var splitLines = (s) => s === "" ? [] : s.split("\n");
function computeHunks(original, current) {
  const a = splitLines(original);
  const b = splitLines(current);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre])
    pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf])
    suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (!am.length && !bm.length)
    return [];
  if (am.length * bm.length > 4e6) {
    return [{ origStart: pre, origEnd: a.length - suf, curStart: pre, curEnd: b.length - suf }];
  }
  const n = am.length;
  const m = bm.length;
  const dp = [];
  for (let i2 = 0; i2 <= n; i2++)
    dp.push(new Uint32Array(m + 1));
  for (let i2 = n - 1; i2 >= 0; i2--) {
    for (let j2 = m - 1; j2 >= 0; j2--) {
      dp[i2][j2] = am[i2] === bm[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
    }
  }
  const hunks = [];
  let i = 0;
  let j = 0;
  let open = null;
  const close = () => {
    if (open)
      hunks.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      close();
      i++;
      j++;
      continue;
    }
    if (!open)
      open = { origStart: pre + i, origEnd: pre + i, curStart: pre + j, curEnd: pre + j };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      j++;
      open.curEnd = pre + j;
    } else {
      i++;
      open.origEnd = pre + i;
    }
  }
  close();
  return hunks;
}
function replaceLines(lines, start, end, replacement) {
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
}
var AgentHunkLensProvider = class {
  constructor() {
    this.changed = new (void 0)();
    this.onDidChangeCodeLenses = this.changed.event;
  }
  refresh() {
    this.changed.fire();
  }
  provideCodeLenses(document) {
    const fsPath = document.uri.fsPath;
    if (document.uri.scheme !== "file" || !hasOriginal(fsPath))
      return [];
    const original = getOriginalContent(fsPath) ?? "";
    const hunks = computeHunks(original, document.getText());
    if (!hunks.length)
      return [];
    const lenses = [];
    const headerLine = Math.max(0, Math.min(hunks[0].curStart, document.lineCount - 1));
    const headerRange = new Range(headerLine, 0, headerLine, 0);
    lenses.push(
      new (void 0)(headerRange, {
        title: `WorkspaceGPT: ${hunks.length} change${hunks.length === 1 ? "" : "s"} in this file`,
        command: ""
      }),
      new (void 0)(headerRange, { title: "$(check-all) Keep all", command: "workspacegpt.agent.keepAllHunks", arguments: [document.uri] }),
      new (void 0)(headerRange, { title: "$(discard) Revert all", command: "workspacegpt.agent.revertAllHunks", arguments: [document.uri] })
    );
    hunks.forEach((h, idx) => {
      const line = Math.min(h.curStart, Math.max(0, document.lineCount - 1));
      const range = new Range(line, 0, line, 0);
      const added = h.curEnd - h.curStart;
      const removed = h.origEnd - h.origStart;
      lenses.push(
        new (void 0)(range, { title: `$(check) Keep (+${added} \u2212${removed})`, command: "workspacegpt.agent.keepHunk", arguments: [document.uri, idx] }),
        new (void 0)(range, { title: "$(discard) Revert", command: "workspacegpt.agent.revertHunk", arguments: [document.uri, idx] })
      );
    });
    return lenses;
  }
};
async function currentHunks(uri) {
  const original = getOriginalContent(uri.fsPath);
  if (original == null)
    return null;
  const doc = await workspace.openTextDocument(uri);
  return { doc, hunks: computeHunks(original, doc.getText()), original };
}
async function replaceDocument(doc, text) {
  const edit = new WorkspaceEdit();
  const full = new Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(doc.uri, full, text);
  await workspace.applyEdit(edit);
  await doc.save();
}
function registerAgentHunkLenses(context) {
  const provider = new AgentHunkLensProvider();
  context.subscriptions.push(
    languages.registerCodeLensProvider({ scheme: "file" }, provider),
    onOriginalsChanged(() => provider.refresh()),
    workspace.onDidChangeTextDocument((e) => {
      if (hasOriginal(e.document.uri.fsPath))
        provider.refresh();
    }),
    commands.registerCommand("workspacegpt.agent.keepHunk", async (uri, idx) => {
      const state = await currentHunks(uri);
      const h = state?.hunks[idx];
      if (!state || !h)
        return;
      const curLines = splitLines(state.doc.getText());
      const origLines = splitLines(state.original);
      const next = replaceLines(origLines, h.origStart, h.origEnd, curLines.slice(h.curStart, h.curEnd));
      setOriginalContent(uri.fsPath, next.join("\n"));
    }),
    commands.registerCommand("workspacegpt.agent.revertHunk", async (uri, idx) => {
      const state = await currentHunks(uri);
      const h = state?.hunks[idx];
      if (!state || !h)
        return;
      const curLines = splitLines(state.doc.getText());
      const origLines = splitLines(state.original);
      const next = replaceLines(curLines, h.curStart, h.curEnd, origLines.slice(h.origStart, h.origEnd));
      await replaceDocument(state.doc, next.join("\n"));
    }),
    commands.registerCommand("workspacegpt.agent.keepAllHunks", async (uri) => {
      const doc = await workspace.openTextDocument(uri);
      setOriginalContent(uri.fsPath, doc.getText());
    }),
    commands.registerCommand("workspacegpt.agent.revertAllHunks", async (uri) => {
      const state = await currentHunks(uri);
      if (!state)
        return;
      await replaceDocument(state.doc, state.original);
    })
  );
}
export {
  computeHunks,
  registerAgentHunkLenses
};
