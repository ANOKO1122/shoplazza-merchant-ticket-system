/**
 * 店匠 Shoplazza：后台 GET 列表/详情写入 SQLite；联系人侧只读 order_index（无实时店匠请求）。
 * 列表: https://www.shoplazza.dev/reference/order-list-v2025-06
 */
import fetch from 'node-fetch';
import {
  countStores, listStoresFromDb, upsertOrderIndexRows, getLatestIndexedOrdersByEmail,
  getLatestIndexedOrdersByOrderNumber, getLastSyncedUpdatedAt, upsertLastSyncedUpdatedAt,
  deleteOrderIndexOlderThan, getOrderSyncResume, setOrderSyncResume, clearOrderSyncResume,
  backfillOrderIndexCustomerEmailFromJson,
} from './store-db';
import { fillOrderIndexPayload, orderRecordFromIndexRow } from './order-index-schema';

const DEFAULT_API_VERSION = '2025-06';
const DEFAULT_LIMIT = 50;
const DEFAULT_INDEX_SYNC_MAX_PAGES_FALLBACK = 2000;
const DEFAULT_INDEX_SYNC_PAGE_LIMIT = 100;
const SHOPLAZZA_ORDER_ID_RE = /^\d{5,}-[A-Za-z0-9][A-Za-z0-9_-]{2,}$/;
const DEFAULT_LIST_EMAIL_ENRICH_MAX = 6;

let shoplazzaLastFetchAt = 0;
const SHOPLAZZA_MIN_INTERVAL_MS = Math.max(500, Number(process.env.SHOPLAZZA_MIN_REQUEST_INTERVAL_MS) || 550);

async function waitForShoplazzaRateLimit(): Promise<void> {
  const now = Date.now();
  const waitMs = shoplazzaLastFetchAt + SHOPLAZZA_MIN_INTERVAL_MS - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  shoplazzaLastFetchAt = Date.now();
}

function shoplazzaFetchTimeoutMs(): number {
  const n = Number(process.env.SHOPLAZZA_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 3000), 120000) : 18000;
}

async function shoplazzaFetch(url: string, init: RequestInit = {}): Promise<import('node-fetch').Response> {
  await waitForShoplazzaRateLimit();
  const ms = shoplazzaFetchTimeoutMs();
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal } as any);
  } finally {
    clearTimeout(id);
  }
}

function storeLabel(cfg: { subdomain: string; accessToken: string; label?: string }): string {
  return (cfg.label && cfg.label.trim()) || cfg.subdomain;
}

export function normalizeShoplazzaSubdomain(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '');
  const host = s.split('/')[0]?.trim() ?? s;
  const lower = host.toLowerCase();
  const suffix = '.myshoplaza.com';
  if (lower.endsWith(suffix)) {
    return host.slice(0, host.length - suffix.length).trim();
  }
  return host.trim();
}

export function loadShoplazzaStoresFromEnv(): Array<{ subdomain: string; accessToken: string; label?: string }> {
  const rawJson = process.env.SHOPLAZZA_STORES_JSON?.trim();
  if (rawJson) {
    let parsed: unknown;
    try { parsed = JSON.parse(rawJson); } catch { throw new Error('SHOPLAZZA_STORES_JSON 不是合法 JSON'); }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('SHOPLAZZA_STORES_JSON 必须为非空数组');
    }
    const out: Array<{ subdomain: string; accessToken: string; label?: string }> = [];
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i] as any;
      const subdomain = String(item.subdomain ?? '').trim();
      const accessToken = String(item.accessToken ?? item.access_token ?? '').trim();
      if (!subdomain || !accessToken) {
        throw new Error(`SHOPLAZZA_STORES_JSON[${i}] 缺少 subdomain 或 accessToken`);
      }
      const normSub = normalizeShoplazzaSubdomain(subdomain);
      if (!normSub) throw new Error(`SHOPLAZZA_STORES_JSON[${i}] subdomain 无效`);
      const label = item.label != null ? String(item.label).trim() : undefined;
      out.push({ subdomain: normSub, accessToken, label: label || undefined });
    }
    return out;
  }
  const rawSub = process.env.SHOPLAZZA_SUBDOMAIN?.trim() ?? '';
  const accessToken = process.env.SHOPLAZZA_ACCESS_TOKEN?.trim() ?? '';
  const subdomain = normalizeShoplazzaSubdomain(rawSub);
  if (subdomain && accessToken) {
    return [{ subdomain, accessToken, label: subdomain }];
  }
  return [];
}

