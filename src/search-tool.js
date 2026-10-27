/**
 * `memory_search` 工具的 DSH 定义（0.10.0 选择性方案的一半）。
 *
 * 背景：memory / user / key 每轮注入，但 project / daily 日志默认不进上下文。
 * 与其把长尾也塞进注入快照（膨胀、稀释不变量），不如让模型按需检索。
 */
import { MemoryError } from './store.js';
import { searchMemory } from './search.js';

const DESCRIPTION = `Search persistent memory across all tracks without loading it into context.

Memory is injected as a snapshot for the low-churn tracks (memory / user / key). The project log and daily log are
written on purpose but NOT injected, and older entries may have been curated away from the snapshot — use this tool
to find them.

When to use it:
- The task mentions a project, branch, file path, command or decided convention and you are unsure whether it was
  already written down (project log / key).
- You need yesterday's (or an older) daily note, or a fact you remember saving but cannot see in the snapshot.
- Before adding a new memory entry, check whether it already exists in another track.

Tips: query with 2-5 distinctive words (paths, names, error codes). Filter with target to one track; raise limit to
see more candidates. The tool only reads — it never writes memory.`;

const PARAMETERS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Words to look for (paths, names, error codes). Case-insensitive.' },
    target: {
      type: 'string',
      enum: ['memory', 'user', 'key', 'project', 'daily'],
      description: 'Limit the search to one track. Omit to search all tracks.',
    },
    limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max matches to return (default 5).' },
  },
  required: ['query'],
  additionalProperties: false,
};

function render(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

export function searchToolDefinition({ store } = {}) {
  if (!store) throw new Error('searchToolDefinition requires a store');

  return {
    name: 'memory_search',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: { type: 'object' }, render: (_args, value) => render(value) },
    execute(args) {
      const input = args ?? {};
      try {
        const query = String(input.query ?? '').trim();
        if (!query) throw new MemoryError('query is required (2-5 distinctive words).', { success: false });
        if (input.target !== undefined && input.target !== null && input.target !== '') {
          if (!store.targets.includes(input.target)) {
            throw new MemoryError(`Unknown target '${input.target}'. Use one of: ${store.targets.join(', ')}.`, {
              success: false,
            });
          }
        }
        const limit = input.limit === undefined ? 5 : Number(input.limit);
        if (!Number.isFinite(limit) || limit < 1 || limit > 20) {
          throw new MemoryError('limit must be an integer between 1 and 20.', { success: false });
        }
        const matches = searchMemory(store, query, { target: input.target || undefined, limit });
        return {
          success: true,
          query,
          target: input.target || null,
          count: matches.length,
          matches,
          note: matches.length
            ? 'Read-only search result. Use the memory tool (add/patch) if something needs updating.'
            : 'No match. Try fewer or different words, or omit target to search every track.',
        };
      } catch (err) {
        if (err instanceof MemoryError) return { success: false, error: err.message, ...err.detail };
        return { success: false, error: err?.message ?? String(err) };
      }
    },
  };
}
