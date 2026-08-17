import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';

// ── Tool argument/result shapes (mirrored in modelWorker.ts's TOOL_DEFS) ──

export interface SearchCodebaseArgs {
  query: string;
  glob?: string;
  caseSensitive?: boolean;
  /** 'content' (default) returns matching lines; 'files_with_matches' returns only file paths — cheap way to survey before reading. */
  outputMode?: 'content' | 'files_with_matches';
}
export interface SearchCodebaseMatch {
  file: string;
  line: number;
  text: string;
  /** A few lines of surrounding context, each prefixed with its line number. */
  context?: string;
}
export interface SearchCodebaseResult {
  matches: SearchCodebaseMatch[];
  truncated: boolean;
  totalMatches: number;
  /** Present when the exact phrase had zero hits and results below are a broader, per-keyword fallback. */
  note?: string;
  /** Populated instead of matches when outputMode is 'files_with_matches'. */
  files?: string[];
}

export interface FindSymbolArgs {
  /** Symbol name (or prefix) to look up, e.g. "LeadsView" or "sendMessage". */
  query: string;
}
export interface SymbolHit {
  name: string;
  kind: string;
  file: string;
  line: number;
  container?: string;
}
export interface FindSymbolResult {
  symbols: SymbolHit[];
  truncated: boolean;
}

export interface SymbolLocationArgs {
  /** Workspace-relative file path where the symbol appears. */
  path: string;
  /** 1-based line number where the symbol appears. */
  line: number;
  /** The symbol text on that line to resolve (first occurrence used). */
  symbol: string;
}
export interface LocationHit {
  file: string;
  line: number;
  preview: string;
}
export interface LocationsResult {
  locations: LocationHit[];
  truncated: boolean;
}

export interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}
export interface ReadFileResult {
  content: string;
  totalLines: number;
  truncated: boolean;
}

export interface ListDirectoryArgs {
  path?: string;
}
export interface ListDirectoryResult {
  entries: { name: string; type: 'file' | 'directory' }[];
}

export interface FindFilesArgs {
  /** Glob pattern matched against file names/paths, e.g. "**\/*Lead*" or "**\/*.filter.ts". */
  pattern: string;
}
export interface FindFilesResult {
  files: string[];
  truncated: boolean;
}

// ── Caps (keep tool output bounded — it all feeds back into the prompt) ──

const MAX_CANDIDATE_FILES = 500;
const MAX_MATCHES = 50;
const MAX_FILE_SIZE_BYTES = 512 * 1024;
const MAX_READ_LINES = 400;
const MAX_READ_BYTES = 20 * 1024;
const CONTEXT_LINES = 2;
const MAX_CONTEXT_CHARS = 500;
const RIPGREP_TIMEOUT_MS = 10_000;

class WorkspaceRootRequiredError extends Error {
  constructor() {
    super('No workspace folder is open — codebase tools are unavailable.');
  }
}

/** A named workspace root, so multi-root results can be disambiguated. */
export interface NamedRoot {
  name: string;
  uri: vscode.Uri;
}

export function getNamedRoots(workspaceRoots: readonly vscode.WorkspaceFolder[]): NamedRoot[] {
  return workspaceRoots.map((f) => ({ name: f.name, uri: f.uri }));
}

/** Resolves a possibly `"<rootName>/<relPath>"`-prefixed path against the given roots. */
function resolveAgainstRoots(
  roots: NamedRoot[],
  relOrDisambiguated: string
): { root: NamedRoot; relPath: string } | null {
  const normalized = relOrDisambiguated.replace(/^\.?\//, '');

  if (roots.length > 1) {
    for (const root of roots) {
      const prefix = `${root.name}/`;
      if (normalized.startsWith(prefix)) {
        return { root, relPath: normalized.slice(prefix.length) };
      }
    }
  }

  // No root prefix (or single-root workspace) — try each root, first that exists wins.
  return { root: roots[0], relPath: normalized };
}

function isLikelyBinary(buffer: Uint8Array): boolean {
  const sampleLength = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

const SEARCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'is', 'are', 'was', 'were', 'be', 'all', 'there', 'what',
  'how', 'does', 'do', 'section', 'check', 'can', 'you', 'please',
]);