export function loadShoplazzaStores(): Array<{ subdomain: string; accessToken: string; label?: string }> {
  try {
    if (countStores() > 0) {
      return listStoresFromDb();
    }
  } catch (e: any) {
    console.warn('[shoplazza] store DB unavailable, using env:', e.message);
  }
  return loadShoplazzaStoresFromEnv();
}

function extractOrderEmail(order: any): string {
  const norm = (v: unknown): string => {
    if (typeof v !== 'string') return '';
    const t = v.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : '';
  };
  const tryKeys = (obj: any, keys: string[]): string => {
    if (!obj || typeof obj !== 'object') return '';
    for (const k of keys) {
      const e = norm(obj[k]);
      if (e) return e;
    }
    return '';
  };
  const parseMaybeObject = (v: unknown): any => {
    if (v && typeof v === 'object') return v;
    if (typeof v === 'string') {
      const t = v.trim();
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { const p = JSON.parse(t); if (p && typeof p === 'object') return p; } catch (_) {}
      }
    }
    return null;
  };
  const top = tryKeys(order, ['email', 'customer_email', 'contact_email', 'buyer_email', 'email_address', 'receiver_email']);
  if (top) return top;
  const customer = parseMaybeObject(order.customer);
  const fromCustomer = tryKeys(customer, ['email', 'customer_email', 'contact_email', 'buyer_email']);
  if (fromCustomer) return fromCustomer;
  const contact = parseMaybeObject(order.contact);
  const fromContact = tryKeys(contact, ['email', 'contact_email', 'customer_email']);
  if (fromContact) return fromContact;
  for (const key of ['billing_address', 'shipping_address']) {
    const addr = parseMaybeObject(order[key]);
    const e = tryKeys(addr, ['email', 'contact_email', 'customer_email']);
    if (e) return e;
  }
  return '';
}

function appendOrderListPageSize(params: URLSearchParams, limit: number): void {
  const n = String(Math.max(1, Math.min(250, limit)));
  params.set('page_size', n);
  params.set('limit', n);
}

async function fetchOrderRecordByIdOnly(cfg: { subdomain: string; accessToken: string }, orderIdRaw: string, apiVersion: string): Promise<any | null> {
  const id = orderIdRaw.replace(/^[#]+/, '').trim();
  if (!id || !SHOPLAZZA_ORDER_ID_RE.test(id)) return null;
  const enc = encodeURIComponent(id);
  const detailUrl = `https://${cfg.subdomain}.myshoplaza.com/openapi/${apiVersion}/orders/${enc}`;
  let res;
  try {
    res = await shoplazzaFetch(detailUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'Access-Token': cfg.accessToken },
    });
  } catch { return null; }
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : {}; } catch { return null; }
  if (!res.ok) return null;
  const one = extractSingleOrderFromJson(json);
  return one ?? null;
}

