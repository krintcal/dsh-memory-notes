/**
 * 0.7.0 回合内自审状态：`<dir>/review-state.json`。
 *
 * 旧版每 N 轮起一个 fork 子会话做 review；0.7.0 改成让主会话在到点的回合里
 * 自己完成回顾（快照里给提示），complete 时再结算。这里只存纯数字时间戳，
 * 坏文件/缺失一律当空状态，写失败只 warn（绝不打断回合）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const REVIEW_STATE_FILE = 'review-state.json';

export function emptyReviewState() {
  return {
    turns_since_review: 0,
    total_turns: 0,
    last_review_at: null,
    due_since: null,
    last_completed_at: null,
  };
}

function stateFile(dir) {
  return path.join(dir, REVIEW_STATE_FILE);
}

function normalize(value) {
  const base = emptyReviewState();
  if (!value || typeof value !== 'object') return base;
  const count = (raw) => (Number.isFinite(Number(raw)) ? Math.max(0, Math.trunc(Number(raw))) : 0);
  const stamp = (raw) => (typeof raw === 'string' && raw ? raw : null);
  return {
    turns_since_review: count(value.turns_since_review),
    total_turns: count(value.total_turns),
    last_review_at: stamp(value.last_review_at),
    due_since: stamp(value.due_since),
    last_completed_at: stamp(value.last_completed_at),
  };
}

export function loadReviewState(dir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')));
  } catch {
    return emptyReviewState();
  }
}

export function saveReviewState(dir, state) {
  const next = normalize(state);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = stateFile(dir);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      console.warn(`[memory-notes] failed to save review state: ${error?.message ?? error}`);
    } catch {
      /* ignore */
    }
  }
  return next;
}

/** 每用户回合 +1；第一次到点时记下 due_since（窗口开始时间）。 */
export function recordTurn(dir, state, interval) {
  const next = normalize(state);
  const limit = Math.max(1, Number(interval) || 10);
  next.turns_since_review += 1;
  next.total_turns += 1;
  if (next.turns_since_review >= limit && !next.due_since) next.due_since = new Date().toISOString();
  return saveReviewState(dir, next);
}

export function reviewStatus(state, interval) {
  const next = normalize(state);
  const limit = Math.max(1, Number(interval) || 10);
  const due = next.turns_since_review >= limit || Boolean(next.due_since);
  return {
    due,
    turns_since: next.turns_since_review,
    interval: limit,
    label: `${next.turns_since_review}/${limit}`,
  };
}

/** 完成回顾：清零本轮计数，记完成时间；due_since 一并清掉。 */
export function completeReview(dir, state) {
  const next = normalize(state);
  const now = new Date().toISOString();
  next.turns_since_review = 0;
  next.due_since = null;
  next.last_review_at = now;
  next.last_completed_at = now;
  return saveReviewState(dir, next);
}
