/**
 * Hermes 0.22.5 兼容的长期记忆存储（DSH 版）。
 *
 * 语义移植自 E:\Hermes\core\hermes-agent\tools\memory_tool_store.py（0.22.5）：
 *  - 两个纯文本文件 MEMORY.md / USER.md，条目用单独一行 § 分隔（ENTRY_DELIMITER = "\n§\n"）
 *  - 配额按字符计（2200 / 1375），超限 = 拒绝写入，绝不截断
 *  - 写路径：排他锁 → 严格 UTF-8 读 → 漂移检测（不一致先备份）→ 原子写
 *  - batch 只在「最终态」校验配额，所以允许先删后加；失败即全不落盘
 *  - patch = 替换条目内的**一个 span**，条目其余原样保留；replace = 整条替换（仅供
 *    旧的 staged 记录重放，模型面已不再暴露）；remove = 删整条
 *  - old_text 匹配：整条精确匹配优先，其次子串（引号/破折号/空白折叠后仍可命中）
 *  - staged 写入带 matched_entry 钉子：批准时只作用于当时审阅的那一条，变了就 stale
 */

import fs from 'node:fs';
import path from 'node:path';

export const ENTRY_DELIMITER = '\n§\n';

/** patch 的 content 不能为空；删条目里的字要 patch 更长的 span，remove 会删掉整条。 */
export const PATCH_DROP_HINT =
  "To drop text inside an entry, patch a longer span that contains it; 'remove' deletes the whole entry.";

export const MEMORY_BLOCK_HEADERS = {
  memory: 'MEMORY (your personal notes)',
  user: 'USER PROFILE (who the user is)',
};

export const TARGETS = ['memory', 'user'];

/** 持锁进程崩溃后，锁目录的存活上限：超过就当作孤儿清掉。 */
const STALE_LOCK_MS = 15_000;
const FILE_FOR = { memory: 'MEMORY.md', user: 'USER.md' };
const SEP = '═'.repeat(46);

/** patch/remove 会改到已有条目 —— 后台 review 里这些操作要 stage 而不是直写。 */
export const DESTRUCTIVE_ACTIONS = new Set(['patch', 'remove', 'replace']);

const text = (v) => (typeof v === 'string' ? v : '');
const fmt = (n) => Number(n).toLocaleString('en-US');
const unique = (items) => [...new Set(items)];

const QUOTE_CHARS = /["`\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f]/g;
const DASH_CHARS = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const WORD_CHAR = /[\p{L}\p{N}]/u;

export class MemoryError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'MemoryError';
    this.detail = detail;
  }
}

/** 模型重新打一遍条目时常见的排版差异：引号/破折号/换行转义/空白折叠。 */
function normalizeForMatch(value) {
  return String(value)
    .replace(/\\n/g, ' ')
    .replace(QUOTE_CHARS, "'")
    .replace(DASH_CHARS, '-')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function substringMatches(entries, oldText) {
  const exact = entries.map((entry, i) => (entry.includes(oldText) ? i : -1)).filter((i) => i >= 0);
  if (exact.length) return exact;
  const needle = normalizeForMatch(oldText);
  if (!WORD_CHAR.test(needle)) return []; // 纯标点/空白会把整条都选中
  return entries.map((entry, i) => (normalizeForMatch(entry).includes(needle) ? i : -1)).filter((i) => i >= 0);
}

/**
 * 整条精确匹配绝对优先：短条目即使文本被更长的兄弟条目包含，也仍然可寻址
 * （remove('test') 不会选中 '...tests pass...'）。重复条目的精确匹配取第一条。
 */
function findUniqueMatch(entries, oldText) {
  const exact = entries.map((entry, i) => (entry === oldText ? i : -1)).filter((i) => i >= 0);
  const matches = exact.length ? exact : substringMatches(entries, oldText);
  if (new Set(matches.map((i) => entries[i])).size > 1) return { index: null, ambiguous: matches };
  return { index: matches.length ? matches[0] : null, ambiguous: [] };
}

function spanOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (haystack.startsWith(needle, i)) count += 1;
  }
  return count;
}

function repeatedSpanMessage(oldText, count) {
  return (
    `'${oldText}' appears ${count} times in the matched entry, and patch edits one span. ` +
    'Include more surrounding text so old_text occurs once.'
  );
}