function buildOrderDetailIdCandidates(o: any): string[] {
  const id = apiStr(o.id).replace(/^#/, '').trim().replace(/\s+/g, '');
  if (!id || !SHOPLAZZA_ORDER_ID_RE.test(id)) return [];
  return [id];
}

function extractOrdersArray(body: unknown): any[] {
  if (Array.isArray(body)) return body.filter((x) => x !== null && typeof x === 'object');
  if (body !== null && typeof body === 'object') {
    const o = body as any;
    if (Array.isArray(o.orders)) return o.orders.filter((x: any) => x !== null && typeof x === 'object');
    if (Array.isArray(o.data)) return o.data.filter((x: any) => x !== null && typeof x === 'object');
    const data = o.data;
    if (data !== null && typeof data === 'object' && Array.isArray(data.orders)) {
      return data.orders.filter((x: any) => x !== null && typeof x === 'object');
    }
  }
  return [];
}

function truthyHasMore(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function extractListCursorState(json: any): { cursor: string; hasMore: boolean } {
  if (json === null || typeof json !== 'object') return { cursor: '', hasMore: false };
  const root = json;
  const data = root.data;
  if (data !== null && typeof data === 'object') {
    const d = data;
    const cursor = typeof d.cursor === 'string' && d.cursor.trim() ? d.cursor.trim() : '';
    const hasMore = truthyHasMore(d.has_more);
    return { cursor, hasMore };
  }
  const c = typeof root.cursor === 'string' && root.cursor.trim() ? root.cursor.trim() : '';
  const hasMore = truthyHasMore(root.has_more);
  return { cursor: c, hasMore };
}

function apiStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

export function extractSortTimestamp(order: Record<string, unknown>): string {
  for (const k of ['processed_at', 'created_at', 'updated_at', 'placed_at']) {
    const v = order[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

const TRACKING_HARVEST_KEYS = [
  'logistics_code', 'tracking_number', 'tracking_numbers', 'track_numbers',
  'tracking_no', 'trackingNumber', 'waybill_no', 'express_no', 'express_number',
];

function harvestTrackingValues(v: unknown, sink: Set<string>, depth: number): void {
  if (depth > 12 || v === null || v === undefined) return;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return;
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try { const parsed = JSON.parse(t); harvestTrackingValues(parsed, sink, depth + 1); return; } catch (_) {}
    }
    sink.add(t);
    return;
  }
  if (typeof v === 'number' && Number.isFinite(v)) { sink.add(String(v)); return; }
  if (Array.isArray(v)) { for (const x of v) harvestTrackingValues(x, sink, depth + 1); return; }
  if (typeof v === 'object') {
    const o = v as any;
    for (const k of TRACKING_HARVEST_KEYS) {
      if (o[k] !== undefined) harvestTrackingValues(o[k], sink, depth + 1);
    }
  }
}

export function extractTrackingNumbersDisplay(order: any): string {
  const sink = new Set<string>();
  harvestTrackingValues(order.logistics_code, sink, 0);
  harvestTrackingValues(order.tracking_number, sink, 0);
  harvestTrackingValues(order.track_number, sink, 0);
  harvestTrackingValues(order.track_numbers, sink, 0);
  const ful = order.fulfillments;
  if (Array.isArray(ful)) { for (const f of ful) harvestTrackingValues(f, sink, 0); }
  else { harvestTrackingValues(ful, sink, 0); }
  const lines = order.shipping_lines;
  if (Array.isArray(lines)) { for (const line of lines) harvestTrackingValues(line, sink, 0); }
  else { harvestTrackingValues(lines, sink, 0); }
  harvestTrackingValues(order.shipping_line, sink, 0);
  return [...sink].join(', ');
}

export function normalizedOrderFromApi(order: any, shopLabel: string, subdomain: string): {
  sortTimestamp: string; shopLabel: string; subdomain: string;
  id: string; name: string; order_number: string; email: string;
  created_at: string; updated_at: string; processed_at: string; cancelled_at: string;
  total_price: string; sub_total: string; total_tax: string; total_shipping: string;
  total_discount: string; currency: string; financial_status: string;
  fulfillment_status: string; payment_method: string; customer_note: string;
  tracking_numbers: string;
} {
  const totalPrice = apiStr(order.total_price) || apiStr(order.current_total_price) || apiStr(order.subtotal_price);
  const orderEmail = extractOrderEmail(order);
  const displayOrderNumber = apiStr(order.order_number) || apiStr(order.number) || apiStr(order.name) || apiStr(order.id);
  return {
    sortTimestamp: extractSortTimestamp(order),
    shopLabel,
    subdomain,
    id: apiStr(order.id),
    name: apiStr(order.name) || apiStr(order.number),
    order_number: displayOrderNumber,
    email: orderEmail,
    created_at: apiStr(order.created_at),
    updated_at: apiStr(order.updated_at),
    processed_at: apiStr(order.processed_at),
    cancelled_at: apiStr(order.cancelled_at),
    total_price: totalPrice,
    sub_total: apiStr(order.sub_total),
    total_tax: apiStr(order.total_tax),
    total_shipping: apiStr(order.total_shipping),
    total_discount: apiStr(order.total_discount),
    currency: apiStr(order.currency),
    financial_status: apiStr(order.financial_status),
    fulfillment_status: apiStr(order.fulfillment_status),
    payment_method: (() => {
      const pm = order.payment_method;
      if (pm === null || pm === undefined) return '';
      if (typeof pm === 'string') return pm.trim();
      if (typeof pm === 'number' || typeof pm === 'boolean') return String(pm);
      if (typeof pm === 'object') { try { return JSON.stringify(pm); } catch { return ''; } }
      return '';
    })(),
    customer_note: apiStr(order.customer_note),
    tracking_numbers: extractTrackingNumbersDisplay(order),
  };
}

function buildOrderIndexRowFromApiOrder(cfg: { subdomain: string; accessToken: string }, order: any, normalized: ReturnType<typeof normalizedOrderFromApi>): any {
  const shortNo = apiStr(order.order_number) || apiStr(order.number);
  return {
    store_subdomain: cfg.subdomain,
    order_id: normalized.id,
    order_number_full: normalized.order_number,
    order_number_short: shortNo,
    customer_email: normalized.email,
    created_at: normalized.created_at,
    updated_at: normalized.updated_at,
    processed_at: normalized.processed_at,
    raw_summary_json: '',
    ...fillOrderIndexPayload(order),
  };
}

function looksLikeEmailToken(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(s);
}

function parseEmailTokenFromPart(p: string): string | null {
  const t = p.trim();
  if (!t) return null;
  let s = t.replace(/^mailto:/i, '').trim();
  const angle = /<([^>]+@[^>]+)>/.exec(s);
  if (angle) s = angle[1].trim();
  if (looksLikeEmailToken(s)) return s.toLowerCase();
  return null;
}

export function normalizeContactEmailForLookup(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  return parseEmailTokenFromPart(raw) ?? '';
}

export function contactEmailForOrderLookup(contact: { email?: string | null; identifier?: string | null; additional_attributes?: any }): string {
  const fromEmail = normalizeContactEmailForLookup(contact.email ?? '');
  if (fromEmail) return fromEmail;
  const fromIdentifier = normalizeContactEmailForLookup(typeof contact.identifier === 'string' ? contact.identifier : '');
  if (fromIdentifier) return fromIdentifier;
  const extra = contact.additional_attributes;
  if (extra !== null && typeof extra === 'object') {
    const nested = extra.email;
    if (typeof nested === 'string') {
      const fromExtra = normalizeContactEmailForLookup(nested);
      if (fromExtra) return fromExtra;
    }
  }
  return '';
}

function uniquePreserveCaseInsensitive(strings: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of strings) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export function parseShoplazzaOrderLookup(raw: unknown): { orderNumbers: string[]; emails: string[] } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { orderNumbers: [], emails: [] };
  }
  const parts = raw
    .split(/[\s,，;；、\n\r|]+/)
    .map((p) => p.replace(/^[#]+/, '').trim())
    .filter(Boolean);
  const orderNumbers: string[] = [];
  const emails: string[] = [];
  for (const p of parts) {
    const em = parseEmailTokenFromPart(p);
    if (em) { emails.push(em); }
    else if (p) { orderNumbers.push(p); }
  }
  return {
    orderNumbers: uniquePreserveCaseInsensitive(orderNumbers),
    emails: uniquePreserveCaseInsensitive(emails),
  };
}

function extractSingleOrderFromJson(body: any): any | null {
  if (body === null || typeof body !== 'object') return null;
  const o = body;
  const tryRec = (v: unknown): any | null => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as any;
      if (rec.id !== undefined || rec.order_number !== undefined || rec.name !== undefined) return rec;
    }
    return null;
  };
  const a = tryRec(o.order); if (a) return a;
  const dataObj = o.data;
  if (dataObj && typeof dataObj === 'object' && !Array.isArray(dataObj)) {
    const dOrder = tryRec(dataObj.order); if (dOrder) return dOrder;
  }
  const b = tryRec(o.data); if (b) return b;
  const c = tryRec(o); if (c) return c;
  return null;
}

function sortOrdersDesc(orders: Array<{ sortTimestamp: string }>): void {
  orders.sort((a, b) => b.sortTimestamp.localeCompare(a.sortTimestamp));
}

function isoDaysBack(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - Math.max(1, Math.min(daysBack, 3650)));
  return d.toISOString();
}

export function getIndexEmailLookupWindowDays(): number {
  const w = process.env.SHOPLAZZA_INDEX_EMAIL_LOOKUP_WINDOW_DAYS?.trim();
  if (w !== undefined && w !== '') {
    const n = Number(w);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, 3650);
  }
  const legacy = Number(process.env.SHOPLAZZA_DAYS_BACK);
  if (Number.isFinite(legacy) && legacy > 0) return Math.min(legacy, 3650);
  return 180;
}

