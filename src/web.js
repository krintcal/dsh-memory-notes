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
import { exportBundle, mergeBundle } from './sync.js';
import { findConflictGroups } from './conflicts.js';

const ROUTES = {
  state: '/api/dsh-memory-notes/state',
  write: '/api/dsh-memory-notes/write',
  pending: '/api/dsh-memory-notes/pending',
  suggestions: '/api/dsh-memory-notes/suggestions',
  sync: '/api/dsh-memory-notes/sync',
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

export function createWebApi({ store, pending, reviewLog, writeLog, suggestions, review } = {}) {
  const pendingEnabled = pending?.enabled === true;
  const suggestionsEnabled = typeof suggestions?.take === 'function';

  function pendingItems() {
    if (!pendingEnabled) return [];
    return pending.list().map(summarizePending);
  }

  function suggestionItems() {
    if (!suggestionsEnabled) return [];
    try {
      return (suggestions.list() ?? []).slice(-20).map(({ id, created_at, target, text }) => ({
        id,
        created_at,
        target,
        text,
      }));
    } catch {
      return [];
    }
  }

  function reviewView() {
    try {
      const value = typeof review === 'function' ? review() : review;
      if (!value || typeof value !== 'object') return { due: false, turns_since: 0, interval: 0, mode: 'off' };
      return {
        due: value.due === true,
        turns_since: Number(value.turns_since) || 0,
        interval: Number(value.interval) || 0,
        mode: value.mode === 'auto' ? 'auto' : value.mode === 'off' ? 'off' : 'suggest',
      };
    } catch {
      return { due: false, turns_since: 0, interval: 0, mode: 'off' };
    }
  }

  function reviewItems() {
    try {
      return reviewLog?.recent?.(10) ?? [];
    } catch {
      return [];
    }
  }

  function writeItems() {
    try {
      return writeLog?.recent?.(20) ?? [];
    } catch {
      return [];
    }
  }

  return {
    state() {
      const targets = {};
      const conflicts = [];
      for (const target of store?.targets ?? ['memory', 'user']) {
        try {
          targets[target] = targetView(store, target);
          for (const pair of findConflictGroups(targets[target].entries ?? [])) {
            conflicts.push({ target, ...pair });
          }
        } catch {
          /* 某一轨读失败不应让整个面板报错 */
        }
      }
      return {
        ok: true,
        targets,
        conflicts,
        pending: pendingItems(),
        suggestions: suggestionItems(),
        review: reviewView(),
        reviews: reviewItems(),
        writes: writeItems(),
      };
    },

    syncExport() {
      try {
        return { ok: true, bundle: exportBundle(store) };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },

    syncMerge(body) {
      const bundle = body && typeof body === 'object' && body.bundle ? body.bundle : body;
      try {
        const result = mergeBundle(store, bundle);
        return { ok: true, ...result, state: this.state() };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },

    write(body) {
      const input = body && typeof body === 'object' ? body : {};
      const target = input.target;
      const action = input.action;
      const content = typeof input.content === 'string' ? input.content : undefined;
      const oldText = typeof input.old_text === 'string' ? input.old_text : undefined;
      store.lastSource = 'panel';
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
        const dropped = pending.drop(loaded.file);
        return {
          ok: true,
          discarded_pending: id,
          ...(dropped ? {} : { drop_failed: true }),
          state: this.state(),
        };
      }
      try {
        store.lastSource = 'panel';
        const result = applyRecord(store, loaded.record);
        const dropped = pending.drop(loaded.file);
        return {
          ok: true,
          applied_pending: id,
          result,
          ...(dropped ? {} : { drop_failed: true }),
          state: this.state(),
        };
      } catch (err) {
        if (err instanceof MemoryError) return { ok: false, error: err.message, ...err.detail };
        return { ok: false, error: err?.message ?? String(err) };
      }
    },

    suggestionsDecision(body) {
      const input = body && typeof body === 'object' ? body : {};
      if (!suggestionsEnabled) return { ok: false, error: 'suggestion queue is unavailable' };
      const id = typeof input.id === 'string' ? input.id : '';
      const record = suggestions.take(id);
      if (!record) return { ok: false, error: `no suggestion '${id}'` };
      if (input.decision === 'discard') {
        const dropped = suggestions.drop(id);
        return {
          ok: true,
          discarded_suggestion: id,
          ...(dropped ? {} : { drop_failed: true }),
          state: this.state(),
        };
      }
      if (input.decision !== 'accept') {
        return { ok: false, error: "decision must be 'accept' or 'discard'" };
      }
      try {
        store.lastSource = 'panel';
        const result = store.add(record.target, record.text);
        const dropped = suggestions.drop(id);
        return {
          ok: true,
          accepted_suggestion: id,
          result,
          ...(dropped ? {} : { drop_failed: true }),
          state: this.state(),
        };
      } catch (err) {
        // 含 § / 超限等失败时保留建议，用户还能在面板里看过再决定。
        if (err instanceof MemoryError) {
          return { ok: false, error: err.message, ...err.detail, state: this.state() };
        }
        return { ok: false, error: err?.message ?? String(err), state: this.state() };
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

function handler(api, fn, method, authorize) {
  return async (req, res) => {
    try {
      // 先问宿主的 connection 服务：Host/Origin fence + GUI cookie 鉴权（0.8.0）。
      if (typeof authorize === 'function' && authorize(req, res) === true) return;
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback requests only' });
        return;
      }
      if (method !== undefined && String(req.method ?? '').toUpperCase() !== method) {
        writeJson(res, 405, { ok: false, error: `method ${req.method} not allowed` });
        return;
      }
      if (method === 'POST') {
        const contentType = req.headers?.['content-type'];
        if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('application/json')) {
          writeJson(res, 415, { ok: false, error: 'content-type must be application/json' });
          return;
        }
      }
      const body = method === 'POST' ? await readJsonBody(req) : undefined;
      writeJson(res, 200, fn(api, body));
    } catch (err) {
      writeJson(res, 400, { ok: false, error: err?.message ?? String(err) });
    }
  };
}

/**
 * 0.9.0：同步路由同时承载 GET（导出）与 POST（合并）。
 * webServer 的同路径路由只能注册一次，所以这里自己按 method 分派。
 */
function syncRouteHandler(api, authorize) {
  return async (req, res) => {
    try {
      if (typeof authorize === 'function' && authorize(req, res) === true) return;
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback requests only' });
        return;
      }
      const method = String(req.method ?? '').toUpperCase();
      if (method === 'GET') {
        writeJson(res, 200, api.syncExport());
        return;
      }
      if (method !== 'POST') {
        writeJson(res, 405, { ok: false, error: `method ${req.method} not allowed` });
        return;
      }
      const contentType = req.headers?.['content-type'];
      if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('application/json')) {
        writeJson(res, 415, { ok: false, error: 'content-type must be application/json' });
        return;
      }
      const body = await readJsonBody(req);
      writeJson(res, 200, api.syncMerge(body));
    } catch (err) {
      writeJson(res, 400, { ok: false, error: err?.message ?? String(err) });
    }
  };
}

/** 组装路由（形状同 webServer.register 契约：{kind:'exact', path, handler}）。 */
export function buildRoutes(api, options = {}) {
  const { authorize } = options;
  return [
    { kind: 'exact', path: ROUTES.state, handler: handler(api, (a) => a.state(), 'GET', authorize) },
    { kind: 'exact', path: ROUTES.write, handler: handler(api, (a, body) => a.write(body), 'POST', authorize) },
    {
      kind: 'exact',
      path: ROUTES.pending,
      handler: handler(api, (a, body) => a.pendingDecision(body), 'POST', authorize),
    },
    {
      kind: 'exact',
      path: ROUTES.suggestions,
      handler: handler(api, (a, body) => a.suggestionsDecision(body), 'POST', authorize),
    },
    { kind: 'exact', path: ROUTES.sync, handler: syncRouteHandler(api, authorize) },
  ];
}

/**
 * 把路由挂到 web 服务上。webServer 是可选服务（CLI 宿主没有），所以走
 * `ctx.inject` 等它出现；注册失败只记日志，绝不影响工具与提示词。
 *
 * 0.8.0 起把 `connection` 也 inject 起来：每个请求先过 `requestRejection`
 * （Host/Origin fence + 浏览器 cookie 鉴权），拿不到 connection 服务的宿主
 * fail-open（纯 CLI 宿主本来就没有 HTTP 入口）。
 */
export function registerWebPanel(ctx, { store, pending, reviewLog, writeLog, suggestions, review }) {
  if (typeof ctx?.inject !== 'function') return;
  const api = createWebApi({ store, pending, reviewLog, writeLog, suggestions, review });
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    try {
      const server = webCtx.webServer ?? webCtx.get?.('webServer');
      if (!server || typeof server.register !== 'function') return;
      const connection = webCtx.connection ?? webCtx.get?.('connection');
      if (typeof connection?.requestRejection !== 'function') {
        console.warn('[memory-notes] connection service unavailable: panel routes run without GUI token auth');
      }
      const authorize = (req, res) => {
        if (typeof connection?.requestRejection !== 'function') return false;
        const rejection = connection.requestRejection(req);
        if (rejection === undefined) return false;
        res.statusCode = rejection;
        res.setHeader('cache-control', 'no-store');
        res.end();
        return true;
      };
      const registerRoutes = () => {
        const disposers = [];
        for (const route of buildRoutes(api, { authorize })) {
          const dispose = server.register(route);
          if (typeof dispose === 'function') disposers.push(dispose);
        }
        return () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch {
              /* 卸载失败不该影响宿主 */
            }
          }
        };
      };
      if (typeof webCtx.effect === 'function') {
        webCtx.effect(registerRoutes, 'dsh-memory-notes: web routes');
      } else {
        registerRoutes();
      }
    } catch (err) {
      webCtx.logger?.warn?.(`dsh-memory-notes: web panel routes not registered: ${err?.message ?? err}`);
    }
  });
}
