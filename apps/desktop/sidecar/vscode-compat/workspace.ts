/**
 * `vscode.workspace` for an app with no editor: documents are the files on
 * disk, a WorkspaceEdit is applied straight to disk, and "open documents"
 * never change underneath anyone (so the editor-change events never fire).
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { runtime } from './runtime';
import { matchesGlob } from './glob';
import { hit } from './notSupported';
import {
  Disposable,
  EventEmitter,
  FileType,
  Position,
  Range,
  RelativePattern,
  Uri,
  WorkspaceEdit,
  neverEvent,
  type Event,
  type TextEdit,
} from './types';

// ── Workspace folders ───────────────────────────────────────────────────────

export interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

let folderCache: { key: string; folders: WorkspaceFolder[] } = { key: '', folders: [] };
const foldersChanged = new EventEmitter<{ added: WorkspaceFolder[]; removed: WorkspaceFolder[] }>();

function currentFolders(): WorkspaceFolder[] {
  const key = runtime.workspaceFolders.join('\0');
  if (folderCache.key !== key) {
    folderCache = {
      key,
      folders: runtime.workspaceFolders.map((p, index) => ({ uri: Uri.file(p), name: path.basename(p), index })),
    };
  }
  return folderCache.folders;
}

/** Host-side: replace the open folders (Tauri folder picker, --workspace). */
export function setWorkspaceFolders(paths: string[]): void {
  const before = currentFolders();
  runtime.workspaceFolders = paths.map((p) => path.resolve(p));
  const after = currentFolders();
  foldersChanged.fire({
    added: after.filter((a) => !before.some((b) => b.uri.fsPath === a.uri.fsPath)),
    removed: before.filter((b) => !after.some((a) => a.uri.fsPath === b.uri.fsPath)),
  });
}
export const onDidChangeWorkspaceFolders: Event<{ added: WorkspaceFolder[]; removed: WorkspaceFolder[] }> = foldersChanged.event;

// ── workspace.fs ────────────────────────────────────────────────────────────

export class FileSystemError extends Error {
  static FileNotFound(uri?: Uri | string) {
    return new FileSystemError(`${uri ?? ''}`, 'FileNotFound');
  }
  static FileExists(uri?: Uri | string) {
    return new FileSystemError(`${uri ?? ''}`, 'FileExists');
  }
  static FileNotADirectory(uri?: Uri | string) {
    return new FileSystemError(`${uri ?? ''}`, 'FileNotADirectory');
  }
  static FileIsADirectory(uri?: Uri | string) {
    return new FileSystemError(`${uri ?? ''}`, 'FileIsADirectory');
  }
  static NoPermissions(uri?: Uri | string) {
    return new FileSystemError(`${uri ?? ''}`, 'NoPermissions');
  }
  constructor(message: string, readonly code: string = 'Unknown') {
    super(`${code}: ${message}`);
    this.name = 'FileSystemError';
  }
}

function toFsError(err: any, uri: Uri): Error {
  switch (err?.code) {
    case 'ENOENT':
      return FileSystemError.FileNotFound(uri.fsPath);
    case 'EEXIST':
      return FileSystemError.FileExists(uri.fsPath);
    case 'ENOTDIR':
      return FileSystemError.FileNotADirectory(uri.fsPath);
    case 'EISDIR':
      return FileSystemError.FileIsADirectory(uri.fsPath);
    case 'EACCES':
    case 'EPERM':
      return FileSystemError.NoPermissions(uri.fsPath);
    default:
      return err instanceof Error ? err : new Error(String(err));
  }
}

async function wrap<T>(uri: Uri, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw toFsError(err, uri);
  }
}

function fileTypeOf(st: fs.Stats, isLink = false): FileType {
  const base = st.isDirectory() ? FileType.Directory : st.isFile() ? FileType.File : FileType.Unknown;
  return isLink ? base | FileType.SymbolicLink : base;
}

