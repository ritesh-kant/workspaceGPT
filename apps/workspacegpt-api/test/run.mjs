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
    promptTokens: 10, completionTokens: 5, totalTokens: 15,
  });
  assert.deepEqual(m.usageFromObject({ prompt_tokens: 10, completion_tokens: 5 }), {
    promptTokens: 10, completionTokens: 5, totalTokens: 15,
  });
  assert.equal(m.usageFromObject(null), null);
  assert.equal(m.usageFromObject({}), null);
  assert.equal(m.usageFromObject({ prompt_tokens: 'lots' }), null);
  assert.equal(m.usageFromObject({ prompt_tokens: -1, total_tokens: NaN }), null, 'nothing valid → null, never NaN credits');
});
await t('non-streaming JSON: top-level usage', () => {
  const body = JSON.stringify({ id: 'x', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 19, completion_tokens: 10, total_tokens: 29 } });
  assert.deepEqual(m.extractUsage(body, 'application/json'), { promptTokens: 19, completionTokens: 10, totalTokens: 29 });
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
  assert.deepEqual(m.extractUsage(sse, 'text/event-stream'), { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
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

console.log('\ndecideAdmission');
const base = { weeklyUsed: 0, weeklyLimit: 2000, windowUsed: 0, windowLimit: 400, windowOldestTs: null, nowSec: 1_000_000, secondsUntilWeeklyReset: 86_400 };
await t('under both limits → allowed', () => {
  assert.deepEqual(m.decideAdmission(base), { allowed: true });
  assert.deepEqual(m.decideAdmission({ ...base, weeklyUsed: 1999, windowUsed: 399 }), { allowed: true });
});
await t('the request that CROSSES a limit is not this one; AT the limit refuses', () => {
  const d = m.decideAdmission({ ...base, weeklyUsed: 2000 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'weekly');
  assert.equal(d.retryAfterSec, 86_400);
  assert.match(m.describeRefusal(d), /Weekly credit limit reached \(2000 of 2000 credits used\)/);
});
await t('window exhausted → refused until the oldest charge ages out', () => {
  const oldest = base.nowSec - 3 * 3600; // 3h ago → frees in 2h
  const d = m.decideAdmission({ ...base, windowUsed: 400, windowOldestTs: oldest });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'window');
  assert.equal(d.retryAfterSec, 2 * 3600);
  assert.match(m.describeRefusal(d), /5-hour credit allowance \(400 of 400 credits\)\. It frees up in about 2 hours/);
});
await t('window refusal with no recorded oldest still yields a sane retry', () => {
  const d = m.decideAdmission({ ...base, windowUsed: 400, windowOldestTs: null });
  assert.equal(d.allowed, false);
  assert.equal(d.retryAfterSec, m.WINDOW_SECONDS);
});
await t('both exhausted → the weekly (longer) wait is the message', () => {
  const d = m.decideAdmission({ ...base, weeklyUsed: 5000, windowUsed: 999, windowOldestTs: base.nowSec - 60 });
  assert.equal(d.reason, 'weekly');
});
await t('a zero/absent limit means uncapped for that dimension', () => {
  assert.deepEqual(m.decideAdmission({ ...base, weeklyLimit: 0, weeklyUsed: 10 ** 9 }), { allowed: true });
});

console.log('\nlimits');
const cfg = { planWeeklyCredits: { free: 2000, pro: 50000 }, fallbackWeeklyCredits: 2000, planWindowCredits: {}, fallbackWindowCredits: undefined };
await t('weekly: override → plan → fallback', () => {
  assert.equal(m.weeklyCreditLimitFor({ plan: 'free', weekly_credit_limit: null }, cfg), 2000);
  assert.equal(m.weeklyCreditLimitFor({ plan: 'pro', weekly_credit_limit: null }, cfg), 50000);
  assert.equal(m.weeklyCreditLimitFor({ plan: 'enterprise', weekly_credit_limit: null }, cfg), 2000, 'unlisted plan → fallback');
  assert.equal(m.weeklyCreditLimitFor({ plan: 'free', weekly_credit_limit: 9000 }, cfg), 9000, 'override wins');
  assert.equal(m.weeklyCreditLimitFor({ plan: 'free', weekly_credit_limit: 0 }, cfg), 2000, 'a zero override is ignored, not "uncapped"');
});
await t('window: configured per plan, else a fifth of weekly', () => {
  assert.equal(m.windowCreditLimitFor({ plan: 'free', weekly_credit_limit: null }, cfg), 400);
  assert.equal(m.windowCreditLimitFor({ plan: 'pro', weekly_credit_limit: null }, cfg), 10000);
  assert.equal(m.windowCreditLimitFor({ plan: 'free', weekly_credit_limit: 9000 }, cfg), 1800, 'follows an override');
  assert.equal(m.windowCreditLimitFor({ plan: 'free', weekly_credit_limit: null }, { ...cfg, planWindowCredits: { free: 123 } }), 123);
  assert.equal(m.windowCreditLimitFor({ plan: 'free', weekly_credit_limit: null }, { ...cfg, fallbackWindowCredits: 77 }), 77);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
