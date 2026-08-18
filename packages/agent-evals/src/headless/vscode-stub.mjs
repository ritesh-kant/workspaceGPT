/**
 * Minimal `vscode` module stub for HEADLESS testing of extension services
 * (P1.9 live validation, PHASES.md). Covers exactly the API surface touched
 * by agentWriteTools / commandTools / codebaseTools at import + prepare time.
 * applyWrite()'s WorkspaceEdit path is NOT faithfully emulated — the harness
 * applies PreparedWrites itself via fs; WorkspaceEdit semantics stay an
 * Extension-Development-Host concern.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';

export const Uri = {
  file(p) {
    return { fsPath: p, scheme: 'file', path: p, toString: () => `file://${p}` };
  },
};

export class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

export class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

export class WorkspaceEdit {
  constructor() {
    this.ops = [];
  }
  createFile(uri, opts) {
    this.ops.push({ kind: 'create', uri, opts });
  }
  deleteFile(uri) {
    this.ops.push({ kind: 'delete', uri });
  }
  insert(uri, pos, text) {
    this.ops.push({ kind: 'insert', uri, pos, text });
  }
  replace(uri, range, text) {
    this.ops.push({ kind: 'replace', uri, range, text });
  }
}

function makeDocument(uri, content) {
  return {
    uri,
    getText: () => content,
    positionAt(offset) {
      const upTo = content.slice(0, offset);
      const line = (upTo.match(/\n/g) || []).length;
      const character = offset - (upTo.lastIndexOf('\n') + 1);
      return new Position(line, character);
    },
    save: async () => true,
  };
}

export const workspace = {
  async openTextDocument(uri) {
    const p = typeof uri === 'string' ? uri : uri.fsPath;
    const content = await fsp.readFile(p, 'utf8'); // throws like the real API when missing
    return makeDocument(typeof uri === 'string' ? Uri.file(uri) : uri, content);
  },
  fs: {
    async stat(uri) {
      const st = await fsp.stat(uri.fsPath);
      return { size: st.size };
    },
  },
  async applyEdit() {
    throw new Error('vscode-stub: applyEdit is not supported headlessly — apply PreparedWrite via fs in the harness.');
  },
  workspaceFolders: [],
  getConfiguration: () => ({ get: () => undefined }),
};

export const window = {
  createOutputChannel: () => ({
    append() {},
    appendLine() {},
    show() {},
    clear() {},
    dispose() {},
  }),
};

export const languages = {
  getDiagnostics: () => [],
};

export const commands = {
  executeCommand: async () => {
    throw new Error('vscode-stub: language-service commands are unavailable headlessly.');
  },
};

// Only referenced as types/enums in some files; harmless minimal values.
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const SymbolKind = {};

// Guard: fail loudly if fs is somehow unavailable (bundler sanity).
if (!fs.existsSync) throw new Error('vscode-stub: fs unavailable');
