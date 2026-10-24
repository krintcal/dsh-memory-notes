/**
 * dsh-memory-notes — Host 半边。
 *
 * 只做三件事：
 *  1) 解析配置 / 默认目录，建一个 MemoryStore；
 *  2) 注册 `memory` 工具（定义在 src/tool.js）；
 *  3) 注册 `memory` 系统提示词段，内容是会话开始时冻结的快照。
 *
 * 冻结快照是 Hermes 的 prompt-cache 语义：同一会话内后续写入不改变本会话
 * 已经注入的文本，改动从下一个会话开始可见。
 */
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from './src/store.js';
import { createCurator } from './src/curator.js';
import { createNudgeScheduler } from './src/nudge.js';
import { createSkillLibrary } from './src/skills.js';
import { skillToolDefinition } from './src/skill-tool.js';
import { toolDefinition } from './src/tool.js';

export const name = 'memory-notes';
export const inject = ['tools', 'systemPrompt'];

const SNAPSHOT_NOTE =
  'Persistent memory loaded at session start. Use the memory tool to add, replace, or remove entries; writes apply to the next session.';

function resolveDir(config) {
  if (typeof config.dir === 'string' && config.dir) return config.dir;
  if (process.env.DSH_MEMORY_DIR) return process.env.DSH_MEMORY_DIR;
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'memories');
}

/** 技能库位置：默认写用户级 ~/.agents/skills（DSH 自带的 skills 提供方会读到这里）。 */
function resolveSkillsDir(config) {
  if (typeof config.skillsDir === 'string' && config.skillsDir) return config.skillsDir;
  if (process.env.DSH_SKILLS_DIR) return process.env.DSH_SKILLS_DIR;
  return path.join(os.homedir(), '.agents', 'skills');
}

/** 会话标识可能藏在 scope.id / scope.session.id / session.id，全部容错。 */
function sessionKey(args) {
  if (!args || typeof args !== 'object') return undefined;
  const scope = args.scope;
  const id = scope?.id ?? scope?.session?.id ?? args.session?.id;
  return typeof id === 'string' && id ? id : undefined;
}

/** 一次磁盘读取；任何异常都退化成空串，绝不把提示词组装搞挂。 */
function readBlocks(store) {
  try {
    return [store.render('memory'), store.render('user')].filter(Boolean).join('\n\n');
  } catch {
    return '';
  }
}

function compose(body) {
  return body ? `${SNAPSHOT_NOTE}\n\n${body}` : '';
}

export function apply(ctx, config = {}) {
  const store = new MemoryStore({
    dir: resolveDir(config),
    memoryCharLimit: config.memoryCharLimit ?? 2200,
    userCharLimit: config.userCharLimit ?? 1375,
  });

  ctx.tools.register(
    toolDefinition({
      store,
      limits: store.limits,
      // 后台 review 的破坏性写入落在这里，等主会话确认
      pendingDir: config.pendingDir ?? path.join(store.dir, 'pending'),
    }),
  );

  // Phase 3：技能写入（自我进化的「写」半边；读的技能索引仍由 DSH 自带 skills 提供方负责）。
  let library;
  if (config.skillsEnabled !== false) {
    library = createSkillLibrary({
      dir: resolveSkillsDir(config),
      usageFile: path.join(store.dir, 'skill-usage.json'),
      strictReadBeforeWrite: config.strictReadBeforeWrite !== false,
    });
  }

  // Phase 4：curator —— 每轮问一次「到点了吗」，到点才整理（14 天 stale / 30 天归档，
  // 只归档不删，pinned 免疫，动手前留快照）。触发条件写在 src/curator.js 里。
  const curator =
    library && config.curatorEnabled !== false
      ? createCurator({
          library,
          stateDir: store.dir,
          config: {
            intervalHours: config.curatorIntervalHours ?? 168,
            staleAfterDays: config.curatorStaleAfterDays ?? 14,
            archiveAfterDays: config.curatorArchiveAfterDays ?? 30,
            keepSnapshots: config.curatorKeepSnapshots ?? 5,
            paused: config.curatorPaused === true,
          },
        })
      : undefined;

  if (library) ctx.tools.register(skillToolDefinition({ library, curator }));

  if (curator && typeof ctx.on === 'function') {
    ctx.effect(() =>
      ctx.on('session/event', (_session, event) => {
        if (event?.type !== 'turn/end') return;
        // 归档要打快照、算 sha256，全是同步 IO；推到下一拍执行，别卡住回合收尾。
        setImmediate(() => {
          try {
            curator.maybeRun();
          } catch {
            /* 整理失败不该影响对话 */
          }
        });
      }),
    );
  }

  const snapshots = new Map(); // sessionId -> frozen text
  const skillsHint =
    config.skillsEnabled === false
      ? ''
      : '\n\nTo keep a reusable procedure, write a skill with the skill_manage tool (create / patch).';

  ctx.systemPrompt.section({
    name: 'memory',
    order: 9000,
    text: (args) => {
      const key = sessionKey(args);
      // 无会话标识 ⇒ 没有可冻结的边界，每次重新读。
      if (!key) return compose(readBlocks(store)) + skillsHint;
      if (snapshots.has(key)) return snapshots.get(key);
      // 冻结之前先从盘上重读一次：宿主进程常驻，缓存会把别的进程（CLI／另一实例）
      // 或重启前写入的条目挡在外面，表现成「明明记了却没生效」。
      try {
        store.load('memory');
        store.load('user');
      } catch {
        /* 读不出来就退回缓存，绝不让提示词组装抛错 */
      }
      const frozen = compose(readBlocks(store)) + skillsHint;
      snapshots.set(key, frozen);
      // 简单 LRU：宿主里会话很多时，避免每个会话的冻结文本都常驻。
      if (snapshots.size > 256) {
        const oldest = snapshots.keys().next().value;
        if (oldest !== undefined) snapshots.delete(oldest);
      }
      return frozen;
    },
  });

  // Phase 2：每 nudgeInterval 个回合在后台起一个 review fork，把值得记的内容写进来。
  // 注意：不能把 subagents 写进 inject（精简宿主没有它就会卡住不激活），也不能直接读
  // ctx.subagents（cordis 对未声明服务会抛错）。这里也**不能**在 apply 时 gate 掉：
  // 服务是后注册的，apply 时 ctx.get('subagents') 还是 undefined，会把调度器一起关掉。
  // 服务一律在真正要派发时懒取（见 src/nudge.js）。
  if (config.reviewEnabled !== false && typeof ctx.on === 'function') {
    const scheduler = createNudgeScheduler({
      ctx,
      store,
      config: {
        dir: store.dir,
        stateFile: config.stateFile,
        nudgeInterval: config.nudgeInterval ?? 10,
        provider: config.provider ?? 'fork',
      },
    });
    ctx.effect(() => () => scheduler.dispose());
  }
}
