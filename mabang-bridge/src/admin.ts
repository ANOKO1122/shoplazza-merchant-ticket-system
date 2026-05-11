/**
 * 店匠店铺管理：Bearer + 会话（密码登录）+ 网页 /admin/ui
 */
import fs from 'fs';
import path from 'path';
import { createHash, timingSafeEqual } from 'crypto';
import { Router, RequestHandler } from 'express';
import cookieSession from 'cookie-session';
import fetch from 'node-fetch';
import {
  listStoresPublic, upsertStore, updateStorePartial, deleteStoreBySubdomain,
  getStoreSecretBySubdomain, clearOrderSyncCursors, deleteAllOrderIndexRows,
} from './store-db';
import { normalizeShoplazzaSubdomain, loadShoplazzaStores, syncAllStoresOrderIndex, getIndexBootstrapDays } from './shoplazza';
import { agentDebugLog } from './debug-log';

const ADMIN_TOKEN = () => process.env.BRIDGE_ADMIN_TOKEN?.trim() ?? '';
const ADMIN_PASSWORD_RAW = () => process.env.BRIDGE_ADMIN_PASSWORD?.trim() ?? '';
const ADMIN_FORM_SECRET = () => ADMIN_PASSWORD_RAW() || ADMIN_TOKEN();

export function isWebAdminPasswordCompliant(s: string): boolean {
  if (s.length < 10 || s.length > 16) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  if (!/[0-9]/.test(s)) return false;
  return true;
}

export function assertWebAdminPasswordPolicyAtStartup(): void {
  const p = ADMIN_PASSWORD_RAW();
  if (!p) return;
  if (!isWebAdminPasswordCompliant(p)) {
    console.error('[admin] BRIDGE_ADMIN_PASSWORD 不符合规则：须为 10–16 位，且同时包含英文字母与数字（ASCII）。');
    process.exit(1);
  }
}

const RATE_WINDOW_MS = 60000;
const RATE_MAX = 60;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: any): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0]?.trim() ?? 'unknown';
  return req.socket.remoteAddress ?? 'unknown';
}

function adminRateLimit(req: any, res: any, next: () => void): void {
  const ip = clientIp(req);
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, b);
  }
  b.count += 1;
  if (b.count > RATE_MAX) {
    res.status(429).json({ error: 'too_many_requests' });
    return;
  }
  next();
}

