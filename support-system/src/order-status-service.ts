import type { PoolClient } from 'pg';
import { getClient } from './pg';
import { normalizeRefundAmount, refundStatusFromFinancialStatus, type NormalizedOrder } from './normalize-order';
import type { ShoplazzaOrderDetail } from './shoplazza-client';

export interface OrderStatus {
  orderStatus: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  refundStatus: string;
  refundAmount: string;
}
type Snapshot = {
  id: string; order_number: string; store_name: string;
  order_status: string; payment_status: string; fulfillment_status: string;
  refund_status: string; refund_amount: string; raw_order_json: Record<string, unknown>;
};
type StatusState = { state_json: Record<string, unknown>; provider_updated_at: string | Date };
const SHIPPING_RANK: Record<string, number> = { '': 0, initialled: 0, waiting: 0, partially_shipped: 1, shipped: 2 };
const TERMINAL_ORDER = new Set(['cancelled', 'finished', 'closed']);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function timestamp(value: unknown): number | null {
  if (!(value instanceof Date) && (typeof value !== 'string' || !value.trim())) return null;
  const result = new Date(value as string).getTime();
  return Number.isFinite(result) ? result : null;
}
// Decimal strings avoid losing cents for values outside JavaScript's exact numeric range.
function amountLessThan(value: string, previous: string): boolean {
  if (!value || !previous) return false;
  const parts = (amount: string) => { const [integer, fraction = ''] = amount.split('.'); return [integer.replace(/^0+(?=\d)/, ''), fraction]; };
  const [left, lf] = parts(value), [right, rf] = parts(previous);
  if (left.length !== right.length) return left.length < right.length;
  if (left !== right) return left < right;
  const length = Math.max(lf.length, rf.length);
  return lf.padEnd(length, '0') < rf.padEnd(length, '0');
}
function same(a: OrderStatus, b: OrderStatus): boolean {
  return (Object.keys(a) as Array<keyof OrderStatus>).every(key => a[key] === b[key]);
}
function snapshotStatus(row: Snapshot): OrderStatus {
  return { orderStatus: text(row.order_status), paymentStatus: text(row.payment_status),
    fulfillmentStatus: text(row.fulfillment_status), refundStatus: text(row.refund_status), refundAmount: text(row.refund_amount) };
}
function rawStatus(status: OrderStatus): Record<string, string> {
  const raw: Record<string, string> = { status: status.orderStatus, financial_status: status.paymentStatus,
    fulfillment_status: status.fulfillmentStatus };
  // Missing refund amounts stay unknown, rather than becoming a fabricated zero.
  if (status.refundAmount !== '') raw.total_refund_price = status.refundAmount;
  return raw;
}

/** Shipping progress is independent of payment/refund and cannot be reset by an old order view. */
export function preserveFulfillmentProgress(previous: string, incoming: string, protectLegacy = true): string {
  if (!incoming) return previous;
  if (previous in SHIPPING_RANK && incoming in SHIPPING_RANK && SHIPPING_RANK[incoming] < SHIPPING_RANK[previous]) return previous;
  if (protectLegacy && previous && !(previous in SHIPPING_RANK) && incoming in SHIPPING_RANK) return previous;
  return incoming;
}

/** A current GET may advance each dimension independently. Legacy writers cannot undo refunds. */
export function mergeOrderStatus(before: OrderStatus, order: Record<string, unknown>, protectLegacy = false): OrderStatus {
  let payment = text(order.financial_status) || before.paymentStatus;
  let status = text(order.status) || before.orderStatus;
  let amount = normalizeRefundAmount(order.total_refund_price) || normalizeRefundAmount(before.refundAmount);
  if (protectLegacy) {
    if ((['partially_refunded', 'refunded', 'refunding', 'refund_failed'].includes(before.paymentStatus)
        && ['waiting', 'pending', 'unpaid', 'authorized', 'paid'].includes(payment))
      || (before.paymentStatus === 'refunded' && payment === 'partially_refunded')
      || (before.paymentStatus === 'paid' && ['waiting', 'pending', 'unpaid', 'authorized'].includes(payment))) {
      payment = before.paymentStatus;
      amount = before.refundAmount;
    }
    if (amountLessThan(amount, normalizeRefundAmount(before.refundAmount))) amount = before.refundAmount;
    if (TERMINAL_ORDER.has(before.orderStatus) && !TERMINAL_ORDER.has(status)) status = before.orderStatus;
  }
  return { orderStatus: status, paymentStatus: payment,
    fulfillmentStatus: preserveFulfillmentProgress(before.fulfillmentStatus, text(order.fulfillment_status), protectLegacy),
    refundStatus: refundStatusFromFinancialStatus(payment), refundAmount: amount };
}

