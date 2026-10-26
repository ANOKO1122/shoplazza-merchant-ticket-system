import { isDeepStrictEqual } from 'node:util';
import { getPool } from './pg';

type Fulfillment = Record<string, any> & { id: string };
type ChangeKind = 'added' | 'updated' | 'history_added' | 'stale' | 'unchanged';

export interface FulfillmentChange {
  fulfillmentId: string;
  kind: ChangeKind;
  beforeTrackingNumbers: string[];
  /** 本次消息拟更新的当前号码；stale/history_added 不覆盖实际当前号码。 */
  afterTrackingNumbers: string[];
  retainedTrackingNumbers: string[];
  addedTrackingNumbers: string[];
}

export interface FulfillmentMergeResult {
  fulfillments: Fulfillment[];
  added: number;
  updated: number;
  unchanged: number;
  stale: number;
  changes: FulfillmentChange[];
  trackingNumbers: string[];
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedId(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new Error('Invalid fulfillment id');
}

function timestamp(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Invalid fulfillment updated_at');
  }
  return Date.parse(value);
}

export function validateFulfillments(value: unknown): Fulfillment[] {
  return validateRecords(value, false);
}

function validateRecords(value: unknown, stored: boolean): Fulfillment[] {
  if (!Array.isArray(value)) throw new Error('Fulfillments must be an array');
  return value.map(item => {
    if (!isRecord(item)) throw new Error('Invalid fulfillment object');
    const id = normalizedId(item.id);
    timestamp(item.updated_at);
    if (item.tracking_items !== undefined &&
        (!Array.isArray(item.tracking_items) || !item.tracking_items.every(isRecord))) {
      throw new Error('Invalid fulfillment tracking_items');
    }
    // 输入来自 JSON；复制后合并，避免修改调用方或其他快照行持有的对象。
    const copy = { ...JSON.parse(JSON.stringify(item)), id };
    // history 是本系统生成的字段，API/回调不能注入或清空已有历史。
    if (!stored) delete copy.tracking_number_history;
    return copy;
  });
}

const TRACKING_KEYS = [
  'tracking_numbers', 'trackingNumbers', 'tracking_number', 'tracking_no', 'trackingNumber',
  'waybill_no', 'waybillNo', 'waybill_number', 'waybillNumber', 'logistics_no', 'logisticsNo',
  'tracking_code', 'trackingCode', 'shipping_tracking_number', 'shippingTrackingNumber',
];

function directTrackingNumbers(value: unknown, allAliases = false): string[] {
  if (!isRecord(value)) return [];
  const collected: string[] = [];
  for (const key of TRACKING_KEYS) {
    const numbers: string[] = [];
    const values = Array.isArray(value[key]) ? value[key] : [value[key]];
    for (const raw of values) {
      if (typeof raw !== 'string' && typeof raw !== 'number') continue;
      const number = String(raw).trim();
      if (number && !numbers.includes(number)) numbers.push(number);
    }
    // 多种字段是同一组号码的兼容表示，不能把旧别名重新当成第二张运单。
    if (numbers.length && !allAliases) return numbers;
    collected.push(...numbers);
  }
  return [...new Set(collected)];
}

/** tracking_items 是多运单的完整列表；不存在时兼容旧的顶层运单字段。 */
export function extractFulfillmentTrackingNumbers(fulfillment: unknown): string[] {
  if (!isRecord(fulfillment)) return [];
  if (Array.isArray(fulfillment.tracking_items)) {
    return [...new Set(fulfillment.tracking_items.flatMap(item => directTrackingNumbers(item)))];
  }
  return directTrackingNumbers(fulfillment);
}

/** 仅用于已经存储的包裹：累计号码包含本地历史及现有当前号码。 */
export function extractStoredFulfillmentTrackingNumbers(fulfillment: unknown): string[] {
  if (!isRecord(fulfillment)) return [];
  const history = Array.isArray(fulfillment.tracking_number_history)
    ? fulfillment.tracking_number_history.filter((value: unknown): value is string => typeof value === 'string').map((value: string) => value.trim()).filter(Boolean)
    : [];
  return [...new Set([...history, ...extractFulfillmentTrackingNumbers(fulfillment)])];
}

function withHistory(fulfillment: Fulfillment): Fulfillment {
  return { ...fulfillment, tracking_number_history: collectedTrackingNumbers(fulfillment) };
}

function collectedTrackingNumbers(fulfillment: unknown): string[] {
  if (!isRecord(fulfillment)) return [];
  const itemNumbers = Array.isArray(fulfillment.tracking_items)
    ? fulfillment.tracking_items.flatMap(item => directTrackingNumbers(item, true)) : [];
  // 当前号沿用优先级；累计号保留同一正文各兼容表示中的所有不同号码。
  return [...new Set([...extractStoredFulfillmentTrackingNumbers(fulfillment),
    ...directTrackingNumbers(fulfillment, true), ...itemNumbers])];
}

