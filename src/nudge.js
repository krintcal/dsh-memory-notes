/**
 * Phase 2（0.7.0 改造）：回合内自我审查调度器。
 *
 * 旧版每 N 轮用 `subagents.startActivation` 起一个 fork 子会话做 review；0.7.0
 * 不再启动任何子代理，改成：
 *  - 每个用户会话的 turn/end 记一次账（`review-state.json`）；
 *  - 到点的回合在内存里捕获「回顾窗口前」的 memory/user/key 条目快照；
 *  - 快照里提示主会话当轮完成回顾；
 *  - 主会话写完（直写或 suggest 入队）后调用 `memory_review_status complete`，
 *    这里再算 diff、写 review-log、inject 一条 developer 消息并清零计数。
 *
 * 三条硬约束：监听器里绝不抛异常；review/curator 子会话不计入；没 complete 就
 * 不清零（宁可下一次继续提示，也不假装回顾完成了）。
 */
import { isReviewSession } from './review-registry.js';
import {
  createReviewLog,
  diffEntries,
  diffPreview,
  isEmptyDiff,
  summarizeDiff,
} from './review-log.js';
import { completeReview, loadReviewState, recordTurn, reviewStatus } from './review-state.js';

const MEMORY_ROUTING = `Memory has TWO distinct stores:
- target='user': who the user is — profile, preferences, expectations.
- target='memory': environment facts, tool quirks, project conventions, paths.
One fact goes to ONE store, never both.`;

const MEMORY_TASK = `Review the conversation above and consider saving to memory if appropriate. If something stands out, save
it once, in the right store, using the memory tool with the matching target. Batch several changes into ONE
'operations' call. If nothing is worth saving, just say 'Nothing to save.' and stop.
Do not save task progress, conversation history, or completed work — look those up with session_search when the
host provides it. Save only facts that stay true across sessions.`;

const SKILL_TASK = `Review the conversation above and update the skill library. Be ACTIVE — most sessions produce at
least one skill update, even if small.

What to write:
- Procedures first: the steps that actually worked, in the order that works.
- A pitfall is worth one line of rule plus why it bites — never just a complaint.
- Record the durable convention, not the incident: no PR numbers, no dates, no verbatim user quotes.
- One lesson, one place. Do not restate AGENTS.md or the tool schema. If a loaded skill turned out wrong,
  fix it in place instead of writing a near-duplicate.

Signals: the user corrected your style or process; you found a non-trivial technique; a loaded skill was stale.

Preference order: (1) update the skill you actually used this session; (2) update an existing umbrella skill;
(3) add a support file (references/, templates/, scripts/); (4) create a new class-level umbrella.

Hard rules: read the skill with skill_manage action='read' before action='patch' — the read-before-write guard
rejects blind writes. Never delete a skill here.`;

const DO_NOT_CAPTURE = `Do not capture: environment-dependent failures, negative assertions ("tool X is broken"),
transient errors that were resolved in-session, one-off task narrative, or unresolved failed attempts.`;

export function reviewPrompt({ memory = true, skills = true, skillsEnabled = true } = {}) {
  const parts = [];
  if (memory && skills && skillsEnabled) {
    parts.push(
      'Review the conversation above and update two things:',
      '',
      `**Memory**: ${MEMORY_ROUTING}`,
      MEMORY_TASK,
      '',
      `**Skills**: ${SKILL_TASK}`,
      '',
      DO_NOT_CAPTURE,
      '',
      'Background rule (DSH): the memory tool writes add directly, but patch/remove are staged for the main session ' +
        "automatically — propose them, don't expect them applied.",
    );
  } else if (memory) {
    parts.push(MEMORY_ROUTING, '', MEMORY_TASK, '', DO_NOT_CAPTURE);
  } else {
    parts.push(SKILL_TASK, '', DO_NOT_CAPTURE);
  }
  return parts.join('\n');
}

function warn(message, error) {
  try {
    console.warn(`[memory-notes] ${message}`, error?.message ?? error ?? '');
  } catch {
    /* 连 console 都不可用就算了 */
  }
}

let warnedLlmImport = false;

/** 优先用宿主的开发者消息构造函数；拿不到就回退普通对象（只 warn 一次）。 */
async function developerMessage(text) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    const create = mod?.createDeveloperMessage ?? mod?.default?.createDeveloperMessage;
    if (typeof create === 'function') {
      return create({ content: [{ type: 'text', text }], source: { kind: 'memory-review' } });
    }
  } catch (error) {
    if (!warnedLlmImport) {
      warnedLlmImport = true;
      warn('@deepseek-ai/dsh-llm unavailable; using a plain developer message', error);
    }
  }
  return { role: 'developer', content: [{ type: 'text', text }], source: { kind: 'memory-review' } };
}

export function reviewNoticeText(entry, mode = 'on') {
  const diff = { memory: entry?.memory, user: entry?.user };
  if (entry?.key !== undefined) diff.key = entry.key;
  if (isEmptyDiff(diff)) return '🧠 记忆回顾完成，没有需要保存的内容';
  const summary = entry?.summary || summarizeDiff(diff);
  const base = `🧠 记忆已更新 · ${summary}（详情见左侧栏「记忆」面板）`;
  if (mode !== 'verbose') return base;
  const lines = [];
  for (const key of ['memory', 'user', 'key']) {
    if (diff[key] === undefined) continue;
    for (const line of diffPreview(diff[key])) {
      if (lines.length >= 3) break;
      lines.push(line);
    }
    if (lines.length >= 3) break;
  }
  return lines.length ? `${base}\n${lines.join('\n')}` : base;
}

