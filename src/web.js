/**
 * 可视化面板的宿主半边：三条只读/写接口，给 `client.js`（左侧栏「记忆」面板）用。
 *
 *   GET  /api/dsh-memory-notes/state   两库条目 + 用量 + pending 列表
 *   POST /api/dsh-memory-notes/write   {target, action: add|patch|remove, old_text?, content?}
 *   POST /api/dsh-memory-notes/pending {id, decision: apply|discard}
 *
 * 信任边界照抄 DSH 生态里同类插件的做法：只接受 loopback 直连（socket 是回环、
 * Host 是回环、不是转发来的、浏览器同源标记正常）。GUI 的 token 由 web 服务自己
 * 兜住，这里只负责「不是本机浏览器就别进」。
 */
import { MemoryError } from './store.js';
import { applyRecord, summarizePending } from './pending.js';

const ROUTES = {
  state: '/api/dsh-memory-notes/state',
  write: '/api/dsh-memory-notes/write',
  pending: '/api/dsh-memory-notes/pending',
};

const MAX_BODY_BYTES = 1024 * 1024;

/* ------------------------------- 访问控制 -------------------------------- */

function isIPv4Loopback(v4) {
  const parts = v4.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function isLoopbackAddress(address) {
  if (address === undefined) return false;
  const normalized = String(address).toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7));
  return isIPv4Loopback(normalized);
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
  return isIPv4Loopback(hostname);
}

export function isLoopbackRequest(request) {
  const socket = request?.socket;
  if (!isLoopbackAddress(socket?.remoteAddress)) return false;
  const headers = request?.headers ?? {};
  // 带转发头说明前面有代理，socket 地址描述的是代理而不是客户端。
  if (headers['cf-connecting-ip'] !== undefined || headers['x-forwarded-for'] !== undefined) return false;
  const host = headers.host;
  if (typeof host !== 'string' || host === '') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/* -------------------------------- 业务逻辑 -------------------------------- */

function targetView(store, target) {
  const entries = [...store.entries(target)];
  return {
    entries,
    used: store.charCount(target),
    limit: store.limit(target),
    percent: store.percent(target),
    usage: store.usagePct(target),
  };
}

export function createWebApi({ store, pending }) {
  const pendingEnabled = pending?.enabled === true;

  function pendingItems() {
    if (!pendingEnabled) return [];
    return pending.list().map(summarizePending);
  }

  return {
    state() {
      return {
        ok: true,
        targets: {
          memory: targetView(store, 'memory'),
          user: targetView(store, 'user'),
        },
        pending: pendingItems(),
      };
    },

    write(body) {
      const input = body && typeof body === 'object' ? body : {};
      const target = input.target;
      const action = input.action;
      const content = typeof input.content === 'string' ? input.content : undefined;
      const oldText = typeof input.old_text === 'string' ? input.old_text : undefined;
      try {
        store.assertTarget(target);
        let result;
        if (action === 'add') {
          if (typeof content !== 'string' || !content.trim()) {
            return { ok: false, error: "content is required for 'add'" };
          }
          result = store.add(target, content);
        } else if (action === 'patch') {
          if (typeof content !== 'string' || !content.trim()) {
            return { ok: false, error: "content is required for 'patch'" };
          }
          if (typeof oldText !== 'string' || !oldText.trim()) {
            return { ok: false, error: "old_text is required for 'patch'" };
          }
          result = store.patch(target, oldText, content);
        } else if (action === 'remove') {
          if (typeof oldText !== 'string' || !oldText.trim()) {
            return { ok: false, error: "old_text is required for 'remove'" };
          }
          result = store.remove(target, oldText);
        } else {
          return { ok: false, error: `Unknown action '${String(action)}'. Use: add, patch, remove` };
        }
        return { ok: true, result, state: this.state() };
      } catch (err) {
        if (err instanceof MemoryError) return { ok: false, error: err.message, ...err.detail };
        return { ok: false, error: err?.message ?? String(err) };
      }
    },

    pendingDecision(body) {
      const input = body && typeof body === 'object' ? body : {};
      if (!pendingEnabled) return { ok: false, error: 'pending queue is unavailable' };
      const id = typeof input.id === 'string' ? input.id : '';
      const loaded = pending.take(id);
      if (!loaded) return { ok: false, error: `no pending entry '${id}'` };
      if (input.decision === 'discard') {
        pending.drop(loaded.file);
        return { ok: true, discarded_pending: id, state: this.state() };
      }
      try {
        const result = applyRecord(store, loaded.record);
        pending.drop(loaded.file);
        return { ok: true, applied_pending: id, result, state: this.state() };
      } catch (err) {
        if (err instanceof MemoryError) return { ok: false, error: err.message, ...err.detail };
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  };
}

/* --------------------------------- HTTP ---------------------------------- */

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function handler(api, fn, method) {
  return async (req, res) => {
    try {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback requests only' });
        return;
      }
      if (method !== undefined && String(req.method ?? '').toUpperCase() !== method) {
        writeJson(res, 405, { ok: false, error: `method ${req.method} not allowed` });
        return;
      }
      const body = method === 'POST' ? await readJsonBody(req) : undefined;
      writeJson(res, 200, fn(api, body));
    } catch (err) {
      writeJson(res, 400, { ok: false, error: err?.message ?? String(err) });
    }
  };
}

/** 组装三条路由（形状同 webServer.register 契约：{kind:'exact', path, handler}）。 */
export function buildRoutes(api) {
  return [
    { kind: 'exact', path: ROUTES.state, handler: handler(api, (a) => a.state(), 'GET') },
    { kind: 'exact', path: ROUTES.write, handler: handler(api, (a, body) => a.write(body), 'POST') },
    { kind: 'exact', path: ROUTES.pending, handler: handler(api, (a, body) => a.pendingDecision(body), 'POST') },
  ];
}

/**
 * 把路由挂到 web 服务上。webServer 是可选服务（CLI 宿主没有），所以走
 * `ctx.inject` 等它出现；注册失败只记日志，绝不影响工具与提示词。
 */
export function registerWebPanel(ctx, { store, pending }) {
  if (typeof ctx?.inject !== 'function') return;
  const api = createWebApi({ store, pending });
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const server = webCtx.webServer ?? webCtx.get?.('webServer');
      if (!server || typeof server.register !== 'function') return;
      for (const route of buildRoutes(api)) server.register(route);
    } catch (err) {
      webCtx.logger?.warn?.(`dsh-memory-notes: web panel routes not registered: ${err?.message ?? err}`);
    }
  });
}
