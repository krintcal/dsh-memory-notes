import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNudgeScheduler } from '../src/nudge.js';
import { createReviewLog } from '../src/review-log.js';

/** 最小假宿主：只实现调度器用到的 ctx.on / ctx.get（services）。 */
function makeCtx({ agent, startActivation } = {}) {
  const listeners = new Map();
  const services = {
    agents: { get: (id) => (agent && agent.id === id ? agent : undefined) },
  };
  if (startActivation) services.subagents = { startActivation };
  const ctx = {
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {
        const current = listeners.get(name) ?? [];
        const index = current.indexOf(fn);
        if (index >= 0) current.splice(index, 1);
      };
    },
    get(name) {
      return services[name];
    },
    agents: services.agents,
    emit(session, event) {
      for (const fn of listeners.get('session/event') ?? []) fn(session, event);
    },
  };
  return ctx;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-nudge-'));
}

const turnEnd = (session) => [session, { type: 'turn/end' }];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function schedulerFor(dir, ctx, overrides = {}) {
  const { store, ...rest } = overrides;
  return createNudgeScheduler({
    ctx,
    store: store ?? { dir },
    config: { dir, nudgeInterval: 10, provider: 'fork', ...rest },
  });
}

test('第 9 个回合不触发，第 10 个回合触发且只触发一次', async () => {
  const dir = tempDir();
  const calls = [];
  const session = { id: 'session-a' };
  const ctx = makeCtx({
    agent: { id: 'session-a' },
    startActivation: (spec) => {
      calls.push(spec);
      return Promise.resolve({ childId: 'child-1', result: new Promise(() => {}) });
    },
  });
  const scheduler = schedulerFor(dir, ctx);

  for (let i = 0; i < 9; i += 1) ctx.emit(...turnEnd(session));
  await tick();
  assert.equal(calls.length, 0, '9 轮不该触发');

  ctx.emit(...turnEnd(session));
  await tick();
  assert.equal(calls.length, 1, '第 10 轮应触发一次');
  assert.equal(calls[0].provider, 'fork');
  assert.equal(calls[0].delivery, 'caller');
  assert.equal(calls[0].request.parent.id, 'session-a');
  assert.match(calls[0].request.prompt[0].text, /memory tool/);
  assert.match(calls[0].request.prompt[0].text, /\*\*Skills\*\*/);
  scheduler.dispose();
});

test('触发后计数清零，再数满 10 轮才再次触发', async () => {
  const dir = tempDir();
  const calls = [];
  const session = { id: 'session-b' };
  const ctx = makeCtx({
    agent: { id: 'session-b' },
    startActivation: (spec) => {
      calls.push(spec);
      return Promise.resolve({ childId: `child-${calls.length}`, result: new Promise(() => {}) });
    },
  });
  const scheduler = schedulerFor(dir, ctx);

  for (let i = 0; i < 20; i += 1) {
    ctx.emit(...turnEnd(session));
    await tick();
  }
  assert.equal(calls.length, 2, '20 轮应触发 2 次');
  scheduler.dispose();
});

test('review 子会话自己的 turn/end 不计数、不触发', async () => {
  const dir = tempDir();
  const calls = [];
  const session = { id: 'session-c' };
  const ctx = makeCtx({
    agent: { id: 'session-c' },
    startActivation: () => {
      calls.push(1);
      return Promise.resolve({ childId: 'child-c', result: new Promise(() => {}) });
    },
  });
  const scheduler = schedulerFor(dir, ctx);

  for (let i = 0; i < 10; i += 1) ctx.emit(...turnEnd(session));
  await tick();
  assert.equal(calls.length, 1);

  // 子会话连来 30 个 turn/end，一次都不该再触发
  for (let i = 0; i < 30; i += 1) ctx.emit(...turnEnd({ id: 'child-c' }));
  await tick();
  assert.equal(calls.length, 1, '子会话不得触发 review');
  scheduler.dispose();
});

