import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  computeDiff,
  summarize,
  applicableChanges,
  hasUnresolvedConflicts,
  type CurrentStateByTarget,
} from './diff';
import type { DesiredConfigVar } from '../types';

const v = (over: Partial<DesiredConfigVar> = {}): DesiredConfigVar => ({
  key: 'K',
  target: 'vercel',
  value: 'true',
  ...over,
});

test('classify: add when missing', () => {
  assert.equal(classify(v(), null), 'add');
});

test('classify: match when equal', () => {
  assert.equal(classify(v({ value: 'true' }), 'true'), 'match');
});

test('classify: update when present and different', () => {
  assert.equal(classify(v({ value: 'false' }), 'true'), 'update');
});

test('classify: sensitive change escalates to conflict', () => {
  assert.equal(classify(v({ value: 'false', sensitive: true }), 'true'), 'conflict');
});

test('classify: sensitive but equal is still match (no overwrite needed)', () => {
  assert.equal(classify(v({ value: 'true', sensitive: true }), 'true'), 'match');
});

test('computeDiff: per-target lookup and missing target = add', () => {
  const desired = [
    v({ key: 'A', target: 'vercel', value: '1' }),
    v({ key: 'B', target: 'vercel', value: '2' }),
    v({ key: 'C', target: 'mach', value: '3' }),
  ];
  const current: CurrentStateByTarget = new Map([
    ['vercel', new Map([['A', '1'], ['B', '9']])],
    // 'mach' deliberately absent -> C should be 'add'
  ]);
  const diff = computeDiff(desired, current);
  assert.equal(diff.find((d) => d.key === 'A')!.action, 'match');
  assert.equal(diff.find((d) => d.key === 'B')!.action, 'update');
  assert.equal(diff.find((d) => d.key === 'C')!.action, 'add');
});

test('summarize counts every action', () => {
  const desired = [
    v({ key: 'A', value: '1' }),
    v({ key: 'B', value: '2' }),
    v({ key: 'C', value: '3', sensitive: true }),
  ];
  const current: CurrentStateByTarget = new Map([
    ['vercel', new Map([['A', '1'], ['B', '9'], ['C', '8']])],
  ]);
  const s = summarize(computeDiff(desired, current));
  assert.deepEqual(s, { add: 0, update: 1, match: 1, conflict: 1, total: 3 });
});

test('applicableChanges excludes match and conflict', () => {
  const desired = [
    v({ key: 'A', value: '1' }), // match
    v({ key: 'B', value: '2' }), // update
    v({ key: 'C', value: '3', sensitive: true }), // conflict
    v({ key: 'D', value: '4' }), // add
  ];
  const current: CurrentStateByTarget = new Map([
    ['vercel', new Map([['A', '1'], ['B', '9'], ['C', '8']])],
  ]);
  const diff = computeDiff(desired, current);
  const keys = applicableChanges(diff).map((d) => d.key).sort();
  assert.deepEqual(keys, ['B', 'D']);
  assert.equal(hasUnresolvedConflicts(diff), true);
});