export function getIndexEmailLookupMaxRows(): number {
  const raw = process.env.SHOPLAZZA_INDEX_LOOKUP_LIMIT;
  if (raw === undefined || raw === '') return 5000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 5000;
  if (n === 0) return 10000;
  return Math.min(Math.max(n, 1), 10000);
}

export function expandEmailLookupVariants(email: string): string[] {
  const e = normalizeContactEmailForLookup(email) || email.trim().toLowerCase();
  if (!e) return [];
  if (process.env.SHOPLAZZA_GMAIL_DOTLESS_LOOKUP === 'false') return [e];
  const m = /^([^@]+)@(gmail\.com|googlemail\.com)$/i.exec(e);
  if (!m) return [e];
  const localNoDots = m[1].replace(/\./g, '');
  const domain = m[2].toLowerCase();
  const alt = `${localNoDots}@${domain}`;
  return alt === e ? [e] : [e, alt];
}

export function extractShoplazzaOrderNumberHintsFromText(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  const re = /\b(\d{5,}-[A-Za-z0-9][A-Za-z0-9_-]{2,})\b/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = m[1].trim();
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export function dedupeNormalizedOrdersByStoreAndId(orders: Array<{ id?: string; subdomain: string; sortTimestamp: string; [key: string]: unknown }>): any[] {
  const m = new Map<string, any>();
  for (const o of orders) {
    const id = (o.id || '').trim();
    if (!id) continue;
    const k = `${o.subdomain}:${id}`;
    if (!m.has(k)) m.set(k, o);
  }
  const arr = [...m.values()];
  sortOrdersDesc(arr);
  return arr;
}

export function getIndexBootstrapDays(): number {
  const b = process.env.SHOPLAZZA_INDEX_BOOTSTRAP_DAYS?.trim();
  if (b !== undefined && b !== '') {
    const n = Number(b);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.max(1, n), 3650);
  }
  const legacy = Number(process.env.SHOPLAZZA_DAYS_BACK);
  if (Number.isFinite(legacy) && legacy > 0) return Math.min(legacy, 3650);
  return 180;
}

