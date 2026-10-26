import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/store.js';
import { renderLiveSnapshot, reviewStatusLine } from '../src/snapshot.js';
import { createTracks } from '../src/tracks.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-snapshot-'));
  const cwd = path.join(dir, 'workspace');
  const layout = createTracks({ dir, cwd });
  const store = new MemoryStore({ dir, ...layout.limits, files: layout.files, targets: layout.targets });
  return { dir, cwd, layout, store };
}

test('组装顺序：memory → user → key → 收尾提示 → 回顾状态 → 分支行', () => {
  const { layout, store } = fixture();
  store.add('memory', 'memory fact');
  store.add('user', 'user preference');
  store.add('key', 'main fact [branch:main]');
  store.add('key', 'other fact [branch:release]');

  const text = renderLiveSnapshot({
    store,
    layout,
    branch: 'main',
    review: { due: false, turns_since: 3, interval: 10 },
    reviewMode: 'suggest',
  });
  const memoryAt = text.indexOf('memory fact');
  const userAt = text.indexOf('user preference');
  const keyAt = text.indexOf('main fact');
  const closingAt = text.indexOf('每回合收尾');
  const reviewAt = text.indexOf('记忆回顾：自上次回顾 3/10 轮。');
  const branchAt = text.indexOf('当前 git 分支：main');
  assert.ok(memoryAt >= 0 && userAt > memoryAt && keyAt > userAt, '三段顺序');
  assert.ok(closingAt > keyAt && reviewAt > closingAt && branchAt > reviewAt, '尾部顺序');
  assert.doesNotMatch(text, /other fact/, '按分支过滤掉 release 条目');
  assert.match(text, /\[branch:main\]/, '标签原样保留');
});

test('同样数据逐字节稳定；分支未知时全量注入且不显示分支行', () => {
  const { layout, store } = fixture();
  store.add('key', 'main only [branch:main]');
  store.add('key', 'release only [branch:release]');

  const options = { store, layout, review: { due: false, turns_since: 1, interval: 10 } };
  const first = renderLiveSnapshot(options);
  const second = renderLiveSnapshot(options);
  assert.equal(first, second);
  assert.match(first, /main only/);
  assert.match(first, /release only/);
  assert.doesNotMatch(first, /当前 git 分支/);
});

test('到点的回顾提示区分 suggest / auto 措辞', () => {
  const suggest = reviewStatusLine({ due: true, turns_since: 10, interval: 10 }, 'suggest');
  const auto = reviewStatusLine({ due: true, turns_since: 10, interval: 10 }, 'auto');
  assert.match(suggest, /action:'suggest'/);
  assert.match(suggest, /memory_review_status 的 complete/);
  assert.match(auto, /直接写入/);
  assert.doesNotMatch(auto, /action:'suggest'/);
  assert.match(suggest, /10\/10 轮/);
});

test('store 抛错时不冒泡（调用方仍能拿到字符串）', () => {
  const { layout } = fixture();
  const broken = {
    load() {
      throw new Error('disk exploded');
    },
    renderEntries() {
      throw new Error('render exploded');
    },
  };
  const text = renderLiveSnapshot({ store: broken, layout, branch: 'main' });
  assert.equal(typeof text, 'string');
  assert.match(text, /每回合收尾/);
});
