/**
 * 0.10.0 的冷热分层：`memory_search` 的检索实现。
 *
 * 只注入 memory / user / key 三轨（快照），project / daily 日志与更早的条目
 * 不进上下文——需要时由模型主动检索。这里用「整条子串命中 + 词元重叠」
 * 打分，纯本地、无依赖、结果稳定（同分按条目长度升序）。
 */

/** Unicode 友好的分词：字母/数字连续段，其余一律当分隔符。 */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

function scoreEntry(entry, query, queryTokens) {
  const lowered = entry.toLowerCase();
  let score = 0;
  if (query && lowered.includes(query)) score += 2;
  if (!queryTokens.length) return score;
  const entryTokens = new Set(tokenize(entry));
  let hits = 0;
  for (const token of queryTokens) {
    if (entryTokens.has(token) || lowered.includes(token)) hits += 1;
  }
  score += hits / queryTokens.length;
  return score;
}

/**
 * 跨轨检索。
 * @param {import('./store.js').MemoryStore} store
 * @param {string} query
 * @param {{target?: string, limit?: number}} [options]
 * @returns {Array<{target: string, entry: string, score: number}>}
 */
export function searchMemory(store, query, { target, limit = 5 } = {}) {
  if (!store) throw new Error('searchMemory requires a store');
  const text = String(query ?? '').trim();
  if (!text) return [];
  const lowered = text.toLowerCase();
  const queryTokens = [...new Set(tokenize(text))];
  const targets = target ? [target] : store.targets;
  const max = Math.min(Math.max(1, Number(limit) || 5), 20);
  const results = [];

  for (const currentTarget of targets) {
    let entries = [];
    try {
      entries = store.entries(currentTarget);
    } catch {
      continue; // 某轨不可读（未启用/文件坏）不该拖垮整个检索
    }
    for (const entry of entries) {
      const score = scoreEntry(entry, lowered, queryTokens);
      if (score > 0) results.push({ target: currentTarget, entry, score: Math.round(score * 100) / 100 });
    }
  }

  results.sort((a, b) => b.score - a.score || a.entry.length - b.entry.length);
  return results.slice(0, max);
}
