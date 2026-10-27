import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../src/store.js';
import { createPendingStore, PENDING_ID_RE } from '../src/pending.js';
import { createWebApi, isLoopbackRequest, buildRoutes, registerWebPanel } from '../src/web.js';
import {
  count as countSuggestions,
  drop as dropSuggestion,
  enqueue,
  list as listSuggestions,
  take as takeSuggestion,
} from '../src/suggestions.js';

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

function fakeResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: '',
    writeHead(status, responseHeaders) {
      this.statusCode = status;
      this.headers = responseHeaders;
    },
    end(body) {
      this.body = body;
    },
  };
}

function rawRequest({ method = 'GET', headers = {}, body = '' } = {}) {
  return {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:9072', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

async function callRoute(route, request) {
  const res = fakeResponse();
  await route.handler(request, res);
  return { res, payload: res.body ? JSON.parse(res.body) : null };
}

function postRoute(api, name) {
  const route = buildRoutes(api).find((item) => item.path === `/api/dsh-memory-notes/${name}`);
  assert.ok(route, `route ${name} exists`);
  return route;
}

test('POST 缺 content-type → 415', async () => {
  const { api } = fixture();
  const { res, payload } = await callRoute(
    postRoute(api, 'write'),
    rawRequest({
      method: 'POST',
      body: JSON.stringify({ target: 'memory', action: 'add', content: 'x' }),
    }),
  );
  assert.equal(res.statusCode, 415);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /content-type/);
});

test('POST text/plain → 415', async () => {
  const { api } = fixture();
  const { res, payload } = await callRoute(
    postRoute(api, 'write'),
    rawRequest({
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ target: 'memory', action: 'add', content: 'x' }),
    }),
  );
  assert.equal(res.statusCode, 415);
  assert.equal(payload.ok, false);
});

test('POST application/json; charset=utf-8 正常写入', async () => {
  const { store, api } = fixture();
  const { res, payload } = await callRoute(
    postRoute(api, 'write'),
    rawRequest({
      method: 'POST',
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
      body: JSON.stringify({ target: 'memory', action: 'add', content: 'hello' }),
    }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(store.entries('memory'), ['hello']);
});

test('registerWebPanel 通过 ctx.effect 注册路由，dispose 时调用每个 disposer', () => {
  const { store, pending } = fixture();
  const registered = [];
  const disposed = [];
  let effectLabel;
  let cleanup;

  const webCtx = {
    webServer: {
      register(route) {
        registered.push(route);
        return () => disposed.push(route.path);
      },
    },
    connection: { requestRejection: () => undefined },
    effect(fn, label) {
      effectLabel = label;
      cleanup = fn();
      return cleanup;
    },
  };

  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ['webServer', 'connection']);
      callback(webCtx);
    },
  };

  registerWebPanel(ctx, { store, pending });
  assert.match(String(effectLabel), /web routes/);
  assert.equal(registered.length, 5);
  assert.equal(disposed.length, 0);

  cleanup();
  assert.deepEqual(disposed.sort(), [
    '/api/dsh-memory-notes/pending',
    '/api/dsh-memory-notes/state',
    '/api/dsh-memory-notes/suggestions',
    '/api/dsh-memory-notes/sync',
    '/api/dsh-memory-notes/write',
  ]);
});

function suggestionFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-web-suggestions-'));
  const store = new MemoryStore({ dir });
  const pending = createPendingStore(path.join(dir, 'pending'));
  const suggestions = {
    enqueue: (record) => enqueue(dir, record),
    list: () => listSuggestions(dir),
    take: (id) => takeSuggestion(dir, id),
    drop: (id) => dropSuggestion(dir, id),
    count: () => countSuggestions(dir),
  };
  const api = createWebApi({
    store,
    pending,
    suggestions,
    review: () => ({ due: true, turns_since: 3, interval: 10, mode: 'suggest' }),
  });
  return { dir, store, pending, suggestions, api };
}

test('state 带 suggestions（最近 20）与 review 状态', () => {
  const { api, dir } = suggestionFixture();
  enqueue(dir, { target: 'memory', text: 'queued fact', source: 'review' });
  const state = api.state();
  assert.equal(state.ok, true);
  assert.equal(state.suggestions.length, 1);
  assert.equal(state.suggestions[0].text, 'queued fact');
  assert.equal(state.suggestions[0].target, 'memory');
  assert.deepEqual(state.review, { due: true, turns_since: 3, interval: 10, mode: 'suggest' });
});