/** The namespace is shared with address edits, normal order upserts and fulfillment updates. */
export async function lockOrderState(client: PoolClient, store: string, orderId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [`support.shipping-address:${store}`, orderId]);
}

async function readStoredStatus(client: PoolClient, store: string, orderId: string) {
  // Read AFTER the advisory lock: a waiter must see the other transaction's commit.
  const snapshots = await client.query<Snapshot>(
    `SELECT id, order_number, store_name, order_status, payment_status, fulfillment_status,
            refund_status, refund_amount, raw_order_json
     FROM support_order_snapshots WHERE store_subdomain = $1 AND order_id = $2 ORDER BY id FOR UPDATE`, [store, orderId]);
  const states = await client.query<StatusState>(
    `SELECT state_json, provider_updated_at FROM support_order_status_state
     WHERE store_subdomain = $1 AND order_id = $2`, [store, orderId]);
  const rows = snapshots.rows;
  const latest = [...rows].sort((a, b) => (timestamp(record(b.raw_order_json).updated_at) ?? -Infinity)
    - (timestamp(record(a.raw_order_json).updated_at) ?? -Infinity))[0];
  let before: OrderStatus = latest ? snapshotStatus(latest)
    : { orderStatus: '', paymentStatus: '', fulfillmentStatus: '', refundStatus: '', refundAmount: '' };
  let version = latest ? timestamp(record(latest.raw_order_json).updated_at) : null;
  const state = states.rows[0];
  const stateVersion = timestamp(state?.provider_updated_at);
  if (state && stateVersion !== null && (version === null || stateVersion >= version)) {
    before = mergeOrderStatus(before, record(state.state_json));
    version = stateVersion;
  }
  // Shipment changes have their own provider clock; retain progress from every email row.
  for (const row of rows) before.fulfillmentStatus = preserveFulfillmentProgress(before.fulfillmentStatus, text(row.fulfillment_status));
  return { rows, before, version };
}

/** Called inside the existing snapshot/address transaction before its upsert. */
export async function guardSnapshotOrderStatus(client: PoolClient, incoming: NormalizedOrder): Promise<{ order: NormalizedOrder; hadSnapshots: boolean }> {
  const saved = await readStoredStatus(client, incoming.storeSubdomain, incoming.orderId);
  if (!saved.rows.length) return { order: incoming, hadSnapshots: false };
  const incomingTime = timestamp(incoming.rawOrderJson.updated_at);
  const stale = saved.version !== null && (incomingTime === null || incomingTime < saved.version);
  const resolved = mergeOrderStatus(saved.before, stale ? {} : incoming.rawOrderJson, true);
  const raw = { ...incoming.rawOrderJson, ...rawStatus(resolved) };
  if (resolved.refundAmount === '') delete raw.total_refund_price;
  if (stale && saved.version !== null) raw.updated_at = new Date(saved.version).toISOString();
  return { order: { ...incoming, ...resolved, rawOrderJson: raw }, hadSnapshots: true };
}

/** Keep alternate-email snapshots consistent after an accepted legacy upsert. */
export async function synchronizeSnapshotOrderStatus(client: PoolClient, order: NormalizedOrder): Promise<void> {
  await client.query(
    `UPDATE support_order_snapshots SET order_status = $3, payment_status = $4, fulfillment_status = $5,
       refund_status = $6, refund_amount = $7,
       raw_order_json = (CASE WHEN jsonb_typeof(raw_order_json) = 'object' THEN raw_order_json ELSE '{}'::jsonb END) || $8::jsonb,
       updated_at = now()
     WHERE store_subdomain = $1 AND order_id = $2 AND (
       (order_status, payment_status, fulfillment_status, refund_status, refund_amount) IS DISTINCT FROM ($3,$4,$5,$6,$7)
       OR (raw_order_json @> $8::jsonb) IS NOT TRUE)`,
    [order.storeSubdomain, order.orderId, order.orderStatus, order.paymentStatus, order.fulfillmentStatus,
      order.refundStatus, order.refundAmount, JSON.stringify(rawStatus(order))]);
}

