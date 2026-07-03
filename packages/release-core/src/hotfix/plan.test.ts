import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConventionalCommit,
  defaultComponentFor,
  nextHotfixNumber,
  formatHotfixTag,
  buildHotfixPlan,
  DEFAULT_HOTFIX_TAG_TEMPLATE,
  type HotfixCommitGroup,
} from './plan';
import type { CommitRef } from '../types';

const commit = (over: Partial<CommitRef> = {}): CommitRef => ({
  sha: 'abc123',
  title: 'feat(mms-bff): add thing',
  ...over,
});

/* --------------------------- conventional commits --------------------------- */

test('parseConventionalCommit: type + scope + description', () => {
  assert.deepEqual(parseConventionalCommit('feat(mms-bff): add google pay'), {
    type: 'feat',
    scope: 'mms-bff',
    breaking: false,
    description: 'add google pay',
  });
});

test('parseConventionalCommit: breaking marker', () => {
  const c = parseConventionalCommit('fix(api)!: drop v1');
  assert.equal(c?.breaking, true);
  assert.equal(c?.scope, 'api');
});

test('parseConventionalCommit: no scope', () => {
  assert.equal(parseConventionalCommit('chore: bump deps')?.scope, undefined);
});

test('parseConventionalCommit: non-conventional returns null', () => {
  assert.equal(parseConventionalCommit('random commit message'), null);
});

/* ----------------------------- component mapping ---------------------------- */

test('defaultComponentFor: explicit component wins over scope', () => {
  assert.equal(defaultComponentFor(commit({ component: 'explicit' })), 'explicit');
});

test('defaultComponentFor: falls back to conventional scope', () => {
  assert.equal(defaultComponentFor(commit({ title: 'fix(mms-web): x' })), 'mms-web');
});

test('defaultComponentFor: undefined when no scope', () => {
  assert.equal(defaultComponentFor(commit({ title: 'fix: no scope', component: undefined })), undefined);
});

/* ------------------------------ hotfix numbers ------------------------------ */

test('nextHotfixNumber: 1 when none', () => {
  assert.equal(nextHotfixNumber(), 1);
  assert.equal(nextHotfixNumber([]), 1);
});

test('nextHotfixNumber: max + 1', () => {
  assert.equal(nextHotfixNumber([1, 3, 2]), 4);
});

/* --------------------------------- tags ------------------------------------- */

test('formatHotfixTag: renders generic default tag, strips duplicate v', () => {
  assert.equal(
    formatHotfixTag(DEFAULT_HOTFIX_TAG_TEMPLATE, 'mms-bff', 'v1.2.3', 1),
    'mms-bff-v1.2.3-hotfix.1',
  );
  assert.equal(
    formatHotfixTag(DEFAULT_HOTFIX_TAG_TEMPLATE, 'mms-bff', '1.2.3', 2),
    'mms-bff-v1.2.3-hotfix.2',
  );
});

test('formatHotfixTag: honours an org-specific template (scoped prefix)', () => {
  assert.equal(
    formatHotfixTag('myorg/{component}-v{version}-hotfix.{n}', 'mms-bff', 'v1.2.3', 1),
    'myorg/mms-bff-v1.2.3-hotfix.1',
  );
});

test('formatHotfixTag: null when base version unknown', () => {
  assert.equal(formatHotfixTag(DEFAULT_HOTFIX_TAG_TEMPLATE, 'c', undefined, 1), null);
  assert.equal(formatHotfixTag(DEFAULT_HOTFIX_TAG_TEMPLATE, 'c', '  ', 1), null);
});

/* ------------------------------- plan assembly ------------------------------ */

const groups = (): HotfixCommitGroup[] => [
  {
    ticket: { id: 'D2C-1', title: 'Ticket one' },
    commits: [
      commit({ sha: 's1', title: 'fix(mms-bff): a' }),
      commit({ sha: 's2', title: 'fix(mms-web): b' }),
    ],
  },
  {
    ticket: { id: 'D2C-2' },
    commits: [
      commit({ sha: 's3', title: 'fix(mms-bff): c' }),
      commit({ sha: 's4', title: 'no scope here' }),
    ],
  },
];

test('buildHotfixPlan: groups commits by component in first-seen order', () => {
  const plan = buildHotfixPlan({
    groups: groups(),
    branch: 'hotfix/2026-07-03',
    now: '2026-07-03T00:00:00Z',
    baseVersions: { 'mms-bff': '1.2.3', 'mms-web': '4.0.0' },
  });

  assert.equal(plan.components.length, 2);
  const bff = plan.components.find((c) => c.component === 'mms-bff')!;
  assert.deepEqual(bff.commits.map((c) => c.sha), ['s1', 's3']);
  assert.equal(bff.commits[0].ticket, 'D2C-1');
  assert.equal(bff.commits[1].ticket, 'D2C-2');
  assert.equal(bff.tag, 'mms-bff-v1.2.3-hotfix.1');

  const web = plan.components.find((c) => c.component === 'mms-web')!;
  assert.equal(web.tag, 'mms-web-v4.0.0-hotfix.1');
});

test('buildHotfixPlan: unassigned commits are surfaced, not dropped', () => {
  const plan = buildHotfixPlan({
    groups: groups(),
    branch: 'hotfix/x',
    now: '2026-07-03T00:00:00Z',
  });
  assert.equal(plan.unassigned.length, 1);
  assert.equal(plan.unassigned[0].sha, 's4');
  assert.equal(plan.summary.unassigned, 1);
});

test('buildHotfixPlan: summary counts', () => {
  const plan = buildHotfixPlan({
    groups: groups(),
    branch: 'hotfix/x',
    now: '2026-07-03T00:00:00Z',
    baseVersions: { 'mms-bff': '1.2.3', 'mms-web': '4.0.0' },
  });
  assert.deepEqual(plan.summary, { tickets: 2, commits: 4, components: 2, unassigned: 1 });
});

test('buildHotfixPlan: tag null when base version missing (reviewer must supply)', () => {
  const plan = buildHotfixPlan({
    groups: [groups()[0]],
    branch: 'hotfix/x',
    now: '2026-07-03T00:00:00Z',
    baseVersions: {}, // none known
  });
  assert.ok(plan.components.every((c) => c.tag === null));
});

test('buildHotfixPlan: existing hotfix numbers bump the ordinal', () => {
  const plan = buildHotfixPlan({
    groups: [groups()[0]],
    branch: 'hotfix/x',
    now: '2026-07-03T00:00:00Z',
    baseVersions: { 'mms-bff': '1.2.3', 'mms-web': '4.0.0' },
    existingHotfixNumbers: { 'mms-bff': [1, 2] },
  });
  const bff = plan.components.find((c) => c.component === 'mms-bff')!;
  assert.equal(bff.hotfixNumber, 3);
  assert.equal(bff.tag, 'mms-bff-v1.2.3-hotfix.3');
});

test('buildHotfixPlan: custom componentFor override', () => {
  const plan = buildHotfixPlan({
    groups: [groups()[0]],
    branch: 'hotfix/x',
    now: '2026-07-03T00:00:00Z',
    componentFor: () => 'fixed-component',
  });
  assert.equal(plan.components.length, 1);
  assert.equal(plan.components[0].component, 'fixed-component');
});
