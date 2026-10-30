/**
 * 待确认队列（pending）—— 后台 review 的破坏性提案落盘在这里，等主会话或
 * 可视化面板批准。0.4.0 把它从 tool.js 抽出来，好让 `web` 半边复用同一套
 * 记录格式与重放逻辑（状态、列表、apply / discard）。
 *
 * 记录两种形状（都带 pin 住的匹配条目，批准时按它精确定位；条目变了就 stale）：
 *   单条 destructive：{id, created_at, target, action, old_text, content?, matched_entry}
 *   batch：          {id, created_at, target, action:'batch', operations:[...每个 op 带 matched_entry]}
 */
import fs from 'node:fs';
import path from 'node:path';

import { DESTRUCTIVE_ACTIONS, MemoryError } from './store.js';

export const PENDING_ID_RE = /^[a-z0-9-]+$/;

export const PREDATES_PINNING =
  'This destructive pending write predates entry pinning and cannot be verified; nothing was applied. Reject it ' +
  'and recreate the change.';

export function hasDestructive(operations) {
  return operations.some((op) => op && typeof op === 'object' && DESTRUCTIVE_ACTIONS.has(op.action));
}

/**
 * 0.12.3：面板在渲染前先给每条 pending 打「已过期」标记——pin 住的条目若已不在
 * 当前库里，批准必然 stale 失败，留着「批准」按钮只会让人以为点不动。
 */
export function pendingStaleness(store, record) {
  const target = record && typeof record.target === 'string' ? record.target : '';
  if (!target) return { stale: false };
  let current;
  try {
    current = store.entries(target);
  } catch {
    return { stale: false };
  }
  const ops = record.action === 'batch' ? record.operations ?? [] : [record];
  for (const op of ops) {
    if (!op || !DESTRUCTIVE_ACTIONS.has(op.action)) continue;
    const pinned = op.matched_entry;
    if (typeof pinned !== 'string' || !pinned) continue;
    if (!current.includes(pinned)) {
      const preview = pinned.length > 80 ? `${pinned.slice(0, 80)}…` : pinned;
      return { stale: true, stale_reason: `条目自提案后已变：${preview}` };
    }
  }
  return { stale: false };
}

export function createPendingStore(dir) {
  const enabled = typeof dir === 'string' && dir.length > 0;

  function read(id) {
    const file = path.join(dir, `${id}.json`);
    try {
      return { file, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      return undefined;
    }
  }

  return {
    enabled,
    dir,
    save(record) {
      fs.mkdirSync(dir, { recursive: true });
      const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const full = { id, created_at: new Date().toISOString(), ...record };
      fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(full, null, 2)}\n`, 'utf8');
      return { id, record: full };
    },
    list() {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
      } catch {
        return [];
      }
      const items = [];
      for (const file of names.sort()) {
        const loaded = read(file.slice(0, -5));
        if (loaded) items.push(loaded.record);
      }
      return items;
    },
    take(id) {
      if (typeof id !== 'string' || !PENDING_ID_RE.test(id)) return undefined;
      return read(id);
    },
    drop(file) {
      try {
        fs.rmSync(file, { force: true });
        return true;
      } catch {
        /* 删不掉就留着，下一次 list 还会看到 */
        return false;
      }
    },
  };
}

/**
 * 重放一条 pending 记录（tool 的 apply_pending 与面板的「批准」共用）。
 * 记录缺少 matched_entry 的破坏性改动一律拒绝；条目已被改过则由 store 抛
 * staleEntryMessage。成功返回 store 的结果（含 usage / PATched_entry_* 等）。
 */
export function applyRecord(store, record) {
  store.assertTarget(record.target);
  if (record.action === 'batch') {
    const ops = Array.isArray(record.operations) ? record.operations : [];
    if (hasDestructive(ops) && ops.some((op) => DESTRUCTIVE_ACTIONS.has(op.action) && !op.matched_entry)) {
      throw new MemoryError(PREDATES_PINNING, { success: false });
    }
    return store.applyBatch(record.target, ops);
  }
  const action = record.action ?? record.op;
  if (DESTRUCTIVE_ACTIONS.has(action) && !record.matched_entry) {
    throw new MemoryError(PREDATES_PINNING, { success: false });
  }
  if (action === 'patch') return store.patch(record.target, record.old_text, record.content, record.matched_entry);
  if (action === 'replace') return store.replace(record.target, record.old_text, record.content, record.matched_entry);
  if (action === 'remove') return store.remove(record.target, record.old_text, record.matched_entry);
  throw new MemoryError(`pending record has unknown action '${action}'`, { success: false });
}

/** 展示用截断：批量预览只给前 10 条、每条 120 字符。 */
function clip(value, max) {
  if (typeof value !== 'string') return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** 待确认记录的展示摘要（不含 pin 数据，给工具与面板共用）。 */
export function summarizePending(record) {
  const isBatch = record.action === 'batch';
  const operations = isBatch
    ? (Array.isArray(record.operations) ? record.operations : []).slice(0, 10).map((op) => ({
        action: op?.action,
        ...(clip(op?.old_text, 120) === undefined ? {} : { old_text: clip(op?.old_text, 120) }),
        ...(clip(op?.content, 120) === undefined ? {} : { content: clip(op?.content, 120) }),
      }))
    : undefined;
  return {
    id: record.id,
    created_at: record.created_at,
    target: record.target,
    action: record.action ?? record.op,
    ...(isBatch ? { operation_count: record.operations?.length ?? 0 } : {}),
    ...(operations === undefined ? {} : { operations }),
    ...(record.old_text === undefined ? {} : { old_text: record.old_text }),
    ...(record.content === undefined ? {} : { content: record.content }),
  };
}
