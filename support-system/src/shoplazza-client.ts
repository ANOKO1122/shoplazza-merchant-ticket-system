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

function shoplazzaFetch(url: string, store: ShoplazzaStoreConfig, bodyTimeoutMs = 18000): Promise<import('node-fetch').Response> {
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
        timeout: bodyTimeoutMs,
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

/** Address writes must fail closed and never expose provider bodies or credentials in errors. */
export class ShoplazzaAddressApiError extends Error {
  constructor(public readonly code: string, public readonly httpStatus = 0) {
    super(httpStatus ? `Shoplazza address API HTTP ${httpStatus}` : 'Shoplazza address API request failed');
    this.name = 'ShoplazzaAddressApiError';
  }
}

async function addressApiRequest(
  store: ShoplazzaStoreConfig, endpoint: string, method: 'GET' | 'PUT', body?: unknown,
): Promise<any> {
  await waitForRateLimit();
  const controller = new AbortController();
  // Keep the deadline alive while consuming the body, including successful PUT responses.
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(`https://${buildApiHost(store.subdomain)}/openapi/2025-06/${endpoint}`, {
      method,
      headers: { 'Access-Token': store.accessToken, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal as any,
      timeout: 18000,
      size: 5 * 1024 * 1024,
    });
    if (!response.ok) {
      (response.body as any)?.destroy?.();
      throw new ShoplazzaAddressApiError('http_error', response.status);
    }
    const json = JSON.parse(await response.text());
    if (!json || typeof json !== 'object' || Array.isArray(json)
      || (json.code !== undefined && json.code !== 'Success')) {
      throw new ShoplazzaAddressApiError('invalid_response');
    }
    return json;
  } catch (error) {
    if (error instanceof ShoplazzaAddressApiError) throw error;
    throw new ShoplazzaAddressApiError('request_failed');
  } finally {
    clearTimeout(timeout);
  }
}

export async function getOrderForAddressUpdate(store: ShoplazzaStoreConfig, orderId: string): Promise<ShoplazzaOrderDetail> {
  const json = await addressApiRequest(store, `orders/${encodeURIComponent(orderId)}`, 'GET');
  const order = extractSingleOrder(json);
  if (!order || String(order.id) !== orderId || !order.shipping_address
    || typeof order.shipping_address !== 'object' || Array.isArray(order.shipping_address)) {
    throw new ShoplazzaAddressApiError('invalid_order');
  }
  return order;
}

/** Status webhooks fetch the current order; errors must remain retryable, never look like deletion. */
export async function getOrderForStatusUpdate(store: ShoplazzaStoreConfig, orderId: string): Promise<ShoplazzaOrderDetail> {
  const json = await addressApiRequest(store, `orders/${encodeURIComponent(orderId)}`, 'GET');
  const order = extractSingleOrder(json);
  if (!order || String(order.id) !== orderId
    || typeof order.updated_at !== 'string' || !order.updated_at.trim() || !Number.isFinite(Date.parse(order.updated_at))
    || !['status', 'financial_status', 'fulfillment_status'].every(key => typeof order[key] === 'string' && String(order[key]).trim())) {
    throw new ShoplazzaAddressApiError('invalid_order');
  }
  return order;
}

export async function getOrderAddressAccessScopes(store: ShoplazzaStoreConfig): Promise<string[]> {
  const json = await addressApiRequest(store, 'oauth/access_scopes', 'GET');
  const scopes: unknown = json.data?.access_scopes ?? json.access_scopes;
  if (!Array.isArray(scopes) || scopes.some(scope => !scope || typeof scope.handle !== 'string')) {
    throw new ShoplazzaAddressApiError('invalid_scopes');
  }
  return scopes.map(scope => scope.handle);
}

/** Callers must preserve the current email; only the shipping-address object is sent. No retries. */
export async function putOrderShippingAddress(
  store: ShoplazzaStoreConfig, orderId: string, address: Record<string, string>,
): Promise<void> {
  const fields = ['first_name', 'last_name', 'phone', 'country', 'country_code', 'province', 'province_code',
    'area', 'city', 'address', 'address1', 'company', 'zip', 'phone_area_code', 'email'];
  if (Object.keys(address).some(key => !fields.includes(key) || typeof address[key] !== 'string')) {
    throw new ShoplazzaAddressApiError('invalid_address');
  }
  await addressApiRequest(store, `orders/${encodeURIComponent(orderId)}`, 'PUT', { order: { shipping_address: address } });
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
    if (!res.ok) {
      console.warn(`[shoplazza-client] getOrderTransactions HTTP ${res.status}: ${text.slice(0, 300)}`);
      return [];
    }
    const json = JSON.parse(text);
    let arr: any[] = [];

    // 兼容多种 API 响应格式：
    // 1. 直接返回数组
    // 2. { transactions: [...] }
    // 3. { data: { transactions: [...] } }
    // 4. { data: [...] }  （常见于新版 API）
    // 5. { data: { transaction: {...} } } 单条
    if (Array.isArray(json)) {
      arr = json;
    } else if (Array.isArray(json.transactions)) {
      arr = json.transactions;
    } else if (json.data && Array.isArray(json.data)) {
      arr = json.data;
    } else if (json.data && Array.isArray(json.data.transactions)) {
      arr = json.data.transactions;
    } else if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
      const d = json.data;
      if (Array.isArray(d.transactions)) arr = d.transactions;
      else if (d.transaction) arr = [d.transaction];
    } else if (json.transaction) {
      arr = [json.transaction];
    }

    const result = arr.filter((t: any) => t && typeof t === 'object');
    if (result.length === 0) {
      console.warn(`[shoplazza-client] getOrderTransactions parsed 0 items, raw response keys: ${Object.keys(json).join(', ')}, has data: ${!!json.data}, data type: ${json.data ? (Array.isArray(json.data) ? 'array' : typeof json.data) : 'N/A'}`);
    }
    return result;
  } catch (e: any) {
    console.warn(`[shoplazza-client] getOrderTransactions error for ${id}: ${e.message}`);
    return [];
  }
}