test('suggestions accept：写入对应 store 后删除建议', () => {
  const { api, store, dir } = suggestionFixture();
  const { record } = enqueue(dir, { target: 'user', text: 'prefers concise replies', source: 'review' });
  const res = api.suggestionsDecision({ id: record.id, decision: 'accept' });
  assert.equal(res.ok, true);
  assert.equal(res.accepted_suggestion, record.id);
  assert.deepEqual(store.entries('user'), ['prefers concise replies']);
  assert.equal(res.state.suggestions.length, 0);
  assert.equal(countSuggestions(dir), 0);
});

test('suggestions discard：只删建议，不写存储', () => {
  const { api, store, dir } = suggestionFixture();
  const { record } = enqueue(dir, { target: 'memory', text: 'do not keep', source: 'review' });
  const res = api.suggestionsDecision({ id: record.id, decision: 'discard' });
  assert.equal(res.ok, true);
  assert.equal(res.discarded_suggestion, record.id);
  assert.deepEqual(store.entries('memory'), []);
  assert.equal(countSuggestions(dir), 0);
});

test('suggestions accept 失败（内容含 §）时保留建议', () => {
  const { api, store, dir } = suggestionFixture();
  const { record } = enqueue(dir, { target: 'memory', text: 'bad\n§\nentry', source: 'review' });
  const res = api.suggestionsDecision({ id: record.id, decision: 'accept' });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /§/);
  assert.deepEqual(store.entries('memory'), []);
  assert.equal(countSuggestions(dir), 1);
});

test('suggestions 未知 id / 非法 decision 返回 ok:false', () => {
  const { api, dir } = suggestionFixture();
  assert.equal(api.suggestionsDecision({ id: 'missing', decision: 'accept' }).ok, false);
  const { record } = enqueue(dir, { target: 'memory', text: 'x', source: 'review' });
  assert.equal(api.suggestionsDecision({ id: record.id, decision: 'maybe' }).ok, false);
  assert.equal(countSuggestions(dir), 1);
});

test('layered 记忆：state 暴露全部五轨（key/project/daily）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-web-layered-'));
  const store = new MemoryStore({
    dir,
    targets: ['memory', 'user', 'key', 'project', 'daily'],
    files: {
      key: path.join(dir, 'projects', 'abc123', 'KEY.md'),
      project: path.join(dir, 'projects', 'abc123', 'PROJECT.md'),
      daily: () => path.join(dir, 'daily', '2026-10-26.md'),
    },
  });
  const pending = createPendingStore(path.join(dir, 'pending'));
  const api = createWebApi({ store, pending });
  store.add('key', 'key entry [branch:main]');
  store.add('daily', 'daily entry');
  store.add('project', 'project entry');

  const state = api.state();
  assert.deepEqual(Object.keys(state.targets).sort(), ['daily', 'key', 'memory', 'project', 'user']);
  assert.deepEqual(state.targets.key.entries, ['key entry [branch:main]']);
  assert.deepEqual(state.targets.daily.entries, ['daily entry']);
  assert.deepEqual(state.targets.project.entries, ['project entry']);
});

/* --------------------- 0.8.0：面板路由 token 鉴权 --------------------- */

function authorizedRoutes(api, rejection) {
  return buildRoutes(api, {
    authorize(req, res) {
      if (rejection === undefined) return false;
      res.statusCode = rejection;
      res.end();
      return true;
    },
  });
}

test('authorize 返回拒绝时路由被拦下，store 不变', async () => {
  const { store, api } = fixture();
  store.add('memory', 'keep');
  const route = authorizedRoutes(api, 401).find((item) => item.path.endsWith('/write'));

  const { res } = await callRoute(
    route,
    rawRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'memory', action: 'add', content: 'hacked' }),
    }),
  );
  assert.equal(res.statusCode, 401);
  assert.deepEqual(store.entries('memory'), ['keep']);
});