test('取不到 parent agent 时不触发，计数保留到下一轮', async () => {
  const dir = tempDir();
  const calls = [];
  const session = { id: 'session-d' };
  let agent = undefined;
  const ctx = makeCtx({
    agent: undefined,
    startActivation: () => {
      calls.push(1);
      return Promise.resolve({ childId: 'child-d', result: new Promise(() => {}) });
    },
  });
  ctx.agents.get = (id) => (agent && agent.id === id ? agent : undefined);
  const scheduler = schedulerFor(dir, ctx);

  for (let i = 0; i < 10; i += 1) ctx.emit(...turnEnd(session));
  await tick();
  assert.equal(calls.length, 0, '没有 parent 不能起 review');

  agent = { id: 'session-d' };
  ctx.emit(...turnEnd(session));
  await tick();
  assert.equal(calls.length, 1, '下一轮应补上');
  scheduler.dispose();
});

test('startActivation 抛错不冒泡，下一轮还能重试', async () => {
  const dir = tempDir();
  let attempts = 0;
  const session = { id: 'session-e' };
  const ctx = makeCtx({
    agent: { id: 'session-e' },
    startActivation: () => {
      attempts += 1;
      throw new Error('boom');
    },
  });
  const scheduler = schedulerFor(dir, ctx);

  for (let i = 0; i < 10; i += 1) ctx.emit(...turnEnd(session));
  await tick();
  assert.equal(attempts, 1, '第 10 轮尝试过一次');

  ctx.emit(...turnEnd(session));
  await tick();
  assert.equal(attempts, 2, '失败后下一轮重试');
  scheduler.dispose();
});

test('计数持久化：新实例能接着上一实例的进度', async () => {
  const dir = tempDir();
  const session = { id: 'session-f' };
  // 第一个实例先跑 3 轮
  const ctx1 = makeCtx({ agent: { id: 'session-f' } });
  const scheduler1 = schedulerFor(dir, ctx1);
  for (let i = 0; i < 3; i += 1) ctx1.emit(...turnEnd(session));
  scheduler1.dispose();
  assert.ok(fs.existsSync(path.join(dir, 'nudge-state.json')), '应写出状态文件');

  // 新实例：再 7 轮才满 10
  const calls = [];
  const ctx2 = makeCtx({
    agent: { id: 'session-f' },
    startActivation: () => {
      calls.push(1);
      return Promise.resolve({ childId: 'child-f', result: new Promise(() => {}) });
    },
  });
  const scheduler2 = schedulerFor(dir, ctx2);
  for (let i = 0; i < 6; i += 1) ctx2.emit(...turnEnd(session));
  await tick();
  assert.equal(calls.length, 0, '3+6=9 轮还不该触发');
  ctx2.emit(...turnEnd(session));
  await tick();
  assert.equal(calls.length, 1, '第 10 轮触发');
  scheduler2.dispose();
});

test('没有 subagents 服务时安静降级（不抛、不写坏状态）', async () => {
  const dir = tempDir();
  const session = { id: 'session-g' };
  const ctx = makeCtx({ agent: { id: 'session-g' } });
  const scheduler = schedulerFor(dir, ctx);
  for (let i = 0; i < 12; i += 1) ctx.emit(...turnEnd(session));
  await tick();
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'nudge-state.json'), 'utf8'));
  assert.equal(state.sessions['session-g'].turns, 12, '降级时计数照常累加');
  scheduler.dispose();
});

/* ------------------------- Phase 1：review 完成后的提示 ------------------------- */

function memoryStoreStub(dir, initial = {}) {
  const data = { memory: [...(initial.memory ?? [])], user: [...(initial.user ?? [])] };
  return {
    dir,
    data,
    load(target) {
      return [...data[target]];
    },
  };
}

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) await tick();
}

