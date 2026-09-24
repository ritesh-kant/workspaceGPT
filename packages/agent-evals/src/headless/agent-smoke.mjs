/**
 * P1.9 live validation — drives the REAL built model worker
 * (apps/vscode-extensions/dist/workers/model/modelWorker.js) against a LOCAL
 * Ollama model, with this process acting as the extension host: every
 * tool_request is served by real service code (agentWriteTools prepare
 * semantics, commandTools denylist+exec, checkpointService) against a
 * throwaway fixture workspace. Writes are auto-approved (the approval UI is
 * an Extension-Development-Host concern) but follow the real order:
 * checkpoint → prepare → apply → diagnostics.
 *
 * Also the efficiency-benchmark harness for the agent loop: captures the
 * worker's `metrics` summary (turns, tokens, budget/compaction events) plus
 * host-measured per-tool latency, and accumulates results across `--runs`
 * into results/agent-smoke.json (merge-on-rerun, see run.mjs) so regressions
 * in modelWorker.ts's loop are visible instead of just pass/fail.
 *
 * Run: node src/headless/agent-smoke.mjs [--model M] [--provider P] [--scenarios s1,s2,s3] [--runs 5] [--timeout-min 10] [--host desktop]
 *
 * --host desktop: find_symbol / go_to_definition / find_references /
 * get_diagnostics are served by the extension's real tool functions over the
 * desktop app's compat module and typescript-language-server
 * (apps/desktop/scripts/desktop-tools.mjs) instead of this file's regex
 * stubs. Records carry `host: 'desktop'` and are kept apart from the default
 * ones, so the two can be compared run for run (DESKTOP-TAURI-PLAN Phase 2 exit).
 * Model/provider/apiKey/baseUrl can also come from packages/agent-evals/.env
 * (see .env.example); precedence is CLI flag > shell env > .env > default.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { buildUnits } from './build-units.mjs';
import { loadEnv } from '../env.mjs';

const pexecFile = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const WORKER_PATH = path.join(repoRoot, 'apps/vscode-extensions/dist/workers/model/modelWorker.js');
const WORKER_SRC_PATH = path.join(repoRoot, 'apps/vscode-extensions/src/workers/model/modelWorker.ts');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

loadEnv();
const MODEL = argOf('model', process.env.WGPT_BENCH_MODEL ?? 'qwen2.5-coder:14b-ctx24k');
const PROVIDER = argOf('provider', process.env.WGPT_BENCH_PROVIDER ?? 'Ollama');
// Remote providers need a real key; Ollama ignores it but the OpenAI client
// requires a non-empty string. Comma-separated keys feed withKeyFailover.
const API_KEY = argOf('api-key', process.env.WGPT_BENCH_API_KEY ?? 'DUMMY_API_KEY');
const BASE_URL = argOf('base-url', process.env.WGPT_BENCH_BASE_URL); // Custom provider only
const ONLY = argOf('scenarios', 's1,s2,s3').split(',');
const RUNS = Math.max(1, parseInt(argOf('runs', '1'), 10) || 1);
const HOST = argOf('host', 'harness');
if (!['harness', 'desktop'].includes(HOST)) throw new Error(`--host must be harness or desktop, got ${HOST}`);
const SCENARIO_TIMEOUT_MS = Math.round(parseFloat(argOf('timeout-min', '10')) * 60 * 1000);

// A stale dist bundle silently produces runs with no `metrics` message (the
// field just stays undefined) — warn instead of letting that look like a
// real zero.
try {
  if (fs.statSync(WORKER_PATH).mtimeMs < fs.statSync(WORKER_SRC_PATH).mtimeMs) {
    console.warn(
      `⚠️  ${path.relative(repoRoot, WORKER_PATH)} is older than its source — rebuild with ` +
        `\`cd apps/vscode-extensions && node esbuild.config.js\` or metrics may be missing/stale.`,
    );
  }
} catch {
  /* dist bundle missing entirely — the Worker constructor below will fail loudly */
}

const outDir = await buildUnits();
const writeTools = await import(path.join(outDir, 'agentWriteTools.mjs'));
const commandTools = await import(path.join(outDir, 'commandTools.mjs'));
const { CheckpointService } = await import(path.join(outDir, 'checkpointService.mjs'));
// The production numbering helper, not a copy of it — see the read_file stub.
const { numberLines } = await import(path.join(outDir, 'lineNumbers.mjs'));

