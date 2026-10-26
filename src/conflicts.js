/**
 * 0.9.0：疑似重复 / 冲突检测（只提示，不改数据）。
 *
 * 记忆是可追加的纯文本，两条条目"互相矛盾"没法可靠判定；能做的是找出
 * 「内容高度相似但并存」的条目，让人决定要不要合并。阈值比写入时的
 * 近似告警（0.6）更严格，避免面板被噪音淹没。
 */
import { similarity } from './store.js';

export const CONFLICT_THRESHOLD = 0.8;

/**
 * @param {string[]} entries 某一轨的条目
 * @param {{threshold?: number, limit?: number}} [options]
 * @returns {{a: string, b: string, similarity: number}[]} 按相似度降序、最多 limit 对
 */
export function findConflictGroups(entries, { threshold = CONFLICT_THRESHOLD, limit = 20 } = {}) {
  if (!Array.isArray(entries) || entries.length < 2) return [];
  const pairs = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const score = similarity(entries[i], entries[j]);
      if (score >= threshold) pairs.push({ a: entries[i], b: entries[j], similarity: Math.round(score * 100) / 100 });
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs.slice(0, limit);
}