export const workspaceFs = {
  readFile: (uri: Uri) => wrap(uri, async () => new Uint8Array(await fsp.readFile(uri.fsPath))),
  writeFile: (uri: Uri, content: Uint8Array) =>
    wrap(uri, async () => {
      await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fsp.writeFile(uri.fsPath, content);
    }),
  stat: (uri: Uri) =>
    wrap(uri, async () => {
      const l = await fsp.lstat(uri.fsPath);
      const st = l.isSymbolicLink() ? await fsp.stat(uri.fsPath) : l;
      return { type: fileTypeOf(st, l.isSymbolicLink()), ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size };
    }),
  readDirectory: (uri: Uri) =>
    wrap(uri, async () => {
      const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((e): [string, FileType] => [
        e.name,
        e.isDirectory() ? FileType.Directory : e.isFile() ? FileType.File : e.isSymbolicLink() ? FileType.SymbolicLink : FileType.Unknown,
      ]);
    }),
  createDirectory: (uri: Uri) => wrap(uri, async () => void (await fsp.mkdir(uri.fsPath, { recursive: true }))),
  delete: (uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }) =>
    wrap(uri, async () => {
      const st = await fsp.lstat(uri.fsPath);
      if (st.isDirectory()) await fsp.rm(uri.fsPath, { recursive: !!options?.recursive });
      else await fsp.unlink(uri.fsPath);
    }),
  rename: (source: Uri, target: Uri, options?: { overwrite?: boolean }) =>
    wrap(source, async () => {
      if (!options?.overwrite && fs.existsSync(target.fsPath)) throw FileSystemError.FileExists(target.fsPath);
      await fsp.rename(source.fsPath, target.fsPath);
    }),
  copy: (source: Uri, target: Uri, options?: { overwrite?: boolean }) =>
    wrap(source, async () => {
      await fsp.cp(source.fsPath, target.fsPath, { recursive: true, force: !!options?.overwrite, errorOnExist: !options?.overwrite });
    }),
};

// ── findFiles ───────────────────────────────────────────────────────────────

/** `files.exclude` defaults — applied when the caller passes `exclude: undefined`, as VS Code does. */
const DEFAULT_FILES_EXCLUDE = ['**/.git', '**/.svn', '**/.hg', '**/CVS', '**/.DS_Store', '**/Thumbs.db'];

export async function findFiles(
  include: string | RelativePattern,
  exclude?: string | RelativePattern | null,
  maxResults?: number,
  token?: { isCancellationRequested: boolean }
): Promise<Uri[]> {
  const bases =
    include instanceof RelativePattern ? [include.base] : currentFolders().map((f) => f.uri.fsPath);
  const includeGlob = include instanceof RelativePattern ? include.pattern : include;
  const excludes =
    exclude === undefined
      ? DEFAULT_FILES_EXCLUDE
      : exclude === null
        ? []
        : [exclude instanceof RelativePattern ? exclude.pattern : exclude];
  const limit = maxResults ?? Number.POSITIVE_INFINITY;
  const out: Uri[] = [];

  const excluded = (rel: string, isDir: boolean) =>
    excludes.some((g) => matchesGlob(rel, g) || (isDir && matchesGlob(`${rel}/_`, g)));

  for (const base of bases) {
    const stack = [''];
    while (stack.length && out.length < limit) {
      if (token?.isCancellationRequested) return out;
      const relDir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(path.join(base, relDir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        // Symlinked directories are not followed: a link back up the tree would loop forever.
        if (e.isDirectory()) {
          if (!excluded(rel, true)) stack.push(rel);
        } else if (e.isFile() || e.isSymbolicLink()) {
          if (!excluded(rel, false) && matchesGlob(rel, includeGlob)) {
            out.push(Uri.file(path.join(base, rel)));
            if (out.length >= limit) break;
          }
        }
      }
    }
  }
  return out;
}

// ── Text documents (disk-backed) ────────────────────────────────────────────

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
  '.json': 'json', '.jsonc': 'jsonc', '.md': 'markdown', '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.cs': 'csharp', '.css': 'css', '.scss': 'scss', '.html': 'html',
  '.yml': 'yaml', '.yaml': 'yaml', '.sh': 'shellscript', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.sql': 'sql', '.xml': 'xml', '.toml': 'toml',
};

export class TextDocument {
  version = 1;
  private _text = '';
  private _lineStarts: number[] = [0];
  mtimeMs = 0;
  readonly isUntitled = false;
  readonly isClosed = false;
  readonly isDirty = false;
  readonly languageId: string;

