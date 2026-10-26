/**
 * Phase 2：后台记忆 / 技能 review 调度器。
 *
 * 文案对齐 Hermes Agent 0.22.5 `agent/background_review.py`：
 *  - _MEMORY_ROUTING_BLOCK：两个 store 的分工，一条事实只进一个 store；
 *  - _MEMORY_REVIEW_PROMPT：只做「值得长期记住」的那一次写入，没有就 Nothing to save.；
 *  - _SKILL_REVIEW_PROMPT：Be ACTIVE，优先更新真正用过的技能，写规则 + 原因，不抄 AGENTS.md；
 *  - _COMBINED_REVIEW_PROMPT：两者都开时合并成一次 review（默认）。
 *
 * 三条硬约束：
 *  - 监听器里绝不抛异常（宿主会被打断），失败只 console.warn；
 *  - review 子会话自己的 turn/end 不计数，避免自我触发；
 *  - 起不来（无 agents / 无 subagents / 抛错）时保留计数，下一轮重试。
 */
import fs from 'node:fs';
import path from 'node:path';

import { clearReviewSession, markReviewSession } from './review-registry.js';
import {
  createReviewLog,
  diffEntries,
  diffPreview,
  isEmptyDiff,
  summarizeDiff,
} from './review-log.js';

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
  if (isEmptyDiff(diff)) return '🧠 记忆回顾完成，没有需要保存的内容';
  const summary = entry?.summary || summarizeDiff(diff);
  const base = `🧠 记忆已更新 · ${summary}（详情见左侧栏「记忆」面板）`;
  if (mode !== 'verbose') return base;
  const lines = [];
  for (const key of ['memory', 'user']) {
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
  const scope = {
    memory: config.memoryEnabled !== false,
    skills: config.skillsEnabled !== false,
  };
  const state = readState(stateFile);
  const reviewing = new Set(); // review 子会话 id（它们的 turn/end 不计数）
  const controller = new AbortController();
  const noticeMode = config.noticeMode ?? 'on';
  const reviewLog = config.reviewLog ?? createReviewLog(store?.dir ?? dir);
  let disposed = false;
  let warnedUnavailable = false;

  function snapshotStores() {
    const out = { memory: [], user: [] };
    if (store && typeof store.load === 'function') {
      for (const target of ['memory', 'user']) {
        try {
          out[target] = store.load(target) ?? [];
        } catch {
          out[target] = [];
        }
      }
    }
    return out;
  }

  function finishReview({ parent, session, childId, before, startedAt }) {
    try {
      const after = snapshotStores();
      const memory = diffEntries(before.memory, after.memory);
      const user = diffEntries(before.user, after.user);
      const summary = summarizeDiff({ memory, user });
      const entry = reviewLog.record({
        channel: 'review',
        session_id: session?.id,
        child_id: childId,
        started_at: startedAt,
        finished_at: Date.now(),
        memory,
        user,
        summary,
      });
      if (noticeMode === 'off') return;
      let agents;
      try {
        agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
      } catch {
        agents = undefined;
      }
      const agent = agents?.get?.(session?.id) ?? parent;
      if (!agent) {
        warn('main session agent is gone; memory review notice was not delivered');
        return;
      }
      void notifyReview(agent, entry, noticeMode);
    } catch (error) {
      warn('failed to record background review', error);
    }
  }

  const prompt =
    typeof config.prompt === 'string' && config.prompt ? config.prompt : reviewPrompt({ ...scope, skillsEnabled: scope.skills });

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
        warn('subagent delegation is unavailable; background review is disabled for this host');
      }
      persist(); // 计数继续累加，等宿主补齐能力后仍按节奏触发
      return;
    }
    const parent = agents.get(session.id);
    if (!parent) {
      persist(); // 会话已回收：保留计数，等下一轮
      return;
    }

    const before = snapshotStores();
    const startedAt = Date.now();
    const activation = subagents.startActivation({
      provider,
      label: 'memory-review',
      request: { prompt: [{ type: 'text', text: prompt }], parent },
      signal: controller.signal,
      delivery: 'caller',
    });
    Promise.resolve(activation).then(
      ({ childId, result }) => {
        if (typeof childId === 'string') {
          reviewing.add(childId);
          markReviewSession(childId); // memory 工具据此把破坏性写入转成 stage
        }
        entry.turns = 0;
        entry.nudged = (entry.nudged ?? 0) + 1;
        entry.lastAt = new Date().toISOString();
        persist();
        Promise.resolve(result)
          .then(
            () => {},
            (error) => warn('background review failed', error),
          )
          .then(() => {
            if (typeof childId === 'string') {
              reviewing.delete(childId);
              clearReviewSession(childId);
            }
            finishReview({ parent, session, childId, before, startedAt });
          });
      },
      (error) => {
        warn('failed to start background review', error);
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
