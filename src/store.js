/**
 * Hermes 兼容的长期记忆存储（DSH 版）。
 *
 * 语义逐条移植自 E:\hermes\core\hermes-agent\tools\memory_tool_store.py：
 *  - 两个纯文本文件 MEMORY.md / USER.md，条目用单独一行 § 分隔（ENTRY_DELIMITER = "\n§\n"）
 *  - 配额按字符计（2200 / 1375，含分隔符），超限 = 拒绝写入，绝不截断
 *  - 写路径：排他锁 → 严格 UTF-8 读 → 漂移检测（不一致先备份）→ 原子写
 *  - batch 只在“最终态”校验配额，所以允许先删后加
 */
import fs from 'node:fs';
import path from 'node:path';

export const ENTRY_DELIMITER = '\n§\n';
/** 持锁进程崩溃后，锁目录的存活上限：超过就当作孤儿清掉。 */
const STALE_LOCK_MS = 15_000;
export const MEMORY_BLOCK_HEADERS = {
  memory: 'MEMORY (your personal notes)',
  user: 'USER PROFILE (who the user is)',
};
export const TARGETS = ['memory', 'user'];

const FILE_FOR = { memory: 'MEMORY.md', user: 'USER.md' };
const SEP = '═'.repeat(46);

const text = (v) => (typeof v === 'string' ? v : '');
const unique = (items) => [...new Set(items)];

export class MemoryError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'MemoryError';
    this.detail = detail;
  }
}

export class MemoryStore {
  constructor({ dir, memoryCharLimit = 2200, userCharLimit = 1375 } = {}) {
    if (!dir) throw new Error('MemoryStore requires a dir');
    this.dir = dir;
    this.limits = { memory: memoryCharLimit, user: userCharLimit };
    this.cache = new Map(); // target -> string[] (load-time snapshot)
  }

  fileFor(target) {
    return path.join(this.dir, FILE_FOR[target]);
  }

  assertTarget(target) {
    if (!TARGETS.includes(target)) {
      throw new MemoryError(`Unknown target '${target}'. Use: memory, user.`);
    }
  }

  parse(raw) {
    return unique(
      raw
        .split(ENTRY_DELIMITER)
        .map((e) => e.trim())
        .filter(Boolean),
    );
  }

  serialize(entries) {
    return entries.join(ENTRY_DELIMITER);
  }

  /** 读盘并缓存为会话快照（对应 Hermes 的 load-time frozen snapshot）。 */
  load(target) {
    this.assertTarget(target);
    const file = this.fileFor(target);
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const entries = this.parse(raw);
    this.cache.set(target, entries);
    return entries;
  }

  entries(target) {
    this.assertTarget(target);
    return this.cache.get(target) ?? this.load(target);
  }

  charCount(target) {
    return this.serialize(this.entries(target)).length;
  }

  limit(target) {
    return this.limits[target];
  }

  usage(target) {
    return `${this.charCount(target)}/${this.limit(target)} chars`;
  }

  percent(target) {
    const limit = this.limit(target);
    return limit > 0 ? Math.min(100, Math.round((this.charCount(target) / limit) * 100)) : 100;
  }

