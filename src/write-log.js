/**
 * 写入日志：每次 add / patch / replace / remove 成功落盘后追加一行 JSON。
 *
 * 文件是 `<dir>/write-log.jsonl`，最多保留 200 行（超出时重写尾部）。面板据此
 * 显示「最近变更」并提供单条撤销——batch 记录带 `batch: true`，不可撤销。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 200;

export function createWriteLog(dir) {
  const file = path.join(dir, 'write-log.jsonl');

  function readLines() {
    try {
      return fs
        .readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '');
    } catch {
      return [];
    }
  }

  function parse(lines) {
    const records = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        if (value && typeof value === 'object') records.push(value);
      } catch {
        /* 坏行跳过，别让一行损坏拖垮整个面板 */
      }
    }
    return records;
  }

  return {
    file,
    append(record = {}) {
      const full = { ts: Date.now(), ...record };
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(full)}\n`, 'utf8');
        const lines = readLines();
        if (lines.length > MAX_LINES) {
          fs.writeFileSync(file, `${lines.slice(-MAX_LINES).join('\n')}\n`, 'utf8');
        }
      } catch (error) {
        try {
          console.warn(`[memory-notes] failed to append write log: ${error?.message ?? error}`);
        } catch {
          /* ignore */
        }
      }
      return full;
    },
    recent(n = 20) {
      const size = Math.max(0, Number(n) || 0);
      if (size === 0) return [];
      return parse(readLines()).slice(-size).reverse();
    },
    count() {
      return readLines().length;
    },
  };
}
