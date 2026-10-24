/**
 * Phase 2：后台记忆 review 调度器。
 *
 * 语义对齐 Hermes 的 memory nudge：每 N 个用户轮（这里按 turn/end 计数），在
 * 回合结束后起一个 fork 子会话，让它在后台回顾对话、把值得长期记住的内容写进
 * memory 工具；整个过程不进入主对话（delivery: 'caller'，主会话看不到提示）。
 *
 * 三条硬约束：
 *  - 监听器里绝不抛异常（宿主会被打断），失败只 console.warn；
 *  - review 子会话自己的 turn/end 不计数，避免自我触发；
 *  - 起不来（无 agents / 无 subagents / 抛错）时保留计数，下一轮重试。
 */
import fs from 'node:fs';
import path from 'node:path';

const REVIEW_PROMPT = [
  '你现在是后台记忆回顾任务，不是主对话。会话历史已在你上下文里。',
  '',
  '请只做一件事：找出这次会话里「值得长期记住」的信息，调用 memory 工具把它写下来。',
  '值得记的：用户的偏好/习惯/背景、项目的约定与事实（路径、技术栈、命令）、反复踩过的坑与结论、',
  '用户明确要求「记住」的内容。不值得记的：一次性的任务细节、临时状态、随手就能 grep 到的东西。',
  '',
  '写法：',
  '- 用户相关 → target=user；项目/技术相关 → target=memory；',
  '- 只允许用 action=add 直接写；如果已存在语义相近的条目需要合并，用 action=stage（op=replace/remove）',
  '  排队等主会话确认——不要用 replace/remove 直接改，后台任务不许动已有条目；',
  '- 每条尽量一句话说清「结论 + 为什么」，字符数加起来别超过配额（超了会被拒绝，那就 stage 一条合并建议）。',
  '',
  '规则：',
  '- 只允许调用 memory 工具，不要调用其它工具，不要读写文件，不要执行命令；',
  '- 没有值得记录的内容，就只回复 Nothing to save.；',
  '- 写完后不要再解释过程，最多用一行说明你记住了什么。',
].join('\n');

function warn(message, error) {
  try {
    console.warn(`[memory-notes] ${message}`, error?.message ?? error ?? '');
  } catch {
    /* 连 console 都不可用就算了 */
  }
}

function readState(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      return { sessions: parsed.sessions };
    }
  } catch {
    /* 文件不存在或坏 JSON：当成空状态 */
  }
  return { sessions: {} };
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function createNudgeScheduler({ ctx, store, config = {} }) {
  const dir = config.dir ?? store?.dir;
  if (!dir) throw new Error('nudge scheduler needs a memory directory');

  const stateFile = config.stateFile ?? path.join(dir, 'nudge-state.json');
  const interval = Math.max(1, Number(config.nudgeInterval ?? 10) || 10);
  const provider = config.provider ?? 'fork';
  const state = readState(stateFile);
  const reviewing = new Set(); // review 子会话 id（它们的 turn/end 不计数）
  const controller = new AbortController();
  let disposed = false;
  let warnedUnavailable = false;

  const persist = () => {
    try {
      writeState(stateFile, state);
    } catch (error) {
      warn(`failed to persist ${stateFile}`, error);
    }
  };

  function launchReview(session, entry) {
    // cordis 对未 inject 的服务直接抛错，只能走 ctx.get()。
    const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined;
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    if (!subagents || typeof subagents.startActivation !== 'function' || !agents || typeof agents.get !== 'function') {
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        warn('subagent delegation is unavailable; memory review is disabled for this host');
      }
      persist(); // 计数继续累加，等宿主补齐能力后仍按节奏触发
      return;
    }
    const parent = agents.get(session.id);
    if (!parent) {
      persist(); // 会话已回收：保留计数，等下一轮
      return;
    }

    const activation = subagents.startActivation({
      provider,
      label: 'memory-review',
      request: { prompt: [{ type: 'text', text: REVIEW_PROMPT }], parent },
      signal: controller.signal,
      delivery: 'caller',
    });
    Promise.resolve(activation).then(
      ({ childId, result }) => {
        if (typeof childId === 'string') reviewing.add(childId);
        entry.turns = 0;
        entry.nudged = (entry.nudged ?? 0) + 1;
        entry.lastAt = new Date().toISOString();
        persist();
        Promise.resolve(result)
          .catch((error) => warn('memory review failed', error))
          .finally(() => {
            if (typeof childId === 'string') reviewing.delete(childId);
          });
      },
      (error) => {
        warn('failed to start memory review', error);
      },
    );
  }

  const onSessionEvent = (session, event) => {
    try {
      if (disposed) return;
      if (!event || event.type !== 'turn/end') return;
      const id = session?.id;
      if (typeof id !== 'string' || !id) return;
      if (reviewing.has(id)) return; // 子会话不计数

      const entry = state.sessions[id] ?? { turns: 0, nudged: 0, lastAt: null };
      entry.turns = (entry.turns ?? 0) + 1;
      state.sessions[id] = entry;

      if (entry.turns < interval) {
        persist();
        return;
      }
      launchReview(session, entry);
    } catch (error) {
      warn('nudge scheduler failed', error);
    }
  };

  const off = ctx.on('session/event', onSessionEvent);

  return {
    dispose() {
      disposed = true;
      try {
        off?.();
      } catch {
        /* ignore */
      }
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    },
  };
}
