import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/store.js';
import { createWriteLog } from '../src/write-log.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-write-log-'));
}

test('append / recent：只保留最后 200 行，最近的排在最前', () => {
  const dir = tempDir();
  const log = createWriteLog(dir);
  for (let i = 0; i < 205; i += 1) log.append({ action: 'add', target: 'memory', after: `entry-${i}` });

  assert.equal(log.count(), 200);
  const recent = log.recent(3);
  assert.equal(recent[0].after, 'entry-204');
  assert.equal(recent[1].after, 'entry-203');
  assert.equal(recent[2].after, 'entry-202');
  assert.equal(typeof recent[0].ts, 'number');

  const lines = fs
    .readFileSync(path.join(dir, 'write-log.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(lines.length, 200);
});

test('store 的 add / patch / remove 各记一条，来源取自 lastSource', () => {
  const dir = tempDir();
  const log = createWriteLog(dir);
  const store = new MemoryStore({ dir, onWrite: (record) => log.append(record) });

  store.lastSource = 'panel';
  store.add('memory', 'alpha');
  store.lastSource = 'panel';
  store.patch('memory', 'alpha', 'beta');
  store.lastSource = 'panel';
  store.remove('memory', 'beta');

  const records = log.recent(10);
  assert.deepEqual(
    records.map((record) => record.action),
    ['remove', 'patch', 'add'],
  );
  assert.equal(records[0].source, 'panel');
  assert.equal(records[0].before, 'beta');
  assert.equal(records[0].after, null);
  assert.equal(records[1].before, 'alpha');
  assert.equal(records[1].after, 'beta');
  assert.equal(records[2].after, 'alpha');
  // 读后清空：下一次写入没显式设置来源时回到默认 tool
  store.add('memory', 'gamma');
  assert.equal(log.recent(1)[0].source, 'tool');
});

test('batch 每个 op 各记一条，并带 batch 标记', () => {
  const dir = tempDir();
  const log = createWriteLog(dir);
  const store = new MemoryStore({ dir, onWrite: (record) => log.append(record) });
  store.add('memory', 'one two');

  store.lastSource = 'tool';
  store.applyBatch('memory', [
    { action: 'patch', old_text: 'two', content: 'three' },
    { action: 'add', content: 'four' },
  ]);

  const batchRecords = log.recent(10).filter((record) => record.batch);
  assert.equal(batchRecords.length, 2);
  assert.deepEqual(batchRecords.map((record) => record.action).sort(), ['add', 'patch']);
  assert.ok(batchRecords.every((record) => record.source === 'tool'));
});

test('onWrite 抛错不影响真实写入', () => {
  const dir = tempDir();
  const store = new MemoryStore({
    dir,
    onWrite: () => {
      throw new Error('audit sink exploded');
    },
  });
  const res = store.add('memory', 'still written');
  assert.equal(res.success, true);
  assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), 'still written');
});
