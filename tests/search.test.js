import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../src/store.js';
import { tokenize, searchMemory } from '../src/search.js';
import { searchToolDefinition } from '../src/search-tool.js';

function freshStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memsearch-'));
  return new MemoryStore({ dir, ...opts });
}

test('tokenize 切分中英文与路径', () => {
  assert.deepEqual(tokenize('Repo lives at E:\\dsh\\work, ok?'), ['repo', 'lives', 'at', 'e', 'dsh', 'work', 'ok']);
  assert.deepEqual(tokenize('记忆 选择性 很重要'), ['记忆', '选择性', '很重要']);
});

test('searchMemory：子串命中排在最前，空查询返回空', () => {
  const store = freshStore();
  store.add('memory', 'User prefers concise replies');
  store.add('memory', 'Repo lives at E:\\dsh\\work');
  store.add('memory', 'Deploys go through the staging proxy');

  assert.deepEqual(searchMemory(store, '   '), []);
  const hits = searchMemory(store, 'dsh\\work');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entry, 'Repo lives at E:\\dsh\\work');
  assert.ok(hits[0].score >= 2);
});

test('searchMemory：词元命中可以匹配多个轨道，target 过滤生效', () => {
  const store = freshStore({ targets: ['memory', 'user', 'project'], files: { project: 'PROJECT.md' } });
  store.add('memory', 'config lives in dsh home');
  store.add('project', 'config lives in dsh home / per-project log');

  const all = searchMemory(store, 'config home');
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map((hit) => hit.target)), new Set(['memory', 'project']));

  const onlyProject = searchMemory(store, 'config home', { target: 'project' });
  assert.equal(onlyProject.length, 1);
  assert.equal(onlyProject[0].target, 'project');
});

test('searchMemory：limit 截断，排序稳定（同分按长度升序）', () => {
  const store = freshStore();
  store.add('memory', 'proxy setting');
  store.add('memory', 'proxy setting alpha beta gamma');
  store.add('memory', 'proxy setting alpha');

  const hits = searchMemory(store, 'proxy setting', { limit: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].entry, 'proxy setting');
  // 同分时短条目优先，结果确定
  assert.ok(hits[0].entry.length <= hits[1].entry.length);
});

test('memory_search 工具：正常返回、空 query 报错、非法 target/limit 报错', () => {
  const store = freshStore();
  store.add('memory', 'User prefers concise replies');
  const tool = searchToolDefinition({ store });

  assert.equal(tool.name, 'memory_search');
  const ok = tool.execute({ query: 'concise' });
  assert.equal(ok.success, true);
  assert.equal(ok.count, 1);
  assert.equal(ok.matches[0].entry, 'User prefers concise replies');

  const empty = tool.execute({ query: '  ' });
  assert.equal(empty.success, false);
  assert.match(empty.error, /query is required/);

  const badTarget = tool.execute({ query: 'x', target: 'nope' });
  assert.equal(badTarget.success, false);
  assert.match(badTarget.error, /Unknown target/);

  const badLimit = tool.execute({ query: 'x', limit: 99 });
  assert.equal(badLimit.success, false);
  assert.match(badLimit.error, /limit must be an integer/);
});

test('memory_search 工具：未命中给出可执行提示', () => {
  const store = freshStore();
  store.add('memory', 'User prefers concise replies');
  const tool = searchToolDefinition({ store });
  const miss = tool.execute({ query: 'nosuchword' });
  assert.equal(miss.success, true);
  assert.equal(miss.count, 0);
  assert.match(miss.note, /No match/);
});
