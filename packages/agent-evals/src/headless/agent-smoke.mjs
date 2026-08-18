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
 * Run: node src/headless/agent-smoke.mjs [--model qwen2.5-coder:14b-ctx24k] [--scenarios s1,s2,s3]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { buildUnits } from './build-units.mjs';

const pexecFile = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const WORKER_PATH = path.join(repoRoot, 'apps/vscode-extensions/dist/workers/model/modelWorker.js');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const MODEL = argOf('model', 'qwen2.5-coder:14b-ctx24k');
const ONLY = argOf('scenarios', 's1,s2,s3').split(',');
const SCENARIO_TIMEOUT_MS = 10 * 60 * 1000;

const outDir = await buildUnits();
const writeTools = await import(path.join(outDir, 'agentWriteTools.mjs'));
const commandTools = await import(path.join(outDir, 'commandTools.mjs'));
const { CheckpointService } = await import(path.join(outDir, 'checkpointService.mjs'));

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

const orientationFor = (ws) =>
  `Workspace root: ${path.basename(ws)}\n` +
  `README.md\nsrc/math.js\nsrc/app.js\ntest.js\n\n` +
  `README head: calc-demo — src/math.js holds arithmetic helpers, test.js is the test suite (node test.js).`;

// ── host-side tool implementations ─────────────────────────────────────

function walk(dir, base = dir, acc = []) {
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

function makeToolHost(ws, log) {
  const roots = [{ name: path.basename(ws), uri: { fsPath: ws } }];
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
      const e = endLine ?? lines.length;
      return { path: rel, totalLines: lines.length, content: lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n') };
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
    find_symbol: async () => ({ error: 'Language services are unavailable in this environment — use search_codebase to locate the symbol instead.' }),
    find_references: async () => ({ error: 'Language services are unavailable in this environment — use search_codebase to find usages instead.' }),
    go_to_definition: async () => ({ error: 'Language services are unavailable in this environment — use search_codebase instead.' }),
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

function runAgent(ws, prompt, log) {
  const { tools, audit, checkpoints } = makeToolHost(ws, log);
  const toolCalls = [];

  return new Promise((resolve) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        prompt,
        searchResults: [],
        modelId: MODEL,
        provider: 'Ollama',
        apiKey: 'DUMMY_API_KEY',
        chatHistory: '',
        codebaseTools: { enabled: true },
        repoOrientation: orientationFor(ws),
      },
    });

    const finish = (outcome) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ ...outcome, toolCalls, audit, checkpoints });
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'scenario timeout' }), SCENARIO_TIMEOUT_MS);

    worker.on('message', async (msg) => {
      if (msg.type === 'tool_request') {
        const impl = tools[msg.name];
        toolCalls.push({ name: msg.name, args: msg.arguments });
        log(`   -> ${msg.name} ${JSON.stringify(msg.arguments ?? {}).slice(0, 140)}`);
        if (!impl) {
          worker.postMessage({ type: 'tool_response', id: msg.id, error: `Unknown tool: ${msg.name}` });
          return;
        }
        try {
          const result = await impl(msg.arguments ?? {});
          worker.postMessage({ type: 'tool_response', id: msg.id, result });
        } catch (e) {
          log(`      TOOL ERROR: ${e.message.split('\n')[0]}`);
          worker.postMessage({ type: 'tool_response', id: msg.id, error: e.message });
        }
      } else if (msg.type === 'done') {
        finish({ ok: true, answer: msg.content ?? '' });
      } else if (msg.type === 'error') {
        finish({ ok: false, error: msg.message });
      }
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

// ── main ───────────────────────────────────────────────────────────────

const log = (s) => console.log(s);
log(`agent-smoke: model=${MODEL} worker=${path.relative(repoRoot, WORKER_PATH)}`);

const report = [];
for (const sc of SCENARIOS.filter((s) => ONLY.includes(s.id))) {
  log(`\n━━ ${sc.id}: ${sc.title}`);
  const ws = makeWorkspace();
  await pexecFile('git', ['-C', ws, 'init', '--quiet']);
  await pexecFile('git', ['-C', ws, 'config', 'user.email', 't@t']);
  await pexecFile('git', ['-C', ws, 'config', 'user.name', 't']);
  await pexecFile('git', ['-C', ws, 'add', '-A']);
  await pexecFile('git', ['-C', ws, 'commit', '--quiet', '-m', 'fixture']);

  const started = Date.now();
  const r = await runAgent(ws, sc.prompt, log);
  const secs = Math.round((Date.now() - started) / 1000);

  let checks = [];
  if (r.ok) checks = await sc.verify(ws, r);
  else checks = [['agent completed', false, r.error]];
  const passed = checks.every(([, ok]) => ok);

  log(`   ${passed ? 'PASS' : 'FAIL'} (${secs}s, ${r.toolCalls.length} tool calls)`);
  for (const [name, ok] of checks) log(`     ${ok ? '✓' : '✗'} ${name}`);
  if (r.answer) log(`   answer: ${r.answer.slice(0, 300).replace(/\n/g, ' ')}`);

  report.push({
    scenario: `${sc.id} ${sc.title}`,
    pass: passed,
    seconds: secs,
    toolCalls: r.toolCalls.map((c) => c.name),
    checks: checks.map(([name, ok]) => ({ name, ok })),
    error: r.error,
    answer: (r.answer ?? '').slice(0, 1500),
  });
}

const resultsDir = path.join(here, '../../results');
fs.mkdirSync(resultsDir, { recursive: true });
const md = [
  `# Agent smoke test — ${MODEL}`,
  `Run: ${new Date().toISOString()} · worker: real dist bundle · tools: real service modules (headless host)`,
  '',
  ...report.map(
    (r) =>
      `## ${r.scenario} — ${r.pass ? 'PASS' : 'FAIL'} (${r.seconds}s)\n` +
      `Tool calls: ${r.toolCalls.join(', ') || '(none)'}\n` +
      r.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.name}`).join('\n') +
      (r.error ? `\n- error: ${r.error}` : '') +
      (r.answer ? `\n\n> ${r.answer.replace(/\n/g, '\n> ')}` : ''),
  ),
].join('\n');
fs.writeFileSync(path.join(resultsDir, 'agent-smoke.md'), md);
log(`\nreport → results/agent-smoke.md`);
process.exit(report.every((r) => r.pass) ? 0 : 1);
