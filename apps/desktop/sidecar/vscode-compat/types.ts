/**
 * Value types from the vscode API: Uri, Position, Range, EventEmitter, … —
 * the pure-data half of the module. Semantics follow vscode.d.ts closely
 * enough for how apps/vscode-extensions/src uses them; nothing here touches
 * the host.
 */
import * as path from 'node:path';
import { notSupportedClass } from './notSupported';

// ── Disposable / events ─────────────────────────────────────────────────────

export class Disposable {
  static from(...items: { dispose(): any }[]): Disposable {
    return new Disposable(() => items.forEach((i) => i?.dispose()));
  }
  private _fn: (() => any) | undefined;
  constructor(callOnDispose: () => any) {
    this._fn = callOnDispose;
  }
  dispose(): any {
    const fn = this._fn;
    this._fn = undefined;
    return fn?.();
  }
}

export type Event<T> = (listener: (e: T) => any, thisArgs?: any, disposables?: Disposable[]) => Disposable;

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => any>();
  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    this.listeners.add(bound);
    const d = new Disposable(() => this.listeners.delete(bound));
    disposables?.push(d);
    return d;
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(data);
      } catch (err) {
        console.error('[vscode-compat] event listener threw:', err);
      }
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

/** An event that never fires — for editor events in an app with no editor. */
export function neverEvent<T>(): Event<T> {
  return () => new Disposable(() => undefined);
}

