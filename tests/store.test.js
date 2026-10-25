import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore, MemoryError, ENTRY_DELIMITER } from '../src/store.js';

function freshStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  return new MemoryStore({ dir, ...opts });
}

test('add 后能跨实例读回，条目以 § 分隔', () => {
  const store = freshStore();
  store.add('memory', 'User prefers concise replies');
  store.add('memory', 'Repo lives at E:\\dsh\\work');

  const raw = fs.readFileSync(path.join(store.dir, 'MEMORY.md'), 'utf8');
  assert.equal(raw, 'User prefers concise replies' + ENTRY_DELIMITER + 'Repo lives at E:\\dsh\\work');

  const reopened = new MemoryStore({ dir: store.dir });
  assert.deepEqual(reopened.load('memory'), [
    'User prefers concise replies',
    'Repo lives at E:\\dsh\\work',
  ]);
});

test('memory 与 user 是两个独立文件与独立配额', () => {
  const store = freshStore({ memoryCharLimit: 2200, userCharLimit: 40 });
  store.add('memory', 'x'.repeat(2000));
  store.add('user', 'short');
  assert.equal(fs.existsSync(path.join(store.dir, 'MEMORY.md')), true);
  assert.equal(fs.existsSync(path.join(store.dir, 'USER.md')), true);
  assert.throws(() => store.add('user', 'y'.repeat(60)), MemoryError, 'user 配额更小，应被拒绝');
});

test('超限拒绝写入，报错带 current_entries 与 usage', () => {
  const store = freshStore({ memoryCharLimit: 30 });
  store.add('memory', 'aaaaaaaaaa'); // 10
  let err;
  try {
    store.add('memory', 'b'.repeat(30));
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof MemoryError);
  assert.match(err.message, /would exceed the limit/);
  assert.equal(err.detail.usage, '10/30');
  assert.deepEqual(err.detail.current_entries, ['aaaaaaaaaa']);
  // 拒绝后磁盘未被修改
  assert.deepEqual(new MemoryStore({ dir: store.dir }).load('memory'), ['aaaaaaaaaa']);
});

test('重复 add 不产生重复条目', () => {
  const store = freshStore();
  store.add('memory', 'same');
  const res = store.add('memory', 'same');
  assert.match(res.message, /already exists/);
  assert.equal(store.entries('memory').length, 1);
});

test('replace 用唯一子串定位，多命中要报错', () => {
  const store = freshStore();
  store.add('memory', 'deploy target is 8080');
  store.add('memory', 'api target is 9000');
  store.replace('memory', 'deploy target', 'deploy target is 9090');
  assert.deepEqual(store.entries('memory'), ['deploy target is 9090', 'api target is 9000']);
  assert.throws(() => store.replace('memory', 'target', 'x'), /Multiple entries matched/);
  assert.throws(() => store.replace('memory', 'nope', 'x'), /No entry matched/);
});

test('remove 删除后其余条目保持顺序', () => {
  const store = freshStore();
  ['a', 'b', 'c'].forEach((v) => store.add('memory', `entry ${v}`));
  store.remove('memory', 'entry b');
  assert.deepEqual(store.entries('memory'), ['entry a', 'entry c']);
});

