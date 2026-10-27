import crypto from 'crypto';
import { ShoplazzaStoreConfig, loadStoresConfig, buildStoreDomain } from './config';
import { query, queryWebhook } from './pg';
import { getOrderByNumber, getOrderDetail, getOrderForAddressUpdate, getOrderTransactions, ShoplazzaOrderDetail, ShoplazzaTransaction } from './shoplazza-client';
import { normalizeOrder } from './normalize-order';
import { createPaidSupportInviteEmailJob, extractStoreCustomDomain } from './email-service';
import { logSync } from './log-service';
import { withSnapshotShippingAddressGuard } from './shipping-address-guard';

/** 需要查卡号后四位的支付渠道（店匠自有支付），第三方支付（PayPal等）跳过交易查询 */
const CARD_LOOKUP_CHANNELS = ['shoplazzapayment'];

function extractPaymentChannel(order: any): string {
  return String(
    order?.payment_line?.payment_channel
    || (Array.isArray(order?.payment_lines) && order.payment_lines[0]?.payment_channel)
    || ''
  ).trim();
}

/** 推送正文已含快照所需字段时，可直接替代订单详情接口。缺任一项则退回详情查询。 */
function isCompletePaidOrder(order: any): boolean {
  if (!order || typeof order !== 'object') return false;
  const id = String(order.id || '').trim();
  const email = String(
    order.customer?.email || order.shipping_address?.email || order.billing_address?.email || ''
  ).trim();
  const financial = String(order.financial_status || '').trim().toLowerCase();
  const hasItems = Array.isArray(order.line_items) && order.line_items.length > 0;
  return Boolean(id && email && financial === 'paid' && extractPaymentChannel(order) && hasItems);
}

