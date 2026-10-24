/**
 * `memory` 工具的 DSH 定义 —— 对齐 Hermes Agent 0.22.5 `tools/memory_tool.py`。
 *
 * 相对 0.2.0 的差异：
 *  - 模型面动作 add / patch / remove：'replace' 已下线（patch 只换条目内的一个 span，
 *    条目其余保留；要整条重写就把整条放进 old_text）。
 *  - schema / 描述文案跟上游一致（WHEN / IF FULL / TARGETS / SKIP）。
 *  - 后台 review 的破坏性写入（patch / remove / batch 里含这两种）永不直写：
 *    先按当前条目 pin 住 matched_entry，再落 pending 记录；主会话用
 *    apply_pending / discard_pending 处理（对应上游 `/memory pending`）。
 *  - apply_pending 重放时按 matched_entry 精确定位，审阅后条目变了就 stale 拒绝。
 *
 * 失败（MemoryError）作为普通结果返回，不抛异常——DSH 里抛异常会中断这一轮。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DESTRUCTIVE_ACTIONS, MemoryError, PATCH_DROP_HINT } from './store.js';
import { isReviewSession, sessionIdFromExec } from './review-registry.js';

const PENDING_ID_RE = /^[a-z0-9-]+$/;
const WIRE_ACTIONS = ['add', 'patch', 'remove'];

export const REPLACE_REMOVED =
  "'replace' is not available; use 'patch'. old_text is the exact span to change and content is its new text; " +
  'the rest of the entry is kept. To rewrite a whole entry, set old_text to the whole entry. Nothing was written.';

const DESCRIPTION = `Save durable facts to persistent memory that survive across sessions. Two plain-text stores:
- target 'user': who the user is — profile, preferences, expectations.
- target 'memory': your own working notes — environment facts, tool quirks, project conventions, paths.

**WHEN**: you learn a durable fact, correct a stale entry, or the user asks you to remember something.
**IF FULL**: the limit is checked on the final state only. Combine removes and patches with the new entry in ONE
'operations' batch (patch shortens an entry, remove drops one entirely) — never retry the same call unchanged.
**TARGETS**: one fact goes to ONE store, never both.
**SKIP**: trivial chit-chat, facts you can re-derive with a quick look, raw data dumps, finished-task logs,
temporary state. Task progress belongs in the session; reusable procedures belong in a skill (skill_manage).

Patch edits a span inside one entry and keeps the rest; remove deletes a whole entry. Destructive edits (patch /
remove) are never applied blind by a background review: they are proposed with 'stage' and the main session applies
them via 'apply_pending' after 'list_pending'.`;

const PARAMETERS = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      enum: ['memory', 'user'],
      description:
        "'user' = who the user is (profile, preferences, expectations); 'memory' = your own notes (environment, " +
        'tool quirks, conventions). One fact goes to ONE store, never both.',
    },
    action: {
      type: 'string',
      enum: ['add', 'patch', 'remove', 'stage', 'list_pending', 'apply_pending', 'discard_pending'],
      description:
        "'add' saves a new entry; 'patch' rewrites a span inside an existing entry; 'remove' deletes an entry; " +
        "'stage' defers a destructive write for approval; 'list_pending' / 'apply_pending' / 'discard_pending' " +
        'manage the pending queue (DSH has no /memory CLI).',
    },
    content: {
      type: 'string',
      description:
        "Required for 'add' and 'patch'. For 'add', the new entry. For 'patch', the text that replaces old_text; " +
        "the rest of the entry is kept. Alias: 'new_text'.",
    },
    old_text: {
      type: 'string',
      description:
        "REQUIRED for 'patch' and 'remove': text from one entry. 'patch' replaces exactly this span (it must occur " +
        "once in the entry); 'remove' deletes the whole entry. Omit for 'add'. For 'stage' with op replace/remove, " +
        'this identifies the entry.',
    },
    new_text: { type: 'string', description: "Alias of 'content'." },
    op: {
      type: 'string',
      enum: ['patch', 'remove', 'replace'],
      description: "For action 'stage': the destructive op to defer (replace is legacy replay only).",
    },
    pending_id: {
      type: 'string',
      description: "For 'apply_pending' / 'discard_pending': the id returned by 'stage' or 'list_pending'.",
    },
    operations: {
      type: 'array',
      description:
        'Atomic batch; the char limit is checked only on the final result. Use ONE batch to shrink (remove / patch) ' +
        'and add in the same call.',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: WIRE_ACTIONS },
          content: { type: 'string' },
          new_text: { type: 'string' },
          old_text: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  required: [],
  additionalProperties: false,
};

const MISSING_TARGET =
  "Missing required target. Retry with target='memory' or target='user' at the top level. For a batch, remove " +
  'target from every operation; use separate calls for different stores. Nothing was written or staged.';

function textOf(input) {
  const value = input?.content ?? input?.new_text;
  return typeof value === 'string' ? value : value == null ? undefined : String(value);
}

function failureResult(err) {
  if (err instanceof MemoryError) return { success: false, error: err.message, ...err.detail };
  return { success: false, error: err?.message ?? String(err) };
}

function checkTarget(store, target) {
  if (target === undefined || target === null) throw new MemoryError(MISSING_TARGET, { success: false });
  store.assertTarget(target);
}

/**
 * 待确认队列。记录两种形状：
 *   单条 destructive：{id, created_at, target, action, old_text, content?, matched_entry}
 *   batch：          {id, created_at, target, action:'batch', operations:[...每个 op 带 matched_entry]}
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
      } catch {
        /* 删不掉就留着，下一次 list 还会看到 */
      }
    },
  };
}

