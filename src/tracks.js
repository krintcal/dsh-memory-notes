/**
 * 0.7.0 分层记忆（五轨）：
 *
 *   memory  <dir>/MEMORY.md                     跨会话的工作笔记
 *   user    <dir>/USER.md                       用户画像 / 偏好
 *   key     <dir>/projects/<hash>/KEY.md        按 git 分支过滤的项目要点
 *   project <dir>/projects/<hash>/PROJECT.md    项目进展日志（不注入快照）
 *   daily   <dir>/daily/<YYYY-MM-DD>.md         当天小结（不注入快照）
 *
 * `<hash>` = sha256(workspace cwd) 前 12 位；没有 cwd 时用 `global`。
 * key 条目可以在末尾带 `[branch:main,release]` 标签；注入时只保留「无标签」或
 * 「包含当前分支」的条目。当前分支未知时全量注入，绝不因为探测失败而隐藏记忆。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export const TRACK_TARGETS = ['memory', 'user', 'key', 'project', 'daily'];
export const SNAPSHOT_TARGETS = ['memory', 'user', 'key'];

export const TRACK_LIMITS = {
  memory: 2200,
  user: 1375,
  key: 2200,
  project: 8000,
  daily: 6000,
};

const BRANCH_TTL_MS = 60_000;
const BRANCH_TIMEOUT_MS = 2_000;
const BRANCH_TAG_RE = /\s*\[branch:([^\]]*)\]\s*$/i;

/** workspace cwd → projects 目录名；无 cwd 统一落到 global。 */
export function workspaceHash(cwd) {
  if (typeof cwd !== 'string' || !cwd) return 'global';
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12);
}

/** 本地日期，避免 toISOString() 在 UTC 边界上把 daily 写到昨天/明天。 */
export function dateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dailyFile(dir, date = new Date()) {
  return path.join(dir, 'daily', `${dateStamp(date)}.md`);
}

export function projectInfo(dir, cwd) {
  const hash = workspaceHash(cwd);
  const projectDir = path.join(dir, 'projects', hash);
  return {
    hash,
    cwd: typeof cwd === 'string' && cwd ? cwd : null,
    label: typeof cwd === 'string' && cwd ? path.basename(cwd) || 'global' : 'global',
    dir: projectDir,
    keyFile: path.join(projectDir, 'KEY.md'),
    projectFile: path.join(projectDir, 'PROJECT.md'),
    metaFile: path.join(projectDir, 'meta.json'),
  };
}

function readMeta(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * meta.json 只写一次；除非 cwd 变了（hash 碰撞或旧的 global 记录）。
 * 写失败只 warn：项目记忆本身仍然可用。
 */
export function ensureProjectMeta(dir, cwd) {
  const info = projectInfo(dir, cwd);
  const existing = readMeta(info.metaFile);
  const normalized = info.cwd;
  if (existing && (existing.cwd ?? null) === normalized) return existing;
  const meta = {
    cwd: normalized,
    label: info.label,
    updated_at: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(info.dir, { recursive: true });
    const tmp = `${info.metaFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, info.metaFile);
  } catch (error) {
    console.warn(`[memory-notes] failed to write ${info.metaFile}: ${error?.message ?? error}`);
  }
  return meta;
}

/**
 * 组装 store 需要的 tracks 配置。layeredTargets:false 时退回 0.6.0 的 memory/user。
 */
export function createTracks({ dir, cwd, layered = true, limits = {} } = {}) {
  const targets = layered ? [...TRACK_TARGETS] : ['memory', 'user'];
  const files = { memory: 'MEMORY.md', user: 'USER.md' };
  const project = layered ? projectInfo(dir, cwd) : undefined;
  if (layered) {
    ensureProjectMeta(dir, cwd);
    files.key = project.keyFile;
    files.project = project.projectFile;
    // 文件名随日期变化：每次 fileFor() 现算，跨午夜自然切到新文件。
    files.daily = () => dailyFile(dir);
  }
  return {
    dir,
    cwd: typeof cwd === 'string' && cwd ? cwd : null,
    layered,
    targets,
    files,
    limits: {
      memoryCharLimit: limits.memoryCharLimit ?? TRACK_LIMITS.memory,
      userCharLimit: limits.userCharLimit ?? TRACK_LIMITS.user,
      keyCharLimit: limits.keyCharLimit ?? TRACK_LIMITS.key,
      projectLogCharLimit: limits.projectLogCharLimit ?? TRACK_LIMITS.project,
      dailyLogCharLimit: limits.dailyLogCharLimit ?? TRACK_LIMITS.daily,
    },
    project,
    snapshotTargets: layered ? [...SNAPSHOT_TARGETS] : ['memory', 'user'],
  };
}

/* ------------------------------- 分支探测 -------------------------------- */

const branchCache = new Map(); // cwd -> {value, at, pending}

function runGitBranch(cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let output = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(undefined);
    }, BRANCH_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => {
      const value = code === 0 ? output.trim() : '';
      finish(value && value !== 'HEAD' ? value : undefined);
    });
  });
}

function cacheEntry(cwd) {
  const key = typeof cwd === 'string' && cwd ? cwd : '';
  return { key, hit: branchCache.get(key) };
}

/** 同步读最近一次成功探测；过期/没探测过返回 undefined。 */
export function cachedBranch(cwd) {
  if (typeof cwd !== 'string' || !cwd) return undefined;
  const { hit } = cacheEntry(cwd);
  if (!hit || Date.now() - hit.at >= BRANCH_TTL_MS) return undefined;
  return hit.value;
}

/** 后台刷新分支缓存；绝不抛错。返回同一个 pending Promise（便于测试 await）。 */
export function primeBranch(cwd) {
  if (typeof cwd !== 'string' || !cwd) return Promise.resolve(undefined);
  const { key, hit } = cacheEntry(cwd);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return Promise.resolve(hit.value);
  const pending = runGitBranch(cwd)
    .then(
      (value) => {
        branchCache.set(key, { value, at: Date.now() });
        return value;
      },
      () => {
        branchCache.set(key, { value: undefined, at: Date.now() });
        return undefined;
      },
    )
    .finally(() => {
      const current = branchCache.get(key);
      if (current) delete current.pending;
    });
  branchCache.set(key, { value: hit?.value, at: hit?.at ?? 0, pending });
  return pending;
}

/**
 * 当前 git 分支。成功结果缓存 60 秒；非 git / 失败 / 超时返回 undefined，从不抛。
 */
export async function currentBranch(cwd) {
  if (typeof cwd !== 'string' || !cwd) return undefined;
  const { hit } = cacheEntry(cwd);
  if (hit && !hit.pending && Date.now() - hit.at < BRANCH_TTL_MS) return hit.value;
  return primeBranch(cwd);
}

/* ------------------------------- 分支过滤 -------------------------------- */

/** 解析条目末尾的 `[branch:a,b]`；没有标签时 branches 为 null。 */
export function parseBranchTag(entry) {
  const text = typeof entry === 'string' ? entry : String(entry ?? '');
  const match = BRANCH_TAG_RE.exec(text);
  if (!match) return { entry: text, branches: null };
  const branches = match[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return { entry: text, branches };
}

/** 当前分支未知 → 全量返回；否则保留无标签条目与包含该分支的条目。 */
export function filterKeyEntries(entries, branch) {
  const list = Array.isArray(entries) ? entries : [];
  if (!branch) return [...list];
  return list.filter((entry) => {
    const parsed = parseBranchTag(entry);
    if (parsed.branches === null) return true;
    return parsed.branches.includes(branch);
  });
}
