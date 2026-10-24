import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../src/store.js';
import { createPendingStore, PENDING_ID_RE } from '../src/pending.js';
import { createWebApi, isLoopbackRequest } from '../src/web.js';

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-web-'));
  const store = new MemoryStore({ dir, ...opts });
  const pending = createPendingStore(path.join(dir, 'pending'));
  return { dir, store, pending, api: createWebApi({ store, pending }) };
}

function fakeRequest(overrides = {}) {
  return {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:9072', ...(overrides.headers ?? {}) },
    ...overrides,
  };
}

test('state 返回两库条目、用量与空 pending', () => {
  const { store, api } = fixture();
  store.add('memory', 'Repo lives at E:\\dsh\\work');
  store.add('user', 'User prefers concise replies');

  const state = api.state();
  assert.equal(state.ok, true);
  assert.deepEqual(state.targets.memory.entries, ['Repo lives at E:\\dsh\\work']);
  assert.deepEqual(state.targets.user.entries, ['User prefers concise replies']);
  assert.equal(state.targets.memory.used, 'Repo lives at E:\\dsh\\work'.length);
  assert.match(state.targets.user.usage, /^\d+% — \d+\/1,375 chars$/);
  assert.deepEqual(state.pending, []);
});

test('write 支持 add / patch / remove，并回带最新 state', () => {
  const { store, api } = fixture();

  const added = api.write({ target: 'memory', action: 'add', content: 'alpha beta' });
  assert.equal(added.ok, true);
  assert.deepEqual(added.state.targets.memory.entries, ['alpha beta']);

  const patched = api.write({ target: 'memory', action: 'patch', old_text: 'beta', content: 'gamma' });
  assert.equal(patched.ok, true);
  assert.deepEqual(store.entries('memory'), ['alpha gamma']);

  const removed = api.write({ target: 'memory', action: 'remove', old_text: 'alpha gamma' });
  assert.equal(removed.ok, true);
  assert.deepEqual(store.entries('memory'), []);
});

test('write 的非法输入返回 ok:false 且不动数据', () => {
  const { store, api } = fixture();
  store.add('memory', 'keep me');

  assert.equal(api.write({ target: 'memory', action: 'add', content: '   ' }).ok, false);
  assert.equal(api.write({ target: 'memory', action: 'patch', old_text: 'keep' }).ok, false);
  assert.equal(api.write({ target: 'memory', action: 'remove' }).ok, false);
  assert.equal(api.write({ target: 'memory', action: 'frobnicate' }).ok, false);
  assert.equal(api.write({ target: 'nope', action: 'add', content: 'x' }).ok, false);
  assert.deepEqual(store.entries('memory'), ['keep me']);
});

test('pending：批准后按 pin 的条目重放，记录被删掉', () => {
  const { store, pending, api } = fixture();
  store.add('user', 'User prefers long answers');

  const record = {
    target: 'user',
    action: 'patch',
    old_text: 'long answers',
    content: 'concise replies',
    matched_entry: 'User prefers long answers',
  };
  const { id, record: saved } = pending.save(record);
  assert.equal(api.pendingDecision({ id, decision: 'apply' }).ok, true);
  assert.deepEqual(store.entries('user'), ['User prefers concise replies']);
  assert.equal(pending.list().length, 0);
  assert.ok(PENDING_ID_RE.test(saved.id));
});

test('pending：条目在提案后被改过 → stale 拒绝，记录保留', () => {
  const { store, pending, api } = fixture();
  store.add('user', 'User prefers long answers');
  const { id } = pending.save({
    target: 'user',
    action: 'remove',
    old_text: 'User prefers long answers',
    matched_entry: 'User prefers long answers',
  });
  // 提案之后主会话又改了这条
  store.patch('user', 'long answers', 'short answers');

  const result = api.pendingDecision({ id, decision: 'apply' });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /stale|no longer/i);
  assert.deepEqual(store.entries('user'), ['User prefers short answers']);
  assert.equal(pending.list().length, 1);

  // discard 可以清掉它
  assert.equal(api.pendingDecision({ id, decision: 'discard' }).ok, true);
  assert.equal(pending.list().length, 0);
});

test('pending：缺 pin 的旧记录拒绝执行（fail-closed）', () => {
  const { store, pending, api } = fixture();
  store.add('memory', 'keep me');
  const { id } = pending.save({ target: 'memory', action: 'remove', old_text: 'keep me' });

  const result = api.pendingDecision({ id, decision: 'apply' });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /predates entry pinning/i);
  assert.deepEqual(store.entries('memory'), ['keep me']);
});

test('未知 pending id 返回错误', () => {
  const { api } = fixture();
  assert.equal(api.pendingDecision({ id: 'nothere', decision: 'apply' }).ok, false);
});

test('isLoopbackRequest：回环放行，转发头/跨站/非回环地址拒绝', () => {
  assert.equal(isLoopbackRequest(fakeRequest()), true);
  assert.equal(isLoopbackRequest(fakeRequest({ socket: { remoteAddress: '::1' } })), true);
  assert.equal(isLoopbackRequest(fakeRequest({ socket: { remoteAddress: '10.0.0.5' } })), false);
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { host: '127.0.0.1:9072', 'x-forwarded-for': '1.2.3.4' } })), false);
  assert.equal(isLoopbackRequest(fakeRequest({ headers: { host: 'evil.example', origin: 'http://evil.example' } })), false);
  assert.equal(
    isLoopbackRequest(fakeRequest({ headers: { host: '127.0.0.1:9072', 'sec-fetch-site': 'cross-site' } })),
    false,
  );
  assert.equal(
    isLoopbackRequest(fakeRequest({ headers: { host: '127.0.0.1:9072', origin: 'http://127.0.0.1:9072' } })),
    true,
  );
});
