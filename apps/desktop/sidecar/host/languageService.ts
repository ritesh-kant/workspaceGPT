/**
 * The desktop's language intelligence: a `typescript-language-server` child
 * speaking LSP over stdio, behind `runtime.languageService` (Phase 2).
 *
 * It answers what VS Code's TypeScript extension answers for the agent tools:
 * workspace symbols (find_symbol), definition / references (go_to_definition,
 * find_references) and live diagnostics (get_diagnostics).
 *
 * Which files it knows about follows VS Code: a file the extension opens with
 * `workspace.openTextDocument` or writes through `applyEdit` is opened in the
 * server, exactly as those calls make VS Code hand the document to tsserver.
 * Edited files stay open for the session; files only read are kept in a small
 * LRU so reading a hundred files doesn't make tsserver re-check a hundred.
 *
 * Diagnostics are the one synchronous API (`languages.getDiagnostics`), and
 * they arrive asynchronously. Returning "no problems" for a file the server
 * hasn't checked yet would be a lie the agent acts on, so a read that lands
 * while a file is still being checked throws DiagnosticsPending, which the
 * get_diagnostics tool reports to the model as "try again".
 *
 * Only JS/TS is served. Other languages get no provider, as in a VS Code with
 * no extension for them: symbol/location lookups return nothing and the tool
 * tells the model to fall back to text search.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type {
  DesktopLanguageService,
  LspDiagnostic,
  LspLocation,
  LspPosition,
  LspSymbol,
} from '../vscode-compat/runtime';

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
};

/** Files only read (not edited, not project seeds) stay open in the server up to this many, least recently used first out. */
const MAX_READ_ONLY_OPEN = 20;
/** A first project load in a large monorepo can take this long; after it, a pending check is reported as stuck. */
const PENDING_GIVE_UP_MS = 45_000;
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * tsserver holds every loaded project in memory (measured on this repo, only
 * the sidecar's children: ~500 MB after a definition lookup, ~680 MB once
 * find_symbol has loaded the extension + webview projects), so it is stopped
 * after this long with no calls. The next call starts it again (~1.5–2.5 s)
 * and re-reports files as pending.
 */
const IDLE_SHUTDOWN_MS = Number(process.env.WGPT_DESKTOP_LSP_IDLE_MS) || 5 * 60_000;
/** tsserver needs a project loaded before workspace/symbol answers; one file per tsconfig/jsconfig loads it. */
const MAX_SEED_PROJECTS = 8;
/** With no tsconfig/jsconfig anywhere, tsserver only has inferred projects of open files: open this many sources. */
const MAX_SEED_LOOSE_FILES = 20;
const SEED_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', 'target']);

/** tsserver ScriptElementKind → LSP SymbolKind, as typescript-language-server maps them. */
const LSP_SYMBOL_VARIABLE = 13;
const TS_SYMBOL_KIND: Record<string, number> = {
  file: 1, module: 2, class: 5, 'local class': 5, method: 6, getter: 6, setter: 6, property: 7, 'JSX attribute': 7,
  field: 8, constructor: 9, enum: 10, interface: 11, function: 12, 'local function': 12,
  var: 13, let: 13, 'local var': 13, parameter: 13, alias: 13, 'type parameter': 13, const: 14, 'enum member': 14,
};

export class DiagnosticsPending extends Error {
  constructor(files: string[], stuck: boolean) {
    super(
      stuck
        ? `The TypeScript server has not reported diagnostics for ${files.join(', ')} after ${PENDING_GIVE_UP_MS / 1000}s. ` +
            'It may still be loading a large project; call get_diagnostics again, or run the type check with run_checks.'
        : `Diagnostics are still being computed for ${files.join(', ')} (the TypeScript server is checking them). ` +
            'Call get_diagnostics again in a moment.'
    );
    this.name = 'DiagnosticsPending';
  }
}

interface OpenDoc {
  uri: string;
  version: number;
  text: string;
  mtimeMs: number;
  /** Edited this session, or a project seed: never evicted (tsserver unloads a project once none of its files are open). */
  keepOpen: boolean;
  lastUsed: number;
  /** When the server was last told about a change it hasn't reported diagnostics for; 0 when settled. */
  pendingSince: number;
}

function isServed(fsPath: string): boolean {
  return path.extname(fsPath).toLowerCase() in LANGUAGE_BY_EXT;
}

function toUri(fsPath: string): string {
  return pathToFileURL(fsPath).href;
}

function fromUri(uri: string): string | undefined {
  return uri.startsWith('file:') ? fileURLToPath(uri) : undefined;
}