/** (patched entry) 或 (error)；single 与 batch 的 patch 共用同一套规则。 */
function patchEntry(entry, oldText, newText) {
  const count = spanOccurrences(entry, oldText);
  if (count > 1) return { error: repeatedSpanMessage(oldText, count) };
  const patched = entry.replace(oldText, newText);
  if (patched === entry) {
    return { error: `Patch is a no-op: '${oldText}' -> '${newText}' leaves the entry unchanged.` };
  }
  return { patched };
}

function wordsOf(value) {
  return new Set(String(value).toLowerCase().match(/\w+/g) ?? []);
}

/** 零命中时按词重叠给 3 条最接近的条目，让模型能看出 old_text 哪里过期了。 */
function closestEntries(entries, oldText) {
  const words = wordsOf(oldText);
  if (!words.size) return [];
  const scored = entries
    .map((entry, i) => {
      const other = wordsOf(entry);
      let overlap = 0;
      for (const word of words) if (other.has(word)) overlap += 1;
      return { i, score: overlap / words.size };
    })
    .filter((item) => item.score >= 0.3)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 3);
  return scored.map((item) => entries[item.i]);
}

function noMatchError(entries, oldText, verb) {
  const closest = closestEntries(entries, oldText);
  const hint = oldText.includes('§')
    ? " old_text must come from ONE entry ('§' separates entries); use one op per entry."
    : '';
  return new MemoryError(
    `No entry matched '${oldText}'.${hint} Retry the ${verb} with old_text copied verbatim from the intended ` +
      `entry${closest.length ? ' (closest_entries below).' : '.'}`,
    {
      success: false,
      ...(closest.length ? { closest_entries: closest } : {}),
    },
  );
}

export function staleEntryMessage(entry) {
  return (
    `Entry changed since it was staged, so this write was not applied: '${entry}' is no longer in memory as ` +
    'reviewed. Recreate the change against the current entry or reject it; the pending record has been preserved.'
  );
}