function hashUtf8(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function safeEqualStr(a: string, b: string): boolean {
  const ba = hashUtf8(a);
  const bb = hashUtf8(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function createAdminSessionMiddleware(): RequestHandler {
  const explicit = process.env.BRIDGE_SESSION_SECRET?.trim();
  const token = ADMIN_TOKEN();
  const key = explicit && explicit.length >= 16
    ? explicit
    : token
      ? createHash('sha256').update('bridge_sess:' + token).digest('base64')
      : 'insecure_dev_only_set_BRIDGE_ADMIN_TOKEN';
  return cookieSession({
    name: 'bridge_admin',
    keys: [key],
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.BRIDGE_COOKIE_SECURE === 'true',
  });
}

function requireAdminConfigured(req: any, res: any, next: () => void): void {
  if (!ADMIN_TOKEN()) {
    agentDebugLog({
      hypothesisId: 'H3-H4',
      location: 'admin.ts:requireAdminConfigured',
      message: '503 admin_not_configured (login/API 路径，非 /ui)',
      data: { path: req.path, originalUrl: req.originalUrl },
    });
    res.status(503).json({ error: 'admin_not_configured', message: 'BRIDGE_ADMIN_TOKEN 未设置' });
    return;
  }
  next();
}

function sessionOk(req: any): boolean {
  const s = req.session;
  return s?.admin === true;
}

function requireAdminAuth(req: any, res: any, next: () => void): void {
  const configured = ADMIN_TOKEN();
  if (!configured) {
    agentDebugLog({
      hypothesisId: 'H3-H4',
      location: 'admin.ts:requireAdminAuth',
      message: '503 admin_not_configured（受保护路由）',
      data: { path: req.path, originalUrl: req.originalUrl },
    });
    res.status(503).json({ error: 'admin_not_configured', message: 'BRIDGE_ADMIN_TOKEN 未设置' });
    return;
  }
  const auth: string = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const bearer = m?.[1]?.trim() ?? '';
  if (bearer && bearer === configured) { next(); return; }
  if (sessionOk(req)) { next(); return; }
  res.status(401).json({ error: 'unauthorized' });
}

function resolveAdminHtmlPath(): string | null {
  const candidates = [
    path.join(__dirname, '..', 'public', 'admin.html'),
    path.join(process.cwd(), 'public', 'admin.html'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

function resolveAuditLogsHtmlPath(): string | null {
  const candidates = [
    path.join(__dirname, '..', 'public', 'audit-logs.html'),
    path.join(process.cwd(), 'public', 'audit-logs.html'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

export function createAdminRouter(): Router {
  const r = Router();
  r.use(adminRateLimit);

  r.get('/ui', (req, res) => {
    const tok = ADMIN_TOKEN();
    agentDebugLog({ hypothesisId: 'H1-H4', location: 'admin.ts:GET /admin/ui entry', message: 'handling /admin/ui', data: { tokenConfigured: tok.length > 0, path: req.path, cwd: process.cwd() } });
    const htmlPath = resolveAdminHtmlPath();
    agentDebugLog({ hypothesisId: 'H2', location: 'admin.ts:GET /admin/ui resolved', message: 'admin.html path', data: { found: htmlPath != null, rel: htmlPath ? path.basename(htmlPath) : null } });
    res.on('finish', () => {
      agentDebugLog({ hypothesisId: 'H1', location: 'admin.ts:GET /admin/ui finish', message: 'response sent', data: { statusCode: res.statusCode } });
    });
    if (!htmlPath) {
      console.error('[admin] admin.html 不存在');
      res.status(500).type('html').send('<h1>admin.html 缺失</h1>');
      return;
    }
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.type('html').send(html);
    } catch (e: any) {
      console.error('[admin] 读取 admin.html 失败:', htmlPath, e);
      res.status(500).type('text/plain; charset=utf-8').send(String(e));
    }
  });

  r.get('/audit-logs/ui', (req, res) => {
    const htmlPath = resolveAuditLogsHtmlPath();
    if (!htmlPath) { res.status(500).type('html').send('<h1>audit-logs.html 缺失</h1>'); return; }
    try { const html = fs.readFileSync(htmlPath, 'utf8'); res.type('html').send(html); }
    catch (e: any) { res.status(500).type('text/plain; charset=utf-8').send(String(e)); }
  });

  r.post('/session/login', requireAdminConfigured, (req, res) => {
    const password = String((req.body as any).password ?? '').trim();
    const expected = ADMIN_FORM_SECRET();
    if (!password || !expected || !safeEqualStr(password, expected)) {
      res.status(401).json({ error: 'invalid_password' });
      return;
    }
    if (req.session) (req.session as any).admin = true;
    res.json({ ok: true });
  });

  r.post('/session/logout', (req, res) => {
    (req as any).session = null;
    res.json({ ok: true });
  });

  r.use(requireAdminAuth);

  r.get('/audit-logs', (req, res) => {
    const date = String(req.query.date ?? '').trim();
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    try {
      const { listAuditLogsByDate } = require('./store-db');
      const out = listAuditLogsByDate(date, limit, offset);
      res.json({ date, limit: Math.min(500, Math.max(1, Number.isFinite(limit) ? limit : 50)), offset: Math.max(0, Number.isFinite(offset) ? offset : 0), total: out.total, rows: out.rows });
    } catch (e: any) { res.status(500).json({ error: 'db_error', message: e.message }); }
  });

  r.get('/audit-events', (req, res) => {
    const date = String(req.query.date ?? '').trim();
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    try {
      const { listAuditEventsByDate } = require('./store-db');
      const out = listAuditEventsByDate(date, limit, offset);
      res.json({ date, limit: Math.min(500, Math.max(1, Number.isFinite(limit) ? limit : 50)), offset: Math.max(0, Number.isFinite(offset) ? offset : 0), total: out.total, rows: out.rows });
    } catch (e: any) { res.status(500).json({ error: 'db_error', message: e.message }); }
  });

  r.get('/stores', (_req, res) => {
    try { const stores = listStoresPublic(); res.json({ stores }); }
    catch (e: any) { res.status(500).json({ error: 'db_error', message: e.message }); }
  });

  r.post('/stores', (req, res) => {
    const body = req.body as any;
    const rawSub = String(body.subdomain ?? '').trim();
    const accessToken = String(body.accessToken ?? body.access_token ?? '').trim();
    const label = body.label != null ? String(body.label).trim() : undefined;
    const subdomain = normalizeShoplazzaSubdomain(rawSub);
    if (!subdomain || !accessToken) { res.status(400).json({ error: 'invalid_body', message: '需要 subdomain 与 accessToken' }); return; }
    try { upsertStore(subdomain, accessToken, label); res.status(201).json({ ok: true, subdomain }); }
    catch (e: any) { res.status(500).json({ error: 'db_error', message: e.message }); }
  });

  r.put('/stores/:subdomain', (req, res) => {
    const key = normalizeShoplazzaSubdomain(req.params.subdomain ?? '');
    if (!key) { res.status(400).json({ error: 'invalid_subdomain' }); return; }
    const body = req.body as any;
    const patch: { accessToken?: string; label?: string | null } = {};
    if (body.accessToken !== undefined || body.access_token !== undefined) patch.accessToken = String(body.accessToken ?? body.access_token ?? '').trim();
    if (body.label !== undefined) patch.label = body.label === null ? null : String(body.label).trim();
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'invalid_body', message: '至少提供 label 或 accessToken' }); return; }
    try {
      const ok = updateStorePartial(key, patch);
      if (!ok) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ ok: true, subdomain: key });
    } catch (e: any) { res.status(500).json({ error: 'db_error', message: e.message }); }
  });

  r.post('/stores/:subdomain/verify', async (req, res) => {
    const key = normalizeShoplazzaSubdomain(req.params.subdomain ?? '');
    if (!key) { res.status(400).json({ error: 'invalid_subdomain' }); return; }
    const row = getStoreSecretBySubdomain(key);
    if (!row) { res.status(404).json({ error: 'not_found' }); return; }
    const apiVersion = process.env.SHOPLAZZA_API_VERSION?.trim() || '2025-06';
    const verifyUrl = `https://${row.subdomain}.myshoplaza.com/openapi/${apiVersion}/orders?limit=1&page=1`;
    try {
      const resp = await fetch(verifyUrl, { method: 'GET', headers: { 'Content-Type': 'application/json', 'Access-Token': row.accessToken } });
      const text = await resp.text();
      if (resp.ok) { res.json({ ok: true, subdomain: key, status: resp.status, message: '验证通过：域名与 token 有效' }); return; }
      let detail = text.slice(0, 200);
      try { const j = text ? JSON.parse(text) : {}; const err = j.error; if (typeof err === 'string' && err.trim()) detail = err.trim(); } catch (_) {}
      res.status(400).json({ ok: false, subdomain: key, status: resp.status, error: 'verify_failed', message: detail || `HTTP ${resp.status}` });
    } catch (e: any) { res.status(400).json({ ok: false, subdomain: key, error: 'network_error', message: e.message }); }
  });

  r.delete('/stores/:subdomain', (req, res) => {
    const key = normalizeShoplazzaSubdomain(req.params.subdomain ?? '');
    if (!key) { res.status(400).json({ error: 'invalid_subdomain' }); return; }
    try {
      const ok = deleteStoreBySubdomain(key);
      if (!ok) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ ok: true, subdomain: key });
    } catch (e: any) { res.status(500).json({ error: 'db_error', message: e.message }); }
  });

  r.post('/order-index/clear-sync-cursors', (_req, res) => {
    try {
      const clearedRows = clearOrderSyncCursors();
      res.json({ ok: true, clearedRows, message: '已清空 order_sync_cursor' });
    } catch (e: any) { res.status(500).json({ error: 'db_error', message: e.message }); }
  });

  r.post('/order-index/purge-and-reindex', (req, res) => {
    try {
      const body = (req.body ?? {}) as any;
      const maxPages = Math.max(1, Math.min(10000, Number(body.maxPages) || Number(process.env.SHOPLAZZA_INDEX_BACKFILL_MAX_PAGES) || Number(process.env.SHOPLAZZA_INDEX_SYNC_MAX_PAGES) || 10000));
      const pageLimit = Math.max(1, Math.min(250, Number(body.pageLimit) || Number(process.env.SHOPLAZZA_INDEX_SYNC_PAGE_LIMIT) || 100));
      const fromBody = Number(body.bootstrapDays);
      const bootstrapDays = Math.max(1, Math.min(3650, Number.isFinite(fromBody) && fromBody > 0 ? fromBody : getIndexBootstrapDays()));
      const deletedOrders = deleteAllOrderIndexRows();
      const clearedRows = clearOrderSyncCursors();
      const stores = loadShoplazzaStores();
      if (stores.length === 0) { res.status(400).json({ ok: false, error: 'no_stores', message: '未配置任何店铺' }); return; }
      res.status(202).json({ ok: true, accepted: true, deletedOrderIndexRows: deletedOrders, clearedSyncCursors: clearedRows, storeCount: stores.length, maxPages, pageLimit, bootstrapDays, message: '已清空 order_index 与同步游标；全量重拉已在后台启动' });
      void syncAllStoresOrderIndex(stores, { maxPages, pageLimit, bootstrapDays })
        .then((results) => {
          const ok = results.filter((x) => !x.error).length;
          const err = results.filter((x) => x.error).length;
          const rows = results.reduce((s, x) => s + x.indexedRows, 0);
          console.info('[admin] order-index purge-and-reindex finished', { okStores: ok, errStores: err, indexedRows: rows });
          for (const r0 of results) { if (r0.error) console.warn('[admin] purge-and-reindex store error', r0.store, r0.error); }
        })
        .catch((e: any) => console.warn('[admin] order-index purge-and-reindex failed', e.message));
    } catch (e: any) { res.status(500).json({ error: 'db_error', message: e.message }); }
  });

  r.post('/order-index/run-full-backfill', (req, res) => {
    try {
      const body = (req.body ?? {}) as any;
      const maxPages = Math.max(1, Math.min(5000, Number(body.maxPages) || Number(process.env.SHOPLAZZA_INDEX_BACKFILL_MAX_PAGES) || 500));
      const pageLimit = Math.max(1, Math.min(250, Number(body.pageLimit) || Number(process.env.SHOPLAZZA_INDEX_SYNC_PAGE_LIMIT) || 100));
      const fromBody = Number(body.bootstrapDays);
      const bootstrapDays = Math.max(1, Math.min(3650, Number.isFinite(fromBody) && fromBody > 0 ? fromBody : getIndexBootstrapDays()));
      const clearedRows = clearOrderSyncCursors();
      const stores = loadShoplazzaStores();
      if (stores.length === 0) { res.status(400).json({ ok: false, error: 'no_stores', message: '未配置任何店铺' }); return; }
      res.status(202).json({ ok: true, accepted: true, clearedRows, storeCount: stores.length, maxPages, pageLimit, bootstrapDays, message: '已清空索引游标；全窗口回补已在后台启动' });
      void syncAllStoresOrderIndex(stores, { maxPages, pageLimit, bootstrapDays })
        .then((results) => {
          const ok = results.filter((x) => !x.error).length;
          const err = results.filter((x) => x.error).length;
          const rows = results.reduce((s, x) => s + x.indexedRows, 0);
          console.info('[admin] order-index full-backfill finished', { okStores: ok, errStores: err, indexedRows: rows });
          for (const r0 of results) { if (r0.error) console.warn('[admin] full-backfill store error', r0.store, r0.error); }
        })
        .catch((e: any) => console.warn('[admin] order-index full-backfill failed', e.message));
    } catch (e: any) { res.status(500).json({ error: 'db_error', message: e.message }); }
  });

  return r;
}
