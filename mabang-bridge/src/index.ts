/**
 * Chatwoot ↔ 店匠 Shoplazza 桥接服务
 * 联系人订单仅从本地 SQLite order_index 读取（由后台 GET 索引进程写入）；无实时店匠请求。
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  getContact, updateContactCustomAttributes, updateContactPrimaryEmail,
  ensureContactAttributeDefinitions, listContactAttributeDefinitions,
  createContactAttributeDefinition, listContactConversations,
  setConversationStatus, createConversationPrivateNote,
  mergeConversationLabels, getConversationTextForOrderHints,
  getConversationContactId,
} from './chatwoot';
import {
  loadShoplazzaStores, parseShoplazzaOrderLookup, contactEmailForOrderLookup,
  normalizeContactEmailForLookup, extractShoplazzaOrderNumberHintsFromText,
  findOrdersByEmailFromIndex, findOrdersByOrderNumberFromIndex,
  dedupeNormalizedOrdersByStoreAndId, getIndexEmailLookupWindowDays,
  getIndexEmailLookupMaxRows, getIndexBootstrapDays, syncAllStoresOrderIndex,
} from './shoplazza';
import { createAdminSessionMiddleware, createAdminRouter, assertWebAdminPasswordPolicyAtStartup } from './admin';
import { agentDebugLog, debugSession47Log, debugSession3700abLog } from './debug-log';
import { insertAuditLog, insertAuditEvent, getOrderIndexStats, backfillOrderIndexCustomerEmailFromJson, orderIndexMissDiagnostics } from './store-db';

const app = express();

/**
 * 浏览器从 Chatwoot（如 :3000）请求桥接（:4000）属于跨域；POST /sync/* 带 Authorization 会触发预检。
 * 不设 BRIDGE_CORS_ORIGINS 时：有 Origin 则回显该 Origin（便于同主机不同端口）。
 * 生产可设为逗号分隔白名单。
 */
const BRIDGE_CORS_ORIGINS = process.env.BRIDGE_CORS_ORIGINS?.trim();
const corsAllowList: string[] | null = BRIDGE_CORS_ORIGINS
  ? BRIDGE_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