test('review 完成后 review-log 有记录（noticeMode: off 也不影响记录）', async () => {
  const dir = tempDir();
  const reviewLog = createReviewLog(dir);
  const store = memoryStoreStub(dir, { memory: ['old note'] });
  const session = { id: 'session-review-log' };
  const injected = [];
  const ctx = makeCtx({
    agent: { id: 'session-review-log', inject: (message) => injected.push(message) },
    startActivation: () => ({
      childId: 'child-log',
      result: Promise.resolve().then(() => {
        store.data.memory = ['old note', 'new note'];
      }),
    }),
  });
  const scheduler = schedulerFor(dir, ctx, { store, reviewLog, noticeMode: 'off' });

  for (let i = 0; i < 10; i += 1) ctx.emit(...turnEnd(session));
  await flush();

  assert.equal(reviewLog.count(), 1);
  const entry = reviewLog.recent(1)[0];
  assert.equal(entry.channel, 'review');
  assert.equal(entry.session_id, 'session-review-log');
  assert.equal(entry.child_id, 'child-log');
  assert.deepEqual(entry.memory.added, ['new note']);
  assert.match(entry.summary, /MEMORY \+1/);
  assert.equal(injected.length, 0, 'off 档不 inject');
  scheduler.dispose();
});

test("noticeMode: 'on' 注入一条 developer 消息，含「记忆已更新」", async () => {
  const dir = tempDir();
  const store = memoryStoreStub(dir, { memory: [] });
  const injected = [];
  const session = { id: 'session-on' };
  const ctx = makeCtx({
    agent: { id: 'session-on', inject: (message) => injected.push(message) },
    startActivation: () => ({
      childId: 'child-on',
      result: Promise.resolve().then(() => {
        store.data.memory = ['remember this'];
      }),
    }),
  });
  const scheduler = schedulerFor(dir, ctx, { store, reviewLog: createReviewLog(dir), noticeMode: 'on' });

  for (let i = 0; i < 10; i += 1) ctx.emit(...turnEnd(session));
  await flush();

  assert.equal(injected.length, 1);
  const message = injected[0];
  assert.equal(message.role, 'developer');
  assert.deepEqual(message.source, { kind: 'memory-review' });
  assert.match(message.content[0].text, /记忆已更新/);
  assert.match(message.content[0].text, /详情见左侧栏/);
  scheduler.dispose();
});

test("noticeMode: 'verbose' 额外带最多 3 条变更预览", async () => {
  const dir = tempDir();
  const longText = `very long memory entry ${'x'.repeat(120)}`;
  const store = memoryStoreStub(dir, { memory: [] });
  const injected = [];
  const session = { id: 'session-verbose' };
  const ctx = makeCtx({
    agent: { id: 'session-verbose', inject: (message) => injected.push(message) },
    startActivation: () => ({
      childId: 'child-verbose',
      result: Promise.resolve().then(() => {
        store.data.memory = [longText, 'second', 'third', 'fourth'];
      }),
    }),
  });
  const scheduler = schedulerFor(dir, ctx, { store, reviewLog: createReviewLog(dir), noticeMode: 'verbose' });

  for (let i = 0; i < 10; i += 1) ctx.emit(...turnEnd(session));
  await flush();

  assert.equal(injected.length, 1);
  const text = injected[0].content[0].text;
  assert.match(text, /\+ /, '新增条目要带 + 前缀');
  assert.match(text, /very long memory entry/);
  const previewLines = text.split('\n').slice(1);
  assert.ok(previewLines.length <= 3, `最多 3 条预览，实际 ${previewLines.length}`);
  scheduler.dispose();
});

test('inject 抛错不影响 review 完成与账本记录', async () => {
  const dir = tempDir();
  const reviewLog = createReviewLog(dir);
  const store = memoryStoreStub(dir, { memory: [] });
  const session = { id: 'session-inject-throw' };
  const ctx = makeCtx({
    agent: {
      id: 'session-inject-throw',
      inject: () => {
        throw new Error('inject refused');
      },
    },
    startActivation: () => ({
      childId: 'child-throw',
      result: Promise.resolve().then(() => {
        store.data.memory = ['written'];
      }),
    }),
  });
  const scheduler = schedulerFor(dir, ctx, { store, reviewLog, noticeMode: 'on' });

  for (let i = 0; i < 10; i += 1) ctx.emit(...turnEnd(session));
  await flush();
  assert.equal(reviewLog.count(), 1);
  assert.deepEqual(reviewLog.recent(1)[0].memory.added, ['written']);
  scheduler.dispose();
});
