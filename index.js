/**
 * dsh-memory-notes — Host 半边。
 *
 * 只做这几件事：
 *  1) 解析配置 / 默认目录，建一个分层 MemoryStore（memory/user/key/project/daily）；
 *  2) 注册 `memory` / `memory_review_status` 工具；
 *  3) 注册 `memory:snapshot` 运行时上下文（context，而不是 section）：每个 step
 *     现算，内容变化时宿主会在对话尾部追加一条新的 user-role 消息。
 *
 * 0.7.0 起不再冻结快照：本会话内写入下一轮即可见，同时保留 prompt 前缀缓存
 * （文本没变就不会 append）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from './src/store.js';
import { createPendingStore } from './src/pending.js';
import { createCurator } from './src/curator.js';
import { createNudgeScheduler } from './src/nudge.js';
import { createReviewLog } from './src/review-log.js';
import { loadReviewState, reviewStatus } from './src/review-state.js';
import { reviewToolDefinition } from './src/review-tool.js';
import { createSkillLibrary } from './src/skills.js';
import { skillToolDefinition } from './src/skill-tool.js';
import { searchToolDefinition } from './src/search-tool.js';
import { renderLiveSnapshot } from './src/snapshot.js';
import {
  count as countSuggestions,
  drop as dropSuggestion,
  enqueue as enqueueSuggestion,
  list as listSuggestions,
  take as takeSuggestion,
} from './src/suggestions.js';
import { toolDefinition } from './src/tool.js';
import { createTracks, primeBranch } from './src/tracks.js';
import { registerWebPanel } from './src/web.js';
import { createWriteLog } from './src/write-log.js';

export const name = 'memory-notes';
export const inject = ['tools', 'systemPrompt'];

/** 本机桌面端会设置 DSH_PROFILE_DIR（如 …/profiles/desktop）；只设 DSH_PROFILE 时按约定推导。 */
function resolveProfileDir() {
  if (process.env.DSH_PROFILE_DIR) return path.join(process.env.DSH_PROFILE_DIR, 'memories');
  if (process.env.DSH_PROFILE) {
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
    return path.join(home, 'profiles', process.env.DSH_PROFILE, 'memories');
  }
  return undefined;
}

/** 记忆目录解析顺序：显式 dir → profile → DSH_MEMORY_DIR → DSH_HOME/memories → ~/.dsh/memories。 */
function resolveDir(config) {
  if (typeof config.dir === 'string' && config.dir) return { dir: config.dir, profileScoped: false };
  if (config.profileScoped !== false) {
    const profileDir = resolveProfileDir();
    if (profileDir) return { dir: profileDir, profileScoped: true };
  }
  if (process.env.DSH_MEMORY_DIR) return { dir: process.env.DSH_MEMORY_DIR, profileScoped: false };
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return { dir: path.join(home, 'memories'), profileScoped: false };
}

/**
 * workspace cwd：显式 config.cwd 优先；否则问宿主 workspace 服务；最后退到 process.cwd()。
 * 显式传 null 表示「没有 cwd」，项目轨会落到 projects/global。
 */
function resolveCwd(config, ctx) {
  if (Object.prototype.hasOwnProperty.call(config, 'cwd')) {
    return typeof config.cwd === 'string' && config.cwd ? config.cwd : undefined;
  }
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('workspace') : ctx?.workspace;
    const cwd = service?.cwd ?? ctx?.cwd;
    if (typeof cwd === 'string' && cwd) return cwd;
  } catch {
    /* 宿主没有 workspace 服务 */
  }
  return process.cwd();
}

/**
 * 一次性迁移：profile 记忆目录还是空的时候，把旧的全局 DSH_HOME/memories 里的
 * MEMORY.md / USER.md 复制过来（不删源）。只在 profile 解析路径上执行，显式
 * config.dir 的调用方（含测试）完全不碰真实 home。
 */
