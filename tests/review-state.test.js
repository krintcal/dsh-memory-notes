import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  REVIEW_STATE_FILE,
  completeReview,
  emptyReviewState,
  loadReviewState,
  recordTurn,
  reviewStatus,
  saveReviewState,
} from '../src/review-state.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-review-state-'));
}

test('缺失文件按空状态处理', () => {
  const dir = tempDir();
  assert.deepEqual(loadReviewState(dir), emptyReviewState());
});

test('坏 JSON / 非对象同样退化成空状态', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, REVIEW_STATE_FILE), '{not json', 'utf8');
  assert.deepEqual(loadReviewState(dir), emptyReviewState());
  fs.writeFileSync(path.join(dir, REVIEW_STATE_FILE), '[1,2,3]', 'utf8');
  assert.deepEqual(loadReviewState(dir), emptyReviewState());
});

test('recordTurn：total 与 since 同步累加，到点第一次记 due_since', () => {
  const dir = tempDir();
  let state = loadReviewState(dir);
  for (let i = 0; i < 2; i += 1) state = recordTurn(dir, state, 3);
  assert.equal(state.total_turns, 2);
  assert.equal(state.turns_since_review, 2);
  assert.equal(state.due_since, null);

  state = recordTurn(dir, state, 3);
  assert.equal(state.turns_since_review, 3);
  assert.ok(state.due_since);
  const firstDue = state.due_since;

  // 已经 due 的窗口不重置开始时间
  state = recordTurn(dir, state, 3);
  assert.equal(state.due_since, firstDue);
});

test('reviewStatus：due / turns_since / interval / label', () => {
  const state = { ...emptyReviewState(), turns_since_review: 3 };
  assert.deepEqual(reviewStatus(state, 10), {
    due: false,
    turns_since: 3,
    interval: 10,
    label: '3/10',
  });
  assert.equal(reviewStatus({ ...state, turns_since_review: 10 }, 10).due, true);
  assert.equal(reviewStatus({ ...state, due_since: '2026-01-01T00:00:00.000Z' }, 10).due, true);
});

test('completeReview：清零计数、写 last_completed_at，状态持久化', () => {
  const dir = tempDir();
  let state = loadReviewState(dir);
  for (let i = 0; i < 10; i += 1) state = recordTurn(dir, state, 10);
  const completed = completeReview(dir, state);
  assert.equal(completed.turns_since_review, 0);
  assert.equal(completed.due_since, null);
  assert.ok(completed.last_completed_at);
  assert.ok(completed.last_review_at);
  assert.equal(completed.total_turns, 10, '累计回合数不归零');

  const reloaded = loadReviewState(dir);
  assert.deepEqual(reloaded, completed);
});

test('saveReviewState 规范化非法字段', () => {
  const dir = tempDir();
  saveReviewState(dir, {
    turns_since_review: -5,
    total_turns: '7',
    last_review_at: 42,
    due_since: '',
    last_completed_at: undefined,
  });
  const state = loadReviewState(dir);
  assert.equal(state.turns_since_review, 0);
  assert.equal(state.total_turns, 7);
  assert.equal(state.last_review_at, null);
  assert.equal(state.due_since, null);
  assert.equal(state.last_completed_at, null);
});
