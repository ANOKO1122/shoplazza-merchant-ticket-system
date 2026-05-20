import fetch from 'node-fetch';
import { loadConfig, ShoplazzaStoreConfig, buildApiHost } from './config';

let lastFetchAt = 0;
const MIN_INTERVAL_MS = 550;

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const waitMs = lastFetchAt + MIN_INTERVAL_MS - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastFetchAt = Date.now();
}

function shoplazzaFetch(url: string, store: ShoplazzaStoreConfig): Promise<import('node-fetch').Response> {
  const ms = 18000;
  return new Promise(async (resolve, reject) => {
    await waitForRateLimit();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Access-Token': store.accessToken,
        },
        signal: controller.signal as any,
      });
      clearTimeout(timeoutId);
      resolve(res);
    } catch (e) {
      clearTimeout(timeoutId);
      reject(e);
    }
  });
}

function apiStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

export interface ShoplazzaOrderDetail {
  id: string;
  number: string;
  order_number: string;
  financial_status: string;
  status: string;
  payment_method: string;
  fulfillment_status: string;
  currency: string;
  total_price: string;
  sub_total: string;
  total_tax: string;
  total_shipping: string;
  total_discount: string;
  created_at: string;
  updated_at: string;
  placed_at: string;
  processed_at: string;
  cancelled_at: string;
  customer: { email: string; first_name: string; last_name: string; phone: string } | null;
  shipping_address: Record<string, unknown> | null;
  billing_address: Record<string, unknown> | null;
  line_items: Record<string, unknown>[];
  shipping_line: Record<string, unknown> | null;
  payment_line: Record<string, unknown> | null;
  payment_lines: Record<string, unknown>[];
  customer_note: string;
  [key: string]: unknown;
}

export interface ShoplazzaTransaction {
  id: string;
  order_id: string;
  amount: string;
  currency: string;
  kind: string;
  status: string;
  created_at: string;
  payment_detail: {
    card_last_four: string;
    payment_method: string;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

function extractSingleOrder(body: any): ShoplazzaOrderDetail | null {
  if (!body || typeof body !== 'object') return null;
  const tryRec = (v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && ((v as any).id || (v as any).order_number)) {
      return v as ShoplazzaOrderDetail;
    }
    return null;
  };
  return tryRec(body.order) || tryRec(body.data?.order) || tryRec(body.data) || tryRec(body);
}

export async function getOrderByNumber(store: ShoplazzaStoreConfig, orderNumber: string): Promise<ShoplazzaOrderDetail | null> {
  const num = orderNumber.replace(/^#/, '').trim();
  if (!num) return null;
  const url = `https://${buildApiHost(store.subdomain)}/openapi/2025-06/orders/number/${encodeURIComponent(num)}`;
  try {
    const res = await shoplazzaFetch(url, store);
    const text = await res.text();
    if (!res.ok) return null;
    const json = JSON.parse(text);
    const order = json.data?.order || json.order || extractSingleOrder(json);
    return order;
  } catch {
    return null;
  }
}

export async function getOrderDetail(store: ShoplazzaStoreConfig, orderId: string): Promise<ShoplazzaOrderDetail | null> {
  const id = orderId.replace(/^#/, '').trim();
  if (!id) return null;
  const url = `https://${buildApiHost(store.subdomain)}/openapi/2025-06/orders/${encodeURIComponent(id)}`;
  try {
    const res = await shoplazzaFetch(url, store);
    const text = await res.text();
    if (!res.ok) return null;
    const json = JSON.parse(text);
    return extractSingleOrder(json);
  } catch {
    return null;
  }
}

export async function getOrderTransactions(store: ShoplazzaStoreConfig, orderId: string): Promise<ShoplazzaTransaction[]> {
  const id = orderId.replace(/^#/, '').trim();
  if (!id) return [];
  const url = `https://${buildApiHost(store.subdomain)}/openapi/2025-06/orders/${encodeURIComponent(id)}/transactions`;
  try {
    const res = await shoplazzaFetch(url, store);
    const text = await res.text();
    if (!res.ok) return [];
    const json = JSON.parse(text);
    let arr: any[] = [];
    if (Array.isArray(json)) {
      arr = json;
    } else if (Array.isArray(json.transactions)) {
      arr = json.transactions;
    } else if (json.data && Array.isArray(json.data.transactions)) {
      arr = json.data.transactions;
    } else if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
      const d = json.data;
      if (Array.isArray(d.transactions)) arr = d.transactions;
      else if (Array.isArray(d)) arr = d;
    }
    return arr.filter((t: any) => t && typeof t === 'object');
  } catch {
    return [];
  }
}

/**
 * 兜底同步用：按 updated_at 增量拉取已支付订单列表（Cursor 分页）。
 * 每页固定 10 条，自动翻页直到 has_more=false。
 */
export async function listPaidOrdersUpdatedSince(
  store: ShoplazzaStoreConfig,
  updatedAtMin: string,
  updatedAtMax: string,
  onProgress?: (page: number, orders: ShoplazzaOrderDetail[]) => void,
): Promise<ShoplazzaOrderDetail[]> {
  const allOrders: ShoplazzaOrderDetail[] = [];
  let cursor: string | null = null;
  let page = 0;
  const maxPages = 2000; // 安全上限：最多 2000 页 = 20000 条

  while (page < maxPages) {
    const params = new URLSearchParams();
    params.set('financial_status', 'paid');
    params.set('updated_at_min', updatedAtMin);
    params.set('updated_at_max', updatedAtMax);
    if (cursor) params.set('cursor', cursor);

    const url = `https://${buildApiHost(store.subdomain)}/openapi/2025-06/orders?${params.toString()}`;
    page++;

    try {
      const res = await shoplazzaFetch(url, store);
      const text = await res.text();
      if (!res.ok) {
        console.warn(`[shoplazza-client] listPaidOrders page ${page} HTTP ${res.status}: ${text.slice(0, 200)}`);
        break;
      }
      const json = JSON.parse(text);
      const orders: ShoplazzaOrderDetail[] = json.data?.orders || json.orders || [];
      const hasMore: boolean = json.data?.has_more ?? json.has_more ?? false;
      const nextCursor: string | null = json.data?.cursor || json.cursor || null;

      for (const o of orders) {
        allOrders.push(o);
      }

      if (onProgress) onProgress(page, orders);

      if (!hasMore || orders.length === 0) break;
      if (!nextCursor) break;
      cursor = nextCursor;
    } catch (e: any) {
      console.error(`[shoplazza-client] listPaidOrders page ${page} error:`, e.message);
      break;
    }
  }

  return allOrders;
}

// ── Webhook 管理 ──

async function shoplazzaFetchWithBody(
  url: string,
  store: ShoplazzaStoreConfig,
  method: 'POST' | 'DELETE',
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const ms = 15000;
  return new Promise(async (resolve) => {
    await waitForRateLimit();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Access-Token': store.accessToken,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal as any,
      });
      clearTimeout(timeoutId);
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch { data = text; }
      resolve({ ok: res.ok, status: res.status, data });
    } catch (e: any) {
      clearTimeout(timeoutId);
      resolve({ ok: false, status: 0, data: { error: e.message || 'Network error' } });
    }
  });
}

