/**
 * Integration test for the metered proxy — the admit → proxy → meter flow in
 * src/chat.ts, driven through the Worker's real `fetch` export (src/index.ts).
 *
 * The pure arithmetic is covered by test/run.mjs. What THIS file exercises is
 * the wiring that file cannot: the request body is parsed and forwarded with
 * `stream_options.include_usage` forced on, the upstream body is `tee()`d so
 * the client's copy is byte-identical, the metering branch runs under
 * `ctx.waitUntil` and its charge lands in D1 through the exact SQL in
 * src/usage.ts, and the next request's admission sees it.
 *
 * No Cloudflare runtime is needed:
 *   · D1  → node:sqlite (in-memory), with the real migrations applied
 *   · KV  → a Map
 *   · ExecutionContext → collects waitUntil promises so the test can await them
 *   · upstream → `globalThis.fetch` replaced per test with a scripted Response
 *
 * Run: node test/proxy.mjs   (or `pnpm test`, which runs both files)
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const require = createRequire(path.join(pkgRoot, '../vscode-extensions/package.json'));
const esbuild = require('esbuild');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-api-proxy-test-'));
await esbuild.build({
  entryPoints: [path.join(pkgRoot, 'src/index.ts')],
  outfile: path.join(outDir, 'worker.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'silent',
});
const worker = (await import(path.join(outDir, 'worker.mjs'))).default;

// ── Cloudflare binding shims ─────────────────────────────────────────────────

/** Enough of the D1 API for src/*.ts: prepare().bind().first()/run()/all() and batch(). */
function makeD1(db) {
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true };
    },
    _exec: () => {
      const stmt = db.prepare(sql);
      // SELECTs return rows; writes return nothing — mirror D1's `results`.
      return /^\s*(select|with)/i.test(sql) ? stmt.all(...params) : (stmt.run(...params), []);
    },
  });
  return {
    prepare: (sql) => wrap(sql),
    batch: async (stmts) => stmts.map((s) => ({ results: s._exec(), success: true })),
  };
}

function makeKV() {
  const store = new Map();
  return {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
  };
}

function makeCtx() {
  const pending = [];
  return {
    waitUntil: (p) => void pending.push(p),
    passThroughOnException: () => {},
    /** Await everything the handler deferred — the metering branch lives here. */
    settle: () => Promise.all(pending.splice(0)),
  };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = path.join(pkgRoot, 'migrations');
  for (const file of fs.readdirSync(dir).sort()) db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  return db;
}

const USER_ID = '4242';
const TOKEN = 'sess_test_token';

function makeEnv(db, overrides = {}) {
  const SESSIONS = makeKV();
  return {
    SESSIONS,
    DB: makeD1(db),
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
    OPENROUTER_API_KEY: 'sk-or-test-vendor-key',
    INFERENCE_PROVIDER: 'openrouter',
    OPENROUTER_MODEL: 'test/upstream-model',
    PLAN_WEEKLY_CREDITS: JSON.stringify({ free: 100, pro: 1000 }),
    WEEKLY_CREDIT_LIMIT: '100',
    TOKENS_PER_CREDIT: '1000',
    ...overrides,
  };
}

async function seedAccount(db, env, { plan = 'free' } = {}) {
  db.prepare(
    `INSERT INTO users (id, login, created_at, github_created_at, plan, status) VALUES (?, 'tester', ?, '2020-01-01T00:00:00Z', ?, 'active')`
  ).run(USER_ID, Date.now(), plan);
  await env.SESSIONS.put(`session:${TOKEN}`, JSON.stringify({ userId: USER_ID, login: 'tester', email: null }));
}

// ── Upstream scripting ───────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
/** Replace fetch with a script; returns the recorded upstream calls. */
function scriptUpstream(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), headers: init.headers, body });
    return respond(body);
  };
  return calls;
}

/** SSE bytes exactly as a vendor emits them: deltas, then a usage-only chunk, then [DONE]. */
function sseBody(deltas, usage) {
  const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
  let text = '';
  for (const d of deltas) text += chunk({ id: 'c1', choices: [{ index: 0, delta: { content: d } }], usage: null });
  if (usage) text += chunk({ id: 'c1', choices: [], usage });
  text += 'data: [DONE]\n\n';
  return text;
}