function resolveIndexSyncMaxPages(options?: { maxPages?: number }): number {
  if (options?.maxPages !== undefined) {
    const n = options.maxPages;
    if (!Number.isFinite(n) || n < 0) return DEFAULT_INDEX_SYNC_MAX_PAGES_FALLBACK;
    if (n === 0) return 10000;
    return Math.min(Math.max(1, n), 10000);
  }
  const raw = process.env.SHOPLAZZA_INDEX_SYNC_MAX_PAGES;
  if (raw === undefined || raw === '') return DEFAULT_INDEX_SYNC_MAX_PAGES_FALLBACK;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_INDEX_SYNC_MAX_PAGES_FALLBACK;
  if (n === 0) return 10000;
  return Math.min(Math.max(1, n), 10000);
}

function isoSubtractCalendarDays(iso: string, days: number): string {
  const d = new Date((iso || '').trim());
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() - Math.max(0, Math.min(days, 365)));
  return d.toISOString();
}

function parseTopLevelError(json: any, fallbackText: string): string {
  if (typeof json === 'object' && json !== null && 'error' in json) {
    return String((json as any).error ?? fallbackText);
  }
  return fallbackText.slice(0, 200);
}

export async function syncStoreOrdersToIndex(cfg: { subdomain: string; accessToken: string; label?: string }, options?: { maxPages?: number; pageLimit?: number; bootstrapDays?: number }): Promise<{
  store: string; indexedRows: number; pagesFetched: number; cursorUpdatedTo: string | null; error?: string;
}> {
  const apiVersion = process.env.SHOPLAZZA_API_VERSION?.trim() || DEFAULT_API_VERSION;
  const label = storeLabel(cfg);
  const pageLimit = options?.pageLimit || Number(process.env.SHOPLAZZA_INDEX_SYNC_PAGE_LIMIT) || DEFAULT_INDEX_SYNC_PAGE_LIMIT;
  const maxPages = resolveIndexSyncMaxPages(options);
  const bootstrapDays = options?.bootstrapDays ?? getIndexBootstrapDays();
  const windowStart = isoDaysBack(bootstrapDays);
  const storedCursor = getLastSyncedUpdatedAt(cfg.subdomain);
  const trimmed = storedCursor?.trim() ?? '';
  const overlapDays = Math.max(0, Math.min(120, Number(process.env.SHOPLAZZA_INDEX_UPDATED_AT_OVERLAP_DAYS) || 30));
  const listUpdatedAtMin = trimmed && trimmed.localeCompare(windowStart) >= 0
    ? (() => { const withOverlap = isoSubtractCalendarDays(trimmed, overlapDays); return withOverlap.localeCompare(windowStart) < 0 ? windowStart : withOverlap; })()
    : windowStart;
  let pagesFetched = 0;
  let indexedRows = 0;
  let maxSeenUpdatedAt = '';
  const base = `https://${cfg.subdomain}.myshoplaza.com/openapi/${apiVersion}/orders`;
  let listCursor = '';
  const resume = getOrderSyncResume(cfg.subdomain);
  if (resume?.resume_updated_at_min && resume.resume_updated_at_min === listUpdatedAtMin && (resume.resume_list_cursor ?? '').trim()) {
    listCursor = resume.resume_list_cursor!.trim();
  }
  let lastHasMore = false;
  let lastListCursor = '';
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({ updated_at_min: listUpdatedAtMin });
    appendOrderListPageSize(params, pageLimit);
    if (listCursor) params.set('cursor', listCursor);
    const url = `${base}?${params.toString()}`;
    let res;
    try {
      res = await shoplazzaFetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'Access-Token': cfg.accessToken },
      });
    } catch (e: any) {
      return { store: label, indexedRows, pagesFetched, cursorUpdatedTo: maxSeenUpdatedAt || null, error: `${label}: 索引同步网络错误 ${e.message}` };
    }
    pagesFetched += 1;
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : {}; } catch {
      return { store: label, indexedRows, pagesFetched, cursorUpdatedTo: maxSeenUpdatedAt || null, error: `${label}: 索引同步响应非 JSON (${res.status})` };
    }
    if (!res.ok) {
      if (res.status === 429 && listCursor) {
        setOrderSyncResume(cfg.subdomain, listUpdatedAtMin, String(listCursor));
        console.warn(`[shoplazza] index sync HTTP 429 for ${label}; resume cursor saved for next run`);
      }
      return { store: label, indexedRows, pagesFetched, cursorUpdatedTo: maxSeenUpdatedAt || null, error: `${label}: 索引同步 HTTP ${res.status} ${parseTopLevelError(json, text)}` };
    }
    const orders = extractOrdersArray(json);
    if (orders.length === 0) break;
    const indexEnrichEmail = process.env.SHOPLAZZA_INDEX_ENRICH_EMAIL !== 'false';
    const rows: any[] = [];
    const enrichMax = Math.max(1, Math.min(12, Number(process.env.SHOPLAZZA_INDEX_ENRICH_MAX_ATTEMPTS) || 6));
    for (const o of orders) {
      let src = o;
      if (indexEnrichEmail && !extractOrderEmail(src)) {
        const candidates = buildOrderDetailIdCandidates(src);
        let attempt = 0;
        for (const tok of candidates) {
          if (attempt >= enrichMax) break;
          attempt += 1;
          const full = await fetchOrderRecordByIdOnly(cfg, tok, apiVersion);
          if (full) { src = full; if (extractOrderEmail(full)) break; }
        }
      }
      const normalized = normalizedOrderFromApi(src, label, cfg.subdomain);
      const updatedAt = normalized.updated_at || normalized.created_at || normalized.processed_at || '';
      if (updatedAt && (!maxSeenUpdatedAt || updatedAt > maxSeenUpdatedAt)) { maxSeenUpdatedAt = updatedAt; }
      rows.push(buildOrderIndexRowFromApiOrder(cfg, src, normalized));
    }
    indexedRows += upsertOrderIndexRows(rows);
    const { cursor: nextIdxCur, hasMore } = extractListCursorState(json);
    listCursor = nextIdxCur;
    lastHasMore = hasMore;
    lastListCursor = listCursor;
    if (!hasMore || !listCursor) break;
  }
  const prunedRows = deleteOrderIndexOlderThan(cfg.subdomain, windowStart);
  if (prunedRows > 0) { console.info(`[shoplazza] order_index pruned ${prunedRows} rows older than window (${bootstrapDays}d) for ${label}`); }
  const truncated = pagesFetched >= maxPages && lastHasMore && !!(lastListCursor && String(lastListCursor).trim());
  let cursorUpdatedReport: string | null = null;
  if (truncated) {
    setOrderSyncResume(cfg.subdomain, listUpdatedAtMin, String(lastListCursor));
    console.warn(`[shoplazza] index sync hit maxPages=${maxPages} with more data pending for ${label}; list cursor saved for resume`);
    cursorUpdatedReport = maxSeenUpdatedAt || null;
  } else {
    clearOrderSyncResume(cfg.subdomain);
    const useJobEndWatermark = process.env.SHOPLAZZA_INDEX_WATERMARK_USE_JOB_END === 'true' || process.env.SHOPLAZZA_INDEX_WATERMARK_MODE === 'job_end';
    const watermark = useJobEndWatermark ? new Date().toISOString() : maxSeenUpdatedAt;
    if (watermark) { upsertLastSyncedUpdatedAt(cfg.subdomain, watermark); cursorUpdatedReport = watermark; }
  }
  return { store: label, indexedRows, pagesFetched, cursorUpdatedTo: cursorUpdatedReport };
}