/** Splits a natural-language query into significant search tokens for the fallback pass. */
function tokenize(query: string): string[] {
  return [...new Set(
    query
      .split(/[^a-zA-Z0-9_]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !SEARCH_STOPWORDS.has(t.toLowerCase()))
  )];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Treats the query as a regex if it looks like one, otherwise as a literal substring. */
function escapeForLiteralOrRegex(query: string): string {
  const looksLikeRegex = /[.*+?^${}()|[\]\\]/.test(query);
  return looksLikeRegex ? query : escapeRegExp(query);
}

function buildContext(lines: string[], centerIdx: number): string {
  const start = Math.max(0, centerIdx - CONTEXT_LINES);
  const end = Math.min(lines.length - 1, centerIdx + CONTEXT_LINES);
  const joined = lines
    .slice(start, end + 1)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join('\n');
  return joined.length > MAX_CONTEXT_CHARS ? joined.slice(0, MAX_CONTEXT_CHARS) : joined;
}

// ── Ripgrep integration ────────────────────────────────────────────────
//
// Real ripgrep gives us a proper regex engine, native .gitignore-awareness,
// and speed on large repos that our own file-by-file scanner can't match.
// It's resolved lazily via @vscode/ripgrep (the same package VS Code itself
// ships), which only bundles the binary for the platform(s) actually
// installed — so on a platform/package-manager combination where that binary
// isn't present (e.g. a packaged VSIX built without that platform's optional
// dependency installed), resolution fails once and every call transparently
// falls back to the pure-JS scanner below instead of erroring.

let ripgrepPathPromise: Promise<string | null> | null = null;

function resolveRipgrepPath(): Promise<string | null> {
  if (!ripgrepPathPromise) {
    ripgrepPathPromise = import('@vscode/ripgrep')
      .then((mod) => mod.rgPath)
      .catch(() => null);
  }
  return ripgrepPathPromise;
}

interface RgEntry {
  file: string;
  line: number;
  text: string;
  isMatch: boolean;
}

function runRipgrepRaw(
  rgPath: string,
  pattern: string,
  opts: { caseSensitive?: boolean; glob?: string },
  roots: NamedRoot[]
): Promise<string | null> {
  const args = ['--json', '--context', String(CONTEXT_LINES), '--max-count', '200', '--max-filesize', String(MAX_FILE_SIZE_BYTES)];
  if (!opts.caseSensitive) args.push('--ignore-case');
  if (opts.glob) args.push('-g', opts.glob);
  args.push('--', pattern, ...roots.map((r) => r.uri.fsPath));

  return new Promise((resolve) => {
    execFile(
      rgPath,
      args,
      { maxBuffer: 20 * 1024 * 1024, timeout: RIPGREP_TIMEOUT_MS },
      (error, stdout) => {
        // Exit code 1 with no stderr means "ran fine, zero matches" — not a failure.
        if (error && (error as any).code !== 1) {
          resolve(null);
          return;
        }
        resolve(stdout ?? '');
      }
    );
  });
}

function parseRipgrepJson(stdout: string, roots: NamedRoot[]): RgEntry[] {
  const entries: RgEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'match' && obj.type !== 'context') continue;
    const absPath: string | undefined = obj.data?.path?.text;
    const lineText: string | undefined = obj.data?.lines?.text;
    if (!absPath || lineText === undefined) continue;
    entries.push({
      file: displayPathFor(vscode.Uri.file(absPath), roots),
      line: obj.data.line_number,
      text: lineText.replace(/\n$/, ''),
      isMatch: obj.type === 'match',
    });
  }
  return entries;
}

/** Builds SearchCodebaseMatch entries (with context) from ripgrep's interleaved match/context stream. */
function toMatchesWithContext(entries: RgEntry[]): SearchCodebaseMatch[] {
  const byFile = new Map<string, RgEntry[]>();
  for (const e of entries) {
    const arr = byFile.get(e.file) ?? [];
    arr.push(e);
    byFile.set(e.file, arr);
  }

  const matches: SearchCodebaseMatch[] = [];
  for (const e of entries) {
    if (!e.isMatch) continue;
    const fileEntries = byFile.get(e.file) ?? [];
    const nearby = fileEntries
      .filter((o) => Math.abs(o.line - e.line) <= CONTEXT_LINES)
      .sort((a, b) => a.line - b.line);
    const context = nearby.map((o) => `${o.line}: ${o.text}`).join('\n').slice(0, MAX_CONTEXT_CHARS);
    matches.push({ file: e.file, line: e.line, text: e.text.trim().slice(0, 500), context });
  }
  return matches;
}