  constructor(readonly uri: Uri, text: string, languageId?: string) {
    this.languageId = languageId ?? LANGUAGE_BY_EXT[path.extname(uri.fsPath).toLowerCase()] ?? 'plaintext';
    this._setText(text);
  }

  _setText(text: string): void {
    this._text = text;
    this._lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this._lineStarts.push(i + 1);
  }

  get fileName(): string {
    return this.uri.fsPath;
  }
  get lineCount(): number {
    return this._lineStarts.length;
  }
  get eol(): number {
    return this._text.includes('\r\n') ? 2 : 1;
  }

  getText(range?: Range): string {
    if (!range) return this._text;
    return this._text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  lineAt(lineOrPosition: number | Position) {
    const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
    if (line < 0 || line >= this.lineCount) throw new Error(`Illegal value for \`line\`: ${line}`);
    const start = this._lineStarts[line]!;
    const nextStart = line + 1 < this.lineCount ? this._lineStarts[line + 1]! : this._text.length;
    let end = nextStart;
    if (line + 1 < this.lineCount) end -= 1; // drop \n
    if (end > start && this._text.charCodeAt(end - 1) === 13) end -= 1; // drop \r
    const text = this._text.slice(start, end);
    const firstNonWs = text.search(/\S/);
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: new Range(new Position(line, 0), this.positionAt(nextStart)),
      firstNonWhitespaceCharacterIndex: firstNonWs === -1 ? text.length : firstNonWs,
      isEmptyOrWhitespace: firstNonWs === -1,
    };
  }

  offsetAt(p: Position): number {
    if (p.line >= this.lineCount) return this._text.length;
    const start = this._lineStarts[Math.max(0, p.line)]!;
    const lineEnd = p.line + 1 < this.lineCount ? this._lineStarts[p.line + 1]! - 1 : this._text.length;
    return Math.min(start + Math.max(0, p.character), lineEnd);
  }

  positionAt(offset: number): Position {
    const o = Math.max(0, Math.min(offset, this._text.length));
    let lo = 0;
    let hi = this._lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._lineStarts[mid]! <= o) lo = mid;
      else hi = mid - 1;
    }
    return new Position(lo, o - this._lineStarts[lo]!);
  }

  getWordRangeAtPosition(p: Position, regex = /[\w$]+/g): Range | undefined {
    const text = this.lineAt(p.line).text;
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index <= p.character && p.character <= m.index + m[0].length) {
        return new Range(p.line, m.index, p.line, m.index + m[0].length);
      }
      if (m[0].length === 0) re.lastIndex++;
    }
    return undefined;
  }

  validatePosition(p: Position): Position {
    return this.positionAt(this.offsetAt(p));
  }
  validateRange(r: Range): Range {
    return new Range(this.validatePosition(r.start), this.validatePosition(r.end));
  }

  /** The document IS the file: applyEdit already wrote it. */
  async save(): Promise<boolean> {
    return true;
  }
}

const documents = new Map<string, TextDocument>();
const contentProviders = new Map<string, { provideTextDocumentContent(uri: Uri, token: unknown): any }>();

export async function openTextDocument(arg: Uri | string | { content?: string; language?: string }): Promise<TextDocument> {
  if (typeof arg === 'object' && !(arg instanceof Uri)) {
    return new TextDocument(Uri.from({ scheme: 'untitled', path: `/Untitled-${Date.now()}` }), arg.content ?? '', arg.language);
  }
  const uri = typeof arg === 'string' ? Uri.file(arg) : arg;
  if (uri.scheme !== 'file') {
    const provider = contentProviders.get(uri.scheme);
    if (!provider) throw new Error(`No text document content provider for scheme "${uri.scheme}"`);
    const text = await provider.provideTextDocumentContent(uri, { isCancellationRequested: false });
    return new TextDocument(uri, String(text ?? ''));
  }
  const key = uri.fsPath;
  const st = await wrap(uri, () => fsp.stat(key));
  if (st.isDirectory()) throw FileSystemError.FileIsADirectory(key);
  const existing = documents.get(key);
  if (existing && existing.mtimeMs === st.mtimeMs) return existing;
  const text = await fsp.readFile(key, 'utf8');
  const doc = existing ?? new TextDocument(uri, text);
  if (existing) {
    existing._setText(text);
    existing.version++;
  }
  doc.mtimeMs = st.mtimeMs;
  documents.set(key, doc);
  return doc;
}

