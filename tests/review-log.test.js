import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReviewLog, diffEntries, summarizeDiff } from '../src/review-log.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-review-log-'));
}

test('diffEntries：新增 / 删除 / 一增一删配成 changed', () => {
  const added = diffEntries(['a'], ['a', 'b']);
  assert.deepEqual(added, { added: ['b'], removed: [], changed: [] });

  const removed = diffEntries(['a', 'b'], ['a']);
  assert.deepEqual(removed, { added: [], removed: ['b'], changed: [] });

  // 同样长度、正好一增一删 → 视为一次改写
  const changed = diffEntries(['a', 'b'], ['a', 'c']);
  assert.deepEqual(changed, { added: [], removed: [], changed: [['b', 'c']] });

  // 多增多删不硬配对
  const many = diffEntries(['a', 'b'], ['c', 'd']);
  assert.deepEqual(many, { added: ['c', 'd'], removed: ['a', 'b'], changed: [] });
});

test('summarizeDiff 输出两库的 + / ~ / - 计数', () => {
  const summary = summarizeDiff({
    memory: { added: ['x'], removed: [], changed: [] },
    user: { added: [], removed: [], changed: [['before', 'after']] },
  });
  assert.equal(summary, 'MEMORY +1 ~0 -0 · USER +0 ~1 -0');
});

test('record / recent：最多保留 50 条，最近的排在最前', () => {
  const dir = tempDir();
  const log = createReviewLog(dir);
  for (let i = 0; i < 55; i += 1) {
    log.record({ channel: 'review', summary: `review-${i}` });
  }
  assert.equal(log.count(), 50);
  const recent = log.recent(10);
  assert.equal(recent.length, 10);
  assert.equal(recent[0].summary, 'review-54', '最新的在最前');
  assert.equal(recent[9].summary, 'review-45');
  assert.equal(typeof recent[0].id, 'string');
  assert.equal(recent[0].channel, 'review');
});

test('record 写坏目录时不抛异常（降级为只返回记录）', () => {
  const dir = tempDir();
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'x', 'utf8');
  const log = createReviewLog(blocked);
  assert.doesNotThrow(() => log.record({ summary: 'x' }));
  assert.equal(log.count(), 0);
  assert.equal(log.recent().length, 0);
});
