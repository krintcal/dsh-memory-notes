/**
 * Phase 4：curator —— 空闲时整理技能库。
 *
 * 照 Hermes 的 agent/curator.py，但只做「按时间归档」这一半，不做 LLM 合并：
 *   - 触发是「空闲 + 距上次够久」，不是 cron：intervalHours 默认 168（7 天）
 *   - 14 天没动 → 标记 stale；30 天没动 → 移到 `.archive/<name>`（只归档，永不删）
 *   - pinned 的技能免疫；归档前留一份快照，最多保留 keepSnapshots 份
 *   - 每次动作写 `.curator_ledger.jsonl`（before/after sha256），全程可追溯
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const DEFAULTS = {
  intervalHours: 168,
  staleAfterDays: 14,
  archiveAfterDays: 30,
  keepSnapshots: 5,
  paused: false,
};

function sha256File(target) {
  try {
    return createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  } catch {
    return undefined;
  }
}

const DAY = 24 * 60 * 60 * 1000;

export function createCurator({ library, stateDir, config = {} }) {
  const settings = { ...DEFAULTS, ...config };
  const skillsDir = library.dir;
  const statePath = path.join(stateDir, 'curator-state.json');
  const ledgerPath = path.join(skillsDir, '.curator_ledger.jsonl');
  const archiveDir = path.join(skillsDir, '.archive');
  const backupDir = path.join(skillsDir, '.curator_backups');

  function readState() {
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      return { last_run_at: null, run_count: 0, last_summary: null };
    }
  }

  // 内存里的 lastRunAt 是兜底：state 文件写不进去时，至少本进程不会每回合重跑一遍整理。
  let lastRunAt = null;

  function writeState(next) {
    lastRunAt = next.last_run_at;
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf8');
    } catch {
      /* 状态写失败不该让对话失败；due() 会退回内存时间戳 */
    }
  }

  function appendLedger(record) {
    try {
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.appendFileSync(ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
    } catch {
      /* ledger 只是审计，写不进去不该中断归档 */
    }
  }

  /** 快照：优先 tar.gz（Windows 10+ 自带 bsdtar），失败退化成逐项目录拷贝。 */
  function snapshot() {
    if (!fs.existsSync(skillsDir)) return undefined;
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(backupDir, `skills-${stamp}.tar.gz`);
    // 必须排除备份与归档目录本身，否则 tar 会把自己包进包里（还会因「读时被改」返回 1）。
    // 显式列出要打包的条目（而不是整目录 + --exclude）：Windows 自带 bsdtar 的
    // --exclude 只匹配归档内的完整路径，传 `skills` 时 `--exclude=.curator_backups`
    // 永远匹配不上 `skills/.curator_backups`，会静默把自己包进去。
    // 另外 -f 必须用相对文件名并在 backupDir 里执行：Git Bash 的 GNU tar 会把
    // `C:\...` 里的冒号当成远程主机（tar (child): Cannot connect to C: resolve failed）。
    const entries = fs
      .readdirSync(skillsDir)
      .filter((name) => name !== '.curator_backups' && name !== '.archive');
    const sysTar = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
      : undefined;
    const bin = sysTar && fs.existsSync(sysTar) ? sysTar : 'tar';
    const tar = entries.length
      ? spawnSync(bin, ['-czf', path.basename(target), '-C', skillsDir, ...entries], {
          cwd: backupDir,
          stdio: 'ignore',
        })
      : { status: 1 };
    if (tar.status !== 0 || !fs.existsSync(target)) {
      // cpSync 不允许把目录拷进自己的子目录，所以逐项拷（跳过备份与归档本身）。
      const fallback = path.join(backupDir, `skills-${stamp}`);
      fs.mkdirSync(fallback, { recursive: true });
      for (const entry of fs.readdirSync(skillsDir)) {
        if (entry === '.curator_backups' || entry === '.archive') continue;
        fs.cpSync(path.join(skillsDir, entry), path.join(fallback, entry), { recursive: true });
      }
      prune();
      return fallback;
    }
    prune();
    return target;
  }

  function prune() {
    let entries;
    try {
      entries = fs
        .readdirSync(backupDir)
        .filter((name) => name.startsWith('skills-'))
        .map((name) => ({ name, at: fs.statSync(path.join(backupDir, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
    } catch {
      return;
    }
    for (const stale of entries.slice(settings.keepSnapshots)) {
      fs.rmSync(path.join(backupDir, stale.name), { recursive: true, force: true });
    }
  }

  function archive(skill) {
    fs.mkdirSync(archiveDir, { recursive: true });
    // 同名技能被重新建、又活到该归档时，不能覆盖上一份归档 —— 「只归档不删」是硬约束。
    let destination = path.join(archiveDir, skill.name);
    if (fs.existsSync(destination)) {
      destination = path.join(archiveDir, `${skill.name}@${new Date().toISOString().replace(/[:.]/g, '-')}`);
    }
    const before = sha256File(path.join(skill.dir, 'SKILL.md'));
    fs.renameSync(skill.dir, destination);
    library.setUsage(skill.name, { state: 'archived', archived_at: new Date().toISOString(), archived_to: destination });
    appendLedger({
      action: 'archive',
      name: skill.name,
      from: skill.dir,
      to: destination,
      before_sha256: before,
    });
    return destination;
  }

  /** 到点了吗：只按时间判断，调用方可以每轮都问，成本是一次 stat + 一次读。 */
  function due(now = Date.now()) {
    if (settings.paused) return false;
    const state = readState();
    const stamp = state.last_run_at ?? lastRunAt;
    if (!stamp) return true;
    const last = Date.parse(stamp);
    if (Number.isNaN(last)) return true;
    return now - last >= settings.intervalHours * 60 * 60 * 1000;
  }

  function run({ now = Date.now(), reason = 'interval' } = {}) {
    const skills = library.activity();
    const summary = { started_at: new Date(now).toISOString(), reason, snapshot: undefined, stale: [], archived: [], skipped: [] };
    if (skills.length === 0) {
      const previous = readState();
      writeState({
        last_run_at: new Date(now).toISOString(),
        run_count: (previous.run_count ?? 0) + 1,
        last_summary: summary,
      });
      return summary;
    }

    summary.snapshot = snapshot();

    for (const skill of skills) {
      if (skill.pinned) {
        summary.skipped.push({ name: skill.name, why: 'pinned' });
        continue;
      }
      const age = now - Date.parse(skill.lastActivity);
      if (Number.isNaN(age)) {
        summary.skipped.push({ name: skill.name, why: 'no-activity-stamp' });
        continue;
      }
      const ageDays = age / DAY;
      if (ageDays >= settings.archiveAfterDays) {
        try {
          summary.archived.push({ name: skill.name, ageDays: Math.round(ageDays), to: archive(skill) });
        } catch (error) {
          summary.skipped.push({ name: skill.name, why: `archive-failed: ${error?.message ?? error}` });
        }
        continue;
      }
      if (ageDays >= settings.staleAfterDays && skill.state !== 'stale') {
        library.setUsage(skill.name, { state: 'stale', stale_since: new Date(now).toISOString() });
        appendLedger({
          action: 'mark-stale',
          name: skill.name,
          ageDays: Math.round(ageDays),
          before_sha256: sha256File(skill.path),
        });
        summary.stale.push({ name: skill.name, ageDays: Math.round(ageDays) });
      }
    }

    const next = {
      last_run_at: new Date(now).toISOString(),
      run_count: (readState().run_count ?? 0) + 1,
      last_summary: summary,
    };
    writeState(next);
    return summary;
  }

  /** 每轮问一次：不到点直接返回 undefined，不产生任何磁盘写。 */
  function maybeRun(options = {}) {
    if (!due(options.now)) return undefined;
    try {
      return run(options);
    } catch {
      return undefined;
    }
  }

  return { due, run, maybeRun, state: readState, paths: { statePath, ledgerPath, archiveDir, backupDir } };
}
