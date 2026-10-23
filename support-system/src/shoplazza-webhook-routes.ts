import express from 'express';
import { loadStoresConfig, buildStoreDomain } from './config';
import { query } from './pg';
import { getOrderByNumber, getOrderDetail, getOrderTransactions, ShoplazzaOrderDetail, ShoplazzaTransaction } from './shoplazza-client';
import { normalizeOrder } from './normalize-order';
import { createPaidSupportInviteEmailJob, extractStoreCustomDomain } from './email-service';
import { logSync } from './log-service';
import { requireWebhookAuth } from './webhook-security';

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

const FULFILLMENT_TOPICS = ['orders/fulfilled', 'orders/partially_fulfilled'];

function collectTrackingNumbers(order: any): string[] {
  const fulfillments = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  const numbers: string[] = [];
  for (const item of fulfillments) {
    const raw = item?.tracking_number || item?.tracking_no || '';
    const text = String(raw || '').trim();
    if (text && !numbers.includes(text)) numbers.push(text);
  }
  return numbers;
}

/** 发货事件只补已有订单的运单和履约状态，不打详情接口，也不新建快照。 */
async function applyFulfillmentWebhook(params: {
  storeSubdomain: string;
  storeName: string;
  topic: string;
  order: any;
  orderId: string;
  orderNumber: string;
}): Promise<void> {
  const trackingNumbers = collectTrackingNumbers(params.order);
  const fulfillmentStatus = String(params.order?.fulfillment_status || '').trim();
  if (!params.orderId && !params.orderNumber) {
    console.warn(`[webhook] 发货事件缺少订单标识: ${params.topic}`);
    return;
  }

  const hasTracking = trackingNumbers.length > 0;
  const fulfillmentsJson = JSON.stringify(Array.isArray(params.order?.fulfillments) ? params.order.fulfillments : []);
  const whereSql = params.orderId
    ? 'store_subdomain = $1 AND order_id = $2'
    : 'store_subdomain = $1 AND order_number = $2';
  const whereValue = params.orderId || params.orderNumber;
  const result = await query(
    `UPDATE support_order_snapshots
     SET fulfillment_status = CASE WHEN $3 <> '' THEN $3 ELSE fulfillment_status END,
         raw_order_json = CASE
           WHEN $4::boolean THEN jsonb_set(
             CASE WHEN jsonb_typeof(raw_order_json) = 'object' THEN raw_order_json ELSE '{}'::jsonb END,
             '{fulfillments}',
             $5::jsonb,
             true
           )
           ELSE raw_order_json
         END,
         last_webhook_topic = $6,
         last_webhook_received_at = now(),
         updated_at = now()
     WHERE ${whereSql}`,
    [params.storeSubdomain, whereValue, fulfillmentStatus, hasTracking, fulfillmentsJson, params.topic],
  );
  const updated = result.rowCount ?? 0;
  if (updated === 0) {
    console.warn(`[webhook] 发货事件未匹配到订单快照: ${params.orderId || params.orderNumber}`);
  } else {
    console.log(`[webhook] 运单已更新: ${params.orderNumber || params.orderId} tracking:${trackingNumbers.join(',') || '无'} rows:${updated}`);
  }
  await logSync({
    source: 'webhook',
    action: 'fulfillment_update',
    storeSubdomain: params.storeSubdomain,
    storeName: params.storeName,
    targetId: params.orderNumber || params.orderId,
    itemsTotal: 1,
    itemsUpdated: updated,
    status: updated > 0 ? 'success' : 'failed',
    detailJson: {
      topic: params.topic,
      trackingCount: trackingNumbers.length,
      tracking: trackingNumbers.join(',').slice(0, 240) || null,
      fulfillmentStatus: fulfillmentStatus || null,
      skippedApi: true,
    },
  });
}

function buildEventKey(params: {
  topic: string;
  storeSubdomain: string;
  orderId: string;
  customerEmail?: string;
}): string {
  const email = (params.customerEmail || 'unknown').trim().toLowerCase();
  return `${params.topic}:${params.storeSubdomain}:${params.orderId}:${email}`;
}