/** `rg -l` — file paths only, no per-line output. Much cheaper for surveying. */
function runRipgrepFilesOnly(
  rgPath: string,
  pattern: string,
  opts: { caseSensitive?: boolean; glob?: string },
  roots: NamedRoot[]
): Promise<string[] | null> {
  const args = ['-l', '--max-filesize', String(MAX_FILE_SIZE_BYTES)];
  if (!opts.caseSensitive) args.push('--ignore-case');
  if (opts.glob) args.push('-g', opts.glob);
  args.push('--', pattern, ...roots.map((r) => r.uri.fsPath));

  return new Promise((resolve) => {
    execFile(
      rgPath,
      args,
      { maxBuffer: 20 * 1024 * 1024, timeout: RIPGREP_TIMEOUT_MS },
      (error, stdout) => {
        if (error && (error as any).code !== 1) {
          resolve(null);
          return;
        }
        const files = (stdout ?? '')
          .split('\n')
          .filter(Boolean)
          .map((p) => displayPathFor(vscode.Uri.file(p), roots));
        resolve(files);
      }
    );
  });
}

async function searchCodebaseViaRipgrep(
  args: SearchCodebaseArgs,
  roots: NamedRoot[]
): Promise<SearchCodebaseResult | null> {
  const rgPath = await resolveRipgrepPath();
  if (!rgPath) return null;

  if (args.outputMode === 'files_with_matches') {
    const files = await runRipgrepFilesOnly(rgPath, escapeForLiteralOrRegex(args.query), args, roots);
    if (files === null) return null;
    if (files.length > 0) {
      return {
        matches: [],
        files: files.slice(0, 100),
        truncated: files.length > 100,
        totalMatches: files.length,
      };
    }
    // Zero exact-phrase files — try the keyword-union fallback, same as content mode.
    const tokens = tokenize(args.query);
    if (tokens.length > 1) {
      const tokenFiles = await runRipgrepFilesOnly(rgPath, tokens.map(escapeRegExp).join('|'), args, roots);
      if (tokenFiles && tokenFiles.length > 0) {
        return {
          matches: [],
          files: tokenFiles.slice(0, 100),
          truncated: tokenFiles.length > 100,
          totalMatches: tokenFiles.length,
          note: `No exact match for "${args.query}" — files matching any of: ${tokens.join(', ')}.`,
        };
      }
    }
    return { matches: [], files: [], truncated: false, totalMatches: 0 };
  }

  const phraseStdout = await runRipgrepRaw(rgPath, escapeForLiteralOrRegex(args.query), args, roots);
  if (phraseStdout === null) return null; // ripgrep failed unexpectedly — fall back to JS scanner

  const phraseMatches = toMatchesWithContext(parseRipgrepJson(phraseStdout, roots));
  if (phraseMatches.length > 0) {
    const truncated = phraseMatches.length > MAX_MATCHES;
    return {
      matches: phraseMatches.slice(0, MAX_MATCHES),
      truncated,
      totalMatches: phraseMatches.length,
    };
  }

  const tokens = tokenize(args.query);
  if (tokens.length <= 1) {
    return { matches: [], truncated: false, totalMatches: 0 };
  }

  const tokenPattern = tokens.map(escapeRegExp).join('|');
  const tokenStdout = await runRipgrepRaw(rgPath, tokenPattern, args, roots);
  if (tokenStdout === null) return { matches: [], truncated: false, totalMatches: 0 };

  const tokenMatches = toMatchesWithContext(parseRipgrepJson(tokenStdout, roots));
  if (tokenMatches.length === 0) {
    return { matches: [], truncated: false, totalMatches: 0 };
  }

  return {
    matches: tokenMatches.slice(0, MAX_MATCHES),
    truncated: tokenMatches.length > MAX_MATCHES,
    totalMatches: tokenMatches.length,
    note: `No exact match for "${args.query}" — showing lines matching any of: ${tokens.join(', ')}.`,
  };
}

