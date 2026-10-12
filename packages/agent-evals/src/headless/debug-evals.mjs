/**
 * Debug mode evals (docs/design/debug-mode.md §8). Seeded bugs run end-to-end
 * through the REAL model worker with a scripted model, so what is asserted is
 * the HARNESS: the evidence ledger, the soft edit gate, the claim check, the
 * probes and the counterfactual — not whether a real model would find the bug.
 *
 * Scored per scenario on the design's list: root cause matches the seeded
 * location, repro ran before the edit, the counterfactual passed, no probe is
 * left in the final tree, and no "confirmed" the run did not earn.
 *
 *   d1 — a full, honest run: repro red, two hypotheses, an edit, repro green,
 *        the fix taken out (red) and put back, "confirmed" delivered clean.
 *   d2 — an overclaim: "confirmed" with no evidence is sent back, and when the
 *        model then settles for "probable" it is delivered as such.
 *   d4 — the repro is run with run_command (whose result does not repeat the
 *        command): it is still recorded as evidence and matched when it goes green.
 *   d5 — the ticket says it WORKED BEFORE: a "confirmed" without a look at git history
 *        is sent back, and after git_log the report names the introducing commit.
 *   d3 — an edit before any observation is held once, and a probe observes the
 *        hot value (and is removed) before the cause is named.
 *
 * Needs a built worker: `cd apps/vscode-extensions && node esbuild.config.js`.
 * Run: node src/headless/debug-evals.mjs [--scenarios d1,d2,d3]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { runAgent, makeWorkspace } from './agent-smoke.mjs';
import { startMockModel } from './mock-model.mjs';
import { buildUnits } from './build-units.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const ONLY = argOf('scenarios', 'd1,d2,d3,d4,d5,d6').split(',');

const outDir = await buildUnits();
const writeTools = await import(path.join(outDir, 'agentWriteTools.mjs'));
const commandTools = await import(path.join(outDir, 'commandTools.mjs'));
const debugService = await import(path.join(outDir, 'debugService.mjs'));
const { numberLines } = await import(path.join(outDir, 'lineNumbers.mjs'));

// ── the seeded bug: the cart total drops its last item ────────────────

const FILES = {
  'package.json': JSON.stringify({ name: 'cart', scripts: { test: 'node --test' } }),
  'src/cart.js':
    'function total(items) {\n' +
    '  let sum = 0;\n' +
    '  for (let i = 0; i < items.length - 1; i++) {\n' +
    '    sum += items[i].price;\n' +
    '  }\n' +
    '  return sum;\n' +
    '}\n' +
    '\nmodule.exports = { total };\n',
  'src/cart.test.js':
    "const test = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('./cart');\n" +
    "test('sums every item', () => assert.equal(total([{ price: 1 }, { price: 2 }, { price: 3 }]), 6));\n",
};
const SEEDED = { file: 'src/cart.js', lines: [3] };
const FIX_OLD = '  for (let i = 0; i < items.length - 1; i++) {';
const FIX_NEW = '  for (let i = 0; i < items.length; i++) {';

const TICKET = {
  id: '1520855', title: 'Cart total is missing the last item', type: 'Bug', state: 'Active', url: 'https://example.test/1520855',
  description: 'The cart total is short by the price of the last item.',
  reproSteps: '1. Add three items priced 1, 2, 3\n2. Open the cart\n3. Total shows 3, expected 6',
};
const REGRESSION_TICKET = { ...TICKET, description: 'The cart total was working before the last release; now it is short by the price of the last item.' };
const PROMPT = 'Debug bug #1520855 — reproduce it, find the root cause and prove it with something you ran, then fix it with the smallest change and add a regression test.';

// ── the host half the worker talks to, mirroring chatService's methods ─

function hostFor(ws, log) {
  const roots = [{ name: path.basename(ws), uri: { fsPath: ws } }];
  const state = debugService.newDebugRunState();
  const originals = new Map();
  const changed = new Map();
  const apply = (w) => {
    if (w.kind === 'delete') fs.unlinkSync(w.uri.fsPath);
    else fs.writeFileSync(w.uri.fsPath, w.after);
  };
  const runTest = async (p) => {
    const command = `node --test ${p}`;
    const res = await commandTools.executeCommand(command, ws);
    return { kind: 'test', command, cwd: '.', ...res };
  };
  const tools = {
    run_checks: async ({ path: p }) => debugService.withProbeOutput(state, await runTest(p)),
    run_command: async ({ command }) => debugService.withProbeOutput(state, await commandTools.executeCommand(command, ws)),
    edit_file: async (args) => {
      const w = await writeTools.prepareEditFile(args, roots);
      if (!originals.has(w.uri.fsPath)) originals.set(w.uri.fsPath, w.before);
      apply(w);
      changed.set(w.displayPath, true);
      return { applied: true, path: w.displayPath, summary: w.summary, added: 1, removed: 1 };
    },
    create_file: async (args) => {
      const w = await writeTools.prepareCreateFile(args, roots);
      originals.set(w.uri.fsPath, '');
      fs.mkdirSync(path.dirname(w.uri.fsPath), { recursive: true });
      apply(w);
      changed.set(w.displayPath, true);
      return { applied: true, path: w.displayPath, summary: w.summary, added: 1, removed: 0 };
    },
    add_probe: async (args) => {
      const id = `p${state.probeSeq + 1}`;
      const w = await writeTools.prepareProbeInsert({ path: args.path, line: Number(args.line), expr: args.expr, label: args.label, id }, roots);
      apply(w); // a probe is not a change to ship: it stays out of `changed`
      state.probeSeq++;
      state.probes.set(id, { id, path: w.displayPath, line: Number(args.line), label: String(args.label ?? args.expr), hypothesis: args.hypothesis });
      return { probe: true, id, path: w.displayPath, line: Number(args.line) };
    },
    remove_probes: async () => {
      let removed = 0;
      for (const rec of [...state.probes.values()]) {
        const w = await writeTools.prepareProbeRemoval(rec.path, [rec.id], roots);
        if (w) { apply(w); removed++; }
        state.probes.delete(rec.id);
      }
      return { removed, remaining: state.probes.size };
    },
    probe_output: async ({ id }) => debugService.probeOutputReport(state, id),
    counterfactual_check: async (args) =>
      debugService.runCounterfactual({ path: args.path, keep: args.keep }, roots, [...changed.keys()], undefined, (abs) => originals.get(abs)),
  };
  // read_file with the production numbering, so edits copy from what the model saw.
  tools.read_file = async ({ path: rel }) => {
    const content = fs.readFileSync(path.join(ws, rel.replace(/^\.?\//, '')), 'utf8');
    return { content: numberLines(content, 1), totalLines: content.split('\n').length, truncated: false, startLine: 1 };
  };
  log(`   (host for ${ws})`);
  return { tools, state };
}

// ── scripted models ───────────────────────────────────────────────────

const REPORT = (status, evidence) =>
  `## ✅ Done — the cart total now includes the last item\n\n### Symptom\nThe total was short by the last item's price.\n\n### Reproduction\n- \`node --test src/cart.test.js\` failed (E1).\n\n` +
  `### Root cause — ${status}\nThe loop bound \`items.length - 1\` stops one item short (\`src/cart.js:L3\`). Evidence: ${evidence}.\n\n### Fix\n- \`src/cart.js\` — loop to \`items.length\`; \`src/cart.test.js\` is the regression test.\n`;

const SCRIPTS = {
  d1: {
    main: [
      { toolCalls: [{ name: 'read_file', args: { path: 'src/cart.js' } }, { name: 'run_checks', args: { path: 'src/cart.test.js', kind: 'test' } }] },
      {
        toolCalls: [
          { name: 'debug_ledger', args: { action: 'hypothesis', text: 'the loop bound stops one item short', predicts: 'total misses the last item price' } },
          { name: 'debug_ledger', args: { action: 'hypothesis', text: 'price is read from the wrong field', predicts: 'total is 0 or NaN, not short by one item' } },
        ],
      },
      { toolCalls: [{ name: 'debug_ledger', args: { action: 'resolve', id: 'H1', status: 'confirmed', evidence: ['E1'], note: 'received 3 where 6 expected: the last price is missing' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'src/cart.js', oldString: FIX_OLD, newString: FIX_NEW } }] },
      { toolCalls: [{ name: 'run_checks', args: { path: 'src/cart.test.js', kind: 'test' } }] },
      { toolCalls: [{ name: 'counterfactual_check', args: { path: 'src/cart.test.js' } }] },
      { finalContent: REPORT('confirmed', 'E1, E2, E3') },
    ],
  },
  d2: {
    main: [
      { toolCalls: [{ name: 'read_file', args: { path: 'src/cart.js' } }] },
      // Overclaims straight from reading the code.
      { finalContent: REPORT('confirmed', 'E1') },
      // Sent back; settles for what it can support.
      { finalContent: REPORT('probable', 'the loop bound, read at src/cart.js:L3 — the one check left is running the test').replace('## ✅ Done — the cart total now includes the last item', '## ⚠️ Root cause not found — only probable from reading · needs the test run') },
    ],
  },
  d4: {
    main: [
      { toolCalls: [{ name: 'read_file', args: { path: 'src/cart.js' } }, { name: 'run_command', args: { command: 'node --test src/cart.test.js' } }] },
      {
        toolCalls: [
          { name: 'debug_ledger', args: { action: 'hypothesis', text: 'the loop bound stops one item short', predicts: 'total misses the last price' } },
          { name: 'debug_ledger', args: { action: 'hypothesis', text: 'a price is parsed wrong', predicts: 'NaN in the total' } },
        ],
      },
      { toolCalls: [{ name: 'edit_file', args: { path: 'src/cart.js', oldString: FIX_OLD, newString: FIX_NEW } }] },
      { toolCalls: [{ name: 'run_command', args: { command: 'node --test src/cart.test.js' } }] },
      { finalContent: '## ✅ Done — fixed\n\n### Root cause — probable\nThe loop bound stops one short (`src/cart.js:L3`), E1 then E2 after the fix.\n' },
    ],
  },
  d5: {
    main: [
      { toolCalls: [{ name: 'read_file', args: { path: 'src/cart.js' } }, { name: 'run_checks', args: { path: 'src/cart.test.js', kind: 'test' } }] },
      {
        toolCalls: [
          { name: 'debug_ledger', args: { action: 'hypothesis', text: 'the loop bound stops one item short', predicts: 'total misses the last price' } },
          { name: 'debug_ledger', args: { action: 'hypothesis', text: 'a price is parsed wrong', predicts: 'NaN in the total' } },
        ],
      },
      { toolCalls: [{ name: 'debug_ledger', args: { action: 'resolve', id: 'H1', status: 'confirmed', evidence: ['E1'] } }] },
      // The history is looked at before the first fix edit (the gate asks once; this model complies).
      { toolCalls: [{ name: 'git_log', args: { path: 'src/cart.js' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'src/cart.js', oldString: FIX_OLD, newString: FIX_NEW } }] },
      { toolCalls: [{ name: 'run_checks', args: { path: 'src/cart.test.js', kind: 'test' } }] },
      { toolCalls: [{ name: 'counterfactual_check', args: { path: 'src/cart.test.js' } }] },
      { finalContent: REPORT('confirmed', 'E1, E2, E3') + '\nIntroduced by `abc1234` (2026-10-01, dev — "tighten cart loop bound").\n' },
    ],
  },
  d6: {
    main: [
      { toolCalls: [{ name: 'read_file', args: { path: 'src/cart.js' } }, { name: 'run_checks', args: { path: 'src/cart.test.js', kind: 'test' } }] },
      {
        toolCalls: [
          { name: 'debug_ledger', args: { action: 'hypothesis', text: 'the loop bound stops one item short', predicts: 'total misses the last price' } },
          { name: 'debug_ledger', args: { action: 'hypothesis', text: 'a price is parsed wrong', predicts: 'NaN in the total' } },
        ],
      },
      { toolCalls: [{ name: 'debug_ledger', args: { action: 'resolve', id: 'H1', status: 'confirmed', evidence: ['E1'] } }] },
      // Ignores the history: the first edit is held once and says why.
      { toolCalls: [{ name: 'edit_file', args: { path: 'src/cart.js', oldString: FIX_OLD, newString: FIX_NEW } }] },
      { toolCalls: [{ name: 'git_log', args: { path: 'src/cart.js' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'src/cart.js', oldString: FIX_OLD, newString: FIX_NEW } }] },
      { toolCalls: [{ name: 'run_checks', args: { path: 'src/cart.test.js', kind: 'test' } }] },
      { toolCalls: [{ name: 'counterfactual_check', args: { path: 'src/cart.test.js' } }] },
      { finalContent: REPORT('confirmed', 'E1, E2, E3') },
    ],
  },
  d3: {
    main: [
      { toolCalls: [{ name: 'read_file', args: { path: 'src/cart.js' } }] },
      // An edit before any observation: held once.
      { toolCalls: [{ name: 'edit_file', args: { path: 'src/cart.js', oldString: FIX_OLD, newString: FIX_NEW } }] },
      // So it observes: the failing test, two ideas, and a probe on the loop bound.
      { toolCalls: [{ name: 'run_checks', args: { path: 'src/cart.test.js', kind: 'test' } }] },
      {
        toolCalls: [
          { name: 'debug_ledger', args: { action: 'hypothesis', text: 'the loop bound stops one item short', predicts: 'the last index visited is length-2' } },
          { name: 'debug_ledger', args: { action: 'hypothesis', text: 'the accumulator resets', predicts: 'sum restarts at 0 mid-loop' } },
        ],
      },
      { toolCalls: [{ name: 'add_probe', args: { path: 'src/cart.js', line: 4, expr: 'i', label: 'index visited', hypothesis: 'H1' } }] },
      { toolCalls: [{ name: 'run_checks', args: { path: 'src/cart.test.js', kind: 'test' } }] },
      { toolCalls: [{ name: 'remove_probes', args: {} }] },
      { finalContent: '## ⚠️ Root cause not found — probable, not fixed yet · stopping before the edit\n\n### Root cause — probable\nThe loop stops at index length-2 (`src/cart.js:L3`), per the probe (E2).\n' },
    ],
  },
};

// ── oracle ────────────────────────────────────────────────────────────

const callsOf = (record, name) => record.toolCalls.filter((c) => c.fromModel && c.name === name);
const orderOf = (record, name) => record.toolCalls.findIndex((c) => c.fromModel && c.name === name);

function leftoverProbes(ws) {
  return Object.keys(FILES).filter((f) => f.endsWith('.js')).filter((f) => fs.readFileSync(path.join(ws, f), 'utf8').includes('WGPT-PROBE'));
}

const ORACLES = {
  d1: ({ ws, record, tools }) => {
    const answer = record.answer ?? '';
    const cart = fs.readFileSync(path.join(ws, SEEDED.file), 'utf8');
    return [
      ['root cause matches the seeded location (src/cart.js, loop bound)', cart.includes(FIX_NEW) && /src\/cart\.js:L3/.test(answer)],
      ['the repro ran BEFORE the first edit', orderOf(record, 'run_checks') >= 0 && orderOf(record, 'run_checks') < orderOf(record, 'edit_file')],
      ['the counterfactual ran and the fix is back in place afterwards', callsOf(record, 'counterfactual_check').length === 1 && cart.includes(FIX_NEW)],
      ['no probe is left in the tree', leftoverProbes(ws).length === 0],
      ['"confirmed" was delivered WITHOUT a harness note (the run earned it)', /### Root cause — confirmed/.test(answer) && !/Harness note:/.test(answer)],
      ['the harness appended its own evidence ledger with the full proof', /### Evidence ledger \(recorded by the harness\)/.test(answer) && /red with the fix reverted — yes/.test(answer)],
      ['the model was never handed an invented evidence id (ledger resolve accepted E1)', !/never recorded in this run/.test(JSON.stringify(record.transcript ?? []))],
    ];
  },
  d2: ({ record, mockState }) => {
    const answer = record.answer ?? '';
    const sentBack = mockState.requests.some((r) => r.messages.some((m) => typeof m.content === 'string' && /calls the root cause \*\*confirmed\*\*, but this run's own record does not back that/.test(m.content)));
    return [
      ['an unearned "confirmed" was sent back to the model, naming what was missing', sentBack],
      ['the delivered report does not claim "confirmed"', !/### Root cause — confirmed/.test(answer)],
      ['no edit was made to justify the claim', callsOf(record, 'edit_file').length === 0],
      ['an honest "not found / probable" ending was accepted with zero edits (no forced edit)', /Root cause not found/.test(answer) && !/Harness note: zero file edits/.test(answer)],
    ];
  },
  d4: ({ record, mockState }) => {
    const toolTexts = mockState.requests.flatMap((r) => r.messages).filter((m) => m.role === 'tool').map((m) => String(m.content));
    return [
      ['a failing run_command was recorded as repro evidence and its id handed to the model', toolTexts.some((t) => /"evidence":\[\{"id":"E1","kind":"repro-fail"/.test(t))],
      ['the same command passing after the fix was recorded as repro-pass', toolTexts.some((t) => /"kind":"repro-pass"/.test(t))],
      ['the ledger shows the repro red then green', /red before the fix \(E1\); green after \(E2\)/.test(record.answer ?? '')],
    ];
  },
  d5: ({ record, mockState }) => {
    const answer = record.answer ?? '';
    const regressionBlock = mockState.requests.some((r) => r.messages.some((m) => typeof m.content === 'string' && m.content.includes('find the commit that broke it')));
    return [
      ['the prompt told the model to start from git history (the ticket says it worked before)', regressionBlock],
      ['git_log ran before the first edit', orderOf(record, 'git_log') >= 0 && orderOf(record, 'git_log') < orderOf(record, 'edit_file')],
      ['"confirmed" delivered clean, with the introducing commit named', /### Root cause — confirmed/.test(answer) && !/Harness note:/.test(answer) && /Introduced by `abc1234`/.test(answer)],
      ['the ledger shows the history was checked', /Regression: reported as working before — git history was checked/.test(answer)],
    ];
  },
  d6: ({ record, mockState }) => {
    const answer = record.answer ?? '';
    const held = mockState.requests.some((r) => r.messages.some((m) => typeof m.content === 'string' && /Debug mode — not edited yet:.*worked before.*git_log/s.test(m.content)));
    return [
      ['the first edit was held, and the message asked for the history', held],
      ['after git_log the same edit went through', callsOf(record, 'git_log').length === 1 && callsOf(record, 'edit_file').length === 1],
      ['no history-related Harness note on the delivered report', !/never checked/.test(answer)],
    ];
  },
  d3: ({ ws, record, mockState }) => {
    const cart = fs.readFileSync(path.join(ws, SEEDED.file), 'utf8');
    const heldMessage = mockState.requests.some((r) => r.messages.some((m) => typeof m.content === 'string' && /Debug mode — not edited yet: no observation yet/.test(m.content)));
    return [
      ['the first edit, made before any observation, was held: the model was told why and the file is untouched', heldMessage && callsOf(record, 'edit_file').length === 0 && cart.includes('items.length - 1')],
      ['a probe was added, its value reached the model, and it was removed', callsOf(record, 'add_probe').length === 1 && callsOf(record, 'remove_probes').length === 1 && leftoverProbes(ws).length === 0],
      ['the probe\'s printed values were recorded as evidence in the ledger', /\(probe\) probe p1 \(index visited\)/.test(record.answer ?? '') || /probe p1 \(index visited\)/.test(record.answer ?? '')],
      ['"probable" ending delivered as such', /### Root cause — probable/.test(record.answer ?? '')],
    ];
  },
};

// ── run ───────────────────────────────────────────────────────────────

const log = (s) => console.log(s);
const rows = [];
for (const id of ONLY) {
  const script = SCRIPTS[id];
  if (!script) { console.error(`no scenario ${id}`); process.exit(2); }
  const ws = makeWorkspace(FILES);
  const regression = id === 'd5' || id === 'd6';
  if (regression) {
    // A real history, so git_log has something to return.
    const g = (...a) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    g('add', '.'); g('commit', '-q', '-m', 'tighten cart loop bound');
  } else {
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  }
  const host = hostFor(ws, log);
  const mock = await startMockModel(script);
  log(`\n▶ ${id}`);
  const record = await runAgent(
    ws,
    PROMPT,
    log,
    {
      provider: 'Custom', baseUrl: mock.baseUrl, modelId: 'mock-model', apiKey: 'MOCK', apiKeys: ['MOCK'],
      harnessProfile: 'strong-model',
      ticketContext: regression ? REGRESSION_TICKET : TICKET, autonomous: true, debugMode: true,
      toolAvailability: { codebase: true, confluence: false, tickets: false, debug: true },
    },
    host.tools,
  );
  const checks = record.ok
    ? ORACLES[id]({ ws, record, mockState: mock.state, tools: host.tools })
    : [['agent completed', false, record.error]];
  await mock.close();
  const pass = checks.every((c) => c[1]);
  log(`   ${pass ? 'PASS' : 'FAIL'} · turns ${record.metrics?.turns ?? '—'} · calls ${record.metrics?.toolCallsExecuted ?? '—'}`);
  for (const [name, ok, detail] of checks) log(`     ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) log(`   answer: ${(record.answer ?? '').slice(0, 1500)}`);
  rows.push({ id, pass, checks: checks.map(([name, ok]) => ({ name, ok })) });
}

const resultsDir = path.join(here, '../../results');
fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, 'debug-evals.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
log(`\n${rows.filter((r) => r.pass).length}/${rows.length} passed`);
process.exit(rows.every((r) => r.pass) ? 0 : 1);
