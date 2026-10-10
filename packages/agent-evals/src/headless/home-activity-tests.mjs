import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUnits } from './build-units.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const require = createRequire(path.join(root, 'apps/vscode-extensions/package.json'));
const out = await buildUnits();
await require('esbuild').build({
  entryPoints: Object.fromEntries(['src/services/home/types.ts', 'src/services/home/homeActivityService.ts', 'src/handlers/HomeActivityMessageHandler.ts', 'src/services/tickets/trackerSelection.ts', 'src/services/historyService.ts', 'src/services/confluence/confluenceWebUrl.ts'].map((p) => [path.basename(p, '.ts'), path.join(root, 'apps/vscode-extensions', p)])),
  outdir: out, outExtension: { '.js': '.mjs' }, bundle: true, format: 'esm', platform: 'node', target: 'node18',
  alias: { vscode: path.join(here, 'vscode-stub.mjs') },
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: 'silent',
});
const { adoReviewState, hasJiraMention, adfText } = await import(path.join(out, 'types.mjs'));
const { selectTracker } = await import(path.join(out, 'trackerSelection.mjs'));
const { sessionTicketUrl } = await import(path.join(out, 'historyService.mjs'));
const { loadHomeActivity, jiraMentions, confluenceMentions } = await import(path.join(out, 'homeActivityService.mjs'));
const { HomeActivityMessageHandler } = await import(path.join(out, 'HomeActivityMessageHandler.mjs'));
const { resolveConfluenceWebUrl } = await import(path.join(out, 'confluenceWebUrl.mjs'));
const { STORAGE_KEYS } = await import(path.join(out, 'constants.mjs'));

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok ${name}`); }
await test('Confluence web links preserve API application contexts without duplicating them', () => {
  const site = 'https://example.atlassian.net';
  const path = '/spaces/D2C/pages/6612615169/2026+Release+Roster';
  const expected = `${site}/wiki${path}?commentId=17#comment-17`;
  for (const link of [path, path.slice(1), `/wiki${path}`, `${site}/wiki${path}`]) {
    assert.equal(resolveConfluenceWebUrl(`${site}/wiki`, `${link}?commentId=17#comment-17`, { base: `${site}/wiki`, context: '/wiki' }), expected);
  }
  assert.equal(resolveConfluenceWebUrl(`${site}/wiki`, path), `${site}/wiki${path}`);
  assert.equal(resolveConfluenceWebUrl(`${site}/wiki`, path, { base: site, context: '/knowledge' }), `${site}/knowledge${path}`);
  assert.equal(resolveConfluenceWebUrl(`${site}/wiki`, '/knowledge/spaces/X/pages/1', { base: `${site}/knowledge` }), `${site}/knowledge/spaces/X/pages/1`);
  assert.equal(resolveConfluenceWebUrl(site, path, { base: site, context: '' }), `${site}${path}`);
  assert.equal(resolveConfluenceWebUrl(`${site}/wiki`, 'https://other.example/unsafe'), '');
  assert.equal(resolveConfluenceWebUrl(`${site}/wiki`, '//other.example/unsafe'), '');
  assert.equal(resolveConfluenceWebUrl(`${site}/wiki`, 'javascript:alert(1)'), '');
  assert.equal(resolveConfluenceWebUrl(`${site}/wiki`, path, { base: 'https://other.example/wiki' }), `${site}/wiki${path}`);
});
function context(config = {}) {
  const values = new Map([[STORAGE_KEYS.SETTINGS, { state: { config } }]]);
  const secrets = new Map([[STORAGE_KEYS.ADO_AUTH_MODE, 'pat'], [STORAGE_KEYS.ADO_PAT, 'test-only-not-a-key']]);
  return { values, secretValues: secrets, globalState: { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => values.set(key, value) }, secrets: { get: async (key) => secrets.get(key) } };
}

await test('Continue resumes the grounded ticket, never another referenced ticket or PR', () => {
  const refs = [{ id: '1', kind: 'work-item', url: 'https://example.org/other' }, { id: '2', kind: 'work-item', url: 'https://example.org/actual' }];
  assert.equal(sessionTicketUrl([{ turnSummary: { ticketId: '2', refs } }]), 'https://example.org/actual');
  assert.equal(sessionTicketUrl([{ turnSummary: { refs } }]), undefined);
  assert.equal(sessionTicketUrl([{ turnSummary: { ticketId: '2', refs: [{ id: '2', kind: 'pull-request', url: 'https://example.org/pr' }] } }]), undefined);
});

