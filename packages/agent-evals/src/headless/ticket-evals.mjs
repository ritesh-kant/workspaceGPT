/**
 * P7 — the ticket eval. Runs ticket-shaped tasks end-to-end through the REAL
 * model worker and scores them against behavioural oracles, under each
 * harness profile.
 *
 * Why it exists: P1-P6 changed how the loop paces itself, when it delegates,
 * what it reads, which gates fire and what it is allowed to claim — and every
 * one of those was calibrated against a single saved transcript (#1534774).
 * Unit tests pin the mechanisms in isolation; this is the only thing that
 * shows them working, or not, inside the real loop.
 *
 * Two modes, because they answer different questions:
 *
 *   --mock   (default) drives the loop against a scripted model. Deterministic,
 *            free, no API key. It cannot tell you whether a real model behaves
 *            better; it tells you whether the HARNESS MECHANISMS fire — the
 *            commit nudge reaching the model, `explore` really running a
 *            sub-loop, a numbered read surviving the round trip into
 *            edit_file, the honesty stamp landing on a fabricated report.
 *   --live   drives it against a real model and scores the P7 metric targets.
 *            Needs a key (WGPT_BENCH_API_KEY / .env, same as agent-smoke).
 *
 * Run: node src/headless/ticket-evals.mjs [--mock|--live] [--scenarios t1,t2]
 *      [--profiles strong-model,small-model] [--runs 1] [--timeout-min 10]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { runAgent } from './agent-smoke.mjs';
import { startMockModel } from './mock-model.mjs';
import { TICKET_SCENARIOS } from './ticket-fixtures.mjs';
import { MOCK_SCRIPTS } from './ticket-mock-scripts.mjs';

const pexecFile = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const resultsDir = path.join(here, '../../results');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

const LIVE = has('live');
const ONLY = argOf('scenarios', 't1,t2,t3,f1').split(',');
const PROFILES = argOf('profiles', 'strong-model,small-model').split(',');
const RUNS = Number(argOf('runs', '1'));

const runCmd = (cmd, cwd) =>
  pexecFile('/bin/bash', ['-lc', cmd], { cwd }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e) => ({ code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }),
  );

const makeWorkspace = (files) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-ticket-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return ws;
};

/** The seeded prompt a click-to-run ticket turn uses in the product. */
const promptFor = (t) =>
  `Work on ticket ${t.id} (${t.title}) autonomously — read the ticket and any design doc behind it, ` +
  `find the code it affects, implement the fix, verify with diagnostics and the relevant tests, and report ` +
  `the result against each acceptance criterion. If, after reading the ticket, the docs, and the code, a ` +
  `decision the ticket should have made is genuinely missing, stop and report exactly what's unclear instead of guessing.`;

// ── P7 metrics ─────────────────────────────────────────────────────────
// Every one is derived from the worker's own metrics or its message stream —
// nothing is inferred from the answer prose except the two facts that only
// live there (the status heading, and whether the harness stamped it).

const WRITE_TOOLS = new Set(['edit_file', 'create_file', 'delete_file']);
const NARRATION_RE =
  /\b(root cause (is|was|lies|sits|turns out)|the fix (needs to|is to|would be|should|must)|key insight|complete understanding|now i (fully |finally )?understand (the )?(root cause|bug|problem|issue|why)|now i (can )?see the (full|whole|complete|entire) (picture|flow|chain)|the (bug|problem|issue) is (that|in|the))\b/i;

function metricsFor(record) {
  const m = record.metrics ?? {};
  const calls = record.toolCalls ?? [];
  const firstWriteAt = calls.findIndex((c) => WRITE_TOOLS.has(c.name));
  const narration = (record.noteLog ?? []).find((n) => NARRATION_RE.test(n.content));
  const answer = record.answer ?? '';
  const writes = m.writesApplied ?? 0;

  return {
    profile: m.harnessProfile ?? null,
    turns: m.turns ?? null,
    toolCalls: m.toolCallsExecuted ?? calls.length,
    writes,
    // Tool CALLS, not turns: a turn can carry several calls, and calls are the
    // unit both numbers are measured in here. Named for what it is.
    callsFromNarrationToFirstEdit:
      narration && firstWriteAt >= 0 ? Math.max(0, firstWriteAt - narration.at) : null,
    narrated: !!narration,
    blocked: /^\s*#{1,4}\s*[^\n]*blocked/im.test(answer),
    noChangeNeeded: /^\s*#{1,4}\s*[^\n]*no change (is )?needed/im.test(answer),
    claimsDone: /^##\s*[^\n]*\b(done|fixed|implemented|complete)\b/im.test(answer),
    harnessStamped: /Harness note:/.test(answer),
    // The failure that must never happen: a completion claim with nothing on
    // disk AND no stamp telling the reader so.
    fabricated:
      writes === 0 &&
      /^##\s*[^\n]*\b(done|fixed|implemented|complete)\b/im.test(answer) &&
      !/Harness note:/.test(answer),
    toolChars: m.toolCharsUsed ?? null,
    exploreCalls: m.exploreCalls ?? 0,
    budgetExhausted: !!m.budgetExhausted,
    iterationCap: m.iterationCap ?? null,
    nudges: m.nudges ?? {},
    wallMs: m.wallMs ?? null,
  };
}