export function registerTextDocumentContentProvider(scheme: string, provider: { provideTextDocumentContent(uri: Uri, token: unknown): any }): Disposable {
  contentProviders.set(scheme, provider);
  return new Disposable(() => contentProviders.delete(scheme));
}

// ── applyEdit ───────────────────────────────────────────────────────────────

function applyTextEdits(text: string, edits: TextEdit[], uri: Uri): string {
  // All edits for one resource are relative to its state before the batch, as in VS Code.
  const doc = new TextDocument(uri, text);
  const spans = edits
    .map((e) => ({ start: doc.offsetAt(e.range.start), end: doc.offsetAt(e.range.end), text: e.newText }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const s of spans) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

export async function applyEdit(edit: WorkspaceEdit): Promise<boolean> {
  // Resolve the whole edit in memory first, then touch the disk: a failure
  // half-way through must not leave some files written and others not.
  const state = new Map<string, string | null>(); // fsPath → content (null = deleted)
  const load = async (p: string) => {
    if (!state.has(p)) state.set(p, fs.existsSync(p) ? await fsp.readFile(p, 'utf8') : null);
    return state.get(p)!;
  };
  const renames: { from: string; to: string }[] = [];
  try {
    const ops = edit._ops;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if (op.kind === 'text') {
        const target = op.uri.fsPath;
        const batch: TextEdit[] = [op.edit];
        while (i + 1 < ops.length && ops[i + 1]!.kind === 'text' && (ops[i + 1] as any).uri.fsPath === target) {
          batch.push((ops[++i] as any).edit);
        }
        const current = await load(target);
        if (current === null) throw new Error(`cannot edit ${target}: file does not exist`);
        state.set(target, applyTextEdits(current, batch, op.uri));
      } else if (op.kind === 'create') {
        const current = await load(op.uri.fsPath);
        if (current !== null && !op.options?.overwrite) {
          if (op.options?.ignoreIfExists) continue;
          throw new Error(`cannot create ${op.uri.fsPath}: file exists`);
        }
        state.set(op.uri.fsPath, '');
      } else if (op.kind === 'delete') {
        const current = await load(op.uri.fsPath);
        if (current === null && !op.options?.ignoreIfNotExists) throw new Error(`cannot delete ${op.uri.fsPath}: not found`);
        state.set(op.uri.fsPath, null);
      } else {
        renames.push({ from: op.from.fsPath, to: op.to.fsPath });
      }
    }
    for (const [p, content] of state) {
      if (content === null) {
        if (fs.existsSync(p)) await fsp.rm(p, { recursive: true });
        documents.delete(p);
      } else {
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.writeFile(p, content, 'utf8');
        const doc = documents.get(p);
        if (doc) {
          doc._setText(content);
          doc.version++;
          doc.mtimeMs = (await fsp.stat(p)).mtimeMs;
        }
      }
    }
    for (const r of renames) {
      await fsp.mkdir(path.dirname(r.to), { recursive: true });
      await fsp.rename(r.from, r.to);
      documents.delete(r.from);
    }
    return true;
  } catch (err) {
    console.error('[vscode-compat] workspace.applyEdit failed:', err);
    return false;
  }
}

// ── Configuration ───────────────────────────────────────────────────────────

let contributedDefaults: Record<string, unknown> | null = null;
/** Defaults from the extension's package.json `contributes.configuration` — the same source VS Code reads. */
function defaults(): Record<string, unknown> {
  if (contributedDefaults) return contributedDefaults;
  contributedDefaults = {
    // Editor settings the extension reads for format-on-save; VS Code's own defaults.
    'editor.formatOnSave': false,
    'editor.tabSize': 4,
    'editor.insertSpaces': true,
  };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(runtime.extensionDir, 'package.json'), 'utf8'));
    const blocks = [pkg.contributes?.configuration ?? []].flat();
    for (const block of blocks) {
      for (const [key, schema] of Object.entries<any>(block?.properties ?? {})) {
        if ('default' in schema) contributedDefaults[key] = schema.default;
      }
    }
  } catch (err) {
    console.warn('[vscode-compat] could not read contributed configuration defaults:', err);
  }
  // The extension's own update check looks at Open VSX and offers
  // `workbench.extensions.installExtension`. The desktop app is updated as
  // a whole by src-tauri/src/updater.rs, so that toast would name the wrong
  // version and its button can't work.
  contributedDefaults['workspacegpt.checkForUpdates'] = false;
  return contributedDefaults;
}