test('authorize 放行时路由正常返回 200', async () => {
  const { api } = fixture();
  const route = authorizedRoutes(api, undefined).find((item) => item.path.endsWith('/state'));
  const { res, payload } = await callRoute(route, rawRequest({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ok, true);
});

test('registerWebPanel 无 connection 服务时 fail-open（不阻断）', async () => {
  const { store, pending } = fixture();
  const registered = [];
  const webCtx = {
    webServer: {
      register(route) {
        registered.push(route);
        return () => {};
      },
    },
    effect(fn) {
      fn();
    },
  };
  const ctx = {
    inject(_services, callback) {
      callback(webCtx);
    },
  };
  registerWebPanel(ctx, { store, pending });
  assert.equal(registered.length, 5);
  const stateRoute = registered.find((route) => route.path.endsWith('/state'));
  const { res, payload } = await callRoute(stateRoute, rawRequest({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ok, true);
});

test('pending batch 摘要带 operations 预览（每条截 120 字符）', () => {
  const { store, pending, api } = fixture();
  store.add('memory', 'alpha beta');
  const long = 'x'.repeat(400);
  pending.save({
    target: 'memory',
    action: 'batch',
    operations: [
      { action: 'patch', old_text: 'beta', content: long, matched_entry: 'alpha beta' },
      { action: 'remove', old_text: 'alpha beta', matched_entry: 'alpha beta' },
    ],
  });
  const item = api.state().pending[0];
  assert.equal(item.action, 'batch');
  assert.equal(item.operation_count, 2);
  assert.equal(item.operations.length, 2);
  assert.equal(item.operations[0].action, 'patch');
  assert.equal(item.operations[0].old_text, 'beta');
  assert.ok(item.operations[0].content.length <= 120);
  assert.match(item.operations[0].content, /…$/);
  assert.equal(item.operations[1].action, 'remove');
});

/* ---------------------- 0.9.0：同步路由与疑似重复 ---------------------- */

function syncRoute(api) {
  const routes = buildRoutes(api).filter((item) => item.path === '/api/dsh-memory-notes/sync');
  assert.equal(routes.length, 1, 'sync 同路径只注册一条路由（按 method 分派）');
  return routes[0];
}

test('GET /sync 导出 bundle，POST /sync 合并远端条目', async () => {
  const { store, api } = fixture();
  store.add('memory', 'local fact');

  const route = syncRoute(api);
  const exported = await callRoute(route, rawRequest({ method: 'GET' }));
  assert.equal(exported.res.statusCode, 200);
  assert.equal(exported.payload.ok, true);
  assert.equal(exported.payload.bundle.format, 'dsh-memory-notes/v1');
  assert.deepEqual(exported.payload.bundle.targets.memory, ['local fact']);

  const body = JSON.stringify({
    format: 'dsh-memory-notes/v1',
    device_id: 'dev-remote',
    targets: { memory: ['local fact', 'remote fact'] },
  });
  const merged = await callRoute(
    route,
    rawRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body }),
  );
  assert.equal(merged.res.statusCode, 200);
  assert.equal(merged.payload.ok, true);
  assert.equal(merged.payload.added, 1);
  assert.deepEqual(store.load('memory').sort(), ['local fact', 'remote fact']);
  assert.equal(merged.payload.state.targets.memory.entries.length, 2);
});

test('GET /sync 未通过鉴权时被拦截', async () => {
  const { api } = fixture();
  const authorize = (req, res) => {
    res.statusCode = 401;
    res.end();
    return true;
  };
  const routes = buildRoutes(api, { authorize });
  const route = routes.find((item) => item.path === '/api/dsh-memory-notes/sync');
  const { res } = await callRoute(route, rawRequest({ method: 'GET' }));
  assert.equal(res.statusCode, 401);
});

test('state 带 conflicts：高度相似的两条并列时给出提示', () => {
  // 0.10.0 起 add 会拦近似重复（0.75），这里关掉写入门，只验证 conflicts 提示链路。
  const { store, api } = fixture({ addSimilarityLimit: 0 });
  store.add('memory', 'config lives in dsh home');
  store.add('memory', 'config lives in dsh home directory');
  store.add('memory', 'unrelated fact about hermes gateway');

  const state = api.state();
  assert.equal(state.conflicts.length >= 1, true);
  const pair = state.conflicts[0];
  assert.equal(pair.target, 'memory');
  assert.equal(pair.similarity >= 0.8, true);
  assert.match(pair.a + pair.b, /config lives in dsh home/);
});