// ── mechanism assertions ───────────────────────────────────────────────

const textOf = (messages) =>
  messages.map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))).join('\n');

function mechanismChecks(sc, profile, state, record) {
  const out = [];
  const mainReqs = state.requests.filter((r) => !r.subAgent && !r.preloopExplorer);
  const subReqs = state.requests.filter((r) => r.subAgent);
  const mainText = textOf(mainReqs.flatMap((r) => r.messages));

  // P5 — the profile actually changes what the model is sent.
  const weakClause = 'never claim edit_file/create_file is';
  out.push([
    `P5: ${profile} prompt ${profile === 'small-model' ? 'carries' : 'omits'} the weak-model scaffolding`,
    profile === 'small-model' ? mainText.includes(weakClause) : !mainText.includes(weakClause),
  ]);
  out.push(['P1: the operating norms reached the model', mainText.includes('## HOW TO WORK')]);

  if (sc.id === 't1') {
    // P3 — a real sub-loop ran, it was offered no write tool, and what came
    // back to the caller was findings rather than file contents.
    out.push(['P3: explore ran a sub-loop with its own turns', subReqs.length >= 2]);
    // Named tools, not a count: the read-only guarantee is about WHICH tools
    // the sub-agent could reach, and a count would pass even if edit_file
    // were among them.
    const writeTools = ['edit_file', 'create_file', 'delete_file', 'run_command', 'run_checks'];
    const offendingTool = subReqs
      .flatMap((r) => r.toolNames ?? [])
      .find((n) => writeTools.includes(n));
    out.push([
      'P3: the sub-agent was offered no write or command tool',
      subReqs.length > 0 && !offendingTool,
      offendingTool ? `saw ${offendingTool}` : undefined,
    ]);
    const exploreResult = /"findings":"([^"]{0,4000})"/.exec(mainText);
    out.push([
      'P3: the caller received findings, not file contents',
      !!exploreResult && exploreResult[1].length < 2000,
      exploreResult ? `${exploreResult[1].length} chars` : 'no findings payload found',
    ]);
    // P2 — the commit nudge reached the model after the narration.
    out.push([
      'P2: the commit nudge was delivered',
      /Checkpoint from the harness: \d+ tool turn\(s\) left/.test(mainText),
    ]);
    // P4 — a prefixed oldString was absorbed rather than rejected.
    out.push([
      'P4: numbered oldString applied (stripper fired)',
      (record.audit ?? []).some((a) => /line-number prefixes/.test(a.detail ?? '')),
    ]);
  }
  return out;
}

// ── run one (scenario × profile) ───────────────────────────────────────

const log = (s) => console.log(s);