const configChanged = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
export const onDidChangeConfiguration = configChanged.event;

export function getConfiguration(section?: string, _scope?: unknown) {
  const full = (key: string) => (section ? `${section}.${key}` : key);
  const lookup = (key: string): { found: boolean; value?: unknown } => {
    const k = full(key);
    const user = runtime.readSettings();
    if (k in user) return { found: true, value: user[k] };
    const d = defaults();
    if (k in d) return { found: true, value: d[k] };
    return { found: false };
  };
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      hit(`workspace.getConfiguration(${full(key)})`);
      const r = lookup(key);
      return r.found ? (r.value as T) : defaultValue;
    },
    has(key: string): boolean {
      return lookup(key).found;
    },
    inspect(key: string) {
      const k = full(key);
      return { key: k, defaultValue: defaults()[k], globalValue: runtime.readSettings()[k] };
    },
    async update(key: string, value: unknown): Promise<void> {
      const k = full(key);
      const next = { ...runtime.readSettings() };
      if (value === undefined) delete next[k];
      else next[k] = value;
      runtime.writeSettings(next);
      configChanged.fire({ affectsConfiguration: (s: string) => k === s || k.startsWith(`${s}.`) });
    },
  };
}

// ── File system watcher ─────────────────────────────────────────────────────

export function createFileSystemWatcher(
  globPattern: string | RelativePattern,
  ignoreCreate = false,
  ignoreChange = false,
  ignoreDelete = false
) {
  const created = new EventEmitter<Uri>();
  const changed = new EventEmitter<Uri>();
  const deleted = new EventEmitter<Uri>();
  const bases = globPattern instanceof RelativePattern ? [globPattern.base] : currentFolders().map((f) => f.uri.fsPath);
  const glob = globPattern instanceof RelativePattern ? globPattern.pattern : globPattern;
  const watchers: fs.FSWatcher[] = [];
  for (const base of bases) {
    try {
      const w = fs.watch(base, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = String(filename).split(path.sep).join('/');
        if (!matchesGlob(rel, glob)) return;
        const uri = Uri.file(path.join(base, String(filename)));
        if (eventType === 'change') {
          if (!ignoreChange) changed.fire(uri);
        } else if (fs.existsSync(uri.fsPath)) {
          if (!ignoreCreate) created.fire(uri);
        } else if (!ignoreDelete) deleted.fire(uri);
      });
      watchers.push(w);
    } catch (err) {
      console.warn(`[vscode-compat] createFileSystemWatcher: cannot watch ${base}:`, err);
    }
  }
  return {
    ignoreCreateEvents: ignoreCreate,
    ignoreChangeEvents: ignoreChange,
    ignoreDeleteEvents: ignoreDelete,
    onDidCreate: created.event,
    onDidChange: changed.event,
    onDidDelete: deleted.event,
    dispose() {
      watchers.forEach((w) => w.close());
      created.dispose();
      changed.dispose();
      deleted.dispose();
    },
  };
}

// ── The namespace ───────────────────────────────────────────────────────────

export const workspace = {
  get workspaceFolders(): WorkspaceFolder[] | undefined {
    const f = currentFolders();
    return f.length ? f : undefined;
  },
  onDidChangeWorkspaceFolders,
  fs: workspaceFs,
  findFiles,
  openTextDocument,
  registerTextDocumentContentProvider,
  applyEdit,
  getConfiguration,
  onDidChangeConfiguration,
  createFileSystemWatcher,
  // No editor: open documents never change under the extension.
  onDidChangeTextDocument: neverEvent<unknown>(),
};