// ── fixture workspace ──────────────────────────────────────────────────

const FIXTURE = {
  'src/math.js': `function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a + b;
}

module.exports = { add, multiply };
`,
  'src/app.js': `const { add } = require('./math');

console.log('2+3 =', add(2, 3));
console.log('10+5 =', add(10, 5));
`,
  'test.js': `const assert = require('assert');
const { add, multiply } = require('./src/math');

assert.strictEqual(add(2, 3), 5, 'add(2,3) should be 5');
assert.strictEqual(multiply(2, 3), 6, 'multiply(2,3) should be 6');
console.log('all tests passed');
`,
  'README.md': `# calc-demo

Tiny demo project. \`src/math.js\` holds the arithmetic helpers, \`src/app.js\`
uses them, \`test.js\` is the test suite (run with \`node test.js\`).
`,
};

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-smoke-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return ws;
}

// Derived from the workspace rather than hardcoded, so a scenario can bring
// its own fixture (the ticket evals do) and still get a real orientation.
export const orientationFor = (ws) => {
  const files = walk(ws).sort();
  const readme = files.find((f) => /^readme\.md$/i.test(f));
  const head = readme
    ? fs.readFileSync(path.join(ws, readme), 'utf8').split('\n').slice(0, 6).join(' ').slice(0, 300)
    : '';
  return (
    `Workspace root: ${path.basename(ws)}\n` +
    files.slice(0, 60).join('\n') +
    (head ? `\n\nREADME head: ${head}` : '')
  );
};

// ── host-side tool implementations ─────────────────────────────────────

export function walk(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, acc);
    else acc.push(path.relative(base, abs));
  }
  return acc;
}

const globToRegex = (glob) =>
  new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );

