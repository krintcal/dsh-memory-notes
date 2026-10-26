/**
 * 后台 review 账本：每次 review 结束后记一条「这次改了什么」，供主会话提示与
 * 左侧栏面板展示。只保留最近 50 条，文件是 `<dir>/review-log.json`。
 *
 * diff 的配对刻意保守：只有「正好一增一删、且两边条目数相同」时才认为是一次改写
 * （changed = [before, after]）；其余一律按新增/删除列，避免把不相关的条目硬配成对。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 50;
const PREVIEW_LIMIT = 80;

function id() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** 入参是字符串数组（store.load() 的 entries）。 */
export function diffEntries(before = [], after = []) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  let added = after.filter((entry) => !beforeSet.has(entry));
  let removed = before.filter((entry) => !afterSet.has(entry));
  const changed = [];
  if (added.length === 1 && removed.length === 1 && before.length === after.length) {
    changed.push([removed[0], added[0]]);
    added = [];
    removed = [];
  }
  return { added, removed, changed };
}

function countPart(diff = {}) {
  return `+${(diff.added ?? []).length} ~${(diff.changed ?? []).length} -${(diff.removed ?? []).length}`;
}

export function summarizeDiff(diff = {}) {
  const parts = [`MEMORY ${countPart(diff.memory)}`, `USER ${countPart(diff.user)}`];
  // 0.7.0：key 轨只有真的参与 diff 时才追加，保持旧记录/旧测试的文案不变。
  if (diff.key !== undefined) parts.push(`KEY ${countPart(diff.key)}`);
  return parts.join(' · ');
}

export function isEmptyDiff(diff = {}) {
  return ['memory', 'user', 'key'].every((target) => {
    if (diff?.[target] === undefined) return true;
    const part = diff[target] ?? {};
    return !(
      (part.added?.length ?? 0) > 0 ||
      (part.removed?.length ?? 0) > 0 ||
      (part.changed?.length ?? 0) > 0
    );
  });
}

function clip(value) {
  const text = String(value ?? '');
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

/** 'verbose' 档用的变更预览：最多 3 条，前缀 + / ~ / -。 */
export function diffPreview(diff = {}) {
  const lines = [];
  for (const [prefix, key] of [['+', 'added'], ['~', 'changed'], ['-', 'removed']]) {
    const part = diff?.[key];
    if (!Array.isArray(part)) continue;
    for (const value of part) {
      if (lines.length >= 3) return lines;
      const text = key === 'changed' && Array.isArray(value) ? `${value[0]} → ${value[1]}` : value;
      lines.push(`${prefix} ${clip(text)}`);
    }
  }
  return lines;
}

export function createReviewLog(dir) {
  const file = path.join(dir, 'review-log.json');

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function write(entries) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  function record(entry = {}) {
    const now = Date.now();
    const full = {
      id: id(),
      started_at: now,
      finished_at: now,
      ...entry,
    };
    try {
      const entries = read();
      entries.push(full);
      write(entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries);
    } catch (error) {
      try {
        console.warn(`[memory-notes] failed to record review: ${error?.message ?? error}`);
      } catch {
        /* ignore */
      }
    }
    return full;
  }

  return {
    file,
    append(entry = {}) {
      return record(entry);
    },
    record,
    recent(n = 10) {
      const size = Math.max(0, Number(n) || 0);
      if (size === 0) return [];
      return read().slice(-size).reverse();
    },
    count() {
      return read().length;
    },
  };
}