/** Pure-JS fallback scanner, used only when ripgrep can't be resolved on this platform/install. */
async function searchCodebaseViaJsScan(
  args: SearchCodebaseArgs,
  roots: NamedRoot[]
): Promise<SearchCodebaseResult> {
  const flags = args.caseSensitive ? 'g' : 'gi';
  let phrasePattern: RegExp;
  try {
    phrasePattern = new RegExp(escapeForLiteralOrRegex(args.query), flags);
  } catch {
    phrasePattern = new RegExp(escapeRegExp(args.query), flags);
  }

  const tokens = tokenize(args.query);
  const tokenPattern =
    tokens.length > 1 ? new RegExp(tokens.map(escapeRegExp).join('|'), flags) : null;

  const phraseMatches: SearchCodebaseMatch[] = [];
  const tokenMatches: SearchCodebaseMatch[] = [];
  let phraseTotalMatches = 0;
  let phraseTruncated = false;
  let tokenTruncated = false;

  const files = await vscode.workspace.findFiles(
    args.glob ?? '**/*',
    undefined,
    MAX_CANDIDATE_FILES
  );

  for (const uri of files) {
    if (phraseMatches.length >= MAX_MATCHES && tokenMatches.length >= MAX_MATCHES) {
      break;
    }
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      continue;
    }
    if (stat.type !== vscode.FileType.File || stat.size > MAX_FILE_SIZE_BYTES) {
      continue;
    }

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      continue;
    }
    if (isLikelyBinary(bytes)) continue;

    const text = Buffer.from(bytes).toString('utf8');
    const lines = text.split('\n');
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
            context: buildContext(lines, i),
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
              context: buildContext(lines, i),
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
      matches: tokenMatches,
      truncated: tokenTruncated,
      totalMatches: tokenMatches.length,
      note: `No exact match for "${args.query}" — showing lines matching any of: ${tokens.join(', ')}.`,
    };
  }

  return { matches: [], truncated: false, totalMatches: 0 };
}

export async function searchCodebase(
  args: SearchCodebaseArgs,
  roots: NamedRoot[]
): Promise<SearchCodebaseResult> {
  if (!roots.length) throw new WorkspaceRootRequiredError();

  const viaRipgrep = await searchCodebaseViaRipgrep(args, roots);
  if (viaRipgrep) return viaRipgrep;

  const jsResult = await searchCodebaseViaJsScan(args, roots);
  if (args.outputMode === 'files_with_matches') {
    const files = [...new Set(jsResult.matches.map((m) => m.file))];
    return { matches: [], files, truncated: jsResult.truncated, totalMatches: files.length, note: jsResult.note };
  }
  return jsResult;
}

export async function readFile(args: ReadFileArgs, roots: NamedRoot[]): Promise<ReadFileResult> {
  if (!roots.length) throw new WorkspaceRootRequiredError();

  const resolved = resolveAgainstRoots(roots, args.path);
  if (!resolved) {
    throw new Error(`Could not resolve path "${args.path}" against any workspace root.`);
  }

  const rootFsPath = resolved.root.uri.fsPath;
  const absPath = path.resolve(rootFsPath, resolved.relPath);
  if (absPath !== rootFsPath && !absPath.startsWith(rootFsPath + path.sep)) {
    throw new Error('Path resolves outside the workspace root — refusing to read.');
  }

  const uri = vscode.Uri.file(absPath);
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type !== vscode.FileType.File) {
    throw new Error(`"${args.path}" is not a file.`);
  }
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`"${args.path}" is too large to read (${stat.size} bytes, cap ${MAX_FILE_SIZE_BYTES}).`);
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  if (isLikelyBinary(bytes)) {
    throw new Error(`"${args.path}" appears to be a binary file — cannot read as text.`);
  }

  const allLines = Buffer.from(bytes).toString('utf8').split('\n');
  const start = Math.max(1, args.startLine ?? 1) - 1;
  const requestedEnd = args.endLine ?? allLines.length;
  const cappedEnd = Math.min(requestedEnd, start + MAX_READ_LINES, allLines.length);

  let content = allLines.slice(start, cappedEnd).join('\n');
  let truncated = cappedEnd < requestedEnd || cappedEnd < allLines.length;
  if (content.length > MAX_READ_BYTES) {
    content = content.slice(0, MAX_READ_BYTES);
    truncated = true;
  }

  return { content, totalLines: allLines.length, truncated };
}

export async function listDirectory(
  args: ListDirectoryArgs,
  roots: NamedRoot[]
): Promise<ListDirectoryResult> {
  if (!roots.length) throw new WorkspaceRootRequiredError();

  const resolved = resolveAgainstRoots(roots, args.path ?? '');
  if (!resolved) {
    throw new Error(`Could not resolve path "${args.path}" against any workspace root.`);
  }

  const rootFsPath = resolved.root.uri.fsPath;
  const absPath = resolved.relPath ? path.resolve(rootFsPath, resolved.relPath) : rootFsPath;
  if (absPath !== rootFsPath && !absPath.startsWith(rootFsPath + path.sep)) {
    throw new Error('Path resolves outside the workspace root — refusing to list.');
  }

  const uri = vscode.Uri.file(absPath);
  const entries = await vscode.workspace.fs.readDirectory(uri);
  return {
    entries: entries.map(([name, type]) => ({
      name,
      type: type === vscode.FileType.Directory ? 'directory' : 'file',
    })),
  };
}