export function makeToolHost(ws, log) {
  const roots = [{ name: path.basename(ws), uri: { fsPath: ws } }];

  /** Declaration scan backing find_symbol/go_to_definition (shape mirrors codebaseTools.SymbolHit). */
  function findDeclarations(query) {
    const q = query.toLowerCase();
    const symbols = [];
    if (!q) return symbols;
    for (const rel of walk(ws).filter((f) => /\.(js|ts|mjs|cjs)$/.test(f))) {
      fs.readFileSync(path.join(ws, rel), 'utf8').split('\n').forEach((text, i) => {
        const m =
          /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(text) ||
          /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(text) ||
          /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(text);
        if (m && m[1].toLowerCase().startsWith(q)) {
          const kind = /\bclass\b/.test(m[0]) ? 'class' : /\bfunction\b/.test(m[0]) ? 'function' : 'variable';
          symbols.push({ name: m[1], kind, file: rel, line: i + 1 });
        }
      });
    }
    return symbols;
  }
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-smoke-shadow-'));
  const checkpoints = new CheckpointService(path.join(shadow, 'cp'), ws);
  const audit = [];

  async function applyPrepared(w) {
    await checkpoints.checkpoint(`before: ${w.summary}`);
    if (w.kind === 'delete') {
      fs.unlinkSync(w.uri.fsPath);
    } else {
      if (w.kind === 'edit' && fs.readFileSync(w.uri.fsPath, 'utf8') !== w.before) {
        throw new Error(`${w.displayPath} changed since the edit was prepared — re-read the file and try again.`);
      }
      fs.mkdirSync(path.dirname(w.uri.fsPath), { recursive: true });
      fs.writeFileSync(w.uri.fsPath, w.after);
    }
    audit.push({ action: w.kind, detail: w.summary, decision: 'auto-approved (headless)', outcome: 'applied' });
    log(`      APPLIED: ${w.summary}`);
    return { applied: true, summary: w.summary };
  }

  async function diagnostics() {
    const diags = [];
    for (const rel of walk(ws).filter((f) => f.endsWith('.js'))) {
      try {
        await pexecFile('node', ['--check', path.join(ws, rel)]);
      } catch (e) {
        diags.push({ file: rel, severity: 'error', message: String(e.stderr || e.message).slice(0, 500) });
      }
    }
    return { diagnostics: diags, note: diags.length ? undefined : 'No problems reported.' };
  }

  const git = (args) => pexecFile('git', ['-C', ws, ...args]).then((r) => r.stdout);

  const tools = {
    read_file: async ({ path: rel, startLine, endLine }) => {
      const abs = path.join(ws, rel.replace(/^\.?\//, ''));
      if (!abs.startsWith(ws)) throw new Error('path outside workspace');
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      const s = startLine ? startLine - 1 : 0;
      const requestedEnd = endLine ?? lines.length;
      // Mirrors the REAL codebaseTools.readFile, caps and all. This stub used
      // to return raw text with a comment asserting production never numbers
      // lines — true when it was written, false since P4 added the "  12→"
      // prefixes. A harness whose read contract has drifted from production
      // measures the wrong thing twice over: it hides prefix-copy failures in
      // edit_file, which is the risk numbering introduced in the first place.
      const cappedEnd = Math.min(requestedEnd, s + 2000, lines.length);
      let content = lines.slice(s, cappedEnd).join('\n');
      let truncated = cappedEnd < requestedEnd || cappedEnd < lines.length;
      if (content.length > 64 * 1024) {
        content = content.slice(0, 64 * 1024);
        const lastNewline = content.lastIndexOf('\n');
        if (lastNewline > 0) content = content.slice(0, lastNewline);
        truncated = true;
      }
      const firstLine = s + 1;
      return {
        content: numberLines(content, firstLine),
        totalLines: lines.length,
        truncated,
        startLine: firstLine,
        endLine: firstLine + content.split('\n').length - 1,
      };
    },
    list_directory: async ({ path: rel } = {}) => {
      const abs = path.join(ws, (rel ?? '.').replace(/^\.?\//, ''));
      return {
        entries: fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })),
      };
    },
    find_files: async ({ pattern }) => {
      const re = globToRegex(pattern.replace(/^\.?\//, ''));
      const loose = new RegExp(pattern.replace(/[*?]/g, ''), 'i');
      const all = walk(ws);
      let files = all.filter((f) => re.test(f));
      if (!files.length) files = all.filter((f) => loose.test(f));
      return { files, totalMatches: files.length };
    },
    search_codebase: async ({ query, glob, caseSensitive, outputMode }) => {
      // Pure-JS scan: the production tool rides VS Code's bundled ripgrep,
      // which does not exist in this headless environment.
      const flags = caseSensitive ? 'g' : 'gi';
      let re;
      try {
        re = new RegExp(query, flags);
      } catch {
        re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); // fixed-string fallback
      }
      const globRe = glob ? globToRegex(glob) : null;
      const files = walk(ws).filter((f) => !globRe || globRe.test(f));
      const matches = [];
      const matchedFiles = [];
      for (const rel of files) {
        const lines = fs.readFileSync(path.join(ws, rel), 'utf8').split('\n');
        let fileHit = false;
        lines.forEach((text, i) => {
          re.lastIndex = 0;
          if (re.test(text)) {
            fileHit = true;
            if (matches.length < 50) matches.push({ file: rel, line: i + 1, text: text.slice(0, 300) });
          }
        });
        if (fileHit) matchedFiles.push(rel);
      }
      if (outputMode === 'files_with_matches') {
        return { files: matchedFiles, totalMatches: matchedFiles.length, matches: [] };
      }
      return { matches, totalMatches: matches.length, truncated: matches.length >= 50 };
    },
    // Working language-service equivalents (regex declaration scan — plenty
    // for the fixture). The old stubs returned a permanent error, which
    // production never does: in the product these are backed by VS Code's
    // language index. A failed FIRST find_symbol call reliably framed weak
    // models into "the symbol does not exist" for the rest of the run (three
    // separate s1 failures with the identical "add is not found" answer),
    // so erroring here made the eval environment HARDER than production.
    find_symbol: async ({ query }) => {
      const symbols = findDeclarations(String(query ?? ''));
      return { symbols: symbols.slice(0, 20), truncated: symbols.length > 20 };
    },
    find_references: async ({ symbol }) => {
      const re = new RegExp(`\\b${String(symbol ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const locations = [];
      for (const rel of walk(ws)) {
        fs.readFileSync(path.join(ws, rel), 'utf8').split('\n').forEach((text, i) => {
          if (re.test(text)) locations.push({ file: rel, line: i + 1, preview: text.trim().slice(0, 200) });
        });
      }
      return { locations: locations.slice(0, 50), truncated: locations.length > 50 };
    },
    go_to_definition: async ({ symbol }) => {
      const symbols = findDeclarations(String(symbol ?? ''));
      return { locations: symbols.map((s) => ({ file: s.file, line: s.line, preview: `${s.kind} ${s.name}` })), truncated: false };
    },
    get_diagnostics: diagnostics,
    search_docs: async () => ({ results: [], note: 'No documentation is indexed in this environment.' }),
    search_tickets: async () => ({ results: [], note: 'No tickets are indexed in this environment.' }),
    git_status: async () => ({ status: (await git(['status', '--porcelain'])) || '(clean)' }),
    git_diff: async ({ path: rel } = {}) => ({ diff: (await git(['diff', ...(rel ? ['--', rel] : [])])) || '(no changes)' }),
    git_log: async ({ maxCount } = {}) => ({ log: await git(['log', `--max-count=${maxCount ?? 10}`, '--oneline']) }),
    git_blame: async ({ path: rel, startLine, endLine }) => ({
      blame: await git(['blame', ...(startLine ? [`-L`, `${startLine},${endLine ?? startLine}`] : []), '--', rel]),
    }),
    run_command: async ({ command, cwd, timeoutSec }) => {
      commandTools.assertCommandAllowed(command);
      const { cwd: absCwd, displayCwd } = commandTools.resolveCommandCwd(roots, cwd);
      log(`      RUN (auto-approved): ${command}  [cwd=${displayCwd}]`);
      const result = await commandTools.executeCommand(command, absCwd, timeoutSec);
      audit.push({ action: 'command', detail: command, decision: 'auto-approved (headless)', outcome: result.exitCode === 0 ? 'applied' : 'failed' });
      return result;
    },
    edit_file: async (args) => applyPrepared(await writeTools.prepareEditFile(args, roots)),
    create_file: async (args) => applyPrepared(await writeTools.prepareCreateFile(args, roots)),
    delete_file: async (args) => applyPrepared(await writeTools.prepareDeleteFile(args, roots)),
  };

  return { tools, audit, checkpoints };
}

// ── worker driver ──────────────────────────────────────────────────────

/**
 * @param extraTools host-side tool implementations to add to (or override in)
 *   the standard set. The worker offers every tool in TOOL_DEFS regardless of
 *   what the host implements, so integration-shaped tools that need no real
 *   backend — `get_ticket` above all — are injected per test rather than
 *   stubbed globally.
 */
export function runAgent(ws, prompt, log, extraWorkerData = {}, extraTools = {}) {
  const { tools: baseTools, audit, checkpoints } = makeToolHost(ws, log);
  const tools = { ...baseTools, ...extraTools };
  const toolCalls = [];
  const toolTimings = [];
  const thoughtMs = [];
  let metrics = null;
  let notes = 0;
  // Assistant prose per turn, tagged with how many tool calls had run when it
  // was written, so a narration can be located relative to the first edit.
  const noteLog = [];
  let chunks = 0;
  let failovers = 0;
  // The worker's mirrored model-facing conversation, assembled exactly the way
  // chatService assembles it (reset replaces, append extends). This is what a
  // resume is fed, so a test can capture a run's transcript and hand it back.
  let transcript = null;
  let resumed = null;

  return new Promise((resolve) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        prompt,
        searchResults: [],
        modelId: MODEL,
        provider: PROVIDER,
        apiKey: API_KEY,
        ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
        chatHistory: '',
        codebaseTools: { enabled: true },
        repoOrientation: orientationFor(ws),
        ...extraWorkerData,
      },
    });

    const finish = (outcome) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ ...outcome, toolCalls, toolTimings, thoughtMs, metrics, notes, noteLog, chunks, failovers, transcript, resumed, audit, checkpoints });
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'scenario timeout' }), SCENARIO_TIMEOUT_MS);

    worker.on('message', async (msg) => {
      if (msg.type === 'tool_request') {
        const impl = tools[msg.name];
        toolCalls.push({ name: msg.name, args: msg.arguments });
        log(`   -> ${msg.name} ${JSON.stringify(msg.arguments ?? {}).slice(0, 140)}`);
        const startedAt = Date.now();
        if (!impl) {
          toolTimings.push({ name: msg.name, ms: Date.now() - startedAt, error: true });
          worker.postMessage({ type: 'tool_response', id: msg.id, error: `Unknown tool: ${msg.name}` });
          return;
        }
        try {
          const result = await impl(msg.arguments ?? {});
          toolTimings.push({ name: msg.name, ms: Date.now() - startedAt, error: false });
          worker.postMessage({ type: 'tool_response', id: msg.id, result });
        } catch (e) {
          log(`      TOOL ERROR: ${e.message.split('\n')[0]}`);
          toolTimings.push({ name: msg.name, ms: Date.now() - startedAt, error: true });
          worker.postMessage({ type: 'tool_response', id: msg.id, error: e.message });
        }
      } else if (msg.type === 'thought') {
        thoughtMs.push(msg.ms);
      } else if (msg.type === 'agent_note') {
        notes++;
        noteLog.push({ at: toolCalls.length, content: String(msg.content ?? '') });
      } else if (msg.type === 'chunk') {
        chunks++;
      } else if (msg.type === 'key_failover') {
        failovers++;
      } else if (msg.type === 'agent_transcript') {
        if (Array.isArray(msg.reset)) transcript = msg.reset;
        else if (Array.isArray(msg.append) && msg.append.length) transcript = [...(transcript ?? []), ...msg.append];
      } else if (msg.type === 'resumed') {
        resumed = { steps: msg.steps ?? 0, writesApplied: msg.writesApplied ?? 0 };
      } else if (msg.type === 'metrics') {
        const { type, ...rest } = msg;
        metrics = rest;
      } else if (msg.type === 'done') {
        finish({ ok: true, answer: msg.content ?? '' });
      } else if (msg.type === 'error') {
        finish({ ok: false, error: msg.message });
      }
      // tool_status is UI-only (fired immediately before its paired
      // tool_request, from the same synchronous call site) — per-tool
      // latency above is measured directly around the real execution
      // instead, which is more accurate than pairing the two events.
    });
    worker.on('error', (e) => finish({ ok: false, error: `worker crashed: ${e.message}` }));
  });
}

// ── scenarios ──────────────────────────────────────────────────────────

const run = (cmd, cwd) => pexecFile('/bin/bash', ['-lc', cmd], { cwd }).then(
  (r) => ({ code: 0, out: r.stdout + r.stderr }),
  (e) => ({ code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }),
);

const SCENARIOS = [
  {
    id: 's1',
    title: 'read-only exploration',
    prompt: 'What does the `add` function in this project do, and where is it used? Answer briefly with file references.',
    verify: async (ws, r) => {
      const checks = [];
      checks.push(['used tools before answering', r.toolCalls.length > 0]);
      checks.push(['answer mentions math.js', /math\.js/i.test(r.answer ?? '')]);
      checks.push(['answer mentions a usage site (app.js or test.js)', /(app\.js|test\.js)/i.test(r.answer ?? '')]);
      checks.push(['no writes performed', !r.toolCalls.some((c) => ['edit_file', 'create_file', 'delete_file'].includes(c.name))]);
      return checks;
    },
  },
  {
    id: 's2',
    title: 'multi-file rename with verification',
    prompt:
      'Rename the function `add` to `sum` across this project: change its definition and update every call site and import/require. When done, verify with get_diagnostics.',
    verify: async (ws, r) => {
      const math = fs.readFileSync(path.join(ws, 'src/math.js'), 'utf8');
      const app = fs.readFileSync(path.join(ws, 'src/app.js'), 'utf8');
      const test = fs.readFileSync(path.join(ws, 'test.js'), 'utf8');
      const appRun = await run('node src/app.js', ws);
      const checks = [];
      checks.push(['sum defined in math.js', /function sum\(/.test(math) && /sum/.test(math.match(/module\.exports.*/)?.[0] ?? '')]);
      checks.push(['no bare add() left anywhere', ![math, app, test].some((s) => /\badd\s*\(/.test(s))]);
      checks.push(['app.js updated and still runs', appRun.code === 0]);
      checks.push(['test.js import updated', /sum/.test(test)]);
      checks.push(['called get_diagnostics after editing', r.toolCalls.some((c) => c.name === 'get_diagnostics')]);
      checks.push(['made a checkpoint per write', (await r.checkpoints.list()).length > 0]);
      return checks;
    },
  },
  {
    id: 's3',
    title: 'run failing test, fix, re-run to green',
    prompt:
      'Running `node test.js` in this project currently fails. Run it, read the failure, find and fix the bug, then re-run the test until it passes.',
    verify: async (ws, r) => {
      const testRun = await run('node test.js', ws);
      const ranTest = r.toolCalls.filter((c) => c.name === 'run_command' && /test\.js/.test(c.args?.command ?? ''));
      const checks = [];
      checks.push(['ran the test via run_command', ranTest.length >= 1]);
      checks.push(['re-ran after fixing (>=2 runs)', ranTest.length >= 2]);
      checks.push(['edited a file', r.toolCalls.some((c) => c.name === 'edit_file')]);
      checks.push(['test now passes', testRun.code === 0]);
      return checks;
    },
  },
];

// ── aggregation helpers ──────────────────────────────────────────────────

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const spread = (xs) => (xs.length ? `${Math.min(...xs)}–${Math.max(...xs)}` : '—');
const fmt = (n) => (n === null || n === undefined ? '—' : Math.round(n));

// ── main ───────────────────────────────────────────────────────────────

const log = (s) => console.log(s);

log(`model: ${MODEL} · provider: ${PROVIDER}${BASE_URL ? ` · baseUrl: ${BASE_URL}` : ''} · runs: ${RUNS} · scenarios: ${ONLY.join(',')}`);
log(`agent-smoke: model=${MODEL} worker=${path.relative(repoRoot, WORKER_PATH)} runs=${RUNS}`);

// Importable: the ticket evals (ticket-evals.mjs) reuse this file's host
// emulation and worker driver, and must not trigger a smoke run by importing
// it. Everything above is definitions; everything below is the run.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

const selected = SCENARIOS.filter((s) => ONLY.includes(s.id));
const runRecords = [];

if (isMain) {
for (let runIndex = 1; runIndex <= RUNS; runIndex++) {
  for (const sc of selected) {
    log(`\n━━ [run ${runIndex}/${RUNS}] ${sc.id}: ${sc.title}`);
    const ws = makeWorkspace();
    await pexecFile('git', ['-C', ws, 'init', '--quiet']);
    await pexecFile('git', ['-C', ws, 'config', 'user.email', 't@t']);
    await pexecFile('git', ['-C', ws, 'config', 'user.name', 't']);
    await pexecFile('git', ['-C', ws, 'add', '-A']);
    await pexecFile('git', ['-C', ws, 'commit', '--quiet', '-m', 'fixture']);

    const startedAt = new Date().toISOString();
    const started = Date.now();
    const desktopHost = HOST === 'desktop'
      ? await (await import(path.join(repoRoot, 'apps/desktop/scripts/desktop-tools.mjs'))).createDesktopToolHost(ws)
      : null;
    const r = await runAgent(ws, sc.prompt, log, {}, desktopHost?.tools ?? {});
    desktopHost?.dispose();
    const wallMs = Date.now() - started;

    let checks = [];
    if (r.ok) checks = await sc.verify(ws, r);
    else checks = [['agent completed', false, r.error]];
    const passed = checks.every(([, ok]) => ok);

    log(`   ${passed ? 'PASS' : 'FAIL'} (${Math.round(wallMs / 1000)}s, ${r.toolCalls.length} tool calls)`);
    for (const [name, ok] of checks) log(`     ${ok ? '✓' : '✗'} ${name}`);
    if (r.answer) log(`   answer: ${r.answer.slice(0, 300).replace(/\n/g, ' ')}`);
    if (!r.metrics) log(`   ⚠️  no metrics message received from worker — dist bundle may be stale`);

    runRecords.push({
      model: MODEL,
      provider: PROVIDER,
      ...(HOST === 'desktop' ? { host: 'desktop' } : {}),
      scenario: sc.id,
      title: sc.title,
      runIndex,
      startedAt,
      pass: passed,
      checks: checks.map(([name, ok]) => ({ name, ok })),
      error: r.error ?? null,
      wallMs,
      metrics: r.metrics,
      toolTimings: r.toolTimings,
      toolCalls: r.toolCalls.map((c) => c.name),
      answerHead: (r.answer ?? '').slice(0, 1500),
    });
  }
}

// ── results.json (merge-on-rerun, keyed by model|provider|scenario) ──────

const resultsDir = path.join(here, '../../results');
fs.mkdirSync(resultsDir, { recursive: true });
const jsonPath = path.join(resultsDir, 'agent-smoke.json');
// Older records have no provider field — treat them as Ollama (the only
// provider the harness supported before it became configurable).
const keyOf = (r) => `${r.model}|${r.provider ?? 'Ollama'}|${r.host ?? 'harness'}|${r.scenario}`;
const ranKeys = new Set(runRecords.map(keyOf));
let merged = runRecords;
if (fs.existsSync(jsonPath)) {
  const prior = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  merged = [...prior.filter((r) => !ranKeys.has(keyOf(r))), ...runRecords];
}
fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2));

// ── agent-smoke.md — per model×scenario summary + per-tool latency ────────

const modelLabel = (r) => `${r.model}${r.provider && r.provider !== 'Ollama' ? ` (${r.provider})` : ''}${r.host === 'desktop' ? ' [desktop tools]' : ''}`;
const reportModels = [...new Set(merged.map(modelLabel))];
const reportScenarios = [...new Set(merged.map((r) => r.scenario))];

let md = `# Agent smoke test\n\nRun: ${new Date().toISOString()} · worker: real dist bundle · tools: real service modules (headless host)\n\n`;
md += `| model | scenario | pass rate | wall s (median, min–max) | turns (median) | LLM turn ms (median) | tool calls (median) | prompt tok (median) | completion tok (median) | Σ budget-exhausted | Σ compactions | Σ nudges |\n`;
md += `|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const model of reportModels) {
  for (const scenario of reportScenarios) {
    const rs = merged.filter((r) => modelLabel(r) === model && r.scenario === scenario);
    if (!rs.length) continue;
    const title = rs[0].title;
    const passRate = `${Math.round((100 * rs.filter((r) => r.pass).length) / rs.length)}%`;
    const wallS = rs.map((r) => r.wallMs / 1000);
    const withMetrics = rs.filter((r) => r.metrics);
    const turns = withMetrics.map((r) => r.metrics.turns);
    // median LLM-call latency across every turn of every run — separates
    // "the model is slow" from "the loop takes too many turns"
    const llmTurnMs = withMetrics.flatMap((r) => (r.metrics.perTurn ?? []).map((t) => t.ms));
    const toolCalls = rs.map((r) => r.toolCalls.length);
    const promptTok = withMetrics.map((r) => r.metrics.promptTokens);
    const completionTok = withMetrics.map((r) => r.metrics.completionTokens);
    const budgetExhausted = withMetrics.filter((r) => r.metrics.budgetExhausted).length;
    const compactions = withMetrics.reduce((a, r) => a + (r.metrics.compactions ?? 0), 0);
    const nudges = withMetrics.reduce((a, r) => {
      const n = r.metrics.nudges ?? {};
      return a + (n.plan ?? 0) + (n.incompleteAnswer ?? 0) + (n.failedWrites ?? 0) + (n.phantomChanges ?? 0) + (n.summary ?? 0);
    }, 0);
    md += `| ${model} | ${scenario} ${title} | ${passRate} | ${fmt(median(wallS))} (${spread(wallS.map(Math.round))}) | ${fmt(median(turns))} | ${fmt(median(llmTurnMs))} | ${fmt(median(toolCalls))} | ${fmt(median(promptTok))} | ${fmt(median(completionTok))} | ${budgetExhausted}/${withMetrics.length} | ${compactions} | ${nudges} |\n`;
  }
}

// per-tool median latency across every run in the merged set
const byTool = new Map();
for (const r of merged) {
  for (const t of r.toolTimings ?? []) {
    if (!byTool.has(t.name)) byTool.set(t.name, []);
    byTool.get(t.name).push(t.ms);
  }
}
if (byTool.size) {
  md += `\n## Per-tool latency (ms, across all runs)\n\n| tool | calls | median ms | min–max ms |\n|---|---|---|---|\n`;
  for (const [name, ms] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)) {
    md += `| ${name} | ${ms.length} | ${fmt(median(ms))} | ${spread(ms)} |\n`;
  }
}

md += `\n## Failures\n\n`;
for (const r of merged.filter((r) => !r.pass)) {
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
  md += `- **${r.model} × ${r.scenario} (run ${r.runIndex})** — ${failed.join('; ') || 'agent did not complete'}${r.error ? ` — error: ${r.error}` : ''}\n`;
}

fs.writeFileSync(path.join(resultsDir, 'agent-smoke.md'), md);
log(`\nreport → results/agent-smoke.json, results/agent-smoke.md`);
process.exit(runRecords.every((r) => r.pass) ? 0 : 1);
} // end isMain
