/**
 * 0.9.0：记忆同步（跨设备 / 跨 profile）。
 *
 * 做法是最保守的「三方基线 + 只加不删」：
 *
 *   - 导出：把所有轨的条目打成一个 JSON bundle（含 device_id / exported_at）；
 *   - 合并：本地 = 我的条目，远端 = bundle 里的条目，基线 = 上次合并后的条目集合。
 *     只在「远端新增且我没见过、基线里也没有」时写入；远端删除只报告、不执行
 *     （除非调用方显式 `applyDeletions: true`）；本地删除的条目不会被远端复活。
 *   - 合并成功后把当前条目写回基线，下一次合并就以它为参照。
 *
 * 这样任何一次合并都不会悄悄丢数据：最坏结果是多出几条重复条目，由面板的
 * 「疑似重复」区块提示人工合并。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BUNDLE_FORMAT = 'dsh-memory-notes/v1';
export const SYNC_STATE_FILE = 'sync-state.json';

function hashText(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16);
}

/** 去空行、去重（按内容 hash），顺序保持第一次出现的位置。 */
export function normalizeEntries(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const key = hashText(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function newDeviceId() {
  return `dev-${crypto.randomBytes(4).toString('hex')}`;
}

export function syncStatePath(dir) {
  return path.join(dir, SYNC_STATE_FILE);
}

export function readSyncState(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncStatePath(dir), 'utf8'));
    return {
      version: 1,
      device_id: typeof parsed.device_id === 'string' && parsed.device_id ? parsed.device_id : newDeviceId(),
      baseline: parsed.baseline && typeof parsed.baseline === 'object' ? parsed.baseline : {},
      last_merged_at: typeof parsed.last_merged_at === 'number' ? parsed.last_merged_at : null,
      last_remote_device: typeof parsed.last_remote_device === 'string' ? parsed.last_remote_device : null,
    };
  } catch {
    return { version: 1, device_id: newDeviceId(), baseline: {}, last_merged_at: null, last_remote_device: null };
  }
}

export function writeSyncState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const file = syncStatePath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清理失败无所谓 */
    }
    throw error;
  }
}

/** 导出当前所有轨的条目；调用方负责把 bundle 传给人/别的设备。 */
export function exportBundle(store, { deviceId, now = Date.now() } = {}) {
  const state = readSyncState(store.dir);
  const targets = {};
  for (const target of store.targets) {
    targets[target] = normalizeEntries(store.load(target));
  }
  return {
    format: BUNDLE_FORMAT,
    device_id: deviceId ?? state.device_id,
    exported_at: new Date(now).toISOString(),
    targets,
  };
}

/**
 * 把 bundle 合并进本地 store。
 * 返回 `{ ok, added, summary, state }`；单条写入失败（配额、内容校验）计入 `skipped`，
 * 不会中断其余条目。
 */
export function mergeBundle(store, bundle, { now = Date.now(), applyDeletions = false } = {}) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('sync bundle must be a JSON object');
  }
  if (bundle.format !== BUNDLE_FORMAT) {
    throw new Error(`unsupported sync bundle format '${String(bundle.format)}'; expected '${BUNDLE_FORMAT}'`);
  }
  const state = readSyncState(store.dir);
  const summary = {};
  let totalAdded = 0;

  for (const target of store.targets) {
    const mine = normalizeEntries(store.load(target));
    const theirs = normalizeEntries(bundle.targets?.[target]);
    const baseline = normalizeEntries(state.baseline?.[target]);
    const mineSet = new Set(mine);
    const theirsSet = new Set(theirs);
    const baseSet = new Set(baseline);

    const incoming = theirs.filter((entry) => !mineSet.has(entry) && !baseSet.has(entry));
    const locallyDeleted = theirs.filter((entry) => !mineSet.has(entry) && baseSet.has(entry));
    const remotelyDeleted = baseline.filter((entry) => !theirsSet.has(entry));

    const addedHere = [];
    const skipped = [];
    for (const entry of incoming) {
      try {
        store.lastSource = 'sync';
        store.add(target, entry);
        addedHere.push(entry);
      } catch (error) {
        skipped.push({ entry: entry.slice(0, 120), reason: error?.message ?? String(error) });
      }
    }
    totalAdded += addedHere.length;

    if (applyDeletions) {
      for (const entry of remotelyDeleted) {
        if (!mineSet.has(entry)) continue;
        try {
          store.lastSource = 'sync';
          store.remove(target, entry);
          mineSet.delete(entry);
        } catch {
          /* 删除失败留着，下次还会报告 */
        }
      }
    }

    const kept = normalizeEntries(store.load(target));
    summary[target] = {
      local_entries: mine.length,
      remote_entries: theirs.length,
      added: addedHere.length,
      skipped,
      remote_deleted: remotelyDeleted.filter((entry) => !theirsSet.has(entry)),
      local_deleted_kept: locallyDeleted,
    };
    state.baseline[target] = kept;
  }

  state.version = 1;
  state.last_merged_at = now;
  state.last_remote_device = typeof bundle.device_id === 'string' ? bundle.device_id : null;
  writeSyncState(store.dir, state);

  return {
    ok: true,
    format: BUNDLE_FORMAT,
    remote_device: state.last_remote_device,
    added: totalAdded,
    summary,
  };
}