function overLimitMessage(newTotal, limit) {
  return `would put memory at ${fmt(newTotal)}/${fmt(limit)} chars: free at least ${fmt(newTotal - limit)} chars`;
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
      throw new MemoryError(`Unknown target '${target}'. Use: memory, user.`, { success: false, target });
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

  readRaw(target) {
    const file = this.fileFor(target);
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return raw.replace(/^\uFEFF/, '');
  }

  /** 读盘并缓存为会话快照（对应 Hermes 的 load-time frozen snapshot）。 */
  load(target) {
    this.assertTarget(target);
    const entries = this.parse(this.readRaw(target));
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

  /** 错误 payload 里的 usage：Hermes 的 _usage() 不带单位。 */
  usageShort(target) {
    return `${fmt(this.charCount(target))}/${fmt(this.limit(target))}`;
  }

  /** 成功 payload 与系统提示词里的 usage：Hermes 的 _usage_pct() 口径。 */
  usagePct(target) {
    const limit = this.limit(target);
    const current = this.charCount(target);
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
    return `${pct}% — ${fmt(current)}/${fmt(limit)} chars`;
  }

  /** 兼容旧调用点：usage() 现在返回 Hermes 0.22.5 的百分比口径。 */
  usage(target) {
    return this.usagePct(target);
  }

  percent(target) {
    const limit = this.limit(target);
    return limit > 0 ? Math.min(100, Math.round((this.charCount(target) / limit) * 100)) : 100;
  }

  /**
   * 阻塞式排他锁：目录是原子创建，比文件内容比较可靠。
   * 崩溃/强杀会留下陈旧锁，所以超过 STALE_LOCK_MS 的锁直接视为孤儿清掉。
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
        if (Date.now() > deadline) throw new MemoryError('Memory store is locked by another writer.', { success: false });
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

  /** 锁内从盘上重读，返回条目数组（read-only 路径用：pin / dry-run）。 */
  readFresh(target) {
    const entries = this.parse(this.readRaw(target));
    this.cache.set(target, entries);
    return entries;
  }

  /**
   * 唯一写入口。mutate(entries) 返回 { entries, extra?, message? }；
   * 这里负责锁、漂移备份、原子写、缓存更新。
   */
  write(target, mutate) {
    this.assertTarget(target);
    return this.withLock(() => {
      const file = this.fileFor(target);
      const raw = this.readRaw(target);
      const onDisk = this.parse(raw);
      const roundTrip = this.serialize(onDisk);
      if (raw.trim() && roundTrip !== raw.trim()) {
        // 与 Hermes 的 _detect_external_drift 一致：手工散写会丢失结构，先留备份
        fs.writeFileSync(`${file}.bak.${Math.floor(Date.now() / 1000)}`, raw, 'utf8');
      }
      this.cache.set(target, onDisk);
      const outcome = mutate([...onDisk]);
      const next = Array.isArray(outcome) ? outcome : outcome.entries;
      const body = this.serialize(next);
      const tmp = path.join(this.dir, `.mem_${path.basename(file)}.tmp`);
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, file);
      this.cache.set(target, next);
      return outcome;
    });
  }

  success(message, extra = {}) {
    return {
      success: true,
      done: true,
      usage: this.usagePct(this.currentTarget),
      entry_count: this.entries(this.currentTarget).length,
      ...(message ? { message } : {}),
      ...extra,
      note: 'Write saved. This update is complete — do not repeat it.',
    };
  }

  /** 成功响应：与 Hermes 的 _success_response 同形（不回显条目内容）。 */
  respond(target, message, extra = {}) {
    return {
      success: true,
      done: true,
      target,
      usage: this.usagePct(target),
      entry_count: this.entries(target).length,
      ...(message ? { message } : {}),
      ...extra,
      note: 'Write saved. This update is complete — do not repeat it.',
    };
  }

  overflow(target, entries, message) {
    return new MemoryError(message, {
      success: false,
      target,
      current_entries: [...entries],
      usage: this.usageShort(target),
    });
  }

  batchFailure(target, message, extra = {}) {
    return new MemoryError(message, {
      success: false,
      target,
      usage: this.usageShort(target),
      ...extra,
    });
  }

  /** 定位 old_text 对应的条目下标；matches/没匹配都给可执行的错误。 */
  locateIn(entries, oldText, verb, matchedEntry) {
    if (matchedEntry !== undefined && matchedEntry !== null) {
      const idx = entries.indexOf(matchedEntry);
      if (idx < 0) throw new MemoryError(staleEntryMessage(matchedEntry), { success: false });
      return idx;
    }
    const needle = text(oldText).trim();
    const { index, ambiguous } = findUniqueMatch(entries, needle);
    if (ambiguous.length) {
      throw new MemoryError(`Multiple entries matched '${needle}'. Be more specific.`, {
        success: false,
        matches: ambiguous.map((i) => {
          const entry = entries[i];
          return entry.length > 80 ? `${entry.slice(0, 80)}...` : entry;
        }),
      });
    }
    if (index === null) throw noMatchError(entries, needle, verb);
    return index;
  }

  /** 锁内只读定位，返回 staged 写入要钉住的完整条目。 */
  resolveEntry(target, oldText, verb) {
    return this.withLock(() => {
      const entries = this.readFresh(target);
      const idx = this.locateIn(entries, oldText, verb);
      return { success: true, matched_entry: entries[idx] };
    });
  }

  add(target, content) {
    const value = text(content).trim();
    if (!value) throw new MemoryError('Content cannot be empty.', { success: false, target });
    if (value.includes(ENTRY_DELIMITER) || value === '§') {
      throw new MemoryError('Content must not contain the § delimiter or be a bare §.', { success: false, target });
    }
    const current = this.entries(target);
    if (current.includes(value)) return this.respond(target, 'Entry already exists (no duplicate added).');
    this.write(target, (entries) => {
      const next = [...entries, value];
      const limit = this.limit(target);
      const total = this.serialize(next).length;
      if (total > limit) {
        throw this.overflow(
          target,
          entries,
          `Memory at ${this.usageShort(target)} chars; adding this entry (${value.length} chars) would exceed ` +
            `the limit by ${fmt(total - limit)} chars. Retry as ONE 'operations' batch that removes or shortens ` +
            `(patch) stale entries from current_entries below to free at least ${fmt(total - limit)} chars AND adds ` +
            'this entry — the limit is checked only on the batch result.',
        );
      }
      return { entries: next, message: 'Entry added.' };
    });
    return this.respond(target, 'Entry added.');
  }

  /** 替换条目内的一个 span，条目其余原样保留（0.22.5 的 patch 语义）。 */
  patch(target, oldText, newText, matchedEntry) {
    const needle = text(oldText).trim();
    if (!needle) {
      throw new MemoryError(
        "'patch' needs old_text — a short unique substring of the entry. None was provided.",
        { success: false, target, current_entries: [...this.entries(target)], usage: this.usageShort(target) },
      );
    }
    const value = text(newText);
    if (!value.trim()) {
      throw new MemoryError(`new_text cannot be empty. ${PATCH_DROP_HINT}`, { success: false, target });
    }
    let extra = {};
    this.write(target, (entries) => {
      const idx = this.locateIn(entries, needle, 'patch', matchedEntry);
      const before = entries[idx];
      const outcome = patchEntry(before, needle, value);
      if (outcome.error) {
        throw new MemoryError(outcome.error, {
          success: false,
          target,
          usage: this.usageShort(target),
        });
      }
      const next = [...entries];
      next[idx] = outcome.patched;
      const total = this.serialize(next).length;
      const limit = this.limit(target);
      if (total > limit) {
        throw this.overflow(
          target,
          entries,
          `Patch would put memory at ${fmt(total)}/${fmt(limit)} chars. Shorten the new text, or 'remove' other ` +
            'stale or less important entries to make room (see current_entries below), then retry — all in this turn.',
        );
      }
      extra = { patched_entry_before: before, patched_entry_after: outcome.patched };
      return { entries: next, extra, message: 'Entry patched.' };
    });
    return this.respond(target, 'Entry patched.', extra);
  }

  /** 整条替换：old_text 只负责定位，不会把 span 拼进去（旧的 staged 记录重放用）。 */
  replace(target, oldText, newContent, matchedEntry) {
    const needle = text(oldText).trim();
    if (!needle) {
      throw new MemoryError('old_text cannot be empty.', { success: false, target });
    }
    const value = text(newContent).trim();
    if (!value) throw new MemoryError("new_content cannot be empty. Use 'remove' to delete entries.", { success: false, target });
    let previous;
    this.write(target, (entries) => {
      const idx = this.locateIn(entries, needle, 'replace', matchedEntry);
      previous = entries[idx];
      const next = [...entries];
      next[idx] = value;
      const total = this.serialize(next).length;
      const limit = this.limit(target);
      if (total > limit) {
        throw this.overflow(
          target,
          entries,
          `Replacement ${overLimitMessage(total, limit)}. Shorten the new content, or retry as ONE 'operations' batch ` +
            'with this replace plus removes/shortenings of other stale entries (see current_entries below) — the ' +
            'limit is checked only on the batch result.',
        );
      }
      return { entries: next, message: 'Entry replaced.' };
    });
    return this.respond(target, 'Entry replaced.', { replaced_entry: previous });
  }

  remove(target, oldText, matchedEntry) {
    const needle = text(oldText).trim();
    if (!needle) throw new MemoryError('old_text cannot be empty.', { success: false, target });
    let removed;
    this.write(target, (entries) => {
      const idx = this.locateIn(entries, needle, 'remove', matchedEntry);
      removed = entries[idx];
      const next = entries.filter((_, i) => i !== idx);
      return { entries: next, message: 'Entry removed.' };
    });
    return this.respond(target, 'Entry removed.', { removed_entry: removed });
  }

  /** 走一遍 batch 的 op 序列（不落盘）；返回 { entries: 结果数组, matched, produced }。 */
  walkBatch(target, entries, operations, note) {
    const working = [...entries];
    const matched = []; // 每个 op 选中的完整条目（add 为 null）
    const produced = new Map(); // 1-based op 序号 -> patch 产出的新条目
    for (const [i, rawOp] of operations.entries()) {
      const op = rawOp && typeof rawOp === 'object' ? rawOp : {};
      const act = op.action;
      let content = text(op.content ?? op.new_text);
      let oldText = text(op.old_text);
      const pos = `Operation ${i + 1} (${act || 'unknown'})`;
      if (act !== 'patch') {
        content = content.trim();
        oldText = oldText.trim();
      }
      if (act === 'add') {
        if (!content) throw this.batchFailure(target, `${pos}: content is required.${note}`);
        if (!working.includes(content)) working.push(content);
        matched.push(null);
        continue;
      }
      if (act !== 'replace' && act !== 'remove' && act !== 'patch') {
        throw this.batchFailure(target, `${pos}: unknown action. Use add, patch, or remove.${note}`);
      }
      if (!oldText) throw this.batchFailure(target, `${pos}: old_text is required.${note}`);
      if (act === 'replace' && !content) {
        throw this.batchFailure(
          target,
          `${pos}: content is required — set this operation object's own 'content' to the COMPLETE new entry ` +
            `(or use action='remove' to delete).${note}`,
        );
      }
      if (act === 'patch' && !content.trim()) {
        throw this.batchFailure(
          target,
          `${pos}: content is required — set this operation object's own 'content' to the new text for the ` +
            `old_text span. ${PATCH_DROP_HINT}${note}`,
        );
      }
      let idx;
      try {
        idx = this.locateIn(working, oldText, act, op.matched_entry);
      } catch (err) {
        if (!(err instanceof MemoryError)) throw err;
        throw this.batchFailure(target, `${pos}: ${err.message}${note}`, {
          ...(err.detail?.closest_entries ? { closest_entries: err.detail.closest_entries } : {}),
          ...(err.detail?.matches ? { matches: err.detail.matches } : {}),
        });
      }
      const previous = working[idx];
      if (act !== 'patch') {
        if (act === 'replace') working.splice(idx, 1, content);
        else working.splice(idx, 1);
        matched.push(previous);
        continue;
      }
      const outcome = patchEntry(previous, oldText, content);
      if (outcome.error) throw this.batchFailure(target, `${pos}: ${outcome.error}${note}`);
      working.splice(idx, 1, outcome.patched);
      matched.push(previous);
      produced.set(i + 1, outcome.patched);
    }
    if (entries.length > 0 && working.length === 0) {
      throw this.batchFailure(
        target,
        'Refusing to empty a previously non-empty store from a batch — merge overlapping entries into a shorter ' +
          `one, or delete single entries deliberately with separate remove calls.${note}`,
      );
    }
    const total = this.serialize(working).length;
    const limit = this.limit(target);
    if (total > limit) {
      throw this.batchFailure(
        target,
        `Applying all ${operations.length} operations ${overLimitMessage(total, limit)} more. Add removes or ` +
          `shortening patches of other stale entries to the same batch, then retry.${note}`,
      );
    }
    return { entries: working, matched, produced };
  }

  buildExtra(operations, matched, produced) {
    const replaced = {};
    const removed = {};
    const patched = {};
    operations.forEach((rawOp, i) => {
      const act = rawOp && typeof rawOp === 'object' ? rawOp.action : undefined;
      const previous = matched[i];
      if (previous == null) return;
      if (act === 'replace') replaced[i + 1] = previous;
      else if (act === 'remove') removed[i + 1] = previous;
      else if (act === 'patch') patched[i + 1] = previous;
    });
    const extra = {};
    if (Object.keys(replaced).length) extra.replaced_entries = replaced;
    if (Object.keys(patched).length) {
      extra.patched_entries = patched;
      extra.patched_entries_after = Object.fromEntries(produced);
    }
    if (Object.keys(removed).length) extra.removed_entries = removed;
    return extra;
  }

  /** 原子批：全部成功或全部不落盘，配额只在最终态校验。 */
  applyBatch(target, operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new MemoryError('operations list is empty.', { success: false, target });
    }
    const note = ' No operations were applied (batch is all-or-nothing).';
    let extra = {};
    this.write(target, (entries) => {
      const walk = this.walkBatch(target, entries, operations, note);
      extra = this.buildExtra(operations, walk.matched, walk.produced);
      return { entries: walk.entries, extra, message: `Applied ${operations.length} operation(s).` };
    });
    return this.respond(target, `Applied ${operations.length} operation(s).`, extra);
  }

  /** 干跑同一套 batch 逻辑，返回每个 op 钉住的完整条目（add 为 null）。 */
  resolveBatchEntries(target, operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new MemoryError('operations list is empty.', { success: false, target });
    }
    return this.withLock(() => {
      const entries = this.readFresh(target);
      const walk = this.walkBatch(target, entries, operations, '');
      return { success: true, matched_entries: walk.matched };
    });
  }

  /** 对应 Hermes 的 _render_block：46 个 ═ 的框 + 用量百分比。 */
  render(target) {
    this.assertTarget(target);
    const entries = this.entries(target);
    if (entries.length === 0) return '';
    const header = `${MEMORY_BLOCK_HEADERS[target]} [${this.usagePct(target)}]`;
    return `${SEP}\n${header}\n${SEP}\n${this.serialize(entries)}`;
  }
}