  /**
   * 阻塞式排他锁：目录是原子创建，比文件内容比较可靠。
   * 崩溃/强杀会留下陈旧锁，所以超过 STALE_LOCK_MS 的锁直接视为孤儿清掉，
   * 否则一次崩溃就让 memory 工具永久不可写。
   */
  withLock(fn) {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, '.lock');
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (this.isStaleLock(lock)) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) throw new MemoryError('Memory store is locked by another writer.');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  isStaleLock(lock) {
    try {
      const stat = fs.statSync(lock);
      const age = Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs);
      return age > STALE_LOCK_MS;
    } catch {
      // 锁刚好被别人放掉：当作可重试
      return true;
    }
  }

  /**
   * 唯一写入口。mutate(entries) 返回新数组；这里负责锁、漂移备份、原子写。
   */
  write(target, mutate) {
    this.assertTarget(target);
    return this.withLock(() => {
      const file = this.fileFor(target);
      let raw = '';
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const onDisk = this.parse(raw);
      const roundTrip = this.serialize(onDisk);
      if (raw.trim() && roundTrip !== raw.trim()) {
        // 与 Hermes 的 _detect_external_drift 一致：手工散写会丢失结构，先留备份
        fs.writeFileSync(`${file}.bak.${Math.floor(Date.now() / 1000)}`, raw, 'utf8');
      }
      this.cache.set(target, onDisk);
      const next = mutate([...onDisk]);
      const body = this.serialize(next);
      const tmp = path.join(this.dir, `.mem_${path.basename(file)}.tmp`);
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, file);
      this.cache.set(target, next);
      return { entries: next, usage: `${body.length}/${this.limit(target)} chars` };
    });
  }

  overflowError(target, candidate) {
    return new MemoryError(
      `Memory at ${this.charCount(target)}/${this.limit(target)} chars. Adding this entry would exceed the limit. ` +
        `Consolidate now: use 'replace' or 'remove', then retry this add — all in this turn.`,
      {
        success: false,
        target,
        current_entries: this.entries(target),
        usage: `${this.charCount(target)}/${this.limit(target)} chars`,
      },
    );
  }

  checkBudget(target, next, { previous, kind = 'add', allowEmpty = false }) {
    const total = this.serialize(next).length;
    const limit = this.limit(target);
    if (total > limit) {
      const err = this.overflowError(target, next);
      if (kind !== 'add') {
        err.message = `Replacement would put memory at ${total}/${limit} chars. Shorten it, or remove other entries first.`;
      }
      throw err;
    }
    // 单条 remove 是清空的合法途径（Hermes 只在 batch 路径拒绝清空）；
    // batch 仍然禁止，避免「一整批操作把记忆抹掉」这种不可见事故。
    if (!allowEmpty && previous.length > 0 && next.length === 0) {
      throw new MemoryError('Refusing to empty a non-empty store from a batch — remove entries one by one instead.');
    }
  }

  add(target, content) {
    const value = text(content).trim();
    if (!value) throw new MemoryError("Content is required for 'add' action.");
    if (value.includes(ENTRY_DELIMITER) || value === '§') {
      throw new MemoryError('Content must not contain the § delimiter or be a bare §.');
    }
    const existing = this.entries(target);
    if (existing.includes(value)) {
      return { success: true, done: true, target, note: 'Entry already exists (no duplicate added).', usage: this.usage(target) };
    }
    const result = this.write(target, (entries) => {
      const next = [...entries, value];
      this.checkBudget(target, next, { previous: entries });
      return next;
    });
    return { success: true, done: true, target, entry_count: result.entries.length, usage: result.usage };
  }

  locate(target, oldText) {
    const needle = text(oldText).trim();
    if (!needle) {
      throw new MemoryError(
        `'replace'/'remove' needs old_text — a short unique substring of the entry. None was provided.`,
        { success: false, target, current_entries: this.entries(target) },
      );
    }
    const hits = this.entries(target).filter((e) => e.includes(needle));
    if (hits.length === 0) {
      throw new MemoryError(`No entry matched '${needle}'.`, {
        success: false,
        target,
        current_entries: this.entries(target),
      });
    }
    if (hits.length > 1) {
      throw new MemoryError(`Multiple entries matched '${needle}'. Be more specific.`, {
        success: false,
        target,
        current_entries: this.entries(target),
      });
    }
    return hits[0];
  }

  replace(target, oldText, newContent) {
    const hit = this.locate(target, oldText);
    const value = text(newContent).trim();
    if (!value) throw new MemoryError("content is required for 'replace' action.");
    const result = this.write(target, (entries) => {
      const next = entries.map((e) => (e === hit ? value : e));
      this.checkBudget(target, next, { previous: entries, kind: 'replace' });
      return next;
    });
    return { success: true, done: true, target, entry_count: result.entries.length, usage: result.usage };
  }

  remove(target, oldText) {
    const hit = this.locate(target, oldText);
    const result = this.write(target, (entries) => {
      const next = entries.filter((e) => e !== hit);
      this.checkBudget(target, next, { previous: entries, allowEmpty: true });
      return next;
    });
    return { success: true, done: true, target, entry_count: result.entries.length, usage: result.usage };
  }

  /** 原子批：全部成功或全部不落盘，配额只在最终态校验。 */
  applyBatch(target, operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new MemoryError('operations must be a non-empty array.');
    }
    const result = this.write(target, (entries) => {
      let next = [...entries];
      for (const [i, op] of operations.entries()) {
        const action = op?.action;
        const label = `operations[${i}]`;
        if (action === 'add') {
          const value = text(op.content ?? op.new_text).trim();
          if (!value) throw new MemoryError(`${label}: content is required for 'add'.`);
          if (!next.includes(value)) next.push(value);
        } else if (action === 'replace') {
          const needle = text(op.old_text).trim();
          const value = text(op.content ?? op.new_text).trim();
          if (!needle || !value) throw new MemoryError(`${label}: 'replace' needs old_text and content.`);
          const hits = next.filter((e) => e.includes(needle));
          if (hits.length !== 1) throw new MemoryError(`${label}: '${needle}' matched ${hits.length} entries.`);
          next = next.map((e) => (e === hits[0] ? value : e));
        } else if (action === 'remove') {
          const needle = text(op.old_text).trim();
          if (!needle) throw new MemoryError(`${label}: 'remove' needs old_text.`);
          const hits = next.filter((e) => e.includes(needle));
          if (hits.length !== 1) throw new MemoryError(`${label}: '${needle}' matched ${hits.length} entries.`);
          next = next.filter((e) => e !== hits[0]);
        } else {
          throw new MemoryError(`${label}: unknown action '${action}'. Use add, replace, remove.`);
        }
      }
      this.checkBudget(target, next, { previous: entries });
      return next;
    });
    return { success: true, done: true, target, entry_count: result.entries.length, usage: result.usage };
  }

  /** 对应 Hermes 的 _render_block：46 个 ═ 的框 + 用量百分比。 */
  render(target) {
    this.assertTarget(target);
    const entries = this.entries(target);
    if (entries.length === 0) return '';
    const header = `${MEMORY_BLOCK_HEADERS[target]} [${this.percent(target)}% — ${this.charCount(target).toLocaleString('en-US')}/${this.limit(target).toLocaleString('en-US')} chars]`;
    return `${SEP}\n${header}\n${SEP}\n${this.serialize(entries)}`;
  }
}