/** Minimal LSP JSON-RPC over a child's stdio (Content-Length framing). */
class LspConnection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  onNotification: (method: string, params: any) => void = () => undefined;
  onClose: (why: string) => void = () => undefined;

  constructor(private readonly child: cp.ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.warn(`[desktop:lsp] ${text.slice(0, 500)}`);
    });
    child.on('exit', (code, signal) => this.close(`typescript-language-server exited (${signal ?? code})`));
    child.on('error', (err) => this.close(`typescript-language-server failed to start: ${err.message}`));
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the TypeScript server did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: unknown): void {
    if (!this.child.stdin.writable) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const length = Number(/Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
      if (!Number.isFinite(length)) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (msg.id !== undefined && msg.method) {
      // A request from the server. Answer the ones typescript-language-server
      // sends with what a client that has no settings UI would say.
      let result: unknown = null;
      if (msg.method === 'workspace/configuration') result = (msg.params?.items ?? []).map(() => ({}));
      this.send({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`TypeScript server: ${msg.error.message ?? 'request failed'}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) this.onNotification(msg.method, msg.params);
  }

  private closed = false;
  private close(why: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    this.pending.clear();
    this.onClose(why);
  }

  kill(): void {
    this.child.kill();
  }
}

export interface LanguageServiceOptions {
  /** Node binary that runs the server (the sidecar's own). */
  nodePath: string;
  workspaceFolders: () => string[];
}

export function createLanguageService(opts: LanguageServiceOptions): DesktopLanguageService & { dispose(): void; restart(): void } {
  let conn: LspConnection | undefined;
  let ready: Promise<LspConnection> | undefined;
  /** Why the server can't run, once starting it has failed; reported instead of retrying on every call. */
  let failure: string | undefined;
  let seeded = false;
  const docs = new Map<string, OpenDoc>(); // fsPath → doc
  const published = new Map<string, LspDiagnostic[]>(); // fsPath → last published diagnostics
  let lastUse = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  function used(): void {
    lastUse = Date.now();
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (Date.now() - lastUse < IDLE_SHUTDOWN_MS) return;
      console.log(`[desktop:lsp] idle for ${Math.round(IDLE_SHUTDOWN_MS / 1000)} s; stopping the TypeScript server`);
      stop();
    }, Math.min(60_000, IDLE_SHUTDOWN_MS));
    idleTimer.unref();
  }

  function resolveServer(): { cli: string; fallbackTsserver?: string } {
    const cli = require.resolve('typescript-language-server/lib/cli.mjs');
    let fallbackTsserver: string | undefined;
    try {
      fallbackTsserver = require.resolve('typescript/lib/tsserver.js');
    } catch {
      // The server then needs a workspace copy of typescript.
    }
    return { cli, fallbackTsserver };
  }

  function start(): Promise<LspConnection> {
    used();
    if (ready) return ready;
    // Read after the first await inside, by which time it is assigned.
    let attempt!: Promise<LspConnection>;
    attempt = (async () => {
      const roots = opts.workspaceFolders();
      const { cli, fallbackTsserver } = resolveServer();
      const child = cp.spawn(opts.nodePath, [cli, '--stdio'], {
        cwd: roots[0] ?? process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      const c = new LspConnection(child);
      c.onNotification = onNotification;
      c.onClose = (why) => {
        if (conn === c) {
          conn = undefined;
          ready = undefined;
          seeded = false;
          published.clear();
          for (const d of docs.values()) d.pendingSince = 0;
          docs.clear();
          console.warn(`[desktop:lsp] ${why}`);
        }
      };
      await c.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'WorkspaceGPT Desktop' },
        rootUri: roots[0] ? toUri(roots[0]) : null,
        workspaceFolders: roots.map((r) => ({ uri: toUri(r), name: path.basename(r) })),
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true, symbol: {} },
          textDocument: {
            synchronization: { didSave: false, dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false },
            definition: { linkSupport: false },
            references: {},
          },
        },
        initializationOptions: {
          hostInfo: 'workspacegpt-desktop',
          tsserver: {
            // The workspace's own typescript wins (the server looks there first); this is for repos without one.
            ...(fallbackTsserver ? { fallbackPath: fallbackTsserver } : {}),
            // A second tsserver that keeps an editor responsive while typing (~200-250 MB here). No editor, no typing.
            useSyntaxServer: 'never',
          },
          // typingsInstaller (~100 MB) downloads @types from npm for JS projects: a network side effect the
          // user never asked for, for type detail the agent's lookups don't need.
          disableAutomaticTypingAcquisition: true,
          preferences: {
            // An extra hidden project built from every package.json dependency, used only for completions.
            includePackageJsonAutoImports: 'off',
          },
        },
      });
      if (ready !== attempt) {
        // stop() or restart() ran while it was starting.
        c.kill();
        throw new Error('the TypeScript server was stopped while starting');
      }
      c.notify('initialized', {});
      conn = c;
      return c;
    })();
    ready = attempt;
    attempt.catch((err: Error) => {
      if (ready !== attempt) return;
      failure = err.message;
      ready = undefined;
    });
    return attempt;
  }

  function onNotification(method: string, params: any): void {
    if (method !== 'textDocument/publishDiagnostics') return;
    const fsPath = fromUri(params.uri);
    if (!fsPath) return;
    published.set(fsPath, params.diagnostics ?? []);
    const doc = docs.get(fsPath);
    // Diagnostics for an older version than the one we sent don't settle it.
    if (doc && (params.version === undefined || params.version === null || params.version >= doc.version)) doc.pendingSince = 0;
  }

  /** Make the server's copy of `fsPath` match the disk. Returns the connection once it's sent. */
  async function sync(fsPath: string, keepOpen: boolean): Promise<LspConnection | undefined> {
    if (!isServed(fsPath) || failure) return undefined;
    const c = await start();
    let st: fs.Stats;
    try {
      st = fs.statSync(fsPath);
    } catch {
      closeDoc(c, fsPath);
      return c;
    }
    const existing = docs.get(fsPath);
    const now = Date.now();
    if (existing) {
      existing.lastUsed = now;
      existing.keepOpen ||= keepOpen;
      if (existing.mtimeMs === st.mtimeMs) return c;
      const text = fs.readFileSync(fsPath, 'utf8');
      existing.mtimeMs = st.mtimeMs;
      if (text === existing.text) return c;
      existing.text = text;
      existing.version++;
      existing.pendingSince = now;
      c.notify('textDocument/didChange', { textDocument: { uri: existing.uri, version: existing.version }, contentChanges: [{ text }] });
      return c;
    }
    const text = fs.readFileSync(fsPath, 'utf8');
    const doc: OpenDoc = { uri: toUri(fsPath), version: 1, text, mtimeMs: st.mtimeMs, keepOpen, lastUsed: now, pendingSince: now };
    docs.set(fsPath, doc);
    c.notify('textDocument/didOpen', {
      textDocument: { uri: doc.uri, languageId: LANGUAGE_BY_EXT[path.extname(fsPath).toLowerCase()], version: 1, text },
    });
    evictReadOnly(c);
    return c;
  }

  /**
   * Resolves once the server has published diagnostics for each file's current
   * version. tsserver answers navto/definition against whatever projects are
   * loaded *right now*, and loading one starts only after didOpen: asked too
   * early, workspace/symbol returns [] and definition stops at the import.
   * The first publish for a file means its project is loaded.
   */
  async function settled(fsPaths: string[], timeoutMs = PENDING_GIVE_UP_MS): Promise<void> {
    const t0 = Date.now();
    while (fsPaths.some((p) => docs.get(p)?.pendingSince) && Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  function closeDoc(c: LspConnection, fsPath: string): void {
    const doc = docs.get(fsPath);
    if (!doc) return;
    docs.delete(fsPath);
    published.delete(fsPath);
    c.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
  }

  function evictReadOnly(c: LspConnection): void {
    const readOnly = [...docs.entries()].filter(([, d]) => !d.keepOpen).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < readOnly.length - MAX_READ_ONLY_OPEN; i++) closeDoc(c, readOnly[i]![0]);
  }

  /** workspace/symbol only searches loaded projects: open one source file per tsconfig. */
  async function seedProjects(): Promise<void> {
    if (seeded) return;
    seeded = true;
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (found.length >= MAX_SEED_PROJECTS || depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isFile() && (e.name === 'tsconfig.json' || e.name === 'jsconfig.json'))) {
        const file = firstSource(dir);
        if (file) found.push(file);
      }
      for (const e of entries) {
        if (e.isDirectory() && !SEED_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
      }
    };
    for (const root of opts.workspaceFolders()) walk(root, 0);
    if (!found.length) {
      // A plain JS repo: no config, so no project to load. VS Code would only
      // know the files open in tabs; here, open the first sources found.
      const loose = (dir: string, depth: number) => {
        if (found.length >= MAX_SEED_LOOSE_FILES || depth > 4) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (found.length >= MAX_SEED_LOOSE_FILES) return;
          if (e.isFile() && isServed(e.name) && !e.name.endsWith('.d.ts')) found.push(path.join(dir, e.name));
        }
        for (const e of entries) {
          if (e.isDirectory() && !SEED_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) loose(path.join(dir, e.name), depth + 1);
        }
      };
      for (const root of opts.workspaceFolders()) loose(root, 0);
    }
    for (const f of found) await sync(f, true);
    await settled(found);
  }

  function firstSource(dir: string): string | undefined {
    for (const sub of ['src', '.']) {
      const d = path.join(dir, sub);
      try {
        const hit = fs.readdirSync(d).find((n) => /\.(ts|tsx)$/.test(n) && !n.endsWith('.d.ts'));
        if (hit) return path.join(d, hit);
      } catch {
        // no such directory
      }
    }
    return undefined;
  }

  /** Graceful stop; state is dropped at once so nothing reads a dying server's diagnostics. */
  function stop(): void {
    const c = conn;
    conn = undefined;
    ready = undefined;
    seeded = false;
    docs.clear();
    published.clear();
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = undefined;
    if (!c) return;
    c.request('shutdown', null)
      .then(() => c.notify('exit', null))
      .catch(() => undefined)
      .finally(() => setTimeout(() => c.kill(), 500).unref());
  }

  function locationFrom(l: any): LspLocation | undefined {
    const uri = l.targetUri ?? l.uri;
    const range = l.targetRange ?? l.range;
    const fsPath = uri ? fromUri(uri) : undefined;
    return fsPath && range ? { fsPath, range } : undefined;
  }

  function unavailable(): Error {
    return new Error(`TypeScript language features are unavailable in the desktop: ${failure}`);
  }

  return {
    supports: isServed,

    touch(fsPath, edited) {
      if (!isServed(fsPath) || failure) return;
      sync(fsPath, edited).catch((err) => console.warn(`[desktop:lsp] could not sync ${fsPath}: ${err.message}`));
    },

    async workspaceSymbols(query) {
      if (failure) throw unavailable();
      await start();
      await seedProjects();
      // LSP workspace/symbol in typescript-language-server passes the most
      // recently used file to navto, which limits the search to that one
      // project. VS Code's default (typescript.workspaceSymbols.scope =
      // allOpenProjects) sends navto with no file: every loaded project. Same here.
      const res = await conn!.request('workspace/executeCommand', {
        command: 'typescript.tsserverRequest',
        arguments: ['navto', { searchValue: query, maxResultCount: 256 }],
      });
      const items = ((res?.body ?? res) || []) as any[];
      const out: LspSymbol[] = [];
      for (const it of Array.isArray(items) ? items : []) {
        if (!it?.file || !it.start) continue;
        out.push({
          name: it.name,
          kind: TS_SYMBOL_KIND[it.kind] ?? LSP_SYMBOL_VARIABLE,
          containerName: it.containerName || undefined,
          fsPath: it.file,
          range: {
            start: { line: it.start.line - 1, character: it.start.offset - 1 },
            end: { line: it.end.line - 1, character: it.end.offset - 1 },
          },
        });
      }
      return out;
    },

    async locations(kind, fsPath, position: LspPosition) {
      if (failure) throw unavailable();
      const c = await sync(fsPath, false);
      if (!c) return [];
      await settled([fsPath]);
      const method = kind === 'definition' ? 'textDocument/definition' : 'textDocument/references';
      const params: any = { textDocument: { uri: toUri(fsPath) }, position };
      if (kind === 'references') params.context = { includeDeclaration: true };
      const raw = await c.request(method, params);
      return [raw ?? []].flat().map(locationFrom).filter((l): l is LspLocation => !!l);
    },

    diagnostics(fsPath) {
      if (failure) throw unavailable();
      used();
      const now = Date.now();
      const targets = fsPath ? [fsPath] : [...docs.keys()];
      const pending: string[] = [];
      let stuck = false;
      for (const p of targets) {
        if (!isServed(p)) continue;
        const doc = docs.get(p);
        let changed = !doc;
        if (doc) {
          try {
            changed = fs.statSync(p).mtimeMs !== doc.mtimeMs;
          } catch {
            changed = true;
          }
        }
        if (changed) {
          // Not open, or changed on disk behind our back (a run_command, a
          // formatter): hand the server the current text and report pending.
          sync(p, doc?.keepOpen ?? false).catch((err) => console.warn(`[desktop:lsp] could not sync ${p}: ${err.message}`));
          pending.push(p);
        } else if (doc!.pendingSince) {
          pending.push(p);
          if (now - doc!.pendingSince > PENDING_GIVE_UP_MS) stuck = true;
        }
      }
      if (pending.length) {
        const roots = opts.workspaceFolders();
        const shown = pending.map((p) => {
          const root = roots.find((r) => p.startsWith(r + path.sep));
          return root ? path.relative(root, p) : p;
        });
        throw new DiagnosticsPending(shown, stuck);
      }
      return targets
        .filter((p) => isServed(p))
        .map((p) => ({ fsPath: p, items: published.get(p) ?? [] }));
    },

    restart() {
      stop();
      failure = undefined;
    },

    dispose() {
      stop();
    },
  };
}