/**
 * Finds files by NAME/path pattern rather than content — catches the case a
 * content search misses entirely, e.g. a doc describing the "leads/funnel"
 * feature in prose while the implementation lives in a component named
 * `LeadsView.tsx` that never uses those exact words.
 */
export async function findFiles(args: FindFilesArgs, roots: NamedRoot[]): Promise<FindFilesResult> {
  if (!roots.length) throw new WorkspaceRootRequiredError();

  const uris = await vscode.workspace.findFiles(args.pattern, undefined, MAX_CANDIDATE_FILES);

  // Sort by modification time, newest first — recently-touched files are the
  // likeliest to be relevant to what the user is asking about right now.
  const withMtime = await Promise.all(
    uris.map(async (u) => {
      try {
        const stat = await vscode.workspace.fs.stat(u);
        return { u, mtime: stat.mtime };
      } catch {
        return { u, mtime: 0 };
      }
    })
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);

  return {
    files: withMtime.map(({ u }) => displayPathFor(u, roots)),
    truncated: uris.length >= MAX_CANDIDATE_FILES,
  };
}

// ── LSP-backed symbol tools ────────────────────────────────────────────
//
// These use the language servers VS Code is already running — exact symbol
// answers with zero text-matching guesswork, something a terminal-based
// agent can't do. Results depend on the relevant language extension being
// active; when a provider returns nothing we say so explicitly (rather than
// erroring) so the model falls back to text search.

const MAX_SYMBOL_RESULTS = 30;

const SYMBOL_KIND_NAMES: string[] = [
  'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property',
  'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable',
  'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key',
  'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter',
];

function symbolKindName(kind: vscode.SymbolKind): string {
  return SYMBOL_KIND_NAMES[kind] ?? 'Symbol';
}

export async function findSymbol(args: FindSymbolArgs, roots: NamedRoot[]): Promise<FindSymbolResult> {
  if (!roots.length) throw new WorkspaceRootRequiredError();

  const symbols = (await vscode.commands.executeCommand(
    'vscode.executeWorkspaceSymbolProvider',
    args.query
  )) as vscode.SymbolInformation[] | undefined;

  if (!symbols || symbols.length === 0) {
    return { symbols: [], truncated: false };
  }

  // Keep only symbols inside the workspace (providers can return library hits).
  const inWorkspace = symbols.filter((s) =>
    roots.some((r) => s.location.uri.fsPath.startsWith(r.uri.fsPath + path.sep))
  );

  return {
    symbols: inWorkspace.slice(0, MAX_SYMBOL_RESULTS).map((s) => ({
      name: s.name,
      kind: symbolKindName(s.kind),
      file: displayPathFor(s.location.uri, roots),
      line: s.location.range.start.line + 1,
      container: s.containerName || undefined,
    })),
    truncated: inWorkspace.length > MAX_SYMBOL_RESULTS,
  };
}

/** Resolves a (path, line, symbol) triple to a concrete document position for the LSP providers. */
async function resolveSymbolPosition(
  args: SymbolLocationArgs,
  roots: NamedRoot[]
): Promise<{ doc: vscode.TextDocument; position: vscode.Position }> {
  const resolved = resolveAgainstRoots(roots, args.path);
  if (!resolved) {
    throw new Error(`Could not resolve path "${args.path}" against any workspace root.`);
  }
  const rootFsPath = resolved.root.uri.fsPath;
  const absPath = path.resolve(rootFsPath, resolved.relPath);
  if (absPath !== rootFsPath && !absPath.startsWith(rootFsPath + path.sep)) {
    throw new Error('Path resolves outside the workspace root — refusing to open.');
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));

  const lineIdx = Math.min(Math.max(1, args.line), doc.lineCount) - 1;
  const lineText = doc.lineAt(lineIdx).text;
  const col = lineText.indexOf(args.symbol);
  if (col === -1) {
    throw new Error(`Symbol "${args.symbol}" not found on line ${args.line} of ${args.path}. The line reads: ${lineText.trim().slice(0, 200)}`);
  }
  return { doc, position: new vscode.Position(lineIdx, col) };
}