function mergeRecord(before: Fulfillment, incoming: Fulfillment, allowSameTimestamp = false): { record: Fulfillment; kind: ChangeKind } {
  const merged = mergePayload(before, incoming);
  const beforeNumbers = collectedTrackingNumbers(before);
  const history = [...new Set([...beforeNumbers, ...collectedTrackingNumbers(incoming)])];
  const { tracking_number_history: _beforeHistory, ...beforeFields } = before;
  const { tracking_number_history: _incomingHistory, ...mergedFields } = merged;
  const historyChanged = !isDeepStrictEqual(before.tracking_number_history, history);
  if (isDeepStrictEqual(beforeFields, mergedFields)) {
    return { record: { ...before, tracking_number_history: history }, kind: historyChanged ? 'updated' : 'unchanged' };
  }
  const previousTime = timestamp(before.updated_at);
  const incomingTime = timestamp(incoming.updated_at);
  // 实时 GET 可以修正秒级时间戳下的冲突；回调无法判断同秒消息的先后。
  if (previousTime !== null && (incomingTime === null || incomingTime < previousTime ||
      (incomingTime === previousTime && !allowSameTimestamp))) {
    return {
      record: { ...before, tracking_number_history: history },
      kind: history.some(number => !beforeNumbers.includes(number)) ? 'history_added' : 'stale',
    };
  }
  return { record: { ...merged, tracking_number_history: history }, kind: 'updated' };
}

function mergePayload(before: Fulfillment | undefined, incoming: Fulfillment): Fulfillment {
  const merged = { ...before, ...incoming };
  const trackingKeys = ['tracking_items', ...TRACKING_KEYS];
  const supplied = (key: string) => Object.prototype.hasOwnProperty.call(incoming, key);
  // 新消息明确提供号码时，以本次使用的表示为准，避免旧数组/别名遮住新号。
  // 未提供任何号码字段的局部状态更新，继续保留完整的原有 tracking_items。
  if (trackingKeys.some(supplied)) {
    for (const key of trackingKeys) if (!supplied(key)) delete merged[key];
  }
  return merged;
}

function uniqueFulfillments(items: Fulfillment[], allowSameTimestamp = false): Map<string, Fulfillment> {
  const result = new Map<string, Fulfillment>();
  for (const item of items) {
    const previous = result.get(item.id);
    result.set(item.id, previous ? mergeRecord(previous, item, allowSameTimestamp).record : item);
  }
  return result;
}

/** 完整列表与局部列表均按 id 合并；缺失的包裹和字段不表示删除。 */
export function mergeFulfillments(
  existing: unknown[], incoming: unknown[], options: { source?: 'webhook' | 'backfill' } = {},
): FulfillmentMergeResult {
  const allowSameTimestamp = options.source === 'backfill';
  const stored = uniqueFulfillments(validateRecords(existing, true));
  const updates = uniqueFulfillments(validateFulfillments(incoming), allowSameTimestamp);
  const counts = { added: 0, updated: 0, unchanged: 0, stale: 0 };
  const changes: FulfillmentChange[] = [];
  for (const fulfillment of updates.values()) {
    const before = stored.get(fulfillment.id);
    const result = before ? mergeRecord(before, fulfillment, allowSameTimestamp) : { record: withHistory(fulfillment), kind: 'added' as const };
    stored.set(fulfillment.id, result.record);
    counts[result.kind === 'history_added' ? 'updated' : result.kind] += 1;
    const beforeNumbers = collectedTrackingNumbers(before);
    const retained = extractStoredFulfillmentTrackingNumbers(result.record);
    changes.push({
      fulfillmentId: fulfillment.id,
      kind: result.kind,
      beforeTrackingNumbers: extractFulfillmentTrackingNumbers(before),
      afterTrackingNumbers: extractFulfillmentTrackingNumbers(mergePayload(before, fulfillment)),
      retainedTrackingNumbers: retained,
      addedTrackingNumbers: retained.filter(number => !beforeNumbers.includes(number)),
    });
  }
  const fulfillments = [...stored.values()].map(withHistory);
  return {
    fulfillments,
    ...counts,
    changes,
    trackingNumbers: [...new Set(fulfillments.flatMap(extractStoredFulfillmentTrackingNumbers))],
  };
}

export interface ApplyFulfillmentUpdateParams {
  storeSubdomain: string;
  storeName?: string;
  orderId: string;
  orderNumber?: string;
  fulfillments: any[];
  fulfillmentStatus?: string;
  source: 'webhook' | 'backfill';
  topic?: string;
}

export interface ApplyFulfillmentUpdateResult extends Omit<FulfillmentMergeResult, 'fulfillments'> {
  matched: boolean;
  orderNumber: string;
}