await test('enabling Jira disables Azure DevOps without deleting its configuration', () => {
  const config = { ado: { isAdoEnabled: true, orgName: 'org' }, jira: { isJiraEnabled: true } };
  assert.equal(selectTracker(config, 'jira').ado.isAdoEnabled, false);
  assert.equal(selectTracker(config, 'jira').ado.orgName, 'org');
  assert.equal(config.ado.isAdoEnabled, true);
  assert.equal(selectTracker(config, 'ado').jira.isJiraEnabled, false);
  assert.equal(selectTracker(config).jira.isJiraEnabled, false);
});
await test('approval requires required reviewers; rejected and waiting votes are distinct', () => {
  assert.equal(adoReviewState([], false), 'awaiting-review');
  assert.equal(adoReviewState([{ vote: 10 }, { isRequired: true, vote: 0 }], false), 'awaiting-review');
  assert.equal(adoReviewState([{ isRequired: true, vote: 5 }], false), 'approved');
  assert.equal(adoReviewState([{ vote: 10 }, { vote: -5 }], false), 'changes-requested');
  assert.equal(adoReviewState([{ vote: 10 }], true), 'draft');
});
await test('Jira mentions match account identifiers, not names in ordinary text', () => {
  const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alex ' }, { type: 'mention', attrs: { id: 'account-1', text: '@Alex' } }] }] };
  assert.equal(hasJiraMention(body, 'account-1'), true);
  assert.equal(hasJiraMention(body, 'account-2'), false);
  assert.equal(hasJiraMention({ type: 'text', text: '@Alex' }, 'account-1'), false);
  assert.equal(adfText(body), 'Alex @Alex');
});
const originalFetch = globalThis.fetch;
try {
  await test('Jira reads actual account mentions, links the comment, and reports incomplete coverage', async () => {
    const ctx = context({ jira: { projectKey: 'PHX' } });
    ctx.values.set('jira-site', { id: 'cloud', url: 'https://example.atlassian.net' });
    ctx.secretValues.set(STORAGE_KEYS.JIRA_OAUTH_TOKENS, JSON.stringify({ accessToken: 'test', expiresAt: Date.now() + 3600_000 }));
    globalThis.fetch = async (raw) => {
      const url = new URL(raw);
      const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'account', text: '@Ritesh' } }, { type: 'text', text: ' please review' }] }] };
      const data = url.pathname.endsWith('myself') ? { accountId: 'account' }
        : url.pathname.endsWith('search/jql') ? { issues: [{ key: 'PHX-284', fields: { summary: 'Checkout timeout' } }], isLast: false }
          : { total: 1, comments: [{ id: '17', body, updated: new Date().toISOString(), author: { displayName: 'Alex' } }] };
      return { ok: true, json: async () => data };
    };
    const result = await jiraMentions(ctx);
    assert.equal(result.items.length, 1);
    assert.ok(result.items[0].url.endsWith('focusedCommentId=17'));
    assert.ok(result.items[0].id.includes(':account:'));
    assert.equal(result.limited, true);
  });
  await test('Confluence uses current-user CQL, safe site links, and a separate connection read namespace', async () => {
    const ctx = context({ confluence: { spaceKey: 'ENG' } });
    ctx.values.set('confluence-site', { id: 'cloud', url: 'https://example.atlassian.net' });
    ctx.values.set('confluence-home-account-scope', 'account-connection');
    ctx.secretValues.set(STORAGE_KEYS.CONFLUENCE_OAUTH_TOKENS, JSON.stringify({ accessToken: 'test', expiresAt: Date.now() + 3600_000 }));
    globalThis.fetch = async (raw) => {
      assert.match(new URL(raw).searchParams.get('cql'), /mention = currentUser\(\)/);
      return { ok: true, json: async () => ({ results: [
        { content: { id: '1', title: 'Design', type: 'page', version: { number: 3, when: new Date().toISOString() } }, url: '/spaces/ENG/pages/1/Design' },
        { content: { id: '2' }, url: 'https://other.example/unsafe' },
      ], _links: { base: 'https://example.atlassian.net/wiki', context: '/wiki' } }) };
    };
    const result = await confluenceMentions(ctx);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].contentType, 'page');
    assert.equal(result.items[0].url, 'https://example.atlassian.net/wiki/spaces/ENG/pages/1/Design');
    assert.ok(result.items[0].id.includes(':account-connection:'));
  });
  await test('first use produces setup states without any network access', async () => {
    globalThis.fetch = () => { throw new Error('Unexpected network request'); };
    const sections = {};
    await loadHomeActivity(context(), (key, value) => sections[key] = value);
    assert.equal(Object.keys(sections).length, 3);
    assert.ok(sections.pullRequests.setup);
    assert.ok(sections.trackerMentions.setup);
    assert.ok(sections.confluenceMentions.setup);
  });
  const config = { ado: { isAdoEnabled: true, isAuthenticated: true, orgName: 'org', projectName: 'project' } };
  await test('ADO filters reviewed requests, keeps approved own PRs, and uses real mention identity', async () => {
    const urls = [];
    globalThis.fetch = async (raw, init) => {
      const url = new URL(raw); urls.push(url);
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal);
      let data;
      const pr = (id, creator, vote) => ({ pullRequestId: id, title: `PR ${id}`, createdBy: { id: creator, displayName: creator }, repository: { id: 'repo', name: 'repo' }, reviewers: [{ id: 'me', vote }], lastMergeSourceCommit: { commitId: 'commit' } });
      if (url.pathname.endsWith('connectionData')) data = { authenticatedUser: { id: 'me' } };
      else if (url.pathname.endsWith('pullrequests')) data = { value: url.searchParams.has('searchCriteria.creatorId') ? [pr(1, 'me', 10)] : [pr(2, 'other', 0), pr(3, 'other', 10), pr(1, 'me', 0)] };
      else if (url.pathname.endsWith('wiql')) data = { workItems: [{ id: 123 }] };
      else if (url.pathname.endsWith('workitems')) data = { value: [{ id: 123, fields: { 'System.Title': 'Ticket' } }] };
      else if (url.pathname.endsWith('comments')) data = { comments: [
        { id: 7, text: '<p>@Me please review</p>', modifiedDate: new Date().toISOString(), mentions: [{ targetId: 'me', artifactType: 'person' }], createdBy: { displayName: 'Alex' } },
        { id: 8, text: '@Me ordinary text', modifiedDate: new Date().toISOString(), mentions: [] },
        { id: 9, text: 'old mention', modifiedDate: '2020-01-01', mentions: [{ targetId: 'me', artifactType: 'person' }] },
      ] };
      else throw new Error(`Unexpected endpoint ${url.pathname}`);
      return { ok: true, json: async () => data };
    };
    const sections = {};
    await loadHomeActivity(context(config), (key, value) => sections[key] = value);
    assert.equal(sections.pullRequests.items.length, 2);
    assert.equal(sections.pullRequests.items.find((p) => p.ownership === 'mine').state, 'approved');
    assert.equal(sections.pullRequests.items.find((p) => p.ownership === 'review').number, '2');
    assert.equal(sections.trackerMentions.items.length, 1);
    assert.ok(sections.trackerMentions.items[0].url.endsWith('discussionCommentId=7'));
    assert.equal(urls.find((url) => url.pathname.endsWith('comments')).searchParams.get('$expand'), 'renderedText');
  });
  await test('a failed PR permission check does not suppress mentions or setup states', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (url, init) => String(url).includes('/pullrequests?') ? Promise.resolve({ ok: false, status: 403 }) : previous(url, init);
    const sections = {};
    await loadHomeActivity(context(config), (key, value) => sections[key] = value);
    assert.match(sections.pullRequests.error, /Access denied/);
    assert.equal(sections.trackerMentions.items.length, 1);
    assert.ok(sections.confluenceMentions.setup);
  });
  await test('read revisions persist, can be marked unread, and concurrent reads do not overwrite each other', async () => {
    const ctx = context(); const handler = new HomeActivityMessageHandler({ webview: { postMessage: () => {} } }, ctx);
    await Promise.all([
      handler.handleMessage({ type: 'home-activity-seen', id: 'mention:a', revision: 'v1' }),
      handler.handleMessage({ type: 'home-activity-seen', id: 'mention:b', revision: 'v1' }),
    ]);
    assert.deepEqual(ctx.values.get('workspacegpt.homeActivitySeen'), { 'mention:a': 'v1', 'mention:b': 'v1' });
    await handler.handleMessage({ type: 'home-activity-seen', id: 'mention:a', revision: null });
    assert.deepEqual(ctx.values.get('workspacegpt.homeActivitySeen'), { 'mention:b': 'v1' });
    const responses = [];
    await new HomeActivityMessageHandler({ webview: { postMessage: (m) => responses.push(m) } }, ctx).handleMessage({ type: 'get-home-activity', requestId: 'new-view' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(responses[0].seen['mention:b'], 'v1');
  });
  await test('responses from a previous tracker configuration are discarded', async () => {
    const ctx = context(config); const responses = [];
    let release;
    globalThis.fetch = () => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ authenticatedUser: { id: 'me' } }) }); });
    const handler = new HomeActivityMessageHandler({ webview: { postMessage: (m) => responses.push(m) } }, ctx);
    await handler.handleMessage({ type: 'get-home-activity', requestId: 'stale' });
    await new Promise((resolve) => setImmediate(resolve));
    ctx.values.set(STORAGE_KEYS.SETTINGS, { state: { config: {} } });
    await handler.handleMessage({ type: 'get-home-activity', requestId: 'current' });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ value: [], workItems: [] }) });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(responses.filter((r) => r.requestId === 'stale' && r.section !== 'confluenceMentions').length, 0);
    assert.ok(responses.some((r) => r.requestId === 'current' && r.complete));
  });
} finally { globalThis.fetch = originalFetch; }
console.log(`${passed} homepage activity tests passed`);