export interface ShoplazzaWebhook {
  id: string;
  address: string;
  topic: string;
  format?: string;
  created_at?: string;
}

export async function registerWebhook(
  store: ShoplazzaStoreConfig,
  address: string,
  topic: string,
): Promise<{ ok: boolean; webhook?: ShoplazzaWebhook; error?: string }> {
  const url = `https://${buildApiHost(store.subdomain)}/openapi/2025-06/webhooks`;
  const body = { webhook: { address, topic, format: 'json' } };

  try {
    const result = await shoplazzaFetchWithBody(url, store, 'POST', body);
    if (result.ok) {
      const wh = result.data?.webhook || result.data?.data?.webhook || result.data;
      return { ok: true, webhook: wh && wh.id ? wh : { id: '', address, topic } };
    }
    // 409/422 可能表示已存在
    if (result.status === 409 || result.status === 422) {
      return { ok: false, error: 'Webhook 可能已存在（冲突）' };
    }
    const errMsg = result.data?.error || result.data?.message || result.data?.errors || `HTTP ${result.status}`;
    return { ok: false, error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg).slice(0, 300) };
  } catch (e: any) {
    return { ok: false, error: e.message || 'Unknown error' };
  }
}

export async function listWebhooks(
  store: ShoplazzaStoreConfig,
): Promise<{ ok: boolean; webhooks: ShoplazzaWebhook[]; error?: string }> {
  const url = `https://${buildApiHost(store.subdomain)}/openapi/2025-06/webhooks?limit=200`;

  try {
    const res = await shoplazzaFetch(url, store);
    const text = await res.text();
    if (!res.ok) {
      let errData: any = null;
      try { errData = JSON.parse(text); } catch { errData = text; }
      const errMsg = errData?.error || errData?.message || `HTTP ${res.status}`;
      return { ok: false, webhooks: [], error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg).slice(0, 200) };
    }
    const json = JSON.parse(text);
    const arr = json.data?.webhooks || json.webhooks || [];
    return {
      ok: true,
      webhooks: Array.isArray(arr) ? arr.map((w: any) => ({
        id: String(w.id || ''),
        address: String(w.address || ''),
        topic: String(w.topic || ''),
        format: w.format || 'json',
        created_at: w.created_at || '',
      })) : [],
    };
  } catch (e: any) {
    return { ok: false, webhooks: [], error: e.message || 'Unknown error' };
  }
}

export async function deleteWebhook(
  store: ShoplazzaStoreConfig,
  webhookId: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = `https://${buildApiHost(store.subdomain)}/openapi/2025-06/webhooks/${encodeURIComponent(webhookId)}`;

  try {
    const result = await shoplazzaFetchWithBody(url, store, 'DELETE');
    if (result.ok || result.status === 404) {
      return { ok: true };
    }
    const errMsg = result.data?.error || result.data?.message || `HTTP ${result.status}`;
    return { ok: false, error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg).slice(0, 200) };
  } catch (e: any) {
    return { ok: false, error: e.message || 'Unknown error' };
  }
}

/** 检查指定 topic 的 webhook 是否已注册，返回匹配的 webhook 对象 */
export async function findWebhookByTopic(
  store: ShoplazzaStoreConfig,
  topic: string,
): Promise<{ registered: boolean; webhook?: ShoplazzaWebhook; error?: string }> {
  const result = await listWebhooks(store);
  if (!result.ok) {
    return { registered: false, error: result.error };
  }
  const found = result.webhooks.find(w => w.topic === topic);
  return { registered: !!found, webhook: found };
}
