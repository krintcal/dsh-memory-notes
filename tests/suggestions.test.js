import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_SUGGESTIONS,
  count,
  drop,
  enqueue,
  list,
  suggestionsFile,
  take,
} from '../src/suggestions.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-suggestions-'));
}

test('enqueue / list / take / drop 基本流程', () => {
  const dir = tempDir();
  const { record, duplicate } = enqueue(dir, { target: 'memory', text: 'pnpm only after sync', source: 'tool' });
  assert.equal(duplicate, false);
  assert.ok(record.id);
  assert.equal(record.target, 'memory');
  assert.equal(record.source, 'tool');
  assert.ok(record.created_at);

  assert.equal(count(dir), 1);
  assert.equal(list(dir).length, 1);
  assert.deepEqual(take(dir, record.id), record);
  assert.equal(take(dir, 'nope'), undefined);

  assert.equal(drop(dir, record.id), true);
  assert.equal(drop(dir, record.id), false);
  assert.equal(count(dir), 0);
});

test('相同 target + text 幂等：返回已有 id，不重复写', () => {
  const dir = tempDir();
  const first = enqueue(dir, { target: 'user', text: 'prefers concise replies', source: 'review' });
  const second = enqueue(dir, { target: 'user', text: 'prefers concise replies', source: 'review' });
  assert.equal(second.duplicate, true);
  assert.equal(second.record.id, first.record.id);
  assert.equal(count(dir), 1);

  // 同文本不同 target 不算重复
  const other = enqueue(dir, { target: 'memory', text: 'prefers concise replies', source: 'review' });
  assert.equal(other.duplicate, false);
  assert.equal(count(dir), 2);
});

test('坏行被跳过，不影响其它记录', () => {
  const dir = tempDir();
  enqueue(dir, { target: 'memory', text: 'good', source: 'review' });
  fs.appendFileSync(suggestionsFile(dir), '{broken json\n', 'utf8');
  assert.deepEqual(list(dir).map((item) => item.text), ['good']);
});

test('最多保留 200 条：超出时丢最旧的', () => {
  const dir = tempDir();
  for (let i = 0; i < MAX_SUGGESTIONS + 5; i += 1) {
    enqueue(dir, { target: 'memory', text: `entry ${i}`, source: 'review' });
  }
  const records = list(dir);
  assert.equal(records.length, MAX_SUGGESTIONS);
  assert.equal(records[0].text, 'entry 5');
  assert.equal(records[records.length - 1].text, `entry ${MAX_SUGGESTIONS + 4}`);
});

test('enqueue 缺少 target/text 时抛错', () => {
  const dir = tempDir();
  assert.throws(() => enqueue(dir, { target: 'memory', text: '   ' }), /requires target and text/);
  assert.throws(() => enqueue(dir, { text: 'no target' }), /requires target and text/);
});