function migrateLegacyMemories(targetDir) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const sourceDir = path.join(home, 'memories');
  if (path.resolve(sourceDir) === path.resolve(targetDir)) return;
  const files = ['MEMORY.md', 'USER.md'];
  if (files.some((file) => fs.existsSync(path.join(targetDir, file)))) return;
  const existing = files.filter((file) => fs.existsSync(path.join(sourceDir, file)));
  if (existing.length === 0) return;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of existing) fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
    console.warn(`[memory-notes] migrated memories from ${sourceDir} to ${targetDir}`);
  } catch (error) {
    console.warn(`[memory-notes] memory migration failed: ${error?.message ?? error}`);
  }
}

/** 技能库位置：默认写用户级 ~/.agents/skills（DSH 自带的 skills 提供方会读到这里）。 */
function resolveSkillsDir(config) {
  if (typeof config.skillsDir === 'string' && config.skillsDir) return config.skillsDir;
  if (process.env.DSH_SKILLS_DIR) return process.env.DSH_SKILLS_DIR;
  return path.join(os.homedir(), '.agents', 'skills');
}

export function apply(ctx, config = {}) {
  const resolved = resolveDir(config);
  if (resolved.profileScoped) migrateLegacyMemories(resolved.dir);

  const cwd = resolveCwd(config, ctx);
  const tracks = createTracks({
    dir: resolved.dir,
    cwd,
    layered: config.layeredTargets !== false,
    limits: {
      memoryCharLimit: config.memoryCharLimit ?? 2200,
      userCharLimit: config.userCharLimit ?? 1375,
      keyCharLimit: config.keyCharLimit ?? 2200,
      projectLogCharLimit: config.projectLogCharLimit ?? 8000,
      dailyLogCharLimit: config.dailyLogCharLimit ?? 6000,
    },
  });

  const writeLog = createWriteLog(resolved.dir);
  const reviewLog = createReviewLog(resolved.dir);
  const store = new MemoryStore({
    dir: resolved.dir,
    ...tracks.limits,
    files: tracks.files,
    targets: tracks.targets,
    threatScan: config.threatScan !== false,
    entryCharLimit: config.entryCharLimit ?? 200,
    addSimilarityLimit: config.addSimilarityLimit ?? 0.75,
    budgetGatePercent: config.budgetGatePercent ?? 85,
    onWrite: (record) => writeLog.append(record),
  });
  if (cwd) void primeBranch(cwd);

  const pendingDir = config.pendingDir ?? path.join(store.dir, 'pending');
  // tool 与面板共用同一个待确认队列：面板里看到的就是工具列表里的那批记录。
  const pending = createPendingStore(pendingDir);

  // 回顾建议队列：memory 工具的 action:'suggest' 与面板的「采纳/丢弃」共用。
  const suggestions = {
    enqueue: (record) => enqueueSuggestion(store.dir, record),
    list: () => listSuggestions(store.dir),
    take: (id) => takeSuggestion(store.dir, id),
    drop: (id) => dropSuggestion(store.dir, id),
    count: () => countSuggestions(store.dir),
  };

  const reviewInterval = Math.max(1, Number(config.reviewInterval ?? config.nudgeInterval ?? 10) || 10);
  const reviewMode = config.reviewMode === 'auto' ? 'auto' : 'suggest';

  // 0.7.0：review 不再起 fork；调度器只记回合数、到点捕获 before 快照、等 complete。
  let scheduler;
  if (config.reviewEnabled !== false) {
    scheduler = createNudgeScheduler({
      ctx,
      store,
      config: {
        dir: store.dir,
        nudgeInterval: reviewInterval,
        reviewInterval,
        reviewMode,
        noticeMode: config.noticeMode ?? 'on',
        prompt: config.reviewPrompt,
        reviewLog,
      },
    });
    if (typeof ctx.effect === 'function') ctx.effect(() => () => scheduler.dispose());
  }

  const toolDeps = {
    store,
    limits: store.limits,
    // 后台 review 的破坏性写入落在这里，等主会话确认
    pendingDir,
    pending,
    suggestions,
    config: { approvalMode: config.approvalMode ?? 'ask' },
  };
  // 宿主服务一律懒取：apply 时 approval / agents 可能还没注册。
  if (typeof ctx.get === 'function') {
    toolDeps.approval = () => {
      try {
        return ctx.get('approval');
      } catch {
        return undefined;
      }
    };
    toolDeps.getAgent = (id) => {
      try {
        return ctx.get('agents')?.get?.(id);
      } catch {
        return undefined;
      }
    };
  }
  ctx.tools.register(toolDefinition(toolDeps));
  // 0.10.0：冷热分层——project/daily 与更早的条目不注入，按需检索。
  if (config.searchEnabled !== false) ctx.tools.register(searchToolDefinition({ store }));

  if (scheduler) {
    ctx.tools.register(
      reviewToolDefinition({
        dir: store.dir,
        interval: reviewInterval,
        mode: reviewMode,
        suggestions,
        scheduler,
      }),
    );
  }

  // 左侧栏「记忆」面板的宿主半边（可选服务 webServer，CLI 宿主没有就自动跳过）。
  if (config.webPanelEnabled !== false) {
    registerWebPanel(ctx, {
      store,
      pending,
      reviewLog,
      writeLog,
      suggestions,
      review: () => {
        if (!scheduler) return { due: false, turns_since: 0, interval: reviewInterval, mode: 'off' };
        const status = reviewStatus(loadReviewState(store.dir), reviewInterval);
        return { due: status.due, turns_since: status.turns_since, interval: status.interval, mode: reviewMode };
      },
    });
  }

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
          ctx,
          store,
          reviewLog,
          config: {
            intervalHours: config.curatorIntervalHours ?? 168,
            staleAfterDays: config.curatorStaleAfterDays ?? 14,
            archiveAfterDays: config.curatorArchiveAfterDays ?? 30,
            keepSnapshots: config.curatorKeepSnapshots ?? 5,
            paused: config.curatorPaused === true,
            consolidate: config.curatorConsolidate ?? 'off',
          },
        })
      : undefined;

  if (library) ctx.tools.register(skillToolDefinition({ library, curator }));

  if (curator && typeof ctx.on === 'function') {
    ctx.effect(() =>
      ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end') return;
        // 归档要打快照、算 sha256，全是同步 IO；推到下一拍执行，别卡住回合收尾。
        setImmediate(() => {
          try {
            curator.maybeRun({ session });
          } catch {
            /* 整理失败不该影响对话 */
          }
        });
      }),
    );
  }

  const skillsHint =
    config.skillsEnabled === false
      ? ''
      : 'To keep a reusable procedure, write a skill with the skill_manage tool (create / patch).';

  function reviewView() {
    if (!scheduler) return undefined;
    const status = reviewStatus(loadReviewState(store.dir), reviewInterval);
    return { due: status.due, turns_since: status.turns_since, interval: status.interval };
  }

  /** 每次 step 现算；任何异常都退化成空串，绝不让宿主步骤失败。 */
  function renderLive() {
    try {
      if (cwd) void primeBranch(cwd);
      return renderLiveSnapshot({
        store,
        layout: tracks,
        review: reviewView(),
        reviewMode,
        skillsHint,
      });
    } catch (error) {
      console.warn(`[memory-notes] live snapshot failed: ${error?.message ?? error}`);
      return '';
    }
  }

  const snapshotContext = {
    name: 'memory:snapshot',
    order: config.snapshotOrder ?? 9000,
    text: () => renderLive(),
  };
  // context 是 user-role 尾部消息，只在文本变化时追加；section 会改整个系统提示词。
  if (typeof ctx.systemPrompt.context === 'function') ctx.systemPrompt.context(snapshotContext);
  else ctx.systemPrompt.section(snapshotContext);
}
