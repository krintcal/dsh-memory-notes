import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../src/store.js';
import { findConflictGroups } from '../src/conflicts.js';
import {
  BUNDLE_FORMAT,
  exportBundle,
  mergeBundle,
  readSyncState,
  syncStatePath,
} from '../src/sync.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-sync-'));
  const store = new MemoryStore({ dir, targets: ['memory', 'user'] });
  return { dir, store };
}

function bundleOf(entries, device = 'dev-remote') {
  return {
    format: BUNDLE_FORMAT,
    device_id: device,
    exported_at: new Date().toISOString(),
    targets: entries,
  };
}

test('exportBundle：带 format/device_id/全部轨的条目', () => {
  const { store } = fixture();
  store.add('memory', 'repo at E:\\dsh\\work');
  store.add('user', 'user prefers concise replies');

  const bundle = exportBundle(store);
  assert.equal(bundle.format, BUNDLE_FORMAT);
  assert.match(bundle.device_id, /^dev-[0-9a-f]{8}$/);
  assert.deepEqual(bundle.targets.memory, ['repo at E:\\dsh\\work']);
  assert.deepEqual(bundle.targets.user, ['user prefers concise replies']);
  assert.equal(typeof bundle.exported_at, 'string');
});

test('mergeBundle：只加远端新增，合并后写基线且幂等', () => {
  const { store, dir } = fixture();
  store.add('memory', 'local fact');

  const remote = bundleOf({ memory: ['local fact', 'remote fact'] });
  const first = mergeBundle(store, remote);
  assert.equal(first.ok, true);
  assert.equal(first.added, 1);
  assert.deepEqual(store.load('memory').sort(), ['local fact', 'remote fact']);

  const state = readSyncState(dir);
  assert.equal(state.last_remote_device, 'dev-remote');
  assert.deepEqual([...state.baseline.memory].sort(), ['local fact', 'remote fact']);
  assert.equal(fs.existsSync(syncStatePath(dir)), true);

  // 同一个 bundle 再合并一次不会重复写入
  const second = mergeBundle(store, remote);
  assert.equal(second.added, 0);
  assert.equal(store.load('memory').length, 2);
});

test('本地删除的条目不会被远端复活', () => {
  const { store } = fixture();
  store.add('memory', 'shared fact');
  const remote = bundleOf({ memory: ['shared fact'] });
  mergeBundle(store, remote); // 建立基线

  store.remove('memory', 'shared fact');
  const again = mergeBundle(store, remote);
  assert.equal(again.added, 0);
  assert.deepEqual(store.load('memory'), []);
  assert.deepEqual(again.summary.memory.local_deleted_kept, ['shared fact']);
});

test('远端删除默认只报告；applyDeletions:true 才执行', () => {
  const { store } = fixture();
  store.add('memory', 'will-be-removed-remotely');
  mergeBundle(store, bundleOf({ memory: ['will-be-removed-remotely'] })); // 基线含它

  const reported = mergeBundle(store, bundleOf({ memory: [] }));
  assert.deepEqual(store.load('memory'), ['will-be-removed-remotely']);
  assert.deepEqual(reported.summary.memory.remote_deleted, ['will-be-removed-remotely']);

  const applied = mergeBundle(store, bundleOf({ memory: [] }), { applyDeletions: true });
  assert.equal(applied.ok, true);
  assert.deepEqual(store.load('memory'), []);
});

test('配额放不下的远端条目记入 skipped，不影响其他条目', () => {
  const { store } = fixture();
  const huge = 'x'.repeat(3000); // user 轨上限 1375
  const result = mergeBundle(store, bundleOf({ user: [huge, 'short fact'] }));
  assert.equal(result.added, 1);
  assert.equal(result.summary.user.skipped.length, 1);
  assert.match(result.summary.user.skipped[0].reason, /would exceed|limit/);
  assert.deepEqual(store.load('user'), ['short fact']);
});

test('格式不对直接报错', () => {
  const { store } = fixture();
  assert.throws(() => mergeBundle(store, { format: 'nope' }), /unsupported sync bundle format/);
  assert.throws(() => mergeBundle(store, null), /must be a JSON object/);
});

test('findConflictGroups：相似条目成对出现，不相似的不算', () => {
  const pairs = findConflictGroups([
    'config lives in dsh home',
    'config lives in dsh home directory',
    'The deploy target is E:\\Hermes',
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].similarity >= 0.8, true);
  assert.equal(pairs[0].a.includes('config'), true);
  assert.deepEqual(findConflictGroups(['only one']), []);
  assert.deepEqual(findConflictGroups(['a b c', 'x y z']), []);
});
