/**
 * 后台 review 会话登记簿（内存）。
 *
 * Hermes 0.22.5 用 `is_unattended_review()` 判断「当前写入来自无人值守的后台 review」，
 * 从而把 patch/remove 自动改成 stage。DSH 没有对应的 provenance API，所以这里退化成
 * 一个进程内的会话 id 集合：nudge 启动 review fork 时登记 childId，结束时注销；
 * memory 工具在 execute 里读 `exec` 上能拿到的 session id，命中就自动 stage。
 *
 * 拿不到 session id 时不会误判为 review（宁可直写），此时 review 提示词里的显式
 * `action='stage'` 仍然是兜底路径。
 */
const sessions = new Set();

export function markReviewSession(id) {
  if (typeof id === 'string' && id) sessions.add(id);
}

export function clearReviewSession(id) {
  if (typeof id === 'string' && id) sessions.delete(id);
}

export function isReviewSession(id) {
  return typeof id === 'string' && sessions.has(id);
}

/** 从工具的 execute 第二参数里尽量挖出当前会话 id；挖不到返回 undefined。 */
export function sessionIdFromExec(exec) {
  if (!exec || typeof exec !== 'object') return undefined;
  const candidates = [
    exec.session?.id,
    exec.scope?.id,
    exec.scope?.session?.id,
    exec.agent?.session?.id,
    exec.context?.session?.id,
  ];
  return candidates.find((id) => typeof id === 'string' && id.length > 0);
}
