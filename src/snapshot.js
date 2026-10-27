/**
 * 0.7.0 实时快照渲染。
 *
 * 记忆块通过 `ctx.systemPrompt.context()` 注入（user-role 尾部消息），agent-loop
 * 只在渲染文本变化时才追加一条。因此这里每次 step 现算，但必须保证「同样的
 * 数据 → 逐字节相同的字符串」：不放时间戳、随机 id 或与数据无关的计数。
 *
 * 组装顺序：memory → user → key（按分支过滤）→ 空行 → 每回合收尾提示 →
 * 回顾状态行 →（分支已知时）分支行。
 */
import { cachedBranch, filterKeyEntries, primeBranch } from './tracks.js';

export const SNAPSHOT_NOTE =
  'Persistent memory is injected as a runtime context message. When its contents change, a new message is ' +
  'appended at the end of the conversation, so writes made in this session are visible from the next turn. Use ' +
  'the memory tool to add, patch, or remove entries; a background curator may still propose destructive edits, ' +
  'which wait in the pending queue for approval.';

export const SEARCH_HINT =
  'project/daily 日志与更早的条目不注入上下文：需要时用 memory_search 工具检索（只读，不改记忆）。';

export const CLOSING_HINT =
  "每回合收尾：向 project 写 1 条本回合进展（memory 工具 target='project'，没有进展就跳过），向 daily 写 1 条当天小结（target='daily'，同一天可 patch 同一条）。";

export const REVIEW_STATUS_PREFIX = '记忆回顾：自上次回顾';

export function reviewStatusLine(review, mode = 'suggest') {
  const count = Number(review?.turns_since) || 0;
  const interval = Math.max(1, Number(review?.interval) || 10);
  const base = `${REVIEW_STATUS_PREFIX} ${count}/${interval} 轮`;
  if (!review?.due) return `${base}。`;
  const action =
    mode === 'auto'
      ? '用 memory 工具直接写入'
      : "写入用 action:'suggest' 入队";
  return (
    `${base} —— 本轮先用 memory 工具完成回顾（${action}，没有可写的就说 Nothing to save. 并跳过），` +
    '完成后调用 memory_review_status 的 complete。'
  );
}

export function branchLine(branch) {
  return `当前 git 分支：${branch}（key 记忆按分支过滤）`;
}

function loadEntries(store, target) {
  try {
    return store.load(target) ?? [];
  } catch {
    return [];
  }
}

/**
 * 现算快照。任何存储异常都退化为跳过该段；调用方（index.js）再包一层 try/catch。
 * `branch` 显式传入时优先（测试/宿主已知分支），否则读 tracks 的分支缓存并在后台刷新。
 */
export function renderLiveSnapshot({ store, layout, branch, review, reviewMode = 'suggest', skillsHint = '' } = {}) {
  if (!store) return '';
  const targets = layout?.snapshotTargets ?? ['memory', 'user'];
  const cwd = layout?.cwd;
  let effectiveBranch = branch;
  if (effectiveBranch === undefined && cwd) {
    effectiveBranch = cachedBranch(cwd);
    // 缓存过期就后台刷新；本 step 先用旧值（没有旧值就先不显示分支行）。
    void primeBranch(cwd);
  }

  const blocks = [];
  for (const target of targets) {
    try {
      let entries = loadEntries(store, target);
      if (target === 'key') entries = filterKeyEntries(entries, effectiveBranch);
      const block = store.renderEntries(target, entries);
      if (block) blocks.push(block);
    } catch (error) {
      console.warn(`[memory-notes] failed to render ${target} snapshot: ${error?.message ?? error}`);
    }
  }

  const lines = [];
  // layeredTargets:false 时没有 project/daily 轨，别提示模型去写不存在的 target。
  lines.push(SEARCH_HINT);
  if (layout?.layered !== false) lines.push(CLOSING_HINT);
  if (review) lines.push(reviewStatusLine(review, reviewMode));
  if (effectiveBranch) lines.push(branchLine(effectiveBranch));
  if (skillsHint) lines.push(skillsHint);

  const body = blocks.length ? `${blocks.join('\n\n')}\n\n${lines.join('\n')}` : lines.join('\n');
  return `${SNAPSHOT_NOTE}\n\n${body}`;
}