/** Deliver `text` in several separately-enqueued chunks, so tee() sees a real stream. */
function streamOf(text, pieces = 4) {
  const enc = new TextEncoder();
  const size = Math.ceil(text.length / pieces);
  return new ReadableStream({
    async start(controller) {
      for (let i = 0; i < text.length; i += size) {
        controller.enqueue(enc.encode(text.slice(i, i + size)));
        await new Promise((r) => setTimeout(r, 1));
      }
      controller.close();
    },
  });
}

function sseResponse(text, status = 200) {
  return new Response(streamOf(text), { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function chatRequest(body, token = TOKEN) {
  return new Request('https://api.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function meRequest() {
  return new Request('https://api.test/v1/me', { headers: { Authorization: `Bearer ${TOKEN}` } });
}

const PROMPT = {
  model: 'client-says-whatever',
  stream: true,
  messages: [{ role: 'user', content: 'hello' }],
  tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
  provider: { order: ['smuggled'] },
};

function weeklyRow(db) {
  return db.prepare('SELECT requests, credits, tokens FROM usage_weekly WHERE user_id = ?').get(USER_ID) ?? null;
}
function eventRows(db) {
  return db.prepare('SELECT ts, credits, tokens FROM usage_events WHERE user_id = ? ORDER BY ts').all(USER_ID);
}

// ── Harness ──────────────────────────────────────────────────────────────────

let pass = 0;
const failures = [];
const quiet = { warn: console.warn, error: console.error };
async function t(name, fn) {
  const db = freshDb();
  const env = makeEnv(db);
  await seedAccount(db, env);
  const ctx = makeCtx();
  const logs = { warn: [], error: [] };
  console.warn = (...a) => logs.warn.push(a);
  console.error = (...a) => logs.error.push(a);
  try {
    await fn({ db, env, ctx, logs });
    pass++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log(`  FAIL  ${name}\n        ${e.stack.split('\n').slice(0, 3).join('\n        ')}`);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = quiet.warn;
    console.error = quiet.error;
  }
}

console.log('streamed request — admit → proxy → meter');
await t('forwards an allowlisted body with include_usage forced on and the model overridden', async ({ env, ctx }) => {
  const calls = scriptUpstream(() => sseResponse(sseBody(['hi'], { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })));
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.headers.Authorization, 'Bearer sk-or-test-vendor-key');
  assert.equal(sent.body.model, 'test/upstream-model', 'client model replaced by the configured one');
  assert.deepEqual(sent.body.stream_options, { include_usage: true });
  assert.deepEqual(sent.body.tools, PROMPT.tools, 'tools reach the vendor — the agent loop depends on it');
  assert.equal(sent.body.provider, undefined, 'non-allowlisted routing knobs are dropped');
  await res.text();
  await ctx.settle();
});

await t('client receives the upstream SSE bytes unchanged while the tee meters the same body', async ({ db, env, ctx }) => {
  const upstreamText = sseBody(['Hel', 'lo', ' world'], { prompt_tokens: 1200, completion_tokens: 900, total_tokens: 2100 });
  scriptUpstream(() => sseResponse(upstreamText));
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.headers.get('Content-Type'), 'text/event-stream');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(await res.text(), upstreamText, 'byte-identical passthrough');
  assert.equal(weeklyRow(db), null, 'nothing charged until the metering branch has run');
  await ctx.settle();
  assert.deepEqual(weeklyRow(db), { requests: 1, credits: 3, tokens: 2100 }, 'ceil(2100/1000) = 3 credits');
  assert.equal(eventRows(db).length, 1);
  assert.deepEqual(eventRows(db)[0].credits, 3);
});

await t('metering completes even if the client never reads its copy', async ({ db, env, ctx }) => {
  scriptUpstream(() => sseResponse(sseBody(['x'], { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 })));
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  await res.body.cancel(); // client disconnected mid-stream
  await ctx.settle();
  assert.deepEqual(weeklyRow(db), { requests: 1, credits: 1, tokens: 600 });
});

await t('the second request is admitted against the first request\'s charge and the headers show it', async ({ env, ctx }) => {
  scriptUpstream(() => sseResponse(sseBody(['a'], { prompt_tokens: 4000, completion_tokens: 1000, total_tokens: 5000 })));
  const first = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(first.headers.get('X-WorkspaceGPT-Credits-Used'), '0', 'headers reflect usage BEFORE this request');
  assert.equal(first.headers.get('X-WorkspaceGPT-Credits-Limit'), '100');
  assert.equal(first.headers.get('X-WorkspaceGPT-Window-Limit'), '20', 'window derives as weekly / 5');
  assert.equal(first.headers.get('X-WorkspaceGPT-Window-Seconds'), String(5 * 3600));
  await first.text();
  await ctx.settle();

  const second = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(second.headers.get('X-WorkspaceGPT-Credits-Used'), '5');
  assert.equal(second.headers.get('X-WorkspaceGPT-Window-Used'), '5');
  await second.text();
  await ctx.settle();

  const me = await (await worker.fetch(meRequest(), env, ctx)).json();
  assert.equal(me.credits_used_this_week, 10);
  assert.equal(me.credits_limit_weekly, 100);
  assert.equal(me.credits_used_window, 10);
  assert.equal(me.credits_limit_window, 20);
  assert.equal(me.tokens_per_credit, 1000);
  assert.equal(me.requests_used_this_week, 10, 'request-era name carries the credit number for one release');
});

console.log('non-streamed and degraded upstream responses');
await t('a JSON (non-stream) completion is charged from usage.total_tokens and stream_options is left alone', async ({ db, env, ctx }) => {
  const calls = scriptUpstream(() =>
    new Response(
      JSON.stringify({ id: 'c1', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 2900, total_tokens: 3000 } }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  );
  const res = await worker.fetch(chatRequest({ ...PROMPT, stream: false }), env, ctx);
  assert.equal(calls[0].body.stream_options, undefined);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'ok');
  await ctx.settle();
  assert.deepEqual(weeklyRow(db), { requests: 1, credits: 3, tokens: 3000 });
});

await t('a stream with no usage chunk charges the estimated prompt size and warns', async ({ db, env, ctx, logs }) => {
  scriptUpstream(() => sseResponse(sseBody(['no usage here'], null)));
  const req = chatRequest(PROMPT);
  const requestChars = JSON.stringify(PROMPT).length;
  const res = await worker.fetch(req, env, ctx);
  await res.text();
  await ctx.settle();
  const row = weeklyRow(db);
  assert.ok(row, 'still charged something');
  assert.equal(row.tokens, Math.ceil(requestChars / 4), 'chars / 4 estimate of what we sent');
  assert.equal(row.credits, 1);
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0][0], /no usage/);
});

