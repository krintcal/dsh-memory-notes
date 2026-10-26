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
import { DESTRUCTIVE_ACTIONS, MemoryError, PATCH_DROP_HINT } from './store.js';
import { isReviewSession, sessionIdFromExec } from './review-registry.js';
import {
  applyRecord,
  createPendingStore,
  hasDestructive,
  summarizePending,
} from './pending.js';

const WIRE_ACTIONS = ['add', 'patch', 'remove'];

export const REPLACE_REMOVED =
  "'replace' is not available; use 'patch'. old_text is the exact span to change and content is its new text; " +
  'the rest of the entry is kept. To rewrite a whole entry, set old_text to the whole entry. Nothing was written.';

const DESCRIPTION = `Save durable facts to persistent memory that survive across sessions. Layered plain-text stores:
- target 'user': who the user is — profile, preferences, expectations.
- target 'memory': your own working notes — environment facts, tool quirks, project conventions, paths.
- target 'key': short branch-scoped project facts; append [branch:main,release] to scope an entry to branches.
- target 'project': this project's progress log (one entry per turn; skip if nothing happened).
- target 'daily': today's running summary (one entry per day; patch it as the day goes on).

**WHEN**: you learn a durable fact, correct a stale entry, or the user asks you to remember something.
**IF FULL**: the limit is checked on the final state only. Combine removes and patches with the new entry in ONE
'operations' batch (patch shortens an entry, remove drops one entirely) — never retry the same call unchanged.
**TARGETS**: one fact goes to ONE store, never both.
**SKIP**: trivial chit-chat, facts you can re-derive with a quick look, raw data dumps, finished-task logs,
temporary state. Do not store task progress, past conversation, or completed work — recall them with
session_search when the host provides it. Memory holds only facts that stay true across sessions; reusable
procedures belong in a skill (skill_manage).

Patch edits a span inside one entry and keeps the rest; remove deletes a whole entry. Destructive edits (patch /
remove) are never applied blind by a background review: they are proposed with 'stage' and the main session applies
them via 'apply_pending' after 'list_pending'.

In review mode, 'suggest' queues a memory/user/key entry for the user to accept in the left sidebar instead of
writing it directly; project/daily are always written directly.`;

