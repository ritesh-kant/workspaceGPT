/**
 * Headless tests for the pure metering logic (src/metering.ts) — the part of
 * usage accounting that turns a vendor response into a charge and decides
 * admission. No Worker runtime, no D1: metering.ts has no runtime imports.
 *
 * The TS is bundled with the extension package's esbuild (no new dependency)
 * into a temp dir, then driven with node:assert.
 *
 * Run: node test/run.mjs   (or `pnpm test`)
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const require = createRequire(path.join(pkgRoot, '../vscode-extensions/package.json'));
const esbuild = require('esbuild');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-api-test-'));
await esbuild.build({
  entryPoints: [path.join(pkgRoot, 'src/metering.ts')],
  outfile: path.join(outDir, 'metering.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2021',
  logLevel: 'silent',
});
const m = await import(path.join(outDir, 'metering.mjs'));

// config.ts is equally runtime-free (it imports only a type), so the layered
// resolution can be driven the same way.
await esbuild.build({
  entryPoints: [path.join(pkgRoot, 'src/config.ts')],
  outfile: path.join(outDir, 'config.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2021',
  logLevel: 'silent',
});
const conf = await import(path.join(outDir, 'config.mjs'));

let pass = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n')[0]}`);
  }
}

console.log('creditsForTokens');
await t('rounds up and never charges less than one credit for a real call', () => {
  assert.equal(m.creditsForTokens(1, 1000), 1);
  assert.equal(m.creditsForTokens(999, 1000), 1);
  assert.equal(m.creditsForTokens(1000, 1000), 1);
  assert.equal(m.creditsForTokens(1001, 1000), 2);
  assert.equal(m.creditsForTokens(47147 + 3468, 1000), 51, 'the s2 agent run from the eval harness');
  assert.equal(m.creditsForTokens(6655 + 500, 1000), 8, 'a doc answer from the eval harness');
});
await t('accumulates fractional credit units so small calls are not each rounded to one credit', () => {
  const units = [200, 200, 200, 200, 200].reduce(
    (sum, tokens) => sum + m.creditUnitsForTokens(tokens, 1000),
    0
  );
  assert.equal(units, m.CREDIT_UNIT_SCALE, 'five 0.2-credit calls sum to one credit');
  assert.equal(Math.ceil(units / m.CREDIT_UNIT_SCALE), 1);
  assert.equal(m.creditsForTokens(200, 1000) * 5, 5, 'the old per-call rounding charged five times too much');
});
await t('zero or garbage tokens charge nothing, garbage divisor falls back to 1000', () => {
  assert.equal(m.creditsForTokens(0, 1000), 0);
  assert.equal(m.creditsForTokens(-5, 1000), 0);
  assert.equal(m.creditsForTokens(NaN, 1000), 0);
  assert.equal(m.creditsForTokens(2500, 0), 3);
  assert.equal(m.creditsForTokens(2500, NaN), 3);
});

console.log('\nusageFromObject / extractUsage');
await t('reads an OpenAI usage object and sums parts when total is missing', () => {
  assert.deepEqual(m.usageFromObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), {
    promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 0,
  });
  assert.deepEqual(m.usageFromObject({ prompt_tokens: 10, completion_tokens: 5 }), {
    promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 0,
  });
  assert.equal(m.usageFromObject(null), null);
  assert.equal(m.usageFromObject({}), null);
  assert.equal(m.usageFromObject({ prompt_tokens: 'lots' }), null);
  assert.equal(m.usageFromObject({ prompt_tokens: -1, total_tokens: NaN }), null, 'nothing valid → null, never NaN credits');
});
await t('non-streaming JSON: top-level usage', () => {
  const body = JSON.stringify({ id: 'x', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 19, completion_tokens: 10, total_tokens: 29 } });
  assert.deepEqual(m.extractUsage(body, 'application/json'), { promptTokens: 19, completionTokens: 10, totalTokens: 29, cachedPromptTokens: 0 });
  assert.equal(m.extractUsage('not json', 'application/json'), null);
  assert.equal(m.extractUsage(JSON.stringify({ choices: [] }), 'application/json'), null);
});
await t('SSE: the LAST non-null usage wins; [DONE], null usage and junk lines are skipped', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"a"}}],"usage":null}',
    '',
    'data: {"choices":[{"delta":{"content":"b"}}]}',
    'data: this is not json',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}',
    'data: [DONE]',
    '',
  ].join('\n');
  assert.deepEqual(m.extractUsage(sse, 'text/event-stream'), { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 0 });
});
await t('SSE detected by body shape when the content-type is missing', () => {
  const sse = 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":1,"total_tokens":8}}\n\ndata: [DONE]\n';
  assert.equal(m.extractUsage(sse, null)?.totalTokens, 8);
});
await t('SSE with no usage anywhere → null (caller estimates)', () => {
  assert.equal(m.extractUsage('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n', 'text/event-stream'), null);
});
await t('estimateTokensFromChars is ~chars/4 and never negative', () => {
  assert.equal(m.estimateTokensFromChars(4000), 1000);
  assert.equal(m.estimateTokensFromChars(1), 1);
  assert.equal(m.estimateTokensFromChars(0), 0);
  assert.equal(m.estimateTokensFromChars(-10), 0);
});

console.log('\ncached-token rebate');
await t('reads cached_tokens from prompt_tokens_details, and from a bare field', () => {
  assert.equal(
    m.usageFromObject({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 80 } })
      .cachedPromptTokens,
    80
  );
  assert.equal(
    m.usageFromObject({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 60 }).cachedPromptTokens,
    60,
    'providers that report it without the details wrapper'
  );
  assert.equal(
    m.usageFromObject({ prompt_tokens: 100, total_tokens: 100, prompt_tokens_details: {}, cached_tokens: 60 }).cachedPromptTokens,
    60,
    'an empty details wrapper does not hide a provider\'s bare cache count'
  );
  assert.equal(m.usageFromObject({ prompt_tokens: 100, total_tokens: 100 }).cachedPromptTokens, 0, 'absent → nothing rebated');
  assert.equal(
    m.usageFromObject({ prompt_tokens: 100, total_tokens: 100, prompt_tokens_details: { cached_tokens: 999 } }).cachedPromptTokens,
    100,
    'a nonsense count larger than the prompt is clamped, never rebating more than was sent'
  );
  assert.equal(
    m.usageFromObject({ prompt_tokens: 100, total_tokens: 100, prompt_tokens_details: { cached_tokens: -5 } }).cachedPromptTokens,
    0
  );
});
await t('billableTokens rebates only the cached share, and is exact when nothing is cached', () => {
  const u = (p, c, t, cached) => ({ promptTokens: p, completionTokens: c, totalTokens: t, cachedPromptTokens: cached });
  assert.equal(m.billableTokens(u(100, 10, 110, 0)), 110, 'no cache → unchanged, the case that must never drift');
  assert.equal(m.billableTokens(u(100, 10, 110, 100)), 30, '110 - 100*0.8');
  assert.equal(m.billableTokens(u(100, 10, 110, 50)), 70, '110 - 50*0.8');
  assert.equal(m.billableTokens(u(0, 0, 0, 0)), 0);
});
await t('billableTokens never goes negative or NaN on a malformed usage object', () => {
  assert.equal(m.billableTokens({ promptTokens: 0, completionTokens: 0, totalTokens: NaN, cachedPromptTokens: 10 }), 0);
  assert.equal(m.billableTokens({ promptTokens: 0, completionTokens: 0, totalTokens: 50, cachedPromptTokens: 9999 }), 10, 'cached is clamped to the total too');
  assert.equal(m.billableTokens({ promptTokens: 0, completionTokens: 0, totalTokens: 50 }), 50, 'missing cached field');
});
await t('the run that motivated this: a warm agent round costs a fraction of what it did', () => {
  // One mid-run round of ADO #1534774: ~35k prompt, nearly all of it the
  // resent transcript OpenRouter had cached, plus a small completion.
  const round = { promptTokens: 35_000, completionTokens: 400, totalTokens: 35_400, cachedPromptTokens: 33_000 };
  assert.equal(m.creditsForTokens(round.totalTokens, 1000), 36, 'what it used to charge');
  assert.equal(m.billableTokens(round), 9_000, '35,400 - 33,000*0.8');
  assert.equal(m.creditsForTokens(m.billableTokens(round), 1000), 9, 'what it charges now — a quarter of the old bill');
});

console.log('\ndecideAdmission');
const base = { weeklyUsed: 0, weeklyLimit: 2000, secondsUntilWeeklyReset: 86_400 };
await t('under the weekly limit → allowed', () => {
  assert.deepEqual(m.decideAdmission(base), { allowed: true });
  assert.deepEqual(m.decideAdmission({ ...base, weeklyUsed: 1999 }), { allowed: true });
});
await t('the request that CROSSES the limit is not this one; AT the limit refuses', () => {
  const d = m.decideAdmission({ ...base, weeklyUsed: 2000 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'weekly');
  assert.equal(d.retryAfterSec, 86_400);
  assert.match(m.describeRefusal(d), /Weekly credit limit reached \(2000 of 2000 credits used\)/);
});
await t('over the limit refuses too, and retries at the weekly reset', () => {
  const d = m.decideAdmission({ ...base, weeklyUsed: 5000, secondsUntilWeeklyReset: 3600 });
  assert.equal(d.allowed, false);
  assert.equal(d.retryAfterSec, 3600);
});
await t('a burst is NOT refused — there is no rolling window any more', () => {
  // The whole week's credits inside one afternoon is allowed by design: the
  // weekly cap bounds the cost, and a burst just spends the week sooner.
  assert.deepEqual(m.decideAdmission({ ...base, weeklyUsed: 1900 }), { allowed: true });
  assert.equal(m.WINDOW_SECONDS, undefined, 'the window constant is gone, not merely unused');
  assert.equal(m.windowCreditLimitFor, undefined, 'no window limit is computed anywhere');
});
await t('a zero/absent limit means uncapped', () => {
  assert.deepEqual(m.decideAdmission({ ...base, weeklyLimit: 0, weeklyUsed: 10 ** 9 }), { allowed: true });
});

console.log('\nlimits');
const cfg = { planWeeklyCredits: { free: 2000, pro: 50000 }, fallbackWeeklyCredits: 2000 };
await t('weekly: override → plan → fallback', () => {
  assert.equal(m.weeklyCreditLimitFor({ plan: 'free', weekly_credit_limit: null }, cfg), 2000);
  assert.equal(m.weeklyCreditLimitFor({ plan: 'pro', weekly_credit_limit: null }, cfg), 50000);
  assert.equal(m.weeklyCreditLimitFor({ plan: 'enterprise', weekly_credit_limit: null }, cfg), 2000, 'unlisted plan → fallback');
  assert.equal(m.weeklyCreditLimitFor({ plan: 'free', weekly_credit_limit: 9000 }, cfg), 9000, 'override wins');
  assert.equal(m.weeklyCreditLimitFor({ plan: 'free', weekly_credit_limit: 0 }, cfg), 2000, 'a zero override is ignored, not "uncapped"');
});

// The custom provider's endpoint is NAMED a base URL, and on 2026-09-07 it was
// deployed as one — "https://api.tokenrouter.com/v1" — while the proxy fetched
// it verbatim. Every request POSTed to /v1, the vendor answered 404 Invalid URL
// (POST /v1), and that passed through to the extension looking like a broken
// Worker route. Both forms must resolve to the same endpoint.
console.log('\nresolveConfig: the custom endpoint accepts a base URL or a full one');
{
  const envFor = (url) => ({ INFERENCE_PROVIDER: 'custom', CUSTOM_API_BASE_URL: url, CUSTOM_MODEL: 'z-ai/glm-5.3-free' });
  const chatUrl = (url, rows) => conf.resolveConfig(envFor(url), rows).chatUrl;

  await t('a base URL gets the chat-completions path appended', () => {
    assert.equal(chatUrl('https://api.tokenrouter.com/v1'), 'https://api.tokenrouter.com/v1/chat/completions');
    assert.equal(chatUrl('https://api.tokenrouter.com/v1/'), 'https://api.tokenrouter.com/v1/chat/completions');
  });
  await t('a full chat-completions URL is left exactly as it is', () => {
    assert.equal(
      chatUrl('https://api.tokenrouter.com/v1/chat/completions'),
      'https://api.tokenrouter.com/v1/chat/completions',
    );
  });
  await t('a D1 override is normalised too, not just the wrangler var', () => {
    assert.equal(
      chatUrl('https://api.tokenrouter.com/v1/chat/completions', [
        { key: 'custom_api_base_url', value: 'https://api.gmi-serving.com/v1' },
      ]),
      'https://api.gmi-serving.com/v1/chat/completions',
    );
  });
  await t('an unset endpoint stays empty so the proxy fails closed', () => {
    assert.equal(chatUrl(''), '');
    assert.equal(chatUrl('   '), '');
  });
  await t('openrouter keeps its own hardcoded endpoint', () => {
    const c = conf.resolveConfig({ INFERENCE_PROVIDER: 'openrouter' }, []);
    assert.equal(c.chatUrl, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(c.apiKeyEnv, 'OPENROUTER_API_KEY');
  });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
