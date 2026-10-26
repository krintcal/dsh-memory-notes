import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNudgeScheduler, reviewPrompt } from '../src/nudge.js';
import { createReviewLog } from '../src/review-log.js';
import { loadReviewState } from '../src/review-state.js';
import { clearReviewSession, markReviewSession } from '../src/review-registry.js';
import { MemoryStore } from '../src/store.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-nudge-'));
}

function makeCtx({ agent } = {}) {
  const listeners = new Map();
  return {
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
      if (name === 'agents') return { get: (id) => (agent && agent.id === id ? agent : undefined) };
      return undefined;
    },
    emit(session, event) {
      for (const fn of listeners.get('session/event') ?? []) fn(session, event);
    },
  };
}

const turnEnd = (session) => [session, { type: 'turn/end' }];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup({ interval = 10, noticeMode = 'on' } = {}) {
  const dir = tempDir();
  const injected = [];
  const session = { id: 'session-a' };
  const agent = { id: session.id, inject: (message) => injected.push(message) };
  const ctx = makeCtx({ agent });
  const store = new MemoryStore({ dir });
  const reviewLog = createReviewLog(dir);
  const scheduler = createNudgeScheduler({
    ctx,
    store,
    config: { dir, nudgeInterval: interval, noticeMode, reviewLog },
  });
  return { dir, ctx, store, reviewLog, scheduler, session, injected, agent };
}

test('reviewPrompt 保留记忆与技能两套提示词', () => {
  const prompt = reviewPrompt({ memory: true, skills: true, skillsEnabled: true });
  assert.match(prompt, /memory tool/);
  assert.match(prompt, /\*\*Skills\*\*/);
  assert.match(prompt, /Be ACTIVE/);
  assert.match(reviewPrompt({ memory: true, skills: false }), /One fact goes to ONE store/);
});

test('第 9 个回合不到点，第 10 个到点且不启动任何子代理', async () => {
  const { ctx, session, scheduler } = setup();
  for (let i = 0; i < 9; i += 1) ctx.emit(...turnEnd(session));
  await tick();
  assert.equal(scheduler.status().due, false);
  assert.equal(scheduler.status().turns_since, 9);

  ctx.emit(...turnEnd(session));
  await tick();
  assert.equal(scheduler.status().due, true);
  assert.equal(scheduler.status().turns_since, 10);
  scheduler.dispose();
});

test('到点后捕获窗口前快照；finishReview 只结算窗口内的变化', async () => {
  const { ctx, session, scheduler, store, reviewLog, injected, dir } = setup({ interval: 2 });
  ctx.emit(...turnEnd(session));
  ctx.emit(...turnEnd(session));
  await tick();
  assert.equal(scheduler.status().due, true);

  store.add('memory', 'fact learned during review');
  const result = scheduler.finishReview(session.id);
  await tick();

  assert.match(result.summary, /MEMORY \+1/);
  assert.equal(reviewLog.count(), 1);
  assert.deepEqual(reviewLog.recent(1)[0].memory.added, ['fact learned during review']);
  assert.equal(loadReviewState(dir).turns_since_review, 0);
  assert.equal(scheduler.status().due, false);
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /记忆已更新/);
  scheduler.dispose();
});

test('同一个 due 窗口只捕获一次 before：多次 turn/end 不刷新基线', async () => {
  const { ctx, session, scheduler, store, reviewLog } = setup({ interval: 2 });
  ctx.emit(...turnEnd(session));
  ctx.emit(...turnEnd(session));
  store.add('memory', 'written before more turns');
  // 到点后继续来回合：基线仍是第一次 due 时（空库）
  ctx.emit(...turnEnd(session));
  ctx.emit(...turnEnd(session));
  scheduler.finishReview(session.id);
  assert.deepEqual(reviewLog.recent(1)[0].memory.added, ['written before more turns']);
  scheduler.dispose();
});

test('review 子会话自己的 turn/end 不计数', async () => {
  const { ctx, scheduler } = setup({ interval: 2 });
  const child = { id: 'review-child' };
  markReviewSession(child.id);
  try {
    for (let i = 0; i < 10; i += 1) ctx.emit(...turnEnd(child));
    assert.equal(scheduler.status().turns_since, 0);
  } finally {
    clearReviewSession(child.id);
  }
  scheduler.dispose();
});

test('计数持久化：新实例接着上一实例的进度', () => {
  const dir = tempDir();
  const session = { id: 'session-persist' };
  const ctx1 = makeCtx();
  const scheduler1 = createNudgeScheduler({
    ctx: ctx1,
    store: new MemoryStore({ dir }),
    config: { dir, nudgeInterval: 10 },
  });
  for (let i = 0; i < 3; i += 1) ctx1.emit(...turnEnd(session));
  scheduler1.dispose();

  const ctx2 = makeCtx();
  const scheduler2 = createNudgeScheduler({
    ctx: ctx2,
    store: new MemoryStore({ dir }),
    config: { dir, nudgeInterval: 10 },
  });
  assert.equal(scheduler2.status().turns_since, 3);
  for (let i = 0; i < 6; i += 1) ctx2.emit(...turnEnd(session));
  assert.equal(scheduler2.status().due, false);
  ctx2.emit(...turnEnd(session));
  assert.equal(scheduler2.status().due, true);
  scheduler2.dispose();
});

test("noticeMode:'off' 只记账本，不 inject；没有变化时提示未保存内容", async () => {
  const { ctx, session, scheduler, reviewLog, injected } = setup({ interval: 1, noticeMode: 'off' });
  ctx.emit(...turnEnd(session));
  scheduler.finishReview(session.id);
  assert.equal(reviewLog.count(), 1);
  assert.equal(injected.length, 0);
  scheduler.dispose();

  const on = setup({ interval: 1, noticeMode: 'on' });
  on.ctx.emit(...turnEnd(on.session));
  on.scheduler.finishReview(on.session.id);
  await tick();
  assert.equal(on.injected.length, 1);
  assert.match(on.injected[0].content[0].text, /没有需要保存的内容/);
  on.scheduler.dispose();
});

test('dispose 后不再计数', () => {
  const { ctx, session, scheduler, dir } = setup();
  scheduler.dispose();
  ctx.emit(...turnEnd(session));
  assert.equal(loadReviewState(dir).turns_since_review, 0);
});