export async function syncAllStoresOrderIndex(
  stores: Array<{ subdomain: string; accessToken: string; label?: string }>,
  options?: { maxPages?: number; pageLimit?: number; bootstrapDays?: number },
): Promise<Array<{ store: string; indexedRows: number; pagesFetched: number; cursorUpdatedTo: string | null; error?: string }>> {
  const batch = Math.max(1, Math.min(8, Number(process.env.SHOPLAZZA_INDEX_SYNC_STORE_CONCURRENCY) || 3));
  const settled: PromiseSettledResult<any>[] = [];
  for (let i = 0; i < stores.length; i += batch) {
    const chunk = stores.slice(i, i + batch);
    const part = await Promise.allSettled(chunk.map((s) => syncStoreOrdersToIndex(s, options)));
    settled.push(...part);
  }
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      store: storeLabel(stores[i]),
      indexedRows: 0, pagesFetched: 0, cursorUpdatedTo: null,
      error: String((r.reason as any)?.message ?? r.reason),
    };
  });
}

function indexRowsToNormalizedOrders(rows: any[]): any[] {
  const out: any[] = [];
  for (const row of rows) {
    const raw = orderRecordFromIndexRow(row);
    if (!raw) continue;
    try {
      const sortFromRow = (row.processed_at && String(row.processed_at).trim()) ||
        (row.created_at && String(row.created_at).trim()) ||
        (row.updated_at && String(row.updated_at).trim()) || '';
      const n = normalizedOrderFromApi(raw, row.store_subdomain, row.store_subdomain);
      out.push({ ...n, sortTimestamp: extractSortTimestamp(raw) || sortFromRow || n.sortTimestamp });
    } catch (_) {}
  }
  return out;
}

export function findOrdersByEmailFromIndex(email: string, limit: number = getIndexEmailLookupMaxRows()): any[] {
  const windowDays = getIndexEmailLookupWindowDays();
  const minIso = windowDays === 0 ? null : isoDaysBack(windowDays);
  const variants = expandEmailLookupVariants(email);
  const perVariantLimit = Math.max(1, Math.ceil(limit / Math.max(1, variants.length)));
  const byKey = new Map<string, any>();
  for (const em of variants) {
    const rows = getLatestIndexedOrdersByEmail(em, perVariantLimit, minIso);
    for (const o of indexRowsToNormalizedOrders(rows)) {
      const k = `${o.subdomain}:${o.id}`;
      if (!o.id.trim()) continue;
      if (!byKey.has(k)) byKey.set(k, o);
    }
  }
  const merged = [...byKey.values()];
  sortOrdersDesc(merged);
  return merged.slice(0, limit);
}

export function findOrdersByOrderNumberFromIndex(orderNumberRaw: string, limit: number = getIndexEmailLookupMaxRows()): any[] {
  const rows = getLatestIndexedOrdersByOrderNumber(orderNumberRaw, limit);
  const out = indexRowsToNormalizedOrders(rows);
  sortOrdersDesc(out);
  return out;
}
