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
  const deferred = [];
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
  const exec = { session, deferContext: (message) => deferred.push(message) };
  return { dir, session, store, reviewLog, scheduler, tool, injected, deferred, exec, turnEnd };
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

test('complete：结算 diff、清零计数、写账本并把 notice 交给 deferContext', async () => {
  const { tool, turnEnd, store, reviewLog, deferred, injected, exec, dir } = fixture();
  turnEnd();
  turnEnd();
  turnEnd();
  assert.equal(tool.execute({ action: 'status' }, exec).due, true);

  store.add('memory', 'new durable fact');
  const res = tool.execute({ action: 'complete' }, exec);
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
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].role, 'user');
  assert.equal(deferred[0].source.kind, 'memory-review');
  assert.equal(deferred[0].source.form, 'notice');
  assert.match(deferred[0].content[0].text, /记忆已更新/);
  assert.equal(injected.length, 0, 'deferContext 可用时不再走 agent.inject');
});

test('complete：没有 deferContext 时退回 agent.inject（仍是 user 角色）', () => {
  const { tool, turnEnd, session, store, injected, exec } = fixture();
  turnEnd();
  turnEnd();
  turnEnd();
  store.add('memory', 'fallback fact');
  const res = tool.execute({ action: 'complete' }, { ...exec, deferContext: undefined, agent: { inject: (m) => injected.push(m) } });
  assert.equal(res.success, true);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].role, 'user');
  assert.equal(injected[0].source.form, 'notice');
});

test('complete 之后再次 complete：计数仍为 0，diff 为空', () => {
  const { tool, turnEnd, reviewLog, exec } = fixture();
  turnEnd();
  turnEnd();
  turnEnd();
  tool.execute({ action: 'complete' }, exec);
  const again = tool.execute({ action: 'complete' }, exec);
  assert.equal(again.due, false);
  assert.equal(again.turns_since, 0);
  assert.match(again.summary, /MEMORY \+0/);
  assert.equal(reviewLog.count(), 2);
});

test("noticeMode:'off'：照样记账，不投递 notice", () => {
  const { tool, turnEnd, reviewLog, deferred, injected, exec } = fixture({ noticeMode: 'off' });
  turnEnd();
  turnEnd();
  turnEnd();
  const res = tool.execute({ action: 'complete' }, exec);
  assert.equal(res.success, true);
  assert.equal(reviewLog.count(), 1);
  assert.equal(deferred.length, 0);
  assert.equal(injected.length, 0);
});

test('未知 action 返回 success:false', () => {
  const { tool, session } = fixture();
  const res = tool.execute({ action: 'frobnicate' }, { session });
  assert.equal(res.success, false);
  assert.match(res.error, /Unknown action/);
});