app.use((req, res, next) => {
  const origin = req.get('Origin');
  let allow: string | undefined;
  if (corsAllowList && corsAllowList.length > 0) {
    if (corsAllowList.includes('*')) {
      allow = origin;
    } else if (origin && corsAllowList.includes(origin)) {
      allow = origin;
    }
  } else if (origin) {
    allow = origin;
  }
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', allow);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bridge-Sync-Token, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: '512kb' }));

// Audit log middleware
app.use((req, res, next) => {
  const startAt = Date.now();
  res.on('finish', () => {
    try {
      const ms = Date.now() - startAt;
      const body = req.body && typeof req.body === 'object' ? req.body : null;
      const accountId = body && (body as any).accountId != null ? Number((body as any).accountId) : null;
      const conversationId = body && (body as any).conversationId != null ? Number((body as any).conversationId) : null;
      const contactId = body && (body as any).contactId != null ? Number((body as any).contactId) : null;
      const xf = req.headers['x-forwarded-for'];
      const ip = typeof xf === 'string' && xf.trim()
        ? xf.split(',')[0]?.trim() ?? ''
        : req.socket?.remoteAddress ?? '';
      const ua = String(req.headers['user-agent'] ?? '').trim();
      insertAuditLog({
        method: req.method,
        path: req.originalUrl || req.url || '',
        statusCode: res.statusCode,
        durationMs: ms,
        ip,
        userAgent: ua,
        accountId: Number.isFinite(accountId) ? accountId : null,
        conversationId: Number.isFinite(conversationId) ? conversationId : null,
        contactId: Number.isFinite(contactId) ? contactId : null,
        details: body ? { keys: Object.keys(body).slice(0, 30) } : null,
      });
    } catch (_e) {}
  });
  next();
});

app.use('/admin', createAdminSessionMiddleware(), createAdminRouter());

const PORT = Number(process.env.PORT) || 4000;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || '';
const CHATWOOT_ACCOUNT_ID = Number(process.env.CHATWOOT_ACCOUNT_ID) || 0;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_ACCESS_TOKEN || '';

const SHOPLAZZA_INDEX_WINDOW_DAYS = getIndexBootstrapDays();
const SHOPLAZZA_INDEX_SYNC_INTERVAL_MS_RAW = Number(process.env.SHOPLAZZA_INDEX_SYNC_INTERVAL_MS);
const SHOPLAZZA_INDEX_SYNC_INTERVAL_MS: number = Number.isFinite(SHOPLAZZA_INDEX_SYNC_INTERVAL_MS_RAW) && SHOPLAZZA_INDEX_SYNC_INTERVAL_MS_RAW > 0
  ? SHOPLAZZA_INDEX_SYNC_INTERVAL_MS_RAW : 180000;
const SHOPLAZZA_INDEX_SYNC_DISABLE_INTERVAL = process.env.SHOPLAZZA_INDEX_SYNC_DISABLE_INTERVAL === 'true' ||
  process.env.SHOPLAZZA_INDEX_SYNC_INTERVAL_MS === '0' ||
  (Number.isFinite(SHOPLAZZA_INDEX_SYNC_INTERVAL_MS_RAW) && SHOPLAZZA_INDEX_SYNC_INTERVAL_MS_RAW <= 0);
const SHOPLAZZA_INDEX_SYNC_ENABLED = process.env.SHOPLAZZA_INDEX_SYNC_ENABLED !== 'false';
const SHOPLAZZA_DAILY_REFRESH_ENABLED = process.env.SHOPLAZZA_DAILY_REFRESH_ENABLED !== 'false';
const SHOPLAZZA_DAILY_REFRESH_HOUR: number = (() => {
  const n = Number(process.env.SHOPLAZZA_DAILY_REFRESH_HOUR);
  if (Number.isFinite(n) && n >= 0 && n <= 23) return n;
  return 8;
})();
const SHOPLAZZA_DAILY_REFRESH_MAX_PAGES = Number(process.env.SHOPLAZZA_DAILY_REFRESH_MAX_PAGES) || 300;
const SHOPLAZZA_DAILY_REFRESH_PAGE_LIMIT = Number(process.env.SHOPLAZZA_DAILY_REFRESH_PAGE_LIMIT) || 100;
const NOTE_MAX = 500;

const SHOPLAZZA_ORDER_LOOKUP_KEY = process.env.SHOPLAZZA_ORDER_LOOKUP_ATTRIBUTE_KEY?.trim() || 'shoplazza_order_lookup';

function loadInboxChannelLabelMap(): Map<number, string> {
  const raw = process.env.BRIDGE_INBOX_CHANNEL_LABELS_JSON?.trim();
  if (!raw) return new Map();
  try {
    const o: any = JSON.parse(raw);
    const m = new Map<number, string>();
    for (const [k, v] of Object.entries(o)) {
      const id = Number(k);
      const title = typeof v === 'string' ? v.trim() : '';
      if (Number.isFinite(id) && id > 0 && title) m.set(id, title);
    }
    return m;
  } catch {
    console.warn('[bridge] BRIDGE_INBOX_CHANNEL_LABELS_JSON 解析失败');
    return new Map();
  }
}

const INBOX_CHANNEL_LABEL_MAP = loadInboxChannelLabelMap();
const INBOX_LABEL_WEBHOOK_EVENTS = new Set(
  (process.env.BRIDGE_INBOX_LABEL_EVENTS?.trim() || 'conversation_created')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

const BRIDGE_EMAIL_CONVERSATION_COLLAPSE = process.env.BRIDGE_EMAIL_CONVERSATION_COLLAPSE === 'true';
const BRIDGE_EMAIL_CONVERSATION_COLLAPSE_LABEL = process.env.BRIDGE_EMAIL_CONVERSATION_COLLAPSE_LABEL?.trim() || 'duplicate_email_thread';
const BRIDGE_EMAIL_CONVERSATION_COLLAPSE_WINDOW_HOURS: number = (() => {
  const n = Number(process.env.BRIDGE_EMAIL_CONVERSATION_COLLAPSE_WINDOW_HOURS);
  if (Number.isFinite(n) && n > 0) return Math.min(24 * 14, n);
  return 24;
})();

function parseWebhookConversationRouting(payload: any): { accountId: number; conversationId: number; inboxId: number } | null {
  const fromAcc = Number(payload.account?.id ?? payload.account_id);
  const accountId = fromAcc > 0 ? fromAcc : CHATWOOT_ACCOUNT_ID > 0 ? CHATWOOT_ACCOUNT_ID : 0;
  const conv = payload.conversation;
  let conversationId = 0;
  let inboxId = 0;
  if (conv && typeof conv === 'object') {
    conversationId = Number(conv.id ?? 0);
    inboxId = Number(conv.inbox_id ?? 0);
  }
  if (!conversationId) conversationId = Number(payload.id ?? 0);
  if (!inboxId) inboxId = Number(payload.inbox_id ?? 0);
  if (!accountId || !conversationId || !inboxId) return null;
  return { accountId, conversationId, inboxId };
}

function parseContactFromPayload(payload: any, eventFromRoot?: string): { accountId: number; contactId: number; conversationId?: number } | null {
  const accountId = Number(payload.account?.id ?? payload.account_id);
  const event = String(payload.event ?? eventFromRoot ?? '');
  const senderMeta = payload.conversation?.meta?.sender;
  const contact = payload.contact ?? payload.conversation?.contact;
  let contactId = Number(contact?.id ?? payload.contact_id);
  if (!contactId && senderMeta != null && senderMeta.id != null) {
    contactId = Number(senderMeta.id);
  }
  if (!contactId && (event === 'contact_created' || event === 'contact_updated') && payload.id != null) {
    contactId = Number(payload.id);
  }
  if (!accountId || !contactId) return null;
  const conv = payload.conversation;
  const conversationId = conv?.id ? Number(conv.id) : undefined;
  return { accountId, contactId, conversationId: conversationId && conversationId > 0 ? conversationId : undefined };
}

function eventIsEmailConversation(payload: any): boolean {
  const conv = payload?.conversation;
  const probes = [conv?.channel, conv?.channel_type, conv?.inbox?.channel_type, payload?.inbox?.channel_type, conv?.meta?.channel, conv?.additional_attributes?.channel, payload?.channel];
  const normalized = probes.map((v: any) => String(v ?? '').trim().toLowerCase()).filter(Boolean).join(' | ');
  if (!normalized) return false;
  return normalized.includes('email');
}

function normalizeConversationCreatedAtMs(row: any): number {
  const v = row?.created_at ?? row?.meta?.created_at;
  if (typeof v === 'number') return v > 1000000000000 ? v : v * 1000;
  if (typeof v === 'string') { const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  return 0;
}

function normalizeConversationStatus(row: any): string {
  const s = String(row?.status ?? row?.meta?.status ?? '').trim().toLowerCase();
  if (s === 'open' || s === 'pending' || s === 'resolved' || s === 'snoozed') return s;
  return '';
}

async function collapseDuplicateEmailConversation(accountId: number, contactId: number, currentConversationId: number): Promise<void> {
  const rows = await listContactConversations(CHATWOOT_BASE_URL, accountId, contactId, CHATWOOT_API_TOKEN);
  if (!Array.isArray(rows) || rows.length === 0) return;
  const now = Date.now();
  const windowMs = Math.max(1, BRIDGE_EMAIL_CONVERSATION_COLLAPSE_WINDOW_HOURS) * 60 * 60 * 1000;
  const candidates = rows
    .map((r: any) => ({ id: Number(r?.id ?? 0), status: normalizeConversationStatus(r), createdAtMs: normalizeConversationCreatedAtMs(r) }))
    .filter((r) => r.id > 0 && r.id !== currentConversationId)
    .filter((r) => r.status === 'open' || r.status === 'pending')
    .filter((r) => r.createdAtMs <= 0 || now - r.createdAtMs <= windowMs)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  const primary = candidates[0];
  if (!primary) return;
  await mergeConversationLabels(CHATWOOT_BASE_URL, accountId, currentConversationId, CHATWOOT_API_TOKEN, [BRIDGE_EMAIL_CONVERSATION_COLLAPSE_LABEL]);
  await setConversationStatus(CHATWOOT_BASE_URL, accountId, currentConversationId, CHATWOOT_API_TOKEN, 'resolved');
  const note = ['系统自动收敛：检测到同联系人重复邮件线程。', `重复线程会话 #${currentConversationId} 已自动标记并设为 resolved。`, `请统一在主会话 #${primary.id} 继续跟进。`].join('\n');
  await createConversationPrivateNote(CHATWOOT_BASE_URL, accountId, primary.id, CHATWOOT_API_TOKEN, note);
  console.info('[bridge] collapsed duplicate email conversation', { accountId, contactId, currentConversationId, primaryConversationId: primary.id, windowHours: BRIDGE_EMAIL_CONVERSATION_COLLAPSE_WINDOW_HOURS });
}

function extractActorFromWebhookPayload(payload: any): { actorType: string | null; actorId: string | null; actorName: string | null } | null {
  const sender = payload?.sender;
  const assignee = payload?.conversation?.assignee ?? payload?.conversation?.meta?.assignee ?? payload?.assignee;
  const actor = sender && typeof sender === 'object' ? sender : assignee && typeof assignee === 'object' ? assignee : null;
  if (!actor) return null;
  const actorType = String(actor.type ?? actor.actor_type ?? actor.sender_type ?? actor.role ?? '').trim() || null;
  const actorId = actor.id != null ? String(actor.id) : actor.uid != null ? String(actor.uid) : null;
  const actorName = String(actor.name ?? actor.display_name ?? actor.email ?? '').trim() || null;
  return { actorType, actorId, actorName };
}

function extractSubjectFromWebhookPayload(payload: any): { accountId: number; conversationId: number | null; contactId: number | null } {
  const conversationId = Number(payload?.conversation?.id ?? payload?.conversation_id ?? payload?.id ?? 0) || 0;
  const contactId = Number(payload?.contact?.id ?? payload?.conversation?.contact?.id ?? payload?.conversation?.meta?.sender?.id ?? payload?.contact_id ?? 0) || 0;
  const accountId = Number(payload?.account?.id ?? payload?.account_id ?? 0) || 0;
  return { accountId, conversationId: conversationId || null, contactId: contactId || null };
}

function buildEventSummary(event: string, actorName: string | null, subject: { accountId: number; conversationId: number | null; contactId: number | null }): string {
  const who = (actorName || '').trim() || '系统';
  const conv = subject.conversationId ? `会话 #${subject.conversationId}` : '会话';
  const contact = subject.contactId ? `联系人 #${subject.contactId}` : '联系人';
  if (event === 'conversation_status_changed') return `${who} 处理了 ${conv}：修改了会话状态`;
  if (event === 'conversation_updated') return `${who} 处理了 ${conv}：更新了会话信息`;
  if (event === 'conversation_created') return `${who} 创建了 ${conv}`;
  if (event === 'message_created') return `${who} 在 ${conv} 发送了消息`;
  if (event === 'contact_created') return `${who} 创建了 ${contact}`;
  if (event === 'contact_updated') return `${who} 更新了 ${contact} 的信息`;
  return `${who} 执行了操作：${event}`;
}

function mergeOrderNumberHintsUnique(base: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...base, ...extra]) {
    const t = (s || '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function parseBearerAuthHeader(req: express.Request): string {
  const raw = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m?.[1]?.trim() ?? '';
}

// Health check
app.get('/health', (req, res) => {
  const base: any = { ok: true, service: 'chatwoot-shoplazza-bridge', contactOrderLookupMode: 'order_index_plus_live_fallback' };
  const token = parseBearerAuthHeader(req);
  const adminTok = process.env.BRIDGE_ADMIN_TOKEN?.trim() ?? '';
  const syncTok = process.env.BRIDGE_SYNC_TOKEN?.trim() || adminTok;
  if (token && (token === adminTok || token === syncTok)) {
    try {
      const stores = loadShoplazzaStores();
      const stats = getOrderIndexStats();
      base.storeCount = stores.length;
      base.orderIndexTotalRows = stats.totalRows;
      base.orderIndexRowsWithEmail = stats.rowsWithEmail;
      base.indexSyncEnabled = SHOPLAZZA_INDEX_SYNC_ENABLED;
      base.skipIndexLookup = process.env.SHOPLAZZA_SKIP_ORDER_INDEX_LOOKUP === 'true' || process.env.SHOPLAZZA_CONTACT_SYNC_SKIP_INDEX === 'true';
    } catch (e: any) { base.diagnosticError = e.message; }
  }
  res.json(base);
});

// Contact attributes page
app.get('/contact-attributes', async (_req, res) => {
  if (!CHATWOOT_BASE_URL || !CHATWOOT_ACCOUNT_ID || !CHATWOOT_API_TOKEN) {
    res.status(500).send('未配置 CHATWOOT_BASE_URL / CHATWOOT_ACCOUNT_ID / CHATWOOT_API_ACCESS_TOKEN');
    return;
  }
  try {
    const list = await listContactAttributeDefinitions(CHATWOOT_BASE_URL, CHATWOOT_ACCOUNT_ID, CHATWOOT_API_TOKEN);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const rows = list.map((a) => `<tr><td>${escapeHtml(String(a.attribute_key ?? (a as any).key ?? ''))}</td><td>${escapeHtml(String(a.attribute_display_name ?? ''))}</td></tr>`).join('');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>联系人自定义属性</title></head><body><h1>Chatwoot 联系人自定义属性定义</h1><table border="1" cellpadding="8"><thead><tr><th>属性键</th><th>显示名</th></tr></thead><tbody>${rows || '<tr><td colspan="2">无</td></tr>'}</tbody></table><p><a href="/health">健康检查</a></p></body></html>`);
  } catch (e: any) { res.status(500).send('请求失败: ' + e.message); }
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

app.get('/chatwoot/open-sync.js', (_req, res) => {
  const p = path.join(__dirname, '..', 'public', 'chatwoot-open-sync.js');
  try { const content = fs.readFileSync(p, 'utf8'); res.type('application/javascript').send(content); }
  catch { res.status(404).type('text/plain').send('not_found'); }
});

app.post('/chatwoot/open-sync-ping', (req, res) => {
  const body = (req.body || {}) as any;
  agentDebugLog({ hypothesisId: 'H2', location: 'index.ts:/chatwoot/open-sync-ping', message: String(body.message ?? 'ping'), data: { phase: String(body.phase ?? ''), path: String(body.path ?? ''), matched: !!body.matched, hasContactId: !!body.hasContactId, syncOk: !!body.syncOk, syncStatus: Number(body.syncStatus ?? 0) } });
  res.json({ ok: true });
});

function shoplazzaOrderFieldsForContact(latest: any | null): Record<string, string> {
  if (!latest) {
    return { id: '', name: '', order_number: '', email: '', created_at: '', updated_at: '', processed_at: '', cancelled_at: '', total_price: '', sub_total: '', total_tax: '', total_shipping: '', total_discount: '', currency: '', financial_status: '', fulfillment_status: '', payment_method: '', tracking_numbers: '', customer_note: '', myshoplaza_subdomain: '', shop_last_store: '' };
  }
  return {
    id: latest.id, name: latest.name, order_number: latest.order_number, email: latest.email,
    created_at: latest.created_at, updated_at: latest.updated_at, processed_at: latest.processed_at,
    cancelled_at: latest.cancelled_at, total_price: latest.total_price, sub_total: latest.sub_total,
    total_tax: latest.total_tax, total_shipping: latest.total_shipping, total_discount: latest.total_discount,
    currency: latest.currency, financial_status: latest.financial_status, fulfillment_status: latest.fulfillment_status,
    payment_method: latest.payment_method, tracking_numbers: latest.tracking_numbers, customer_note: latest.customer_note,
    myshoplaza_subdomain: latest.subdomain, shop_last_store: latest.subdomain,
  };
}

function formatRecentOrdersForSidebar(orders: any[], maxItems: number = 15): string {
  if (orders.length === 0) return '';
  const lines: string[] = [];
  const cap = Math.max(1, Math.min(maxItems, 30));
  for (const o of orders.slice(0, cap)) {
    const track = (o.tracking_numbers || '').trim();
    const trackShort = track.length > 55 ? `${track.slice(0, 52)}…` : track;
    lines.push(`${o.created_at || o.updated_at || '-'} | ${o.subdomain} | ${o.order_number || o.id} | ${o.total_price || '-'} ${o.currency || ''} | ${o.financial_status || '-'}${trackShort ? ` | 物流:${trackShort}` : ''}`);
  }
  if (orders.length > cap) { lines.push(`... 共 ${orders.length} 单`); }
  return lines.join('\n');
}

function nextRunAtHour(hourLocal: number): Date {
  const now = new Date();
  const run = new Date(now);
  run.setHours(Math.max(0, Math.min(23, hourLocal)), 0, 0, 0);
  if (run.getTime() <= now.getTime()) { run.setDate(run.getDate() + 1); }
  return run;
}

const ACTIVE_SYNC_TOKEN = process.env.BRIDGE_SYNC_TOKEN?.trim() || ADMIN_TOKEN();
const ACTIVE_SYNC_DEDUP_MS = Number(process.env.BRIDGE_ACTIVE_SYNC_DEDUP_MS) || 8000;
const activeSyncBuckets = new Map<string, { startedAt: number; promise: Promise<any> }>();

function ADMIN_TOKEN(): string {
  return process.env.BRIDGE_ADMIN_TOKEN?.trim() ?? '';
}

function parseSyncToken(req: express.Request): string {
  const raw = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  if (m?.[1]) return m[1].trim();
  const v = req.headers['x-bridge-sync-token'];
  return typeof v === 'string' ? v.trim() : '';
}

function requireActiveSyncAuth(req: express.Request, res: express.Response): boolean {
  if (!ACTIVE_SYNC_TOKEN) {
    agentDebugLog({ hypothesisId: 'H4', location: 'index.ts:requireActiveSyncAuth', message: 'sync token not configured', data: { hasAdminToken: !!ADMIN_TOKEN(), hasSyncToken: !!process.env.BRIDGE_SYNC_TOKEN } });
    res.status(503).json({ error: 'sync_not_configured', message: '未设置 BRIDGE_SYNC_TOKEN 或 BRIDGE_ADMIN_TOKEN' });
    return false;
  }
  const provided = parseSyncToken(req);
  if (!provided || provided !== ACTIVE_SYNC_TOKEN) {
    agentDebugLog({ hypothesisId: 'H4', location: 'index.ts:requireActiveSyncAuth', message: 'active sync auth failed', data: { hasProvidedToken: !!provided, providedLen: provided.length, expectedLen: ACTIVE_SYNC_TOKEN.length } });
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function dedupSync(key: string, runner: () => Promise<any>): Promise<any> {
  const now = Date.now();
  const hit = activeSyncBuckets.get(key);
  if (hit && now - hit.startedAt <= ACTIVE_SYNC_DEDUP_MS) { return hit.promise; }
  const p = runner().finally(() => { const cur = activeSyncBuckets.get(key); if (cur?.promise === p) activeSyncBuckets.delete(key); });
  activeSyncBuckets.set(key, { startedAt: now, promise: p });
  return p;
}

async function syncContactShoplazzaOrder(
  accountId: number, contactId: number, trigger: string,
  opts?: { conversationId?: number },
): Promise<{
  ok: boolean; accountId: number; contactId: number; trigger: string;
  resolvedBy: string; matchingOrdersCount: number; syncNote: string;
  latestOrderSummary: { orderNumber: string; email: string; subdomain: string } | null;
  storeErrorsCount: number; skippedReason?: string;
}> {
  if (!CHATWOOT_BASE_URL || !CHATWOOT_API_TOKEN) {
    return { ok: false, accountId, contactId, trigger, resolvedBy: 'none', matchingOrdersCount: 0, syncNote: '', latestOrderSummary: null, storeErrorsCount: 0, skippedReason: 'missing_chatwoot_env' };
  }
  let stores;
  try { stores = loadShoplazzaStores(); } catch (e: any) {
    const note = `店匠配置错误: ${e.message}`;
    try { await updateContactCustomAttributes(CHATWOOT_BASE_URL, accountId, contactId, CHATWOOT_API_TOKEN, { shoplazza_sync_note: note }); } catch (_) {}
    return { ok: false, accountId, contactId, trigger, resolvedBy: 'none', matchingOrdersCount: 0, syncNote: note, latestOrderSummary: null, storeErrorsCount: 0, skippedReason: 'invalid_stores_config' };
  }
  if (stores.length === 0) {
    return { ok: false, accountId, contactId, trigger, resolvedBy: 'none', matchingOrdersCount: 0, syncNote: '', latestOrderSummary: null, storeErrorsCount: 0, skippedReason: 'no_stores' };
  }
  const contact = await getContact(CHATWOOT_BASE_URL, accountId, contactId, CHATWOOT_API_TOKEN);
  if (!contact) {
    return { ok: false, accountId, contactId, trigger, resolvedBy: 'none', matchingOrdersCount: 0, syncNote: '', latestOrderSummary: null, storeErrorsCount: 0, skippedReason: 'contact_not_found' };
  }
  const customAttrs: any = (contact.custom_attributes ?? {});
  const parsedLookup = parseShoplazzaOrderLookup(customAttrs[SHOPLAZZA_ORDER_LOOKUP_KEY]);
  const contactEmail = contactEmailForOrderLookup(contact);
  let mergedOrderNumbers = mergeOrderNumberHintsUnique([...parsedLookup.orderNumbers], []);
  if (opts?.conversationId) {
    try {
      const blob = await getConversationTextForOrderHints(CHATWOOT_BASE_URL, accountId, opts.conversationId, CHATWOOT_API_TOKEN);
      mergedOrderNumbers = mergeOrderNumberHintsUnique(mergedOrderNumbers, extractShoplazzaOrderNumberHintsFromText(blob));
    } catch (e: any) { console.warn('[bridge] conversation order hints failed', e.message); }
  }
  if (mergedOrderNumbers.length === 0 && parsedLookup.emails.length === 0 && !contactEmail) {
    const note = '无联系人邮箱且未填写「订单邮箱/订单号」，无法匹配店匠订单';
    await updateContactCustomAttributes(CHATWOOT_BASE_URL, accountId, contactId, CHATWOOT_API_TOKEN, { shoplazza_sync_note: note });
    return { ok: false, accountId, contactId, trigger, resolvedBy: 'none', matchingOrdersCount: 0, syncNote: note, latestOrderSummary: null, storeErrorsCount: 0, skippedReason: 'missing_lookup_and_email' };
  }
  try {
    console.info('[bridge] 同步开始', { accountId, contactId, trigger, storeCount: stores.length, hasContactEmail: !!contactEmail });
    let orders: any[] = [];
    let resolvedBy = 'none';
    const emailCandidates: string[] = [...parsedLookup.emails];
    if (contactEmail) { emailCandidates.push(contactEmail); }
    const seenEm = new Set<string>();
    const uniqueEmails: string[] = [];
    for (const e of emailCandidates) {
      const k = normalizeContactEmailForLookup(e) || e.trim().toLowerCase();
      if (!k || seenEm.has(k)) continue;
      seenEm.add(k);
      uniqueEmails.push(k);
    }
    const skipIndexLookup = process.env.SHOPLAZZA_SKIP_ORDER_INDEX_LOOKUP === 'true' || process.env.SHOPLAZZA_CONTACT_SYNC_SKIP_INDEX === 'true';
    for (const em of uniqueEmails) {
      const indexed = skipIndexLookup ? [] : findOrdersByEmailFromIndex(em);
      debugSession47Log({ hypothesisId: 'H2', location: 'index.ts:syncContactShoplazzaOrder:after_index_read', message: 'index lookup result', data: { indexedLen: indexed.length } });
      if (indexed.length > 0) { orders = indexed; resolvedBy = 'email'; break; }
      if (!skipIndexLookup) { console.info('[bridge] 本地 order_index 未命中该邮箱', { email: em }); }
    }
    if (orders.length === 0) {
      for (const num of mergedOrderNumbers) {
        const byNum = skipIndexLookup ? [] : findOrdersByOrderNumberFromIndex(num);
        if (byNum.length > 0) { orders = byNum; resolvedBy = 'order_number'; break; }
      }
    }
    if (orders.length === 0) {
      const primaryEmail = uniqueEmails[0] ?? '';
      const diag = orderIndexMissDiagnostics(primaryEmail, mergedOrderNumbers);
      debugSession3700abLog({ hypothesisId: 'H1-H5', location: 'index.ts:syncContactShoplazzaOrder:index_miss_diag', message: 'order_index miss diagnostics', data: { accountId, contactId, skipIndexLookup, emailCandidateCount: uniqueEmails.length, orderHintCount: mergedOrderNumbers.length, ...diag } });
    }
    if (orders.length > 0) { orders = dedupeNormalizedOrdersByStoreAndId(orders); }
    const latest = orders[0];
    const recentOrdersForSidebar = dedupeNormalizedOrdersByStoreAndId(
      resolvedBy === 'email' && orders.length > 0 ? orders : (() => {
        const em = normalizeContactEmailForLookup(String(latest?.email ?? '')) || parsedLookup.emails[0] || contactEmail || '';
        if (!em) return [];
        return findOrdersByEmailFromIndex(em);
      })(),
    );
    const recentOrdersText = formatRecentOrdersForSidebar(recentOrdersForSidebar, 15);
    let syncNote = '';
    if (orders.length === 0) {
      syncNote = `本地 order_index 未找到匹配订单（按邮箱检索最近 ${getIndexEmailLookupWindowDays()} 天内、最多 ${getIndexEmailLookupMaxRows()} 条；索引进库保留约 ${SHOPLAZZA_INDEX_WINDOW_DAYS} 天）。` + `侧栏只读已入库数据：请确认后台店匠索引进程已运行并把该单写入索引；① 联系人邮箱是否与订单收件邮箱一致；② 订单号/订单 id 提示仅用于匹配已入库字段。`;
    }
    if (resolvedBy === 'order_number' && orders.length > 0) { syncNote = syncNote ? `[按订单号·索引] ${syncNote}` : '[按订单号·索引] 已同步'; }
    else if (resolvedBy === 'email' && orders.length > 0) { syncNote = syncNote ? `[按邮箱·索引] ${syncNote}` : '[按邮箱·索引] 已同步'; }
    const customAttributes: Record<string, any> = {
      matching_orders_count: orders.length,
      ...shoplazzaOrderFieldsForContact(latest),
      shoplazza_recent_orders: recentOrdersText,
      shoplazza_sync_note: syncNote.slice(0, NOTE_MAX),
    };
    if (!latest) { customAttributes.shop_last_store = 'not_found'; }
    debugSession47Log({ hypothesisId: 'H4', location: 'index.ts:syncContactShoplazzaOrder:before_chatwoot_put', message: 'about to update contact custom_attributes', data: { ordersLen: orders.length, resolvedBy, syncNoteHead: syncNote.slice(0, 100) } });
    const cwOk = await updateContactCustomAttributes(CHATWOOT_BASE_URL, accountId, contactId, CHATWOOT_API_TOKEN, customAttributes);
    if (!cwOk) { console.warn('[bridge] Chatwoot 写入联系人属性失败', { accountId, contactId, trigger, orders: orders.length }); }
    else { console.info('[bridge] 同步完成', { accountId, contactId, trigger, orders: orders.length, resolvedBy, syncNote: syncNote.slice(0, 120) }); }
    if (orders.length > 0 && latest) {
      const orderEmail = (latest.email || '').trim();
      if (orderEmail) {
        const curLower = contactEmailForOrderLookup(contact);
        if (orderEmail.toLowerCase() !== curLower) {
          await updateContactPrimaryEmail(CHATWOOT_BASE_URL, accountId, contactId, CHATWOOT_API_TOKEN, orderEmail);
        }
      }
    }
    return { ok: true, accountId, contactId, trigger, resolvedBy, matchingOrdersCount: orders.length, syncNote, latestOrderSummary: latest ? { orderNumber: latest.order_number, email: latest.email, subdomain: latest.subdomain } : null, storeErrorsCount: 0 };
  } catch (err: any) {
    debugSession3700abLog({ runId: 'pre-fix', hypothesisId: 'H4-H5', location: 'index.ts:syncContactShoplazzaOrder:catch', message: 'sync threw error', data: { accountId, contactId, trigger, errName: err?.name || 'Error', errMessage: err?.message || String(err), errStackHead: String(err?.stack || '').split('\n').slice(0, 3).join(' | ') } });
    const note = `同步失败: ${err.message}`.slice(0, NOTE_MAX);
    try { await updateContactCustomAttributes(CHATWOOT_BASE_URL, accountId, contactId, CHATWOOT_API_TOKEN, { shoplazza_sync_note: note }); } catch (_) {}
    return { ok: false, accountId, contactId, trigger, resolvedBy: 'none', matchingOrdersCount: 0, syncNote: note, latestOrderSummary: null, storeErrorsCount: 0, skippedReason: 'sync_error' };
  }
}

// Webhook endpoint
app.post('/webhook/chatwoot', async (req, res) => {
  res.status(200).send('OK');
  const event = req.body?.event || '';
  const payload = (req.body?.payload || req.body);
  const supported = ['conversation_created', 'message_created', 'contact_created', 'contact_updated', 'conversation_updated', 'conversation_status_changed'];
  if (!supported.includes(event)) { return; }

  try {
    const actor = extractActorFromWebhookPayload(payload) || { actorType: null, actorId: null, actorName: null };
    const subject = extractSubjectFromWebhookPayload(payload);
    const summary = buildEventSummary(event, actor.actorName, subject);
    insertAuditEvent({
      action: event, summary,
      actorType: actor.actorType, actorId: actor.actorId, actorName: actor.actorName,
      subjectType: subject.conversationId ? 'conversation' : subject.contactId ? 'contact' : null,
      subjectId: subject.conversationId ? String(subject.conversationId) : subject.contactId ? String(subject.contactId) : null,
      accountId: subject.accountId || null, conversationId: subject.conversationId, contactId: subject.contactId,
      meta: { hasConversation: !!payload?.conversation, hasSender: !!payload?.sender, inboxId: payload?.conversation?.inbox_id ?? payload?.inbox_id ?? null },
    });
  } catch (_e) {}

  if (INBOX_CHANNEL_LABEL_MAP.size > 0 && INBOX_LABEL_WEBHOOK_EVENTS.has(event) && CHATWOOT_BASE_URL && CHATWOOT_API_TOKEN) {
    const routing = parseWebhookConversationRouting(payload);
    if (routing) {
      const labelTitle = INBOX_CHANNEL_LABEL_MAP.get(routing.inboxId);
      if (labelTitle) {
        void mergeConversationLabels(CHATWOOT_BASE_URL, routing.accountId, routing.conversationId, CHATWOOT_API_TOKEN, [labelTitle]).then((ok) => {
          if (ok) console.info('[bridge] merged inbox channel label', { event, inboxId: routing.inboxId, conversationId: routing.conversationId, labelTitle });
        });
      }
    }
  }

  const parsed = parseContactFromPayload(payload, event);
  if (!parsed) {
    console.warn('[bridge] webhook: 无法解析 contact_id，跳过同步', { event, hasAccount: !!payload.account?.id, hasConvMeta: !!payload.conversation?.meta });
    return;
  }

  if (event === 'conversation_created' && BRIDGE_EMAIL_CONVERSATION_COLLAPSE && CHATWOOT_BASE_URL && CHATWOOT_API_TOKEN && parsed.conversationId && eventIsEmailConversation(payload)) {
    void collapseDuplicateEmailConversation(parsed.accountId, parsed.contactId, parsed.conversationId).catch((e) => {
      console.warn('[bridge] collapse duplicate email conversation failed', { accountId: parsed.accountId, contactId: parsed.contactId, conversationId: parsed.conversationId, error: e?.message || String(e) });
    });
  }

  console.info('[bridge] webhook → 同步联系人订单', { event, accountId: parsed.accountId, contactId: parsed.contactId });
  debugSession47Log({ hypothesisId: 'H1', location: 'index.ts:webhook/chatwoot', message: 'webhook will sync', data: { event, accountId: parsed.accountId, contactId: parsed.contactId } });
  void dedupSync(`${parsed.accountId}:${parsed.contactId}`, () => syncContactShoplazzaOrder(parsed.accountId, parsed.contactId, `webhook:${event}`, { conversationId: parsed.conversationId }));
});

// Active sync endpoints
app.post('/sync/contact-order', async (req, res) => {
  agentDebugLog({ hypothesisId: 'H2', location: 'index.ts:/sync/contact-order', message: 'active sync endpoint called', data: { hasAuthHeader: !!req.headers.authorization } });
  if (!requireActiveSyncAuth(req, res)) return;
  const body = (req.body || {}) as any;
  const accountId = Number(body.accountId ?? body.account_id ?? CHATWOOT_ACCOUNT_ID);
  const contactId = Number(body.contactId ?? body.contact_id);
  const conversationId = Number(body.conversationId ?? body.conversation_id);
  if (!accountId || !contactId) { res.status(400).json({ error: 'invalid_body', message: '需要 accountId/contactId' }); return; }
  try {
    void dedupSync(`${accountId}:${contactId}`, () => syncContactShoplazzaOrder(accountId, contactId, 'open_conversation', { conversationId: conversationId > 0 ? conversationId : undefined }))
      .then((result) => { console.info('[bridge] 后台同步结束', { accountId, contactId, ok: result.ok, orders: result.matchingOrdersCount, skipped: result.skippedReason }); })
      .catch((e) => console.warn('[bridge] 后台同步异常', accountId, contactId, e.message));
    res.json({ ok: true, accepted: true, accountId, contactId, message: 'sync_started_background' });
  } catch (e: any) { res.status(500).json({ error: 'sync_error', message: e.message }); }
});

app.post('/sync/conversation-order', async (req, res) => {
  agentDebugLog({ hypothesisId: 'H2', location: 'index.ts:/sync/conversation-order', message: 'conversation sync endpoint called', data: { hasAuthHeader: !!req.headers.authorization } });
  if (!requireActiveSyncAuth(req, res)) return;
  const body = (req.body || {}) as any;
  const accountId = Number(body.accountId ?? body.account_id ?? CHATWOOT_ACCOUNT_ID);
  const conversationId = Number(body.conversationId ?? body.conversation_id);
  if (!accountId || !conversationId) { res.status(400).json({ error: 'invalid_body', message: '需要 accountId/conversationId' }); return; }
  try {
    const contactId = await getConversationContactId(CHATWOOT_BASE_URL, accountId, conversationId, CHATWOOT_API_TOKEN);
    if (!contactId) { res.status(404).json({ error: 'contact_not_found_from_conversation' }); return; }
    void dedupSync(`${accountId}:${contactId}`, () => syncContactShoplazzaOrder(accountId, contactId, 'open_conversation', { conversationId }))
      .then((result) => { console.info('[bridge] 后台同步结束', { accountId, contactId, conversationId, ok: result.ok, orders: result.matchingOrdersCount }); })
      .catch((e) => console.warn('[bridge] 后台同步异常', accountId, contactId, e.message));
    res.json({ ok: true, accepted: true, accountId, contactId, conversationId, message: 'sync_started_background' });
  } catch (e: any) { res.status(500).json({ error: 'sync_error', message: e.message }); }
});

async function startup(): Promise<void> {
  assertWebAdminPasswordPolicyAtStartup();
  if (CHATWOOT_BASE_URL && CHATWOOT_ACCOUNT_ID > 0 && CHATWOOT_API_TOKEN) {
    try {
      await ensureContactAttributeDefinitions(CHATWOOT_BASE_URL, CHATWOOT_ACCOUNT_ID, CHATWOOT_API_TOKEN);
      if (SHOPLAZZA_ORDER_LOOKUP_KEY !== 'shoplazza_order_lookup') {
        const existing = await listContactAttributeDefinitions(CHATWOOT_BASE_URL, CHATWOOT_ACCOUNT_ID, CHATWOOT_API_TOKEN);
        const keys = new Set(existing.map((a) => (a.attribute_key ?? (a as any).key) ?? ''));
        if (!keys.has(SHOPLAZZA_ORDER_LOOKUP_KEY)) {
          await createContactAttributeDefinition(CHATWOOT_BASE_URL, CHATWOOT_ACCOUNT_ID, CHATWOOT_API_TOKEN, {
            attribute_key: SHOPLAZZA_ORDER_LOOKUP_KEY, attribute_display_name: '订单邮箱/订单号',
            attribute_display_type: 0, attribute_description: '客户提供的下单邮箱或订单号，可混填；桥接仅从本地 order_index 匹配',
          });
        }
      }
    } catch (e: any) { console.warn('[startup] ensure contact attribute definitions failed:', e.message); }
  }

  if (SHOPLAZZA_INDEX_SYNC_ENABLED) {
    const runIndexSync = async (trigger: string) => {
      try {
        const stores = loadShoplazzaStores();
        if (stores.length === 0) return;
        const results = await syncAllStoresOrderIndex(stores);
        const okStores = results.filter((r) => !r.error).length;
        const errStores = results.filter((r) => !!r.error).length;
        const indexedRows = results.reduce((s, r) => s + r.indexedRows, 0);
        agentDebugLog({ hypothesisId: 'H5', location: 'index.ts:startup:index_sync', message: 'index sync finished', data: { trigger, stores: stores.length, okStores, errStores, indexedRows } });
      } catch (e: any) { agentDebugLog({ hypothesisId: 'H5', location: 'index.ts:startup:index_sync', message: 'index sync failed', data: { trigger, error: e.message.slice(0, 200) } }); }
    };
    void runIndexSync('startup');
    if (SHOPLAZZA_INDEX_SYNC_DISABLE_INTERVAL) {
      console.info('[bridge] 索引进库：已关闭定时轮询');
    } else {
      setInterval(() => { void runIndexSync('interval'); }, Math.max(60000, SHOPLAZZA_INDEX_SYNC_INTERVAL_MS));
    }
  }

  if (SHOPLAZZA_DAILY_REFRESH_ENABLED) {
    const scheduleDailyRefresh = () => {
      const next = nextRunAtHour(SHOPLAZZA_DAILY_REFRESH_HOUR);
      const waitMs = Math.max(5000, next.getTime() - Date.now());
      setTimeout(async () => {
        try {
          const stores = loadShoplazzaStores();
          if (stores.length > 0) {
            const results = await syncAllStoresOrderIndex(stores, { maxPages: SHOPLAZZA_DAILY_REFRESH_MAX_PAGES, pageLimit: SHOPLAZZA_DAILY_REFRESH_PAGE_LIMIT });
            const indexedRows = results.reduce((s, r) => s + r.indexedRows, 0);
            const errStores = results.filter((r) => !!r.error).length;
            agentDebugLog({ hypothesisId: 'H6', location: 'index.ts:daily_refresh', message: 'daily monthly refresh finished', data: { stores: stores.length, indexedRows, errStores, indexWindowDays: getIndexBootstrapDays(), dailyMaxPages: SHOPLAZZA_DAILY_REFRESH_MAX_PAGES } });
          }
        } catch (e: any) { agentDebugLog({ hypothesisId: 'H6', location: 'index.ts:daily_refresh', message: 'daily monthly refresh failed', data: { error: e.message.slice(0, 200) } }); }
        finally { scheduleDailyRefresh(); }
      }, waitMs);
    };
    scheduleDailyRefresh();
  }

  app.listen(PORT, () => {
    console.log(`shoplazza-bridge listening on port ${PORT}`);
    console.info('[bridge] 联系人订单同步: 仅 order_index（不实时请求店匠）；索引由后台 SHOPLAZZA_INDEX_SYNC 任务写入');
    if (process.env.SHOPLAZZA_INDEX_EMAIL_BACKFILL_ON_STARTUP !== 'false') {
      setImmediate(() => {
        try { const n = backfillOrderIndexCustomerEmailFromJson(); if (n > 0) console.info('[bridge] order_index 已回补 customer_email:', n, '行'); }
        catch (e: any) { console.warn('[bridge] customer_email 列回补失败', e.message); }
      });
    }
  });
}

startup();