function hasDestructive(operations) {
  return operations.some((op) => op && typeof op === 'object' && DESTRUCTIVE_ACTIONS.has(op.action));
}

const STAGED_MESSAGE =
  'Background review may not delete memory entries unattended. The proposed %s was staged for your approval — ' +
  "review it with action='list_pending' (then 'apply_pending' to apply, 'discard_pending' to drop).";

const PREDATES_PINNING =
  'This destructive pending write predates entry pinning and cannot be verified; nothing was applied. Reject it ' +
  'and recreate the change.';

export function toolDefinition({ store, limits, pendingDir } = {}) {
  if (!store) throw new Error('toolDefinition requires a store');
  const pending = createPendingStore(pendingDir);

  function pendingUnavailable() {
    return { success: false, error: 'pending queue is unavailable (no pendingDir configured)' };
  }

  /** 把一次单条写入做成 pending 记录（pin 住当前条目）。 */
  function stageSingle(input, target, action) {
    const oldText = typeof input.old_text === 'string' ? input.old_text : '';
    const content = textOf(input);
    if (!oldText.trim()) {
      return {
        success: false,
        error: `action 'stage' with op '${action}' requires old_text identifying the entry`,
      };
    }
    if (action !== 'remove' && (content === undefined || !content.trim())) {
      return { success: false, error: `staged ${action} requires content` };
    }
    let pinned;
    try {
      pinned = store.resolveEntry(target, oldText, action);
    } catch (err) {
      return failureResult(err);
    }
    const { id } = pending.save({
      target,
      action,
      old_text: oldText,
      ...(action === 'remove' ? {} : { content }),
      matched_entry: pinned.matched_entry,
    });
    return {
      success: true,
      staged: true,
      pending_id: id,
      message:
        'Staged, not applied. The main session applies it with action="apply_pending" (or drops it with ' +
        '"discard_pending").',
    };
  }

  /** 把一次 batch 做成 pending 记录（每个破坏性 op pin 住当前条目）。 */
  function stageBatch(operations, target) {
    let pinned;
    try {
      pinned = store.resolveBatchEntries(target, operations);
    } catch (err) {
      return failureResult(err);
    }
    const ops = operations.map((rawOp, i) => {
      const op = { ...(rawOp && typeof rawOp === 'object' ? rawOp : {}) };
      const matched = pinned.matched_entries[i];
      if (DESTRUCTIVE_ACTIONS.has(op.action) && matched != null) op.matched_entry = matched;
      return op;
    });
    const { id } = pending.save({ target, action: 'batch', operations: ops });
    return {
      success: true,
      staged: true,
      pending_id: id,
      message:
        'Staged, not applied. The main session applies it with action="apply_pending" (or drops it with ' +
        '"discard_pending").',
    };
  }

  function stageAction(input) {
    if (!pending.enabled) return pendingUnavailable();
    const operations = Array.isArray(input.operations) ? input.operations : undefined;
    if (operations) {
      if (operations.length === 0) return { success: false, error: 'operations list is empty.' };
      const target = input.target;
      try {
        checkTarget(store, target);
      } catch (err) {
        return failureResult(err);
      }
      return stageBatch(operations, target);
    }
    const action = input.op;
    if (!DESTRUCTIVE_ACTIONS.has(action)) {
      return { success: false, error: "action 'stage' requires op: 'patch', 'remove' (or legacy 'replace')" };
    }
    const target = input.target;
    try {
      checkTarget(store, target);
    } catch (err) {
      return failureResult(err);
    }
    return stageSingle(input, target, action);
  }

  function applyPending(input) {
    if (!pending.enabled) return pendingUnavailable();
    if (input.action === 'list_pending') {
      const items = pending.list().map((record) => ({
        id: record.id,
        created_at: record.created_at,
        target: record.target,
        action: record.action ?? record.op,
        ...(record.action === 'batch' ? { operation_count: record.operations?.length ?? 0 } : {}),
        ...(record.old_text === undefined ? {} : { old_text: record.old_text }),
        ...(record.content === undefined ? {} : { content: record.content }),
      }));
      return { success: true, pending_count: items.length, pending: items };
    }
    if (input.action === 'discard_pending') {
      const id = typeof input.pending_id === 'string' ? input.pending_id : '';
      const loaded = pending.take(id);
      if (!loaded) return { success: false, error: `no pending entry '${id}'; call action='list_pending' first` };
      pending.drop(loaded.file);
      return { success: true, discarded_pending: id };
    }
    const id = typeof input.pending_id === 'string' ? input.pending_id : '';
    const loaded = pending.take(id);
    if (!loaded) return { success: false, error: `no pending entry '${id}'; call action='list_pending' first` };
    const { record } = loaded;
    try {
      store.assertTarget(record.target);
      let result;
      if (record.action === 'batch') {
        const ops = Array.isArray(record.operations) ? record.operations : [];
        const unpinned = ops.some((op) => DESTRUCTIVE_ACTIONS.has(op.action) && !op.matched_entry);
        if (unpinned) return { success: false, error: PREDATES_PINNING };
        result = store.applyBatch(record.target, ops);
      } else {
        const action = record.action ?? record.op;
        if (DESTRUCTIVE_ACTIONS.has(action) && !record.matched_entry) {
          return { success: false, error: PREDATES_PINNING };
        }
        if (action === 'patch') {
          result = store.patch(record.target, record.old_text, record.content, record.matched_entry);
        } else if (action === 'replace') {
          result = store.replace(record.target, record.old_text, record.content, record.matched_entry);
        } else if (action === 'remove') {
          result = store.remove(record.target, record.old_text, record.matched_entry);
        } else {
          return { success: false, error: `pending record has unknown action '${action}'` };
        }
      }
      pending.drop(loaded.file);
      return { ...result, applied_pending: record.id };
    } catch (err) {
      return failureResult(err);
    }
  }

  /** 真正执行一次写请求（add / batch / 单条）。 */
  function applyWrite(input) {
    const operations = Array.isArray(input.operations) ? input.operations : undefined;
    if (operations) {
      if (operations.length === 0) return { success: false, error: 'operations list is empty.' };
      const target = input.target;
      checkTarget(store, target);
      for (const op of operations) {
        if (op && typeof op === 'object' && op.target !== undefined) {
          return {
            success: false,
            error:
              "Operation objects must not carry their own target. Set target once at the top level and use " +
              'separate calls for different stores. Nothing was written or staged.',
          };
        }
        if (op && typeof op === 'object' && op.action === 'replace') return { success: false, error: REPLACE_REMOVED };
      }
      return store.applyBatch(target, operations);
    }
    const action = input.action;
    if (action === 'add') {
      const target = input.target;
      checkTarget(store, target);
      return store.add(target, textOf(input));
    }
    if (action === 'patch' || action === 'remove') {
      const target = input.target;
      checkTarget(store, target);
      const oldText = input.old_text;
      if (typeof oldText !== 'string' || !oldText.trim()) {
        throw new MemoryError(
          `'${action}' needs old_text -- a short unique substring of the entry to ${action}. None was provided. ` +
            `Reissue the ${action} with old_text set to part of one of the current_entries below.`,
          {
            success: false,
            target,
            current_entries: [...store.entries(target)],
            usage: store.usageShort(target),
          },
        );
      }
      if (action === 'patch') {
        const content = textOf(input);
        if (typeof content !== 'string' || !content.trim()) {
          throw new MemoryError(
            `content (the new text for the old_text span) is required for 'patch' action. ${PATCH_DROP_HINT}`,
            { success: false, target },
          );
        }
        return store.patch(target, oldText, content);
      }
      return store.remove(target, oldText);
    }
    return { success: false, error: `Unknown action '${action}'. Use: add, patch, remove` };
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
    execute(args, exec) {
      const input = args ?? {};
      try {
        const action = input.action;
        if (action === 'list_pending' || action === 'apply_pending' || action === 'discard_pending') {
          return applyPending(input);
        }
        if (action === 'stage') return stageAction(input);
        if (action === 'replace') return { success: false, error: REPLACE_REMOVED };

        const operations = Array.isArray(input.operations) ? input.operations : undefined;
        if (!action && !operations) {
          return {
            success: false,
            error:
              "Missing required parameter: provide 'action' (add/patch/remove) or 'operations' (batch list). " +
              'Got neither.',
          };
        }
        if (action && action !== 'add' && action !== 'patch' && action !== 'remove') {
          return { success: false, error: `Unknown action '${action}'. Use: add, patch, remove` };
        }

        // 后台 review 不许直写破坏性改动：整批/单条转成 pending 提案。
        const unattended = isReviewSession(sessionIdFromExec(exec));
        const destructive = operations ? hasDestructive(operations) : DESTRUCTIVE_ACTIONS.has(action);
        if (unattended && destructive) {
          if (!pending.enabled) return pendingUnavailable();
          const target = input.target;
          checkTarget(store, target);
          const staged = operations ? stageBatch(operations, target) : stageSingle(input, target, action);
          if (!staged.success) return staged;
          return {
            success: true,
            staged: true,
            proposal_staged: true,
            pending_id: staged.pending_id,
            message: STAGED_MESSAGE.replace('%s', operations ? 'batch' : `'${action}'`),
          };
        }

        return applyWrite(input);
      } catch (err) {
        return failureResult(err);
      }
    },
    limits,
  };
}
