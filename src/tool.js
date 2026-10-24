/**
 * `memory` 工具的 DSH 定义。
 *
 * 参数是原始 JSON Schema（不是 defineTool 的 DSL）；结果按 Hermes 的形状返回：
 * 成功时只回 usage / entry_count，不回显条目内容，避免模型看到内容后重复调用。
 * 失败（MemoryError）也作为普通结果返回，不抛异常——DSH 里抛异常会中断这一轮。
 */
import fs from 'node:fs';
import path from 'node:path';
import { MemoryError } from './store.js';

const NOTE = 'Write saved. This update is complete — do not repeat it.';
const PENDING_ID_RE = /^[a-z0-9-]+$/;

const DESCRIPTION = `Long-term memory shared across sessions. Two plain-text stores:
- target 'user': who the user is — profile, preferences, expectations.
- target 'memory': your own working notes.

Rules:
1. Only store facts that hold for every session. Never store task details — those belong to the session or to files.
2. When you have more than one change, make them all in a single call via the 'operations' array. The character limit is checked only against the final result.
3. If an add is rejected for exceeding the limit, the response includes 'current_entries' and 'usage'. Use 'replace' or 'remove' — or an atomic batch that shrinks first and adds after — then retry. Never retry the same call unchanged.

Destructive edits (replace/remove) are never applied blind by a background review: it calls action 'stage' instead, and the main session applies it with 'apply_pending' after 'list_pending'.`;

const PARAMETERS = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      enum: ['memory', 'user'],
      description: "'user' = who the user is (profile, preferences, expectations); 'memory' = your own notes.",
    },
    action: { type: 'string', enum: ['add', 'replace', 'remove', 'stage', 'list_pending', 'apply_pending'] },
    content: { type: 'string', description: 'Entry text for add; replacement text for replace.' },
    old_text: { type: 'string', description: 'Unique substring identifying the entry for replace/remove.' },
    new_text: { type: 'string', description: 'Alias of content.' },
    op: { type: 'string', enum: ['replace', 'remove'], description: "For action 'stage': the destructive op to stage." },
    pending_id: { type: 'string', description: "For action 'apply_pending': the id returned by 'stage'/'list_pending'." },
    operations: {
      type: 'array',
      description: 'Atomic batch; the char limit is checked only on the final result.',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'replace', 'remove'] },
          content: { type: 'string' },
          new_text: { type: 'string' },
          old_text: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  required: [],
  additionalProperties: false,
};

function textOf(args) {
  const value = args?.content ?? args?.new_text;
  return typeof value === 'string' ? value : value == null ? undefined : String(value);
}

function successResult(store, target, result) {
  return {
    success: true,
    done: true,
    target,
    usage: result?.usage ?? store.usage(target),
    entry_count: result?.entry_count ?? store.entries(target).length,
    note: NOTE,
  };
}

function failureResult(err) {
  if (err instanceof MemoryError) {
    return { success: false, error: err.message, ...err.detail };
  }
  return { success: false, error: err?.message ?? String(err) };
}

/**
 * 待确认队列：后台 review fork 不直接 replace/remove，而是写一条记录到这里，
 * 由主会话（或用户）用 list_pending / apply_pending 决定要不要真落盘。
 * 抄 Hermes memory_tool 的 stage_write / background_delete_gate。
 */
function createPendingStore(dir) {
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
    save({ target, op, old_text, content }) {
      fs.mkdirSync(dir, { recursive: true });
      const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const record = { id, created_at: new Date().toISOString(), target, op, old_text };
      if (content !== undefined) record.content = content;
      fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      return { id, record };
    },
    list() {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
      } catch {
        return [];
      }
      const items = [];
      for (const name of names.sort()) {
        const loaded = read(name.slice(0, -5));
        if (loaded) items.push(loaded.record);
      }
      return items;
    },
    take(id) {
      if (!PENDING_ID_RE.test(id)) return undefined;
      const loaded = read(id);
      if (!loaded) return undefined;
      return loaded;
    },
    drop(file) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* 删不掉就留着，下一次 list 还会看到 */
      }
    },
  };
}

export function toolDefinition({ store, limits, pendingDir } = {}) {
  if (!store) throw new Error('toolDefinition requires a store');
  const pending = createPendingStore(pendingDir);

  function applyPending(input) {
    if (!pending.enabled) {
      return { success: false, error: 'pending queue is unavailable (no pendingDir configured)' };
    }
    if (input.action === 'list_pending') {
      const items = pending.list().map((record) => ({
        id: record.id,
        created_at: record.created_at,
        target: record.target,
        op: record.op,
        old_text: record.old_text,
        content: record.content,
      }));
      return { success: true, pending_count: items.length, pending: items };
    }
    const id = typeof input.pending_id === 'string' ? input.pending_id : '';
    const loaded = pending.take(id);
    if (!loaded) return { success: false, error: `no pending entry '${id}'; call action='list_pending' first` };
    const { record } = loaded;
    const result =
      record.op === 'replace'
        ? store.replace(record.target, record.old_text, record.content)
        : store.remove(record.target, record.old_text);
    pending.drop(loaded.file);
    return { ...successResult(store, record.target, result), applied_pending: record.id, op: record.op };
  }

  function stage(input) {
    if (!pending.enabled) {
      return { success: false, error: 'pending queue is unavailable (no pendingDir configured)' };
    }
    if (input.op !== 'replace' && input.op !== 'remove') {
      return { success: false, error: "action 'stage' requires op: 'replace' or 'remove'" };
    }
    if (typeof input.old_text !== 'string' || !input.old_text) {
      return { success: false, error: "action 'stage' requires old_text identifying the entry" };
    }
    if (input.op === 'replace' && typeof textOf(input) !== 'string') {
      return { success: false, error: "staged replace requires content (the replacement text)" };
    }
    const { id } = pending.save({
      target: input.target,
      op: input.op,
      old_text: input.old_text,
      content: input.op === 'replace' ? textOf(input) : undefined,
    });
    return {
      success: true,
      staged: true,
      pending_id: id,
      note: 'Staged, not applied. The main session must call action="apply_pending" with this id.',
    };
  }

  return {
    name: 'memory',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute(args, _exec) {
      const input = args ?? {};
      const target = input.target;
      try {
        if (!input.action) {
          if (Array.isArray(input.operations)) {
            return successResult(store, target, store.applyBatch(target, input.operations));
          }
          return { success: false, error: "Provide either 'action' or 'operations'." };
        }
        if (input.action === 'list_pending' || input.action === 'apply_pending') {
          return applyPending(input);
        }
        if (input.action === 'stage') {
          return stage(input);
        }
        if (input.action === 'add') {
          return successResult(store, target, store.add(target, textOf(input)));
        }
        if (input.action === 'replace') {
          return successResult(store, target, store.replace(target, input.old_text, textOf(input)));
        }
        if (input.action === 'remove') {
          return successResult(store, target, store.remove(target, input.old_text));
        }
        return {
          success: false,
          error: `Unknown action '${input.action}'. Use: add, replace, remove, stage, list_pending, apply_pending.`,
        };
      } catch (err) {
        return failureResult(err);
      }
    },
    limits,
  };
}