async function insertWebhookEvent(params: {
  eventKey: string;
  storeSubdomain: string;
  topic: string;
  orderId?: string;
  orderNumber?: string;
  customerEmail?: string;
  payload: unknown;
  headers: Record<string, string>;
}): Promise<{ inserted: boolean }> {
  const result = await query(
    `INSERT INTO shoplazza_webhook_events (event_key, store_subdomain, topic, order_id, order_number, customer_email, payload_json, headers_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [
      params.eventKey,
      params.storeSubdomain,
      params.topic,
      params.orderId || null,
      params.orderNumber || null,
      params.customerEmail || null,
      JSON.stringify(params.payload),
      JSON.stringify(params.headers),
    ],
  );

  const inserted = (result.rowCount ?? 0) > 0;
  if (!inserted) {
    console.log(`[webhook] 重复事件已跳过: ${params.eventKey}`);
  }
  return { inserted };
}

export function createShoplazzaWebhookRouter(): express.Router {
  const router = express.Router();

  let config: Awaited<ReturnType<typeof loadStoresConfig>> | null = null;
  let configFetchedAt = 0;
  const CONFIG_TTL_MS = 30_000; // 30 秒刷新一次，启停可及时生效

  async function ensureStores() {
    if (!config || Date.now() - configFetchedAt > CONFIG_TTL_MS) {
      config = await loadStoresConfig();
      configFetchedAt = Date.now();
    }
    return config;
  }

  router.post('/webhook/:storeSubdomain', requireWebhookAuth, async (req, res) => {
    const { storeSubdomain } = req.params;
    const payload = req.body;
    const topic = String(req.headers['x-shoplazza-topic'] || payload?.topic || '').trim();

    res.status(200).json({ ok: true });

    const stores = await ensureStores();
    const store = stores.find(s => s.subdomain === storeSubdomain);
    if (!store) {
      console.warn(`[webhook] 未知店铺: ${storeSubdomain}`);
      return;
    }

    if (!topic) {
      console.warn(`[webhook] 缺少 topic`, { storeSubdomain });
      return;
    }

    const order = payload?.order;
    const orderId = order?.id ? String(order.id).trim() : '';
    const orderNumber = order?.number || order?.order_number ? String(order.number || order.order_number).trim() : '';
    const customerEmail = order?.customer?.email || order?.shipping_address?.email || order?.billing_address?.email || '';

    const eventKey = buildEventKey({ topic, storeSubdomain, orderId, customerEmail });

    try {
      const { inserted } = await insertWebhookEvent({
        eventKey,
        storeSubdomain,
        topic,
        orderId,
        orderNumber,
        customerEmail,
        payload,
        headers: req.headers as Record<string, string>,
      });

      if (FULFILLMENT_TOPICS.includes(topic)) {
        if (inserted) console.log(`[webhook] 收到事件: ${eventKey}`);
        await applyFulfillmentWebhook({
          storeSubdomain,
          storeName: store.storeName,
          topic,
          order,
          orderId,
          orderNumber,
        });
        return;
      }

      if (topic === 'orders/create') {
        return;
      }

      if (inserted) {
        console.log(`[webhook] 收到事件: ${eventKey}`);

        const orderTopics = ['orders/paid', 'orders/updated'];
        if (orderTopics.includes(topic) && (orderId || orderNumber)) {
          try {
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
                detail = order as ShoplazzaOrderDetail;
                detailSource = 'webhook_payload';
                if (topic === 'orders/paid' && !String(detail.financial_status || '').trim()) {
                  detail.financial_status = 'paid';
                }
                console.warn(`[webhook] 订单详情查询失败，改用推送正文: ${orderId || orderNumber}`);
              }
            }
            if (!detail) {
              console.warn(`[webhook] 订单详情查询失败且推送无订单体: id=${orderId} number=${orderNumber}`);
              return;
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
              return;
            }

            const snapshotResult = await query(
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
                 fulfillment_status = EXCLUDED.fulfillment_status,
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
                 raw_order_json = EXCLUDED.raw_order_json,
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
                new Date().toISOString(),
                new Date().toISOString(),
              ],
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
            console.log(`[webhook] 订单快照已更新: ${normalized.orderNumber} ${normalized.customerEmail} fulfillment:${normalized.fulfillmentStatus} card:${normalized.cardLast4 || '无'}`);

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
          } catch (err: any) {
            console.error(`[webhook] 订单处理失败: ${orderId}`, err.message);
            await logSync({
              source: 'webhook',
              action: 'order_paid',
              storeSubdomain,
              targetId: orderId || orderNumber || '',
              itemsTotal: 1,
              status: 'failed',
              errorMessage: err.message,
            });
          }
        }
      }
    } catch (err: any) {
      console.error(`[webhook] 入库失败: ${eventKey}`, err.message);
    }
  });

  return router;
}
