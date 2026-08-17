#!/usr/bin/env node
/**
 * Phase 0.1 edit-format spike runner.
 *
 *   GEMINI_API_KEY=… node src/run.mjs                 # all models × formats × tasks
 *   node src/run.mjs --selftest                       # harness check, no API calls
 *   node src/run.mjs --models gemini-3.7-flash --tasks rename-fn,json-edit
 *
 * Models are OpenAI-compatible endpoints; add more via MODELS_JSON env
 * (same shape as DEFAULT_MODELS). Results → results/results.json + report.md.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formats, EvalError } from './formats.mjs';
import { tasks, loadFiles } from './tasks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_MODELS = [
  // keyEnv: null → local endpoint, no API key required (Ollama accepts any bearer)
  { name: 'qwen2.5-coder-14b', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:14b-ctx24k', keyEnv: null },
  { name: 'gemini-3.7-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.7-flash', keyEnv: 'GEMINI_API_KEY' },
  { name: 'gemini-3.1-pro-preview', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.1-pro-preview', keyEnv: 'GEMINI_API_KEY' },
  { name: 'claude-sonnet', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', keyEnv: 'ANTHROPIC_API_KEY' },
];

// ── prompt ──────────────────────────────────────────────────────────────────

function buildMessages(task, format) {
  const files = loadFiles(task.files);
  const fileSections = Object.entries(files)
    .map(([p, c]) => `### ${p}\n\`\`\`\n${c}\`\`\``)
    .join('\n\n');
  return [
    {
      role: 'system',
      content: `You are a precise code-editing engine. Apply the requested change to the given files.\n\n${format.instructions}\n\nOutput ONLY the edits in the format above — no explanations, no extra prose.`,
    },
    {
      role: 'user',
      content: `${task.instruction}\n\n${task.files.length ? `Current files:\n\n${fileSections}` : 'There are no existing files; you are creating new ones.'}`,
    },
  ];
}

// ── key rotation ─────────────────────────────────────────────────────────────
//
// Support "KEY1,KEY2,KEY3" in the env var so a rate-limited key doesn't stall
// the whole matrix. Rotation state persists per keyEnv across calls (module-
// level ring), same idea as this repo's apiKeyFailover.ts: on 429/5xx, hop to
// the next key immediately; only sleep once every key has been tried once in
// this attempt cycle.

const keyRings = new Map(); // keyEnv -> { keys: string[], idx: number }

function keyRing(keyEnv) {
  if (!keyRings.has(keyEnv)) {
    const keys = keyEnv
      ? (process.env[keyEnv] ?? '')
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean)
      : ['local']; // keyless endpoint (Ollama) — dummy bearer, ring of one
    keyRings.set(keyEnv, { keys, idx: 0 });
  }
  return keyRings.get(keyEnv);
}

function currentKey(keyEnv) {
  const ring = keyRing(keyEnv);
  return ring.keys[ring.idx % ring.keys.length];
}

function rotateKey(keyEnv) {
  const ring = keyRing(keyEnv);
  ring.idx++;
}

// ── model call (OpenAI-compatible) ──────────────────────────────────────────

async function callModel(m, messages) {
  const started = Date.now();
  const ring = keyRing(m.keyEnv);
  const maxCycles = 2;
  let lastError = null;
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    let rateLimitedThisCycle = false;
    for (let i = 0; i < ring.keys.length; i++) {
      const keyIdx = ring.idx % ring.keys.length;
      const res = await fetch(`${m.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${currentKey(m.keyEnv)}` },
        body: JSON.stringify({ model: m.model, temperature: 0, messages }),
      });
      if (res.status === 429 || res.status >= 500) {
        rateLimitedThisCycle = true;
        lastError = `key#${keyIdx} HTTP ${res.status}`;
        rotateKey(m.keyEnv); // try the next key right away, no wait
        continue;
      }
      // 401/403/404: key/project-level access problem (e.g. a free-tier key
      // without gemini-2.5-pro) — key-specific, so rotate past it too.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        lastError = `key#${keyIdx} HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`;
        console.log(`\n    [key#${keyIdx} can't serve ${m.model} (${res.status}) — rotating]`);
        rotateKey(m.keyEnv);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const json = await res.json();
      return {
        text: json.choices?.[0]?.message?.content ?? '',
        completionTokens: json.usage?.completion_tokens ?? null,
        ms: Date.now() - started,
      };
    }
    // every key in the ring failed this cycle — wait only if any were 429/5xx
    // (access errors won't heal with time, so don't sleep for those alone)
    if (rateLimitedThisCycle && cycle < maxCycles - 1) {
      await new Promise((r) => setTimeout(r, 20_000 * (cycle + 1)));
    } else if (!rateLimitedThisCycle) {
      break;
    }
  }
  throw new Error(`all ${ring.keys.length} key(s) for ${m.keyEnv} failed for ${m.model}; last: ${lastError}`);
}

// ── evaluation ──────────────────────────────────────────────────────────────

function evaluate(task, format, text) {
  const original = loadFiles(task.files);
  let edits, applied;
  try {
    edits = format.parse(text);
  } catch (e) {
    return { status: 'parse_fail', detail: e.message };
  }
  try {
    applied = format.apply(edits, original);
  } catch (e) {
    return { status: e instanceof EvalError ? 'apply_fail' : 'harness_error', detail: e.message };
  }
  const failed = task.checks.filter((c) => !c.fn(applied)).map((c) => c.desc);
  return failed.length ? { status: 'check_fail', detail: failed.join('; ') } : { status: 'pass' };
}

// ── selftest: canned model outputs prove the harness itself works ───────────

function selftest() {
  const cases = [
    {
      format: 'search-replace',
      task: tasks.find((t) => t.id === 'json-edit'),
      output: `apps/vscode-extensions/package.json\n<<<<<<< SEARCH\n  "scripts": {\n=======\n  "scripts": {\n    "eval": "node ../../packages/agent-evals/src/run.mjs",\n>>>>>>> REPLACE`,
    },
    {
      format: 'unified-diff',
      task: tasks.find((t) => t.id === 'css-append'),
      output: (() => {
        const css = loadFiles(['App.css'])['apps/vscode-extensions/webview/src/App.css'];
        const tail = css.split('\n').slice(-4).filter((l) => l !== '');
        const ctx = tail.map((l) => ` ${l}`).join('\n');
        return '```diff\n--- a/apps/vscode-extensions/webview/src/App.css\n+++ b/apps/vscode-extensions/webview/src/App.css\n@@ -1,1 +1,1 @@\n' + ctx + '\n+\n+.agent-panel {\n+  display: flex;\n+  flex-direction: column;\n+  gap: 8px;\n+}\n```';
      })(),
    },
    {
      format: 'full-file',
      task: tasks.find((t) => t.id === 'create-file'),
      output: "apps/vscode-extensions/src/utils/keyMask.ts\n```\n/** Mask an API key for display. */\nexport function maskKey(key: string): string {\n  if (key.length <= 8) return '••••';\n  return key.slice(0, 4) + '…' + key.slice(-2);\n}\n```",
    },
    // negative: ambiguous search must be rejected, not silently applied
    {
      format: 'search-replace',
      task: tasks.find((t) => t.id === 'ambiguous-target'),
      output: `apps/vscode-extensions/src/utils/getLlmSettings.ts\n<<<<<<< SEARCH\n    apiKey: apiKeys[0] || undefined,\n=======\n    apiKey: apiKeys.at(0),\n>>>>>>> REPLACE`,
      expect: 'apply_fail',
    },
  ];
  let ok = true;
  for (const c of cases) {
    const r = evaluate(c.task, formats[c.format], c.output);
    const want = c.expect ?? 'pass';
    const good = r.status === want;
    ok &&= good;
    console.log(`${good ? '✅' : '❌'} selftest ${c.format} × ${c.task.id}: ${r.status}${r.detail ? ` (${r.detail})` : ''} — expected ${want}`);
  }
  process.exit(ok ? 0 : 1);
}

// ── main ────────────────────────────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

if (process.argv.includes('--selftest')) selftest();

const modelList = (process.env.MODELS_JSON ? JSON.parse(process.env.MODELS_JSON) : DEFAULT_MODELS)
  .filter((m) => !m.keyEnv || process.env[m.keyEnv])
  .filter((m) => !arg('models') || arg('models').split(',').includes(m.name));
const taskList = tasks.filter((t) => !arg('tasks') || arg('tasks').split(',').includes(t.id));
const formatList = Object.values(formats).filter((f) => !arg('formats') || arg('formats').split(',').includes(f.id));

if (modelList.length === 0) {
  console.error('No models runnable: set GEMINI_API_KEY (and/or ANTHROPIC_API_KEY), or MODELS_JSON.');
  process.exit(1);
}

const results = [];
for (const m of modelList) {
  for (const f of formatList) {
    for (const t of taskList) {
      process.stdout.write(`${m.name} × ${f.id} × ${t.id} … `);
      try {
        const { text, completionTokens, ms } = await callModel(m, buildMessages(t, f));
        const r = evaluate(t, f, text);
        results.push({ model: m.name, format: f.id, task: t.id, ...r, completionTokens, ms });
        console.log(`${r.status}${r.detail ? ` (${r.detail.slice(0, 80)})` : ''} [${completionTokens ?? '?'} tok, ${ms}ms]`);
      } catch (e) {
        results.push({ model: m.name, format: f.id, task: t.id, status: 'call_fail', detail: String(e).slice(0, 200) });
        console.log(`call_fail (${String(e).slice(0, 80)})`);
      }
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────
//
// Merge with any existing results.json: a re-run of a subset (or a crashed
// run) replaces only the cells it actually ran, keeping earlier passes.

mkdirSync(join(ROOT, 'results'), { recursive: true });
const resultsPath = join(ROOT, 'results', 'results.json');
let merged = results;
if (existsSync(resultsPath)) {
  const prior = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const ranKey = new Set(results.map((r) => `${r.model}|${r.format}|${r.task}`));
  merged = [...prior.filter((r) => !ranKey.has(`${r.model}|${r.format}|${r.task}`)), ...results];
}
writeFileSync(resultsPath, JSON.stringify(merged, null, 2));

const reportModels = [...new Set(merged.map((r) => r.model))];
const reportFormats = [...new Set(merged.map((r) => r.format))];
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');
let md = `# Edit-format spike results\n\n| model | format | pass | apply-ok | avg tokens | avg ms |\n|---|---|---|---|---|---|\n`;
for (const mName of reportModels) {
  for (const fId of reportFormats) {
    const rs = merged.filter((r) => r.model === mName && r.format === fId);
    const pass = rs.filter((r) => r.status === 'pass').length;
    const applied = rs.filter((r) => r.status === 'pass' || r.status === 'check_fail').length;
    const toks = rs.filter((r) => r.completionTokens);
    const avg = (xs, k) => (xs.length ? Math.round(xs.reduce((a, r) => a + r[k], 0) / xs.length) : '—');
    md += `| ${mName} | ${fId} | ${pct(pass, rs.length)} | ${pct(applied, rs.length)} | ${avg(toks, 'completionTokens')} | ${avg(toks, 'ms')} |\n`;
  }
}
md += `\n## Failures\n\n`;
for (const r of merged.filter((r) => r.status !== 'pass')) {
  md += `- **${r.model} × ${r.format} × ${r.task}** — ${r.status}: ${r.detail}\n`;
}
writeFileSync(join(ROOT, 'results', 'report.md'), md);
console.log(`\nWrote results/results.json and results/report.md`);
