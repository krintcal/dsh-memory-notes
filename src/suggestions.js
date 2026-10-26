/**
 * 回顾建议队列：`<dir>/SUGGESTIONS.jsonl`，最多 200 条。
 *
 * `reviewMode: 'suggest'` 时，模型在回顾里不直接写 memory/user/key，而是把内容
 * 放进这个队列；用户在左侧栏「记忆」面板逐条采纳/丢弃。记录形状：
 *   { id, created_at, target, text, source: 'review' | 'tool' }
 *
 * 已经采纳/丢弃的记录会被删除，所以「文件里还在」等价于「未处理」。相同
 * target + text 的重复入队是幂等的，直接返回已有 id。
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_SUGGESTIONS = 200;

export function suggestionsFile(dir) {
  return path.join(dir, 'SUGGESTIONS.jsonl');
}

function newId() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function normalize(record) {
  if (!record || typeof record !== 'object') return undefined;
  const target = typeof record.target === 'string' ? record.target : '';
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!target || !text) return undefined;
  return {
    id: typeof record.id === 'string' && record.id ? record.id : newId(),
    created_at: typeof record.created_at === 'string' && record.created_at ? record.created_at : new Date().toISOString(),
    target,
    text,
    source: record.source === 'tool' ? 'tool' : 'review',
  };
}

export function list(dir) {
  let raw = '';
  try {
    raw = fs.readFileSync(suggestionsFile(dir), 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = normalize(JSON.parse(line));
      if (parsed) records.push(parsed);
    } catch {
      /* 坏行跳过，别让一行损坏拖垮整个队列 */
    }
  }
  return records;
}

function write(dir, records) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = suggestionsFile(dir);
    const tmp = `${file}.tmp`;
    const body = records.map((record) => JSON.stringify(record)).join('\n');
    fs.writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    try {
      console.warn(`[memory-notes] failed to write suggestions: ${error?.message ?? error}`);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/**
 * 入队。返回 { record, duplicate }；record 一定带 id。
 * 内容相同（target + text）且未处理的记录视为同一条，不重复写。
 */
export function enqueue(dir, input) {
  const record = normalize(input);
  if (!record) throw new Error('suggestion requires target and text');
  const records = list(dir);
  const existing = records.find((item) => item.target === record.target && item.text === record.text);
  if (existing) return { record: existing, duplicate: true };
  const next = [...records, record];
  const trimmed = next.length > MAX_SUGGESTIONS ? next.slice(-MAX_SUGGESTIONS) : next;
  write(dir, trimmed);
  return { record, duplicate: false };
}

export function take(dir, id) {
  if (typeof id !== 'string' || !id) return undefined;
  return list(dir).find((record) => record.id === id);
}

export function drop(dir, id) {
  if (typeof id !== 'string' || !id) return false;
  const records = list(dir);
  const next = records.filter((record) => record.id !== id);
  if (next.length === records.length) return false;
  return write(dir, next);
}

export function count(dir) {
  return list(dir).length;
}