await t('a vendor 5xx passes through with its status and is not charged', async ({ db, env, ctx }) => {
  scriptUpstream(() => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.message, 'overloaded');
  await ctx.settle();
  assert.equal(weeklyRow(db), null);
  assert.equal(eventRows(db).length, 0);
});

await t('a vendor 429 passes through unmetered so the client SDK can back off', async ({ db, env, ctx }) => {
  scriptUpstream(() => new Response('rate limited', { status: 429, headers: { 'Retry-After': '3' } }));
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.status, 429);
  await ctx.settle();
  assert.equal(weeklyRow(db), null);
});

await t('a vendor 401 becomes our 502, never a "sign in again" on the client', async ({ db, env, ctx, logs }) => {
  scriptUpstream(() => new Response('bad key', { status: 401 }));
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.type, 'upstream_auth_failed');
  assert.equal(logs.error.length, 1);
  assert.equal(weeklyRow(db), null);
});

await t('an unreachable vendor is a 502 with nothing charged', async ({ db, env, ctx }) => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.type, 'upstream_unreachable');
  assert.equal(weeklyRow(db), null);
});

console.log('admission');
await t('weekly allowance exhausted → 429 weekly_limit_reached, vendor never called', async ({ db, env, ctx }) => {
  const calls = scriptUpstream(() => sseResponse(sseBody(['x'], { total_tokens: 1 })));
  // Seed exactly at the limit through the real charge path.
  const { chargeCredits } = await bundleUsage();
  await chargeCredits(env, USER_ID, { credits: 100, tokens: 100_000 });
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.type, 'weekly_limit_reached');
  assert.match(body.error.message, /week/i);
  assert.ok(Number(res.headers.get('Retry-After')) > 0, 'Retry-After is set');
  assert.ok(Number(res.headers.get('Retry-After')) <= 7 * 86400);
  assert.equal(res.headers.get('X-WorkspaceGPT-Credits-Used'), '100');
  assert.equal(calls.length, 0);
  assert.deepEqual(weeklyRow(db), { requests: 1, credits: 100, tokens: 100_000 }, 'a refusal is not charged');
});