export interface ApplyOrderStatusUpdateResult {
  matched: boolean;
  changed: boolean;
  orderNumber: string;
  skipReason?: 'not_found' | 'stale' | 'unchanged' | 'missing_updated_at';
  before: OrderStatus;
  after: OrderStatus;
}

/** Status-only, existing orders only. No customer, address, parcel, token or email writes. */
export async function applyOrderStatusUpdate(params: {
  storeSubdomain: string; storeName?: string; order: ShoplazzaOrderDetail; topic: string;
}): Promise<ApplyOrderStatusUpdateResult> {
  const store = text(params.storeSubdomain);
  const order = record(params.order);
  const orderId = text(order.id);
  if (!store || !orderId) throw new Error('Order status update requires a store and order ID');
  const started = Date.now();
  const client = await getClient();
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    await lockOrderState(client, store, orderId);
    const saved = await readStoredStatus(client, store, orderId);
    const orderNumber = saved.rows.find(row => row.order_number)?.order_number || text(order.number || order.order_number) || orderId;
    const incomingTime = timestamp(order.updated_at);
    let skipReason: ApplyOrderStatusUpdateResult['skipReason'];
    if (!saved.rows.length) skipReason = 'not_found';
    else if (incomingTime === null) skipReason = 'missing_updated_at';
    else if (saved.version !== null && incomingTime < saved.version) skipReason = 'stale';
    const after = skipReason ? saved.before : mergeOrderStatus(saved.before, order, incomingTime === saved.version);
    const rawPatch = rawStatus(after);
    const changedRows = skipReason ? [] : saved.rows.filter(row => !same(snapshotStatus(row), after)
      || Object.entries(rawPatch).some(([key, value]) => text(record(row.raw_order_json)[key]) !== value));
    if (!skipReason) {
      await client.query(
        `INSERT INTO support_order_status_state (store_subdomain, order_id, state_json, provider_updated_at, last_topic)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (store_subdomain, order_id) DO UPDATE SET state_json = EXCLUDED.state_json,
           provider_updated_at = EXCLUDED.provider_updated_at, last_topic = EXCLUDED.last_topic, updated_at = now()`,
        [store, orderId, JSON.stringify(rawPatch), new Date(incomingTime!).toISOString(), params.topic]);
      if (changedRows.length) {
        await client.query(
          `UPDATE support_order_snapshots SET order_status = $2, payment_status = $3, fulfillment_status = $4,
             refund_status = $5, refund_amount = $6,
             raw_order_json = (CASE WHEN jsonb_typeof(raw_order_json) = 'object' THEN raw_order_json ELSE '{}'::jsonb END) || $7::jsonb,
             last_webhook_topic = $8, last_webhook_received_at = now(), updated_at = now()
           WHERE id = ANY($1::bigint[])`,
          [changedRows.map(row => row.id), after.orderStatus, after.paymentStatus, after.fulfillmentStatus,
            after.refundStatus, after.refundAmount, JSON.stringify(rawPatch), params.topic]);
      } else skipReason = 'unchanged';
    }
    await client.query(
      `INSERT INTO support_sync_logs (source, action, store_subdomain, store_name, target_id,
        items_total, items_updated, items_skipped, status, duration_ms, detail_json)
       VALUES ('webhook', 'order_status_update', $1, $2, $3, 1, $4, $5, 'success', $6, $7::jsonb)`,
      [store, params.storeName || saved.rows[0]?.store_name || null, orderNumber, changedRows.length ? 1 : 0,
        changedRows.length ? 0 : 1, Date.now() - started, JSON.stringify({ topic: params.topic, reason: skipReason || 'updated',
          before: saved.before, after, matchedRows: saved.rows.length, changedRows: changedRows.length })]);
    await client.query('COMMIT');
    return { matched: saved.rows.length > 0, changed: changedRows.length > 0, orderNumber, skipReason, before: saved.before, after };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { releaseError = new Error('Order-status transaction rollback failed'); }
    throw error;
  } finally { client.release(releaseError); }
}