async function locationsFromProvider(
  command: 'vscode.executeDefinitionProvider' | 'vscode.executeReferenceProvider',
  args: SymbolLocationArgs,
  roots: NamedRoot[]
): Promise<LocationsResult> {
  if (!roots.length) throw new WorkspaceRootRequiredError();

  const { doc, position } = await resolveSymbolPosition(args, roots);
  const raw = (await vscode.commands.executeCommand(command, doc.uri, position)) as
    | (vscode.Location | vscode.LocationLink)[]
    | undefined;

  if (!raw || raw.length === 0) {
    return { locations: [], truncated: false };
  }

  const normalized = raw.map((l) =>
    'targetUri' in l
      ? { uri: l.targetUri, range: l.targetRange }
      : { uri: l.uri, range: l.range }
  );

  const capped = normalized.slice(0, MAX_SYMBOL_RESULTS);
  const locations: LocationHit[] = [];
  for (const loc of capped) {
    let preview = '';
    try {
      const targetDoc = await vscode.workspace.openTextDocument(loc.uri);
      preview = targetDoc.lineAt(loc.range.start.line).text.trim().slice(0, 200);
    } catch {
      // Preview is best-effort — the location itself is still useful.
    }
    locations.push({
      file: displayPathFor(loc.uri, roots),
      line: loc.range.start.line + 1,
      preview,
    });
  }

  return { locations, truncated: normalized.length > MAX_SYMBOL_RESULTS };
}

export function goToDefinition(args: SymbolLocationArgs, roots: NamedRoot[]): Promise<LocationsResult> {
  return locationsFromProvider('vscode.executeDefinitionProvider', args, roots);
}

export function findReferences(args: SymbolLocationArgs, roots: NamedRoot[]): Promise<LocationsResult> {
  return locationsFromProvider('vscode.executeReferenceProvider', args, roots);
}

// ── Repo orientation (injected into the first prompt of a codebase turn) ──
//
// Claude Code starts sessions with CLAUDE.md and an early directory listing;
// giving the model the same orientation up front saves it 2–4 discovery
// round trips per question.

const ORIENTATION_EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',
  'venv', '.venv', '__pycache__', '.turbo', '.idea', '.vscode-test',
]);
const ORIENTATION_MAX_LINES = 150;
const ORIENTATION_README_CHARS = 1500;

async function listTreeLevel(
  uri: vscode.Uri,
  indent: string,
  depthLeft: number,
  lines: string[]
): Promise<void> {
  if (lines.length >= ORIENTATION_MAX_LINES) return;

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return;
  }

  entries.sort(([aName, aType], [bName, bType]) => {
    if (aType !== bType) return bType - aType; // directories first
    return aName.localeCompare(bName);
  });

  for (const [name, type] of entries) {
    if (lines.length >= ORIENTATION_MAX_LINES) {
      lines.push(`${indent}…`);
      return;
    }
    if (name.startsWith('.') || ORIENTATION_EXCLUDED_DIRS.has(name)) continue;

    if (type === vscode.FileType.Directory) {
      lines.push(`${indent}${name}/`);
      if (depthLeft > 1) {
        await listTreeLevel(vscode.Uri.joinPath(uri, name), indent + '  ', depthLeft - 1, lines);
      }
    } else {
      lines.push(`${indent}${name}`);
    }
  }
}

export async function buildRepoOrientation(roots: NamedRoot[]): Promise<string> {
  if (!roots.length) return '';

  const sections: string[] = [];

  for (const root of roots) {
    const lines: string[] = [];
    await listTreeLevel(root.uri, '  ', 2, lines);
    const header = roots.length > 1 ? `Workspace root "${root.name}":` : 'Workspace structure (top 2 levels):';
    sections.push(`${header}\n${lines.join('\n')}`);

    for (const readmeName of ['README.md', 'readme.md', 'Readme.md']) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root.uri, readmeName));
        const head = Buffer.from(bytes).toString('utf8').slice(0, ORIENTATION_README_CHARS);
        sections.push(`${readmeName} (first ${ORIENTATION_README_CHARS} chars):\n${head}`);
        break;
      } catch {
        // No README at this root — fine.
      }
    }
  }

  return sections.join('\n\n');
}

function displayPathFor(uri: vscode.Uri, roots: NamedRoot[]): string {
  for (const root of roots) {
    const rel = path.relative(root.uri.fsPath, uri.fsPath);
    if (!rel.startsWith('..')) {
      return roots.length > 1 ? `${root.name}/${rel}` : rel;
    }
  }
  return uri.fsPath;
}