/**
 * 兜底同步用：按 created_at（下单时间）增量拉取已支付订单列表（Cursor 分页）。
 * 用 created_at 而非 updated_at，避免把"很久前支付、最近才发货"的旧订单重复拉取。
 * 每页固定 10 条，自动翻页直到 has_more=false。
 */
export async function listPaidOrdersCreatedSince(
  store: ShoplazzaStoreConfig,
  createdAtMin: string,
  createdAtMax: string,
  onProgress?: (page: number, orders: ShoplazzaOrderDetail[]) => void,
): Promise<ShoplazzaOrderDetail[]> {
  const allOrders: ShoplazzaOrderDetail[] = [];
  let cursor: string | null = null;
  let page = 0;
  const maxPages = 2000; // 安全上限：最多 2000 页 = 20000 条

  while (page < maxPages) {
    const params = new URLSearchParams();
    params.set('financial_status', 'paid');
    params.set('created_at_min', createdAtMin);
    params.set('created_at_max', createdAtMax);
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

/**
 * 未支付兜底：按 updated_at 拉取仍在 waiting 的订单。
 * 任一页失败或超过页数上限时抛错，调用方不得推进未支付进度。
 */
export async function listWaitingOrdersUpdatedSince(
  store: ShoplazzaStoreConfig,
  updatedAtMin: string,
  updatedAtMax: string,
): Promise<ShoplazzaOrderDetail[]> {
  const allOrders: ShoplazzaOrderDetail[] = [];
  let cursor: string | null = null;
  let page = 0;
  const maxPages = 200;
  const seenCursors = new Set<string>();

  while (page < maxPages) {
    const params = new URLSearchParams();
    params.set('financial_status', 'waiting');
    params.set('page_size', '250');
    params.set('updated_at_min', updatedAtMin);
    params.set('updated_at_max', updatedAtMax);
    if (cursor) params.set('cursor', cursor);

    const url = `https://${buildApiHost(store.subdomain)}/openapi/2025-06/orders?${params.toString()}`;
    page++;
    const res = await shoplazzaFetch(url, store);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`waiting list HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text);
    let orders: ShoplazzaOrderDetail[] = json.data?.orders ?? json.orders;
    // 店匠空窗口实测返回 { code: 'Success', data: {} }，只兼容这个明确成功的空对象。
    if (orders === undefined && json.code === 'Success'
      && json.data && typeof json.data === 'object' && !Array.isArray(json.data)
      && Object.keys(json.data).length === 0) {
      orders = [];
    }
    if (!Array.isArray(orders)) {
      throw new Error('waiting list response has no orders array');
    }
    const hasMore: boolean = json.data?.has_more ?? json.has_more ?? false;
    const nextCursor: string | null = json.data?.cursor || json.cursor || null;
    allOrders.push(...orders);
    if (!hasMore) return allOrders;
    if (orders.length === 0) {
      throw new Error('waiting list has more pages but returned an empty page');
    }
    if (!nextCursor) {
      throw new Error('waiting list has more pages but no cursor');
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error('waiting list returned a repeated cursor');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw Object.assign(new Error('waiting list exceeded 200 pages'), { code: 'WAITING_WINDOW_TOO_LARGE' });
}

// ── Webhook 管理 ──

async function shoplazzaFetchWithBody(
  url: string,
  store: ShoplazzaStoreConfig,
  method: 'POST' | 'DELETE' | 'PUT',
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const ms = 15000;
  return new Promise(async (resolve) => {
    await waitForRateLimit();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ms);
    try {
      const hasBody = body !== undefined && body !== null;
      const headers: Record<string, string> = {
        'Access-Token': store.accessToken,
      };
      if (hasBody) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(body) : undefined,
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

/** 支付、物流及已有订单的后续状态变化。 */
export const STORE_WEBHOOK_TOPICS = [
  'orders/paid',
  'orders/fulfilled',
  'orders/partially_fulfilled',
  'fulfillments/create',
  'fulfillments/update',
  'orders/partially_refunded',
  'orders/refunded',
  'orders/cancelled',
  'orders/finished',
] as const;

/** 以前注册过、现在要删掉的事件。 */
export const RETIRED_WEBHOOK_TOPICS = ['orders/create', 'orders/update'] as const;

export async function registerWebhook(
  store: ShoplazzaStoreConfig,
  address: string,
  topic: string,
): Promise<{ ok: boolean; webhook?: ShoplazzaWebhook; error?: string }> {
  const url = `https://${buildApiHost(store.subdomain)}/openapi/2025-06/webhooks`;
  const body = { webhook: { address, topic } };

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
    return { ok: false, error: `注册 Webhook 失败: HTTP ${result.status}` };
  } catch (e: any) {
    return { ok: false, error: '注册 Webhook 失败' };
  }
}

/** 修改已有订阅的接收地址，保留 topic 和订阅 ID。 */
export async function updateWebhookAddress(
  store: ShoplazzaStoreConfig,
  webhookId: string,
  address: string,
  topic: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = `https://${buildApiHost(store.subdomain)}/openapi/2025-06/webhooks/${encodeURIComponent(webhookId)}`;
  const result = await shoplazzaFetchWithBody(url, store, 'PUT', {
    id: webhookId,
    webhook: { address, topic },
  });
  // 不把可能回显回调密钥的响应正文写入日志。
  return result.ok ? { ok: true } : { ok: false, error: `更新 Webhook 地址失败: HTTP ${result.status}` };
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

/** 物流兜底专用：接口失败或列表不完整时抛错，不把失败当作没有运单。 */
export async function listOrderFulfillments(
  store: ShoplazzaStoreConfig,
  orderId: string,
): Promise<Record<string, unknown>[]> {
  const id = orderId.trim();
  if (!id) throw new Error('Fulfillment list requires an order ID');
  const baseUrl = `https://${buildApiHost(store.subdomain)}/openapi/2025-06/orders/${encodeURIComponent(id)}/fulfillments`;
  const fulfillments: Record<string, unknown>[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < 200; page++) {
    const url = cursor ? `${baseUrl}?${new URLSearchParams({ cursor })}` : baseUrl;
    const response = await shoplazzaFetch(url, store, 18000);
    if (!response.ok) throw new Error(`Fulfillment list HTTP ${response.status}`);
    const body = JSON.parse(await response.text());
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Fulfillment list response is not an object');
    }
    if (body.code !== undefined && body.code !== 'Success') {
      throw new Error('Fulfillment list API returned an unsuccessful code');
    }
    let items: unknown = body.data?.fulfillments ?? body.fulfillments;
    // 已实测未发货订单使用 Success + 空 data 对象，其他缺少列表的响应仍视为异常。
    if (items === undefined && body.code === 'Success'
      && body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      && Object.keys(body.data).length === 0) {
      items = [];
    }
    if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('Fulfillment list response has no valid fulfillments array');
    }
    if (items.some(item => item.order_id !== undefined && String(item.order_id) !== id)) {
      throw new Error('Fulfillment list contains a different order');
    }
    const hasMore: unknown = body.data?.has_more ?? body.has_more ?? false;
    if (typeof hasMore !== 'boolean') throw new Error('Fulfillment list has an invalid pagination flag');
    fulfillments.push(...items);
    if (!hasMore) return fulfillments;
    const nextCursor: unknown = body.data?.cursor ?? body.cursor;
    if (items.length === 0 || typeof nextCursor !== 'string' || !nextCursor || seenCursors.has(nextCursor)) {
      throw new Error('Fulfillment list pagination is incomplete or repeated');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error('Fulfillment list exceeded 200 pages');
}

class FulfillmentBatchError extends Error {
  constructor(reason: string) { super(`Fulfillment batch ${reason}`); }
}

// Compare JSON objects independently of key insertion order, retaining array order and every field.
function fulfillmentFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** Missing IDs stay absent; callers must not treat them as successful empty fulfillment lists. */
export async function listOrderFulfillmentsBatch(
  store: ShoplazzaStoreConfig,
  orderIds: string[],
): Promise<Map<string, Record<string, unknown>[]>> {
  if (!Array.isArray(orderIds) || orderIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new FulfillmentBatchError('requires nonempty string order IDs');
  }
  const ids = [...new Set(orderIds.map(id => id.trim()))];
  if (ids.length > 50) throw new FulfillmentBatchError('exceeds the 50 unique order IDs limit');
  const results = new Map<string, Record<string, unknown>[]>();
  if (ids.length === 0) return results;
  const requested = new Set(ids);
  const fingerprints = new Map<string, string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  try {
    for (let page = 0; page < 200; page++) {
      const params = new URLSearchParams({ page_size: '250' });
      for (const id of ids) params.append('ids', id);
      if (cursor) params.set('cursor', cursor);
      await waitForRateLimit();
      const controller = new AbortController();
      // Keep the absolute deadline alive through body consumption, not just headers.
      const timeout = setTimeout(() => controller.abort(), 18000);
      let body: any;
      try {
        const response = await fetch(`https://${buildApiHost(store.subdomain)}/openapi/2025-06/orders?${params}`, {
          method: 'GET',
          headers: { 'Access-Token': store.accessToken, 'Content-Type': 'application/json' },
          signal: controller.signal as any,
          timeout: 18000,
        });
        if (!response.ok) {
          (response.body as any)?.destroy?.();
          throw new FulfillmentBatchError(`HTTP ${response.status}`);
        }
        body = JSON.parse(await response.text());
      } finally {
        clearTimeout(timeout);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new FulfillmentBatchError('response is not an object');
      }
      if (body.code !== undefined && body.code !== 'Success') {
        throw new FulfillmentBatchError('API returned an unsuccessful code');
      }
      const data = body.data === undefined ? body : body.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new FulfillmentBatchError('response has no valid orders array');
      }
      // Live list pagination can end with exactly { code: 'Success', data: {} }.
      if (body.code === 'Success' && data === body.data && Object.keys(data).length === 0
        && Object.keys(body).every(key => key === 'code' || key === 'data')) return results;
      if (!Array.isArray(data.orders)) throw new FulfillmentBatchError('response has no valid orders array');
      const hasMore = data.has_more === undefined ? false : data.has_more;
      if (typeof hasMore !== 'boolean') throw new FulfillmentBatchError('has an invalid pagination flag');

      for (const order of data.orders) {
        if (!order || typeof order !== 'object' || Array.isArray(order)
          || typeof order.id !== 'string' || !requested.has(order.id)) {
          throw new FulfillmentBatchError('contains an invalid or unexpected order ID');
        }
        const items: unknown = order.fulfillments;
        if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
          throw new FulfillmentBatchError('response has no valid fulfillments array');
        }
        const packageFingerprints = new Map<string, string>();
        for (const item of items) {
          if (item.order_id !== undefined && item.order_id !== order.id) {
            throw new FulfillmentBatchError('contains a fulfillment for a different order');
          }
          if (typeof item.id === 'string' && item.id) {
            const fingerprint = fulfillmentFingerprint(item);
            if (packageFingerprints.has(item.id) && packageFingerprints.get(item.id) !== fingerprint) {
              throw new FulfillmentBatchError('contains a conflicting duplicate fulfillment ID');
            }
            packageFingerprints.set(item.id, fingerprint);
          }
        }
        const fingerprint = fulfillmentFingerprint(items);
        if (fingerprints.has(order.id) && fingerprints.get(order.id) !== fingerprint) {
          throw new FulfillmentBatchError('contains a conflicting duplicate order ID');
        }
        fingerprints.set(order.id, fingerprint);
        results.set(order.id, items);
      }
      if (!hasMore) return results;
      const nextCursor: unknown = data.cursor;
      if (data.orders.length === 0 || typeof nextCursor !== 'string' || !nextCursor.trim() || seenCursors.has(nextCursor)) {
        throw new FulfillmentBatchError('pagination is incomplete or repeated');
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new FulfillmentBatchError('exceeded 200 pages');
  } catch (error) {
    if (error instanceof FulfillmentBatchError) throw error;
    // node-fetch/JSON failures may contain request URLs, payload fragments or credentials.
    throw new FulfillmentBatchError('request failed');
  }
}