test('batch 只在最终态校验配额：允许先删后加', () => {
  const store = freshStore({ memoryCharLimit: 30 });
  store.add('memory', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa'); // 28 chars
  // 单独 add 一定失败
  assert.throws(() => store.add('memory', 'bbbb'), MemoryError);
  // 先删后加在最终态只有 4 字符，应成功
  const res = store.applyBatch('memory', [
    { action: 'remove', old_text: 'aaa' },
    { action: 'add', content: 'bbbb' },
  ]);
  assert.equal(res.success, true);
  assert.deepEqual(store.entries('memory'), ['bbbb']);
});

test('batch 失败时整体不落盘', () => {
  const store = freshStore();
  store.add('memory', 'keep me');
  assert.throws(
    () =>
      store.applyBatch('memory', [
        { action: 'add', content: 'temporary' },
        { action: 'remove', old_text: 'not-there' },
      ]),
    /No entry matched/,
  );
  assert.deepEqual(store.entries('memory'), ['keep me']);
  assert.deepEqual(new MemoryStore({ dir: store.dir }).load('memory'), ['keep me']);
});

test('batch 拒绝把非空 store 清空', () => {
  const store = freshStore();
  store.add('memory', 'only one');
  assert.throws(
    () => store.applyBatch('memory', [{ action: 'remove', old_text: 'only one' }]),
    /Refusing to empty/,
  );
  assert.deepEqual(store.entries('memory'), ['only one']);
});

test('单条 remove 可以删掉最后一条（清空的正规途径）', () => {
  const store = freshStore();
  store.add('memory', 'only one');
  const result = store.remove('memory', 'only one');
  assert.equal(result.success, true);
  assert.deepEqual(store.entries('memory'), []);
  assert.equal(store.render('memory'), '');
  // 磁盘上也要真的空了
  assert.deepEqual(new MemoryStore({ dir: store.dir }).load('memory'), []);
});

test('render 产出 Hermes 的框与用量行', () => {
  const store = freshStore({ memoryCharLimit: 2200 });
  store.add('memory', 'hello');
  const block = store.render('memory');
  const lines = block.split('\n');
  assert.equal(lines[0], '═'.repeat(46));
  assert.equal(lines[1], 'MEMORY (your personal notes) [0% — 5/2,200 chars]');
  assert.equal(lines[2], '═'.repeat(46));
  assert.equal(store.render('user'), '', '空 store 不渲染');
});

test('往返不一致时先备份再结构化（去重、丢空白）', () => {
  const store = freshStore();
  fs.mkdirSync(store.dir, { recursive: true });
  const file = path.join(store.dir, 'MEMORY.md');
  // 手写了一个重复条目：解析后会去重，往返不等于原文 → 应触发漂移备份
  fs.writeFileSync(file, 'first note\n§\nfirst note\n', 'utf8');
  store.load('memory');
  store.add('memory', 'third');
  const backups = fs.readdirSync(store.dir).filter((n) => n.startsWith('MEMORY.md.bak.'));
  assert.equal(backups.length, 1, '漂移应留下 .bak.<ts>');
  assert.deepEqual(new MemoryStore({ dir: store.dir }).load('memory'), ['first note', 'third']);
});

test('patch 内容含 § 被拒绝且数据不变', () => {
  const store = freshStore();
  store.add('memory', 'alpha beta');
  assert.throws(() => store.patch('memory', 'beta', 'beta\n§\ngamma'), MemoryError);
  assert.deepEqual(store.entries('memory'), ['alpha beta']);
  assert.deepEqual(new MemoryStore({ dir: store.dir }).load('memory'), ['alpha beta']);
});

test('batch 里 patch 内容含 § → 整批拒绝且数据不变', () => {
  const store = freshStore();
  store.add('memory', 'alpha beta');
  assert.throws(
    () =>
      store.applyBatch('memory', [
        { action: 'add', content: 'temporary' },
        { action: 'patch', old_text: 'beta', content: 'beta\n§\ngamma' },
      ]),
    MemoryError,
  );
  assert.deepEqual(store.entries('memory'), ['alpha beta']);
  assert.deepEqual(new MemoryStore({ dir: store.dir }).load('memory'), ['alpha beta']);
});

test('replace 内容含 § 被拒绝且数据不变', () => {
  const store = freshStore();
  store.add('memory', 'alpha beta');
  assert.throws(() => store.replace('memory', 'alpha beta', 'x\n§\ny'), MemoryError);
  assert.deepEqual(store.entries('memory'), ['alpha beta']);
  assert.deepEqual(new MemoryStore({ dir: store.dir }).load('memory'), ['alpha beta']);
});