/** Shared with the legacy orders/updated path; only orders/paid creates an invite. */
export async function processOrderWebhook(params: {
  store: ShoplazzaStoreConfig;
  topic: 'orders/paid' | 'orders/updated';
  payload: any;
  receivedAt?: string;
}): Promise<{ orderNumber: string }> {
  const { store, topic, payload, receivedAt } = params;
  const storeSubdomain = store.subdomain;
  const order = payload?.order;
  const orderId = identifier(order?.id);
  const orderNumber = identifier(order?.number || order?.order_number);
  // 正文齐全则直接当订单详情；缺字段再打详情接口
  const detailApiStart = Date.now();
  let detailSource: 'webhook_payload' | 'api' = 'api';
  let detail: ShoplazzaOrderDetail | null = null;
  if (isCompletePaidOrder(order)) {
    detail = order as ShoplazzaOrderDetail;
    detailSource = 'webhook_payload';
    console.log(`[webhook] 使用推送正文，跳过订单详情: ${orderId || orderNumber}`);
    await logSync({
      source: 'webhook',
      action: 'order_detail_from_payload',
      storeSubdomain,
      storeName: store.storeName,
      targetId: orderId || orderNumber || '',
      status: 'success',
      durationMs: Date.now() - detailApiStart,
      detailJson: { orderId, orderNumber, skippedApi: true },
    });
  } else {
    detail = orderId ? await getOrderDetail(store, orderId) : null;
    if (!detail && orderNumber) {
      detail = await getOrderByNumber(store, orderNumber);
    }
    await logSync({
      source: 'api',
      action: 'order_detail_fetch',
      storeSubdomain,
      storeName: store.storeName,
      targetId: orderId || orderNumber || '',
      status: detail ? 'success' : 'failed',
      durationMs: Date.now() - detailApiStart,
      detailJson: { orderId, orderNumber, found: !!detail },
    });
    if (!detail && order?.id) {
      detail = { ...order } as ShoplazzaOrderDetail;
      detailSource = 'webhook_payload';
      if (topic === 'orders/paid' && !String(detail.financial_status || '').trim()) {
        detail.financial_status = 'paid';
      }
      console.warn(`[webhook] 订单详情查询失败，改用推送正文: ${orderId || orderNumber}`);
    }
  }
  if (!detail) {
    throw new Error('Order detail is not available yet; queued for retry');
  }
  const actualOrderId = detail.id || orderId;
  const savedFromWebhookAfterApiFailure = detailSource === 'webhook_payload' && !isCompletePaidOrder(order);

  // 详情接口失败时不再查交易，卡号留给兜底同步。只对店匠官方支付查 transactions。
  const paymentChannel = extractPaymentChannel(detail).toLowerCase();
  let transactions: ShoplazzaTransaction[] = [];
  const txApiStart = Date.now();
  if (!savedFromWebhookAfterApiFailure && CARD_LOOKUP_CHANNELS.some(ch => paymentChannel.includes(ch))) {
    transactions = await getOrderTransactions(store, actualOrderId);
    await logSync({
      source: 'api',
      action: 'transaction_fetch',
      storeSubdomain,
      storeName: store.storeName,
      targetId: actualOrderId,
      status: 'success',
      durationMs: Date.now() - txApiStart,
      detailJson: { count: transactions.length, paymentChannel },
    });
  }

  const normalized = normalizeOrder(storeSubdomain, store.storeName, detail, transactions);

  // 只处理已支付订单的快照和邮件（安全校验）
  if (normalized.paymentStatus !== 'paid') {
    console.log(`[webhook] 跳过非已支付订单: ${normalized.orderNumber} (financial_status=${normalized.paymentStatus})`);
    return { orderNumber: normalized.orderNumber || orderNumber };
  }
  if (topic === 'orders/paid' && (!normalized.orderId || !normalized.customerEmail)) {
    throw new Error('Paid order is missing its ID or customer email; queued for retry');
  }

  const snapshotResult = await withSnapshotShippingAddressGuard(
    normalized, () => getOrderForAddressUpdate(store, normalized.orderId), (client, normalized) => client.query(
    `INSERT INTO support_order_snapshots
      (store_subdomain, store_name, order_id, order_number, customer_email, customer_name,
       order_status, fulfillment_status, order_amount, order_currency,
       payment_status, payment_method, paid_at, refund_status, refund_amount,
       transaction_id_masked, card_last4,
       items_json, shipping_address_json, billing_address_json, logistics_json,
       payment_detail_json, raw_order_json,
       snapshot_source, last_webhook_topic, last_webhook_received_at, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     ON CONFLICT (store_subdomain, order_id, customer_email)
     DO UPDATE SET
       order_number = EXCLUDED.order_number,
       order_status = EXCLUDED.order_status,
       fulfillment_status = CASE
         WHEN support_order_snapshots.fulfillment_status IN ('partially_shipped', 'shipped')
           AND COALESCE(EXCLUDED.fulfillment_status, '') IN ('', 'initialled', 'waiting')
         THEN support_order_snapshots.fulfillment_status
         WHEN support_order_snapshots.fulfillment_status = 'shipped' AND EXCLUDED.fulfillment_status = 'partially_shipped'
         THEN support_order_snapshots.fulfillment_status
         ELSE EXCLUDED.fulfillment_status END,
       order_amount = EXCLUDED.order_amount,
       order_currency = EXCLUDED.order_currency,
       payment_status = EXCLUDED.payment_status,
       payment_method = EXCLUDED.payment_method,
       paid_at = EXCLUDED.paid_at,
       refund_status = EXCLUDED.refund_status,
       refund_amount = EXCLUDED.refund_amount,
       transaction_id_masked = EXCLUDED.transaction_id_masked,
       card_last4 = CASE WHEN EXCLUDED.card_last4 <> '' THEN EXCLUDED.card_last4 ELSE support_order_snapshots.card_last4 END,
       items_json = EXCLUDED.items_json,
       shipping_address_json = EXCLUDED.shipping_address_json,
       billing_address_json = EXCLUDED.billing_address_json,
       logistics_json = EXCLUDED.logistics_json,
       payment_detail_json = CASE WHEN EXCLUDED.payment_detail_json::text <> '{}'::text THEN EXCLUDED.payment_detail_json ELSE support_order_snapshots.payment_detail_json END,
       raw_order_json = CASE
         WHEN jsonb_typeof(support_order_snapshots.raw_order_json->'fulfillments') = 'array'
           AND support_order_snapshots.raw_order_json->'fulfillments' <> '[]'::jsonb
         THEN jsonb_set(EXCLUDED.raw_order_json, '{fulfillments}', support_order_snapshots.raw_order_json->'fulfillments', true)
         ELSE EXCLUDED.raw_order_json END,
       last_webhook_topic = EXCLUDED.last_webhook_topic,
       last_webhook_received_at = EXCLUDED.last_webhook_received_at,
       updated_at = now()
     RETURNING (created_at = updated_at) AS is_new`,
    [
      normalized.storeSubdomain,
      normalized.storeName,
      normalized.orderId,
      normalized.orderNumber,
      normalized.customerEmail,
      normalized.customerName,
      normalized.orderStatus,
      normalized.fulfillmentStatus,
      normalized.orderAmount,
      normalized.orderCurrency,
      normalized.paymentStatus,
      normalized.paymentMethod,
      normalized.paidAt,
      normalized.refundStatus,
      normalized.refundAmount,
      normalized.transactionIdMasked,
      normalized.cardLast4,
      JSON.stringify(normalized.itemsJson),
      JSON.stringify(normalized.shippingAddressJson),
      JSON.stringify(normalized.billingAddressJson),
      JSON.stringify(normalized.logisticsJson),
      JSON.stringify(normalized.paymentDetailJson),
      JSON.stringify(normalized.rawOrderJson),
      'shoplazza_webhook',
      topic,
      receivedAt || new Date().toISOString(),
      new Date().toISOString(),
    ],
    ),
  );

  if (topic === 'orders/paid') {
    const emailJob = await createPaidSupportInviteEmailJob({
      storeSubdomain: normalized.storeSubdomain,
      storeName: normalized.storeName,
      storeDomain: extractStoreCustomDomain(normalized.rawOrderJson) || buildStoreDomain(normalized.storeSubdomain),
      orderId: normalized.orderId,
      orderNumber: normalized.orderNumber,
      orderedAt: normalized.paidAt,
      customerEmail: normalized.customerEmail,
      customerName: normalized.customerName,
      paymentMethod: normalized.paymentMethod,
      cardLast4: normalized.cardLast4,
      orderAmount: normalized.orderAmount,
      orderCurrency: normalized.orderCurrency,
      jobSource: 'webhook',
    });
    console.log(`[webhook] email job ${emailJob.inserted ? 'created' : 'exists'}: ${emailJob.job.email_job_no}`);
  }
  console.log(`[webhook] 订单快照已更新: ${normalized.orderNumber}`);

  const isNew = Boolean(snapshotResult.rows[0]?.is_new);
  await logSync({
    source: 'webhook',
    action: 'order_paid',
    storeSubdomain,
    storeName: store.storeName,
    targetId: normalized.orderNumber || normalized.orderId,
    itemsTotal: 1,
    itemsNew: isNew ? 1 : 0,
    itemsUpdated: isNew ? 0 : 1,
    status: 'success',
    detailJson: {
      topic,
      paymentStatus: normalized.paymentStatus,
      detailSource,
      savedWebhookAfterApiFailure: savedFromWebhookAfterApiFailure,
      card_last4: normalized.cardLast4 || null,
    },
  });
  return { orderNumber: normalized.orderNumber || orderNumber };
}