export class CancellationTokenSource {
  private emitter = new EventEmitter<void>();
  private _cancelled = false;
  readonly token: { readonly isCancellationRequested: boolean; onCancellationRequested: Event<void> };
  constructor() {
    const isCancelled = () => this._cancelled;
    this.token = {
      get isCancellationRequested() {
        return isCancelled();
      },
      onCancellationRequested: this.emitter.event,
    };
  }
  cancel(): void {
    if (!this._cancelled) {
      this._cancelled = true;
      this.emitter.fire();
    }
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

// ── Uri ─────────────────────────────────────────────────────────────────────

const URI_RE = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;
const isWindows = process.platform === 'win32';

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  /** The exact string Uri.parse() saw, so http(s) links round-trip byte for byte. */
  private readonly _raw?: string;

  private constructor(scheme: string, authority: string, p: string, query: string, fragment: string, raw?: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = p;
    this.query = query;
    this.fragment = fragment;
    this._raw = raw;
  }

  static file(fsPath: string): Uri {
    let p = isWindows ? fsPath.replace(/\\/g, '/') : fsPath;
    if (isWindows && /^[a-zA-Z]:/.test(p)) p = '/' + p;
    if (!p.startsWith('/')) p = '/' + p;
    return new Uri('file', '', p, '', '');
  }

  static parse(value: string): Uri {
    const m = URI_RE.exec(value);
    if (!m) return new Uri('', '', value, '', '', value);
    const dec = (s: string | undefined) => {
      try {
        return decodeURIComponent(s ?? '');
      } catch {
        return s ?? '';
      }
    };
    return new Uri(m[2] ?? '', dec(m[4]), dec(m[5]), m[7] ?? '', m[9] ?? '', value);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return base.with({ path: path.posix.join(base.path || '/', ...segments) });
  }

  static from(c: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(c.scheme, c.authority ?? '', c.path ?? '', c.query ?? '', c.fragment ?? '');
  }

  get fsPath(): string {
    let p = this.path;
    if (this.authority && this.scheme === 'file') p = `//${this.authority}${p}`;
    if (isWindows) {
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
      p = p.replace(/\//g, '\\');
    }
    return p;
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    );
  }

  toString(skipEncoding = false): string {
    if (this._raw !== undefined) return this._raw;
    const enc = skipEncoding ? (s: string) => s : (s: string) => encodeURI(s).replace(/[?#]/g, encodeURIComponent);
    let out = '';
    if (this.scheme) out += `${this.scheme}:`;
    if (this.authority || this.scheme === 'file') out += `//${enc(this.authority)}`;
    out += enc(this.path);
    if (this.query) out += `?${this.query}`;
    if (this.fragment) out += `#${this.fragment}`;
    return out;
  }

  toJSON(): unknown {
    return { $mid: 1, scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath, external: this.toString() };
  }
}

// ── Positions and ranges ────────────────────────────────────────────────────

export class Position {
  constructor(readonly line: number, readonly character: number) {}
  isBefore(o: Position): boolean {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
  isAfter(o: Position): boolean {
    return !this.isEqual(o) && !this.isBefore(o);
  }
  isEqual(o: Position): boolean {
    return this.line === o.line && this.character === o.character;
  }
  isBeforeOrEqual(o: Position): boolean {
    return this.isBefore(o) || this.isEqual(o);
  }
  compareTo(o: Position): number {
    return this.isBefore(o) ? -1 : this.isEqual(o) ? 0 : 1;
  }
  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
  with(line = this.line, character = this.character): Position {
    return new Position(line, character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    const s = typeof a === 'number' ? new Position(a, b as number) : a;
    const e = typeof a === 'number' ? new Position(c as number, d as number) : (b as Position);
    [this.start, this.end] = s.isBeforeOrEqual(e) ? [s, e] : [e, s];
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }
  contains(p: Position | Range): boolean {
    if (p instanceof Range) return this.contains(p.start) && this.contains(p.end);
    return this.start.isBeforeOrEqual(p) && p.isBeforeOrEqual(this.end);
  }
  with(start = this.start, end = this.end): Range {
    return new Range(start, end);
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;
  constructor(anchor: Position | number, active: Position | number, c?: number, d?: number) {
    const a = typeof anchor === 'number' ? new Position(anchor, active as number) : anchor;
    const b = typeof anchor === 'number' ? new Position(c as number, d as number) : (active as Position);
    super(a, b);
    this.anchor = a;
    this.active = b;
  }
  get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
  }
}

export class Location {
  readonly range: Range;
  constructor(readonly uri: Uri, rangeOrPosition: Range | Position) {
    this.range = rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition;
  }
}

export class TextEdit {
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range: Range): TextEdit {
    return new TextEdit(range, '');
  }
  constructor(readonly range: Range, readonly newText: string) {}
}

export type FileOperation =
  | { kind: 'create'; uri: Uri; options?: { overwrite?: boolean; ignoreIfExists?: boolean } }
  | { kind: 'delete'; uri: Uri; options?: { recursive?: boolean; ignoreIfNotExists?: boolean } }
  | { kind: 'rename'; from: Uri; to: Uri; options?: { overwrite?: boolean } }
  | { kind: 'text'; uri: Uri; edit: TextEdit };

/** Recorded operations; `workspace.applyEdit` performs them against the disk in order. */
export class WorkspaceEdit {
  readonly _ops: FileOperation[] = [];
  get size(): number {
    return new Set(this._ops.map((o) => ('uri' in o ? o.uri.toString() : o.from.toString()))).size;
  }
  replace(uri: Uri, range: Range, newText: string): void {
    this._ops.push({ kind: 'text', uri, edit: TextEdit.replace(range, newText) });
  }
  insert(uri: Uri, position: Position, newText: string): void {
    this._ops.push({ kind: 'text', uri, edit: TextEdit.insert(position, newText) });
  }
  delete(uri: Uri, range: Range): void {
    this._ops.push({ kind: 'text', uri, edit: TextEdit.delete(range) });
  }
  set(uri: Uri, edits: TextEdit[]): void {
    for (const edit of edits) this._ops.push({ kind: 'text', uri, edit });
  }
  createFile(uri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
    this._ops.push({ kind: 'create', uri, options });
  }
  deleteFile(uri: Uri, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void {
    this._ops.push({ kind: 'delete', uri, options });
  }
  renameFile(from: Uri, to: Uri, options?: { overwrite?: boolean }): void {
    this._ops.push({ kind: 'rename', from, to, options });
  }
}

export class RelativePattern {
  readonly baseUri: Uri;
  readonly base: string;
  constructor(base: Uri | string | { uri: Uri }, readonly pattern: string) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base instanceof Uri ? base : base.uri;
    this.base = this.baseUri.fsPath;
  }
}

export class CodeLens {
  constructor(public range: Range, public command?: { title: string; command: string; arguments?: any[] }) {}
  get isResolved(): boolean {
    return !!this.command;
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');
  constructor(readonly id: string, readonly color?: ThemeColor) {}
}

export class MarkdownString {
  constructor(public value = '', public supportThemeIcons = false) {}
  appendText(v: string): this {
    this.value += v;
    return this;
  }
  appendMarkdown(v: string): this {
    this.value += v;
    return this;
  }
}

export class Diagnostic {
  source?: string;
  code?: string | number;
  constructor(public range: Range, public message: string, public severity: DiagnosticSeverity = DiagnosticSeverity.Error) {}
}

// ── Enums (numeric values match vscode.d.ts) ────────────────────────────────

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

export enum SymbolKind {
  File = 0, Module, Namespace, Package, Class, Method, Property, Field, Constructor, Enum, Interface,
  Function, Variable, Constant, String, Number, Boolean, Array, Object, Key, Null, EnumMember,
  Struct, Event, Operator, TypeParameter,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

/** Only constructed inside the `vscode.lm?.` branch, which the desktop never enters (lm is undefined). */
export const McpStdioServerDefinition = notSupportedClass(
  'vscode.McpStdioServerDefinition',
  'MCP server registration with the editor is a VS Code feature'
);
