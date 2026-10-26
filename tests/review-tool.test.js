import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/store.js';
import { createNudgeScheduler } from '../src/nudge.js';
import { createReviewLog } from '../src/review-log.js';
import { reviewToolDefinition } from '../src/review-tool.js';
import { count as countSuggestions, enqueue, list as listSuggestions } from '../src/suggestions.js';
import { loadReviewState } from '../src/review-state.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-review-tool-'));
}

function fakeCtx(agent) {
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

function fixture({ interval = 3, noticeMode = 'on' } = {}) {
  const dir = tempDir();
  const injected = [];
  const session = { id: 'session-review-tool' };
  const agent = { id: session.id, inject: (message) => injected.push(message) };
  const ctx = fakeCtx(agent);
  const store = new MemoryStore({ dir });
  const reviewLog = createReviewLog(dir);
  const scheduler = createNudgeScheduler({
    ctx,
    store,
    config: { dir, nudgeInterval: interval, noticeMode, reviewLog },
  });
  const suggestions = {
    list: () => listSuggestions(dir),
    count: () => countSuggestions(dir),
  };
  const tool = reviewToolDefinition({ dir, interval, mode: 'suggest', suggestions, scheduler });
  const turnEnd = () => ctx.emit(session, { type: 'turn/end' });
  return { dir, session, store, reviewLog, scheduler, tool, injected, turnEnd };
}

test('status：返回约定字段，未到点 due=false', () => {
  const { tool, dir, session } = fixture();
  enqueue(dir, { target: 'memory', text: 'queued note', source: 'review' });
  const res = tool.execute({ action: 'status' }, { session });
  assert.equal(res.success, true);
  assert.equal(res.due, false);
  assert.equal(res.turns_since, 0);
  assert.equal(res.interval, 3);
  assert.equal(res.mode, 'suggest');
  assert.equal(res.suggestions_pending, 1);
  assert.equal(res.last_review_at, null);
  assert.equal(res.last_completed_at, null);
});

test('complete：结算 diff、清零计数、写账本并通知主会话', async () => {
  const { tool, turnEnd, session, store, reviewLog, injected, dir } = fixture();
  turnEnd();
  turnEnd();
  turnEnd();
  assert.equal(tool.execute({ action: 'status' }, { session }).due, true);

  store.add('memory', 'new durable fact');
  const res = tool.execute({ action: 'complete' }, { session });
  assert.equal(res.success, true);
  assert.equal(res.due, false);
  assert.equal(res.turns_since, 0);
  assert.equal(res.interval, 3);
  assert.ok(res.last_completed_at);
  assert.match(res.summary, /回顾完成：MEMORY \+1/);

  const state = loadReviewState(dir);
  assert.equal(state.turns_since_review, 0);
  assert.equal(state.total_turns, 3);

  assert.equal(reviewLog.count(), 1);
  const entry = reviewLog.recent(1)[0];
  assert.equal(entry.channel, 'review');
  assert.deepEqual(entry.memory.added, ['new durable fact']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /记忆已更新/);
});

test('complete 之后再次 complete：计数仍为 0，diff 为空', () => {
  const { tool, turnEnd, session, reviewLog } = fixture();
  turnEnd();
  turnEnd();
  turnEnd();
  tool.execute({ action: 'complete' }, { session });
  const again = tool.execute({ action: 'complete' }, { session });
  assert.equal(again.due, false);
  assert.equal(again.turns_since, 0);
  assert.match(again.summary, /MEMORY \+0/);
  assert.equal(reviewLog.count(), 2);
});

test("noticeMode:'off'：照样记账，不 inject", () => {
  const { tool, turnEnd, session, reviewLog, injected } = fixture({ noticeMode: 'off' });
  turnEnd();
  turnEnd();
  turnEnd();
  const res = tool.execute({ action: 'complete' }, { session });
  assert.equal(res.success, true);
  assert.equal(reviewLog.count(), 1);
  assert.equal(injected.length, 0);
});

test('未知 action 返回 success:false', () => {
  const { tool, session } = fixture();
  const res = tool.execute({ action: 'frobnicate' }, { session });
  assert.equal(res.success, false);
  assert.match(res.error, /Unknown action/);
});
