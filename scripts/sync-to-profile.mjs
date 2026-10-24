/**
 * 把本仓库的源码同步进 profile 里的安装副本。
 *
 * 为什么需要：插件以 `file:` 依赖装进 profile，pnpm 会把包**复制**进
 * `E:\dsh\home\profiles\desktop\node_modules\dsh-memory-notes`（部分文件是硬链接，
 * 部分不是）。于是仓库里改了代码，运行中的宿主读到的仍是旧副本 —— 这类
 * "改了没反应" 会表现为 bundle 静默不激活。
 *
 * 硬链接的文件与仓库是同一 inode，复制会报 EINVAL，这里按 "同文件即已同步" 跳过。
 *
 * 用法：node scripts/sync-to-profile.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const profileDir =
  process.env.DSH_MEMORY_PROFILE_PKG ??
  path.join(process.env.DSH_HOME ?? 'E:\\dsh\\home', 'profiles', 'desktop', 'node_modules', 'dsh-memory-notes');

if (!existsSync(profileDir)) {
  console.error(`profile copy not found: ${profileDir}`);
  process.exit(1);
}

let copied = 0;
let skipped = 0;

function copyOne(from, to) {
  try {
    copyFileSync(from, to);
    copied += 1;
  } catch (error) {
    // EINVAL：源与目标是同一 inode（pnpm 硬链接），内容本来就一致。
    if (error && (error.code === 'EINVAL' || error.code === 'ERR_FS_CP_EINVAL')) {
      skipped += 1;
      return;
    }
    throw error;
  }
}

function syncTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const entry of readdirSync(fromDir)) {
    const from = path.join(fromDir, entry);
    const to = path.join(toDir, entry);
    if (statSync(from).isDirectory()) syncTree(from, to);
    else copyOne(from, to);
  }
}

for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'icon.svg', 'package.json']) {
  const from = path.join(repo, file);
  if (existsSync(from)) copyOne(from, path.join(profileDir, file));
}

for (const dir of ['src', 'locale', 'tests', 'scripts']) {
  const from = path.join(repo, dir);
  if (existsSync(from)) syncTree(from, path.join(profileDir, dir));
}

console.log(`synced ${repo} -> ${profileDir} (copied ${copied}, hardlinked ${skipped})`);