/** 通过 agent.inject 推一条开发者消息；绝不用 followup / steer，避免多跑一轮模型。 */
export async function notifyReview(agent, entry, mode = 'on') {
  if (!agent || typeof agent.inject !== 'function') {
    warn('no main-session agent to receive the memory review notice; skipping inject');
    return false;
  }
  const text = reviewNoticeText(entry, mode);
  const message = await developerMessage(text);
  try {
    const result = agent.inject(message);
    if (result && typeof result.catch === 'function') {
      await result.catch((error) => warn('failed to inject memory review notice', error));
    }
    return true;
  } catch (error) {
    warn('failed to inject memory review notice', error);
    return false;
  }
}

/** 读取 store 里参与快照的三轨；任何一轨读失败都退化成空数组。 */
export function snapshotStores(store) {
  const out = { memory: [], user: [], key: [] };
  const targets = Array.isArray(store?.targets) ? store.targets : ['memory', 'user'];
  for (const target of ['memory', 'user', 'key']) {
    if (!targets.includes(target)) continue;
    try {
      out[target] = store.load(target) ?? [];
    } catch {
      out[target] = [];
    }
  }
  return out;
}

/**
 * 结算一次回顾（给 `memory_review_status complete` 调用）。
 *
 * 签名按任务书：finishReview(sessionId, store, reviewLog, noticeMode)。
 * options.before / startedAt 由调度器在到点时捕获；拿不到就按「窗口内没有变化」
 * 处理。仍然清零计数、写账本，并在 noticeMode 允许时通知主会话。
 */
export function finishReview(sessionId, store, reviewLog, noticeMode = 'on', options = {}) {
  const id = typeof sessionId === 'string' && sessionId ? sessionId : 'unknown';
  const after = snapshotStores(store);
  const before = options.before ?? after;
  const memory = diffEntries(before.memory, after.memory);
  const user = diffEntries(before.user, after.user);
  const hasKey = Array.isArray(store?.targets) && store.targets.includes('key');
  const key = hasKey ? diffEntries(before.key ?? [], after.key ?? []) : undefined;
  const diff = key === undefined ? { memory, user } : { memory, user, key };
  const summary = summarizeDiff(diff);
  const entry = reviewLog?.append
    ? reviewLog.append({
        channel: 'review',
        session_id: id,
        started_at: options.startedAt ?? Date.now(),
        finished_at: Date.now(),
        ...diff,
        summary,
      })
    : undefined;
  if (noticeMode !== 'off' && options.agent) {
    void notifyReview(options.agent, entry ?? { ...diff, summary }, noticeMode);
  }
  if (store?.dir) completeReview(store.dir, loadReviewState(store.dir));
  return { sessionId: id, summary, entry };
}

function resolveAgent(ctx, sessionId) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get('agents')?.get?.(sessionId) : undefined;
  } catch {
    return undefined;
  }
}

export function createNudgeScheduler({ ctx, store, config = {} }) {
  const dir = config.dir ?? store?.dir;
  if (!dir) throw new Error('nudge scheduler needs a memory directory');

  const interval = Math.max(1, Number(config.reviewInterval ?? config.nudgeInterval ?? 10) || 10);
  const reviewMode = config.reviewMode === 'auto' ? 'auto' : 'suggest';
  const noticeMode = config.noticeMode ?? 'on';
  const reviewLog = config.reviewLog ?? createReviewLog(dir);
  const pendingSnapshots = new Map(); // sessionId -> { before, startedAt }
  let disposed = false;

  function capture(sessionId) {
    if (pendingSnapshots.has(sessionId)) return;
    pendingSnapshots.set(sessionId, { before: snapshotStores(store), startedAt: Date.now() });
  }

  function onSessionEvent(session, event) {
    try {
      if (disposed) return;
      if (!event || event.type !== 'turn/end') return;
      const id = session?.id;
      if (typeof id !== 'string' || !id) return;
      if (isReviewSession(id)) return; // review / curator 子会话不计数
      const next = recordTurn(dir, loadReviewState(dir), interval);
      if (reviewStatus(next, interval).due) capture(id);
    } catch (error) {
      warn('nudge scheduler failed', error);
    }
  }

  const off = typeof ctx?.on === 'function' ? ctx.on('session/event', onSessionEvent) : undefined;

  return {
    interval,
    reviewMode,
    status() {
      return reviewStatus(loadReviewState(dir), interval);
    },
    /** 调度器内部结算：取出到点时捕获的 before，顺便解析主会话 agent。 */
    finishReview(sessionId) {
      const id = typeof sessionId === 'string' && sessionId ? sessionId : 'unknown';
      const captured = pendingSnapshots.get(id);
      try {
        const result = finishReview(id, store, reviewLog, noticeMode, {
          before: captured?.before,
          startedAt: captured?.startedAt,
          agent: resolveAgent(ctx, id),
        });
        pendingSnapshots.delete(id);
        return result;
      } catch (error) {
        warn('failed to finish memory review', error);
        pendingSnapshots.delete(id);
        return { sessionId: id, summary: '', entry: undefined };
      }
    },
    dispose() {
      disposed = true;
      try {
        off?.();
      } catch {
        /* ignore */
      }
      pendingSnapshots.clear();
    },
  };
}