function nextFulfillmentStatus(current: unknown[], incoming: unknown, stale: number): string | null {
  if (stale > 0 || typeof incoming !== 'string') return null;
  const ranks: Record<string, number> = { '': 0, initialled: 0, waiting: 0, partially_shipped: 1, shipped: 2 };
  if (!Object.prototype.hasOwnProperty.call(ranks, incoming)) return null;
  const previous = current.map(value => typeof value === 'string' ? value : '');
  // 已有更后的终态或未知状态不能由包裹更新覆盖。
  if (previous.some(value => !Object.prototype.hasOwnProperty.call(ranks, value))) return null;
  const previousRank = Math.max(0, ...previous.map(value => ranks[value]));
  return ranks[incoming] >= previousRank && ranks[incoming] > 0 ? incoming : null;
}

/** 同一订单的所有邮箱快照在一个事务内锁定、合并，并写入可核对的包裹日志。 */
export async function applyFulfillmentUpdate(params: ApplyFulfillmentUpdateParams): Promise<ApplyFulfillmentUpdateResult> {
  if (typeof params.storeSubdomain !== 'string' || !params.storeSubdomain.trim() ||
      typeof params.orderId !== 'string' || !params.orderId.trim()) {
    throw new Error('Fulfillment update requires storeSubdomain and orderId');
  }
  if (params.source !== 'webhook' && params.source !== 'backfill') throw new Error('Invalid fulfillment source');
  const incoming = validateFulfillments(params.fulfillments);
  const start = Date.now();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const snapshots = await client.query(
      `SELECT id, order_number, store_name, fulfillment_status, raw_order_json
       FROM support_order_snapshots
       WHERE store_subdomain = $1 AND order_id = $2
       ORDER BY id FOR UPDATE`,
      [params.storeSubdomain.trim(), params.orderId.trim()],
    );
    const matched = snapshots.rows.length > 0;
    const orderNumber = snapshots.rows.find(row => row.order_number)?.order_number || params.orderNumber || params.orderId;
    // 兼容历史上同一订单多邮箱行的差异：取各行包裹并集，再向所有行写回同一结果。
    const existing: unknown[] = snapshots.rows.flatMap(row => {
      const raw = isRecord(row.raw_order_json) ? row.raw_order_json : {};
      return Array.isArray(raw.fulfillments) ? raw.fulfillments : [];
    });
    const merged = matched ? mergeFulfillments(existing, incoming, { source: params.source }) : mergeFulfillments([], []);
    const oldMessages = merged.stale + merged.changes.filter(change => change.kind === 'history_added').length;
    const nextStatus = nextFulfillmentStatus(snapshots.rows.map(row => row.fulfillment_status), params.fulfillmentStatus, oldMessages);
    const statusChanged = nextStatus !== null && snapshots.rows.some(row => row.fulfillment_status !== nextStatus);
    const snapshotsMatch = snapshots.rows.every(row => isDeepStrictEqual(row.raw_order_json?.fulfillments, merged.fulfillments));
    // 兜底轮询只在实际数据变化时改快照；检查时间由独立同步状态记录。
    if (matched && (params.source === 'webhook' || statusChanged || !snapshotsMatch)) {
      await client.query(
        `UPDATE support_order_snapshots
         SET raw_order_json = jsonb_set(
               CASE WHEN jsonb_typeof(raw_order_json) = 'object' THEN raw_order_json ELSE '{}'::jsonb END,
               '{fulfillments}', $2::jsonb, true),
             last_webhook_topic = CASE WHEN $3 = 'webhook' THEN COALESCE($4, last_webhook_topic) ELSE last_webhook_topic END,
             last_webhook_received_at = CASE WHEN $3 = 'webhook' THEN now() ELSE last_webhook_received_at END,
             fulfillment_status = COALESCE($5, fulfillment_status),
             updated_at = now()
         WHERE id = ANY($1::bigint[])`,
        [snapshots.rows.map(row => row.id), JSON.stringify(merged.fulfillments), params.source, params.topic || null,
          nextStatus],
      );
    }

    const itemsTotal = new Set(incoming.map(item => item.id)).size;
    await client.query(
      `INSERT INTO support_sync_logs
        (source, action, store_subdomain, store_name, target_id,
         items_total, items_new, items_updated, items_skipped, status, error_message, duration_ms, detail_json)
       VALUES ($1, 'fulfillment_update', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        params.source, params.storeSubdomain.trim(), params.storeName || snapshots.rows[0]?.store_name || null,
        orderNumber, itemsTotal, merged.added, merged.updated,
        matched ? merged.stale + merged.unchanged : itemsTotal,
        matched ? 'success' : 'failed', matched ? null : 'Order snapshot not found', Date.now() - start,
        JSON.stringify({
          topic: params.topic || null, changes: merged.changes, trackingNumbers: merged.trackingNumbers,
          trackingCount: merged.trackingNumbers.length, fulfillmentCount: merged.fulfillments.length,
          stale: merged.stale, unchanged: merged.unchanged, skippedApi: params.source === 'webhook', matched,
          historyAdded: merged.changes.filter(change => change.kind === 'history_added').length,
        }),
      ],
    );
    await client.query('COMMIT');
    const { fulfillments: _fulfillments, ...result } = merged;
    return { matched, orderNumber, ...result };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* 保留原始失败原因 */ }
    throw error;
  } finally {
    client.release();
  }
}
