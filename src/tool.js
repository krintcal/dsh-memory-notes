/**
 * `memory` 工具的 DSH 定义。
 *
 * 参数是原始 JSON Schema（不是 defineTool 的 DSL）；结果按 Hermes 的形状返回：
 * 成功时只回 usage / entry_count，不回显条目内容，避免模型看到内容后重复调用。
 * 失败（MemoryError）也作为普通结果返回，不抛异常——DSH 里抛异常会中断这一轮。
 */
import { MemoryError } from './store.js';

const NOTE = 'Write saved. This update is complete — do not repeat it.';

const DESCRIPTION = `Long-term memory shared across sessions. Two plain-text stores:
- target 'user': who the user is — profile, preferences, expectations.
- target 'memory': your own working notes.

Rules:
1. Only store facts that hold for every session. Never store task details — those belong to the session or to files.
2. When you have more than one change, make them all in a single call via the 'operations' array. The character limit is checked only against the final result.
3. If an add is rejected for exceeding the limit, the response includes 'current_entries' and 'usage'. Use 'replace' or 'remove' — or an atomic batch that shrinks first and adds after — then retry. Never retry the same call unchanged.`;

const PARAMETERS = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      enum: ['memory', 'user'],
      description: "'user' = who the user is (profile, preferences, expectations); 'memory' = your own notes.",
    },
    action: { type: 'string', enum: ['add', 'replace', 'remove'] },
    content: { type: 'string', description: 'Entry text for add; replacement text for replace.' },
    old_text: { type: 'string', description: 'Unique substring identifying the entry for replace/remove.' },
    new_text: { type: 'string', description: 'Alias of content.' },
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
  required: ['target'],
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

export function toolDefinition({ store, limits } = {}) {
  if (!store) throw new Error('toolDefinition requires a store');

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
        if (Array.isArray(input.operations) && !input.action) {
          return successResult(store, target, store.applyBatch(target, input.operations));
        }
        if (!input.action) {
          return { success: false, error: "Provide either 'action' or 'operations'." };
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
          error: `Unknown action '${input.action}'. Use: add, replace, remove.`,
        };
      } catch (err) {
        return failureResult(err);
      }
    },
    limits,
  };
}