await t('rolling-window allowance exhausted → 429 window_limit_reached with a short Retry-After', async ({ env, ctx }) => {
  const calls = scriptUpstream(() => sseResponse(sseBody(['x'], { total_tokens: 1 })));
  const { chargeCredits } = await bundleUsage();
  const now = Math.floor(Date.now() / 1000);
  // 20 window credits (100/5); spend them 4 hours ago → frees in ~1 hour.
  await chargeCredits(env, USER_ID, { credits: 20, tokens: 20_000 }, now - 4 * 3600);
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.type, 'window_limit_reached');
  const retry = Number(res.headers.get('Retry-After'));
  assert.ok(retry > 3000 && retry <= 3660, `Retry-After ≈ 1h, got ${retry}s`);
  assert.equal(calls.length, 0);
});

await t('window charges older than five hours no longer count', async ({ env, ctx }) => {
  const calls = scriptUpstream(() => sseResponse(sseBody(['x'], { total_tokens: 1000 })));
  const { chargeCredits } = await bundleUsage();
  const now = Math.floor(Date.now() / 1000);
  await chargeCredits(env, USER_ID, { credits: 20, tokens: 20_000 }, now - 6 * 3600);
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.status, 200, 'window is clear again');
  assert.equal(res.headers.get('X-WorkspaceGPT-Window-Used'), '0');
  assert.equal(res.headers.get('X-WorkspaceGPT-Credits-Used'), '20', 'but the week still remembers');
  assert.equal(calls.length, 1);
  await res.text();
  await ctx.settle();
});

await t('a per-user weekly_credit_limit override beats the plan', async ({ db, env, ctx }) => {
  db.prepare('UPDATE users SET weekly_credit_limit = 3 WHERE id = ?').run(USER_ID);
  const calls = scriptUpstream(() => sseResponse(sseBody(['x'], { total_tokens: 2500 })));
  const first = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(first.headers.get('X-WorkspaceGPT-Credits-Limit'), '3');
  await first.text();
  await ctx.settle();
  const second = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(second.status, 429, '3 credits spent of 3');
  assert.equal(calls.length, 1);
});

await t('an app_config row overrides the wrangler var without a redeploy', async ({ db, env, ctx }) => {
  db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('plan_weekly_credits', '{\"free\":7}', 0)").run();
  db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('tokens_per_credit', '100', 0)").run();
  scriptUpstream(() => sseResponse(sseBody(['x'], { total_tokens: 250 })));
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.headers.get('X-WorkspaceGPT-Credits-Limit'), '7');
  await res.text();
  await ctx.settle();
  assert.equal(weeklyRow(db).credits, 3, 'ceil(250/100) under the overridden divisor');
});

console.log('gates before admission');
await t('no or unknown session → 401 not_signed_in', async ({ env, ctx }) => {
  const calls = scriptUpstream(() => sseResponse(''));
  for (const token of [null, 'nope']) {
    const res = await worker.fetch(chatRequest(PROMPT, token), env, ctx);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.type, 'not_signed_in');
  }
  assert.equal(calls.length, 0);
});

await t('suspended account → 403', async ({ db, env, ctx }) => {
  db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(USER_ID);
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.status, 403);
});

await t('missing vendor key → 500 server_misconfigured, nothing charged', async ({ db, env, ctx, logs }) => {
  delete env.OPENROUTER_API_KEY;
  const res = await worker.fetch(chatRequest(PROMPT), env, ctx);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.type, 'server_misconfigured');
  assert.equal(logs.error.length, 1);
  assert.equal(weeklyRow(db), null);
});

await t('malformed body → 400 before anything is forwarded', async ({ env, ctx }) => {
  const calls = scriptUpstream(() => sseResponse(''));
  const bad = new Request('https://api.test/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: '{not json',
  });
  assert.equal((await worker.fetch(bad, env, ctx)).status, 400);
  assert.equal((await worker.fetch(chatRequest({ messages: [] }), env, ctx)).status, 400);
  assert.equal(calls.length, 0);
});

/** The real chargeCredits, for seeding — so tests spend through the same SQL the Worker does. */
async function bundleUsage() {
  const file = path.join(outDir, 'usage.mjs');
  if (!fs.existsSync(file)) {
    await esbuild.build({
      entryPoints: [path.join(pkgRoot, 'src/usage.ts')],
      outfile: file,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      logLevel: 'silent',
    });
  }
  return import(file);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
fs.rmSync(outDir, { recursive: true, force: true });
if (failures.length) process.exit(1);