async function runOne(sc, profile, runIndex) {
  const ws = makeWorkspace(sc.files);
  let mock = null;
  let extra = {
    ticketContext: sc.ticket,
    autonomous: true,
    harnessProfile: profile,
  };

  if (!LIVE) {
    const script = MOCK_SCRIPTS[sc.id];
    if (!script) throw new Error(`no mock script for ${sc.id} — add one or run --live`);
    mock = await startMockModel(script);
    extra = {
      ...extra,
      provider: 'Custom',
      baseUrl: mock.baseUrl,
      modelId: 'mock-model',
      apiKey: 'MOCK',
      apiKeys: ['MOCK'],
    };
  }

  log(`\n▶ ${sc.id} · ${profile} · run ${runIndex} — ${sc.title}`);
  const record = await runAgent(ws, promptFor(sc.ticket), (s) => log(s), extra);
  const met = metricsFor(record);
  const checks = record.ok
    ? await sc.oracle({ ws, record, runCmd, metrics: met })
    : [['agent completed', false, record.error]];
  if (mock) await mock.close();

  // Mechanism checks (mock mode only): assert from what the model ACTUALLY
  // RECEIVED, not from whether the run happened to pass. A mechanism that
  // silently stopped working would still let a scripted run succeed.
  if (mock) checks.push(...mechanismChecks(sc, profile, mock.state, record));

  const pass = checks.every((c) => c[1]);
  log(
    `   ${pass ? 'PASS' : 'FAIL'} · writes ${met.writes} · turns ${met.turns} · calls ${met.toolCalls} · ` +
      `explore ${met.exploreCalls} · toolChars ${met.toolChars}`,
  );
  for (const [name, ok, detail] of checks) log(`     ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);

  return {
    scenario: sc.id,
    title: sc.title,
    profile,
    runIndex,
    mode: LIVE ? 'live' : 'mock',
    pass,
    checks: checks.map(([name, ok, detail]) => ({ name, ok, detail: detail ?? null })),
    metrics: met,
    mockRequests: mock ? mock.state.requests.length : null,
    error: record.ok ? null : record.error,
    answer: (record.answer ?? '').slice(0, 4000),
    workspace: ws,
  };
}

// ── main ───────────────────────────────────────────────────────────────

const selected = TICKET_SCENARIOS.filter((s) => ONLY.includes(s.id));
if (!selected.length) {
  console.error(`no scenarios matched ${ONLY.join(',')} — available: ${TICKET_SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(2);
}

log(`ticket-evals: mode=${LIVE ? 'live' : 'mock (scripted model)'} scenarios=${selected.map((s) => s.id).join(',')} profiles=${PROFILES.join(',')} runs=${RUNS}`);

const rows = [];
for (let runIndex = 1; runIndex <= RUNS; runIndex++) {
  for (const sc of selected) {
    for (const profile of PROFILES) {
      try {
        rows.push(await runOne(sc, profile, runIndex));
      } catch (e) {
        log(`   ERROR ${sc.id}/${profile}: ${e.message}`);
        rows.push({
          scenario: sc.id, profile, runIndex, mode: LIVE ? 'live' : 'mock',
          pass: false, checks: [], metrics: {}, error: e.message,
        });
      }
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────

fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, 'ticket-evals.json'), JSON.stringify({ generatedAt: new Date().toISOString(), mode: LIVE ? 'live' : 'mock', rows }, null, 2));

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const agg = (rs, f) => rs.map(f).filter((v) => typeof v === 'number');
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

let md = `# Ticket evals (P7)\n\nGenerated ${new Date().toISOString()} · mode **${LIVE ? 'live' : 'mock (scripted model)'}**\n\n`;
if (!LIVE) {
  md += `> Scripted-model run. This validates that the harness MECHANISMS fire inside the real\n` +
        `> worker — it says nothing about whether a real model behaves better. For that, run\n` +
        `> \`--live\` with an API key.\n\n`;
}

md += `## Per run\n\n| scenario | profile | pass | writes | turns | calls | narration→edit | explore | toolChars | blocked | stamped |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  const m = r.metrics ?? {};
  md += `| ${r.scenario} | ${r.profile} | ${r.pass ? '✅' : '❌'} | ${m.writes ?? '—'} | ${m.turns ?? '—'} | ${m.toolCalls ?? '—'} | ${m.callsFromNarrationToFirstEdit ?? '—'} | ${m.exploreCalls ?? '—'} | ${m.toolChars ?? '—'} | ${m.blocked ? 'yes' : 'no'} | ${m.harnessStamped ? 'yes' : 'no'} |\n`;
}

md += `\n## P7 targets\n\n| metric | target | result |\n|---|---|---|\n`;
const fixRows = rows.filter((r) => r.scenario === 't1');
const wrote = fixRows.filter((r) => (r.metrics?.writes ?? 0) > 0).length;
md += `| runs with ≥1 write (fix scenarios) | ≥ 90% | ${pct(wrote, fixRows.length)} (${wrote}/${fixRows.length}) |\n`;
const gaps = agg(rows, (r) => r.metrics?.callsFromNarrationToFirstEdit);
// In mock mode this measures the SCRIPT, not a model's judgement: the scripted
// narration turn deliberately batches reads, so the gap is whatever the script
// puts between them. Only the live number means anything, and saying so is
// cheaper than letting a fixture artefact read as a regression.
md += `| tool calls from root cause to first edit | ≤ 2 | ${gaps.length ? median(gaps) : 'not observed'}${LIVE ? '' : ' — *script-determined in mock mode; not a model measurement*'} |\n`;
const blocked = rows.filter((r) => r.metrics?.blocked).length;
const blockedOutsideT3 = rows.filter((r) => r.metrics?.blocked && r.scenario !== 't3').length;
md += `| "Blocked" endings outside the contradictory ticket | 0 | ${blockedOutsideT3} (of ${blocked} total blocked) |\n`;
const fab = rows.filter((r) => r.metrics?.fabricated).length;
md += `| fabricated completion claims | 0 | ${fab} |\n`;
const chars = agg(rows, (r) => r.metrics?.toolChars);
md += `| median tool chars per run | lower is better | ${chars.length ? median(chars) : '—'} |\n`;

md += `\n## Failures\n\n`;
const failures = rows.filter((r) => !r.pass);
md += failures.length
  ? failures.map((r) => `- **${r.scenario} / ${r.profile}** — ${r.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || r.error}\n`).join('')
  : `None.\n`;

fs.writeFileSync(path.join(resultsDir, 'ticket-evals.md'), md);
log(`\nreport → results/ticket-evals.json, results/ticket-evals.md`);
log(`${rows.filter((r) => r.pass).length}/${rows.length} passed`);
process.exit(rows.every((r) => r.pass) ? 0 : 1);