function identifier(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '0') return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return '';
}

export function parsePaidWebhook(payload: any): { orderId: string; orderNumber: string; customerEmail: string } {
  const order = payload?.order;
  if (!order || typeof order !== 'object' || Array.isArray(order)) throw new Error('Invalid paid order payload');
  const orderId = identifier(order.id);
  const orderNumber = identifier(order.number || order.order_number);
  if ((!orderId && !orderNumber) || (order.id !== undefined && order.id !== null && !orderId)) {
    throw new Error('Paid order ID or number is required');
  }
  const email = order.customer?.email || order.shipping_address?.email || order.billing_address?.email;
  return { orderId, orderNumber, customerEmail: typeof email === 'string' ? email.trim().toLowerCase() : '' };
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function paidEventKey(storeSubdomain: string, payload: unknown): string {
  // The provider's deduplication header is reused across different orders.
  // Canonical content distinguishes updates while collapsing identical deliveries.
  return `paid:${storeSubdomain}:orders/paid:${crypto.createHash('sha256').update(stableJson(payload)).digest('hex')}`;
}

export async function enqueuePaidWebhook(params: {
  storeSubdomain: string;
  payload: unknown;
  headers: Record<string, unknown>;
}): Promise<void> {
  const parsed = parsePaidWebhook(params.payload);
  const headers = Object.fromEntries([
    'x-shoplazza-topic', 'x-shoplazza-shop-domain', 'x-shoplazza-api-version',
    'x-shoplazza-deduplication-id', 'content-type', 'user-agent',
  ].filter(name => typeof params.headers[name] === 'string').map(name => [name, params.headers[name]]));
  await queryWebhook(
    `INSERT INTO shoplazza_webhook_events
       (event_key, store_subdomain, topic, order_id, order_number, customer_email, payload_json, headers_json,
        status, next_attempt_at, delivery_count, last_received_at)
     VALUES ($1, $2, 'orders/paid', $3, $4, $5, $6, $7, 'received', now(), 1, now())
     ON CONFLICT (event_key) DO UPDATE
       SET delivery_count = shoplazza_webhook_events.delivery_count + 1,
           last_received_at = GREATEST(COALESCE(shoplazza_webhook_events.last_received_at,
             shoplazza_webhook_events.received_at), EXCLUDED.last_received_at)`,
    [paidEventKey(params.storeSubdomain, params.payload), params.storeSubdomain, parsed.orderId || null,
      parsed.orderNumber || null, parsed.customerEmail || null, JSON.stringify(params.payload), JSON.stringify(headers)],
  );
}

let activeRun: Promise<{ processed: number; failed: number }> | undefined;

export function processPendingPaidWebhooks(options: { limit?: number } = {}): Promise<{ processed: number; failed: number }> {
  if (activeRun) return activeRun;
  const run = async () => {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit || 50)));
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < limit; i++) {
      // Atomic claim across processes; only new paid: events are eligible, never historical receipt rows.
      const claimed = await query(
        `UPDATE shoplazza_webhook_events SET status = 'processing', processing_started_at = now(),
           attempts = attempts + 1, updated_at = now()
         WHERE id = (
           SELECT id FROM shoplazza_webhook_events
           WHERE event_key LIKE 'paid:%' AND topic = 'orders/paid'
             AND ((status IN ('received', 'failed') AND COALESCE(next_attempt_at, received_at) <= now())
               OR (status = 'processing' AND processing_started_at < now() - interval '10 minutes'))
           ORDER BY COALESCE(next_attempt_at, received_at), id
           FOR UPDATE SKIP LOCKED LIMIT 1
         ) RETURNING *`,
      );
      const event = claimed.rows[0];
      if (!event) break;
      try {
        parsePaidWebhook(event.payload_json);
        const stores = await loadStoresConfig();
        const store = stores.find(item => item.subdomain === event.store_subdomain);
        if (!store) throw new Error('Store is not currently enabled');
        const result = await processOrderWebhook({ store, topic: 'orders/paid', payload: event.payload_json,
          receivedAt: event.received_at instanceof Date ? event.received_at.toISOString() : event.received_at });
        const saved = await query(
          `UPDATE shoplazza_webhook_events SET status = 'processed', processed_at = now(),
             processing_started_at = NULL, next_attempt_at = NULL, error_message = NULL,
             order_number = COALESCE(NULLIF($2, ''), order_number), updated_at = now()
           WHERE id = $1 AND status = 'processing' AND attempts = $3`,
          [event.id, result.orderNumber, event.attempts],
        );
        processed += saved.rowCount || 0;
      } catch (error: any) {
        const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(7, Math.max(0, Number(event.attempts) - 1)));
        const message = String(error?.message || 'Paid order processing failed').slice(0, 500);
        const saved = await query(
          `UPDATE shoplazza_webhook_events SET status = 'failed', error_message = $2,
             processing_started_at = NULL, next_attempt_at = now() + ($3 * interval '1 second'), updated_at = now()
           WHERE id = $1 AND status = 'processing' AND attempts = $4`,
          [event.id, message, delaySeconds, event.attempts],
        );
        if (saved.rowCount) {
          failed++;
          await logSync({ source: 'webhook', action: 'order_paid', storeSubdomain: event.store_subdomain,
            targetId: event.order_number || event.order_id || '', itemsTotal: 1, status: 'failed',
            errorMessage: message, detailJson: { topic: 'orders/paid', attempts: event.attempts, retryInSeconds: delaySeconds } });
        }
        console.error(`[paid-worker] event ${event.id} failed; retry in ${delaySeconds}s`);
      }
    }
    return { processed, failed };
  };
  activeRun = run().finally(() => { activeRun = undefined; });
  return activeRun;
}