function parametersFor(targets) {
  const list = Array.isArray(targets) && targets.length ? targets : ['memory', 'user'];
  return {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: [...list],
        description:
          `One of: ${list.join(', ')}. 'user' = who the user is; 'memory' = your own notes; 'key' = branch-scoped ` +
          "project facts; 'project' = project progress log; 'daily' = today's summary. One fact goes to ONE store.",
      },
      action: {
        type: 'string',
        enum: ['add', 'patch', 'remove', 'suggest', 'stage', 'list_pending', 'apply_pending', 'discard_pending'],
        description:
          "'add' saves a new entry; 'patch' rewrites a span inside an existing entry; 'remove' deletes an entry; " +
          "'suggest' queues a memory/user/key entry for user approval; 'stage' defers a destructive write for " +
          "approval; 'list_pending' / 'apply_pending' / 'discard_pending' manage the pending queue (DSH has no " +
          '/memory CLI).',
      },
      content: {
        type: 'string',
        description:
          "Required for 'add', 'patch' and 'suggest'. For 'add', the new entry. For 'patch', the text that replaces " +
          "old_text; the rest of the entry is kept. For 'suggest', the proposed entry text. Alias: 'new_text'.",
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
}

function missingTargetMessage(targets) {
  const list = Array.isArray(targets) && targets.length ? targets : ['memory', 'user'];
  return (
    `Missing required target. Retry with ${list.map((target) => `target='${target}'`).join(' / ')} at the top ` +
    'level. For a batch, remove target from every operation; use separate calls for different stores. Nothing ' +
    'was written or staged.'
  );
}


function textOf(input) {
  const value = input?.content ?? input?.new_text;
  return typeof value === 'string' ? value : value == null ? undefined : String(value);
}

function failureResult(err) {
  if (err instanceof MemoryError) return { success: false, error: err.message, ...err.detail };
  return { success: false, error: err?.message ?? String(err) };
}

function checkTarget(store, target) {
  if (target === undefined || target === null) {
    throw new MemoryError(missingTargetMessage(store?.targets), { success: false });
  }
  store.assertTarget(target);
}


const STAGED_MESSAGE =
  'Background review may not delete memory entries unattended. The proposed %s was staged for your approval — ' +
  "review it with action='list_pending' (then 'apply_pending' to apply, 'discard_pending' to drop).";

const APPROVAL_STAGED_MESSAGE = '审批通道不可用，已排队，请在左侧栏「记忆」面板确认';

const REJECTED_RESULT = {
  success: false,
  error: 'Memory write was rejected by the user.',
  note: 'Nothing was written.',
};

/**
 * 向宿主审批服务要一个决定。返回 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'skip'。
 * 任何异常都降级成 'unavailable'，绝不让工具抛错。
 */
export async function requestApproval({ approval, agent, callId }, description) {
  if (!approval) return 'unavailable';
  try {
    if (approval.effectivePolicy?.(agent?.session) === 'never') return 'skip';
  } catch {
    /* policy 查询失败就继续问 */
  }
  if (typeof approval.request !== 'function') return 'unavailable';
  try {
    return await approval.request({ agent, toolName: 'memory', callId, reason: description });
  } catch {
    return 'unavailable';
  }
}

function approvalReason(input, operations, target) {
  if (operations) {
    return `批量修改记忆（${target}）：${operations.length} 项，含删除/改写`;
  }
  const span = typeof input.old_text === 'string' ? input.old_text.slice(0, 60) : '';
  const verb = input.action === 'remove' ? '删除记忆' : '修改记忆';
  return `${verb}（${target}）：${span}`;
}

export function toolDefinition({
  store,
  limits,
  pendingDir,
  pending: sharedPending,
  suggestions,
  approval,
  getAgent,
  config = {},
} = {}) {
  if (!store) throw new Error('toolDefinition requires a store');
  const pending = sharedPending ?? createPendingStore(pendingDir);
  const approvalMode = config.approvalMode ?? 'ask';
  const approvalConfigured = approval !== undefined;
  const targets = Array.isArray(store.targets) && store.targets.length ? store.targets : ['memory', 'user'];
  const parameters = parametersFor(targets);

  function resolveApproval() {
    try {
      return typeof approval === 'function' ? approval() : approval;
    } catch {
      return undefined;
    }
  }

  function resolveAgent(exec, sessionId) {
    const direct = exec?.agent ?? exec?.session?.agent;
    if (direct && typeof direct === 'object') return direct;
    try {
      return typeof getAgent === 'function' ? getAgent(sessionId) : undefined;
    } catch {
      return undefined;
    }
  }

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

  /** 把破坏性写入转成待确认提案（后台 review / stage 模式 / 审批不可用共用）。 */
  function stageDestructive(input, operations, message) {
    if (!pending.enabled) return pendingUnavailable();
    const target = input.target;
    try {
      checkTarget(store, target);
    } catch (err) {
      return failureResult(err);
    }
    const staged = operations ? stageBatch(operations, target) : stageSingle(input, target, input.action);
    if (!staged.success) return staged;
    return {
      success: true,
      staged: true,
      proposal_staged: true,
      pending_id: staged.pending_id,
      message: message ?? STAGED_MESSAGE.replace('%s', operations ? 'batch' : `'${input.action}'`),
    };
  }

  /** ask 模式：问宿主审批；拒绝则不写，通道不可用则转 pending。 */
  function approvalWrite(input, operations, exec) {
    const target = input.target;
    try {
      checkTarget(store, target);
    } catch (err) {
      return Promise.resolve(failureResult(err));
    }
    const sessionId = sessionIdFromExec(exec);
    const agent = resolveAgent(exec, sessionId);
    const callId = exec?.callId ?? exec?.call?.id;
    const description = approvalReason(input, operations, target);
    const approvalService = resolveApproval();
    return requestApproval({ approval: approvalService, agent, callId }, description).then((outcome) => {
      if (outcome === 'rejected' || outcome === 'cancelled') return { ...REJECTED_RESULT };
      if (outcome === 'unavailable') return stageDestructive(input, operations, APPROVAL_STAGED_MESSAGE);
      try {
        return applyWrite(input, 'tool');
      } catch (err) {
        return failureResult(err);
      }
    });
  }

  function applyPending(input) {
    if (!pending.enabled) return pendingUnavailable();
    if (input.action === 'list_pending') {
      const items = pending.list().map(summarizePending);
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
      const result = applyRecord(store, record);
      pending.drop(loaded.file);
      return { ...result, applied_pending: record.id };
    } catch (err) {
      return failureResult(err);
    }
  }

  /** 真正执行一次写请求（add / batch / 单条）。source 供写入日志区分来源。 */
  function applyWrite(input, source = 'tool') {
    store.lastSource = source;
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
    return { success: false, error: `Unknown action '${action}'. Use: add, patch, remove, suggest` };
  }

  /** reviewMode:'suggest' 的写入：只入队 memory/user/key，project/daily 直写。 */
  function suggestAction(input, exec) {
    const target = input.target;
    try {
      checkTarget(store, target);
    } catch (err) {
      return failureResult(err);
    }
    if (!['memory', 'user', 'key'].includes(target)) {
      return {
        success: false,
        error:
          "action 'suggest' only supports target 'memory', 'user' or 'key'; write project/daily directly with " +
          "action='add'.",
      };
    }
    const content = textOf(input);
    if (typeof content !== 'string' || !content.trim()) {
      return { success: false, error: "action 'suggest' requires content — the proposed entry text." };
    }
    if (!suggestions || typeof suggestions.enqueue !== 'function') {
      return { success: false, error: 'suggestion queue is unavailable (no suggestions directory configured)' };
    }
    const source = isReviewSession(sessionIdFromExec(exec)) ? 'review' : 'tool';
    try {
      const queued = suggestions.enqueue({ target, text: content, source });
      const record = queued?.record ?? queued;
      return {
        success: true,
        staged: true,
        pending_id: record?.id,
        target,
        message: '已写入建议队列，等待在左侧栏「记忆」面板确认。',
      };
    } catch (err) {
      return failureResult(err);
    }
  }

  return {
    name: 'memory',
    description: DESCRIPTION,
    parameters,
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
        if (action === 'suggest') return suggestAction(input, exec);
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
              "Missing required parameter: provide 'action' (add/patch/remove/suggest) or 'operations' (batch " +
              'list). Got neither.',
          };
        }
        if (action && action !== 'add' && action !== 'patch' && action !== 'remove') {
          return { success: false, error: `Unknown action '${action}'. Use: add, patch, remove, suggest` };
        }

        const unattended = isReviewSession(sessionIdFromExec(exec));
        const destructive = operations ? hasDestructive(operations) : DESTRUCTIVE_ACTIONS.has(action);

        // 后台 review 不许直写破坏性改动：整批/单条转成 pending 提案。
        if (unattended) {
          if (destructive) {
            return stageDestructive(input, operations, STAGED_MESSAGE.replace('%s', operations ? 'batch' : `'${action}'`));
          }
          return applyWrite(input, 'review');
        }

        // 主会话的破坏性写入：auto 直写；stage 直接排队；ask 走宿主审批。
        if (destructive) {
          if (approvalMode === 'auto') return applyWrite(input, 'tool');
          if (approvalMode === 'stage') return stageDestructive(input, operations);
          if (approvalConfigured) return approvalWrite(input, operations, exec);
        }

        return applyWrite(input, 'tool');
      } catch (err) {
        return failureResult(err);
      }
    },
    limits,
  };
}
