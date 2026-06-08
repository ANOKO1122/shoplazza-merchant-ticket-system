import express from 'express';
import { loadStoresConfig, buildStoreDomain } from './config';
import { query } from './pg';
import { getOrderByNumber, getOrderDetail, getOrderTransactions, ShoplazzaTransaction } from './shoplazza-client';
import { normalizeOrder } from './normalize-order';
import { createPaidSupportInviteEmailJob } from './email-service';
import { logSync } from './log-service';

/** 需要查卡号后四位的支付渠道（店匠自有支付），第三方支付（PayPal等）跳过交易查询 */
const CARD_LOOKUP_CHANNELS = ['shoplazzapayment'];

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

  router.post('/webhook/:storeSubdomain', async (req, res) => {
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

      if (inserted) {
        console.log(`[webhook] 收到事件: ${eventKey}`);

        const orderTopics = ['orders/paid', 'orders/fulfilled', 'orders/updated'];
        if (orderTopics.includes(topic) && (orderId || orderNumber)) {
          try {
            // API补全：查询订单详情
            const detailApiStart = Date.now();
            let detail = orderId ? await getOrderDetail(store, orderId) : null;
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
            if (!detail) {
              console.warn(`[webhook] 订单详情查询失败: id=${orderId} number=${orderNumber}`);
              return;
            }
            const actualOrderId = detail.id || orderId;

            // 只对店匠官方支付查 transactions（拿卡号后四位），第三方支付跳过以节省 API 配额
            const paymentChannel = String(
              (detail.payment_line as any)?.payment_channel || ''
            ).toLowerCase();
            let transactions: ShoplazzaTransaction[] = [];
            const txApiStart = Date.now();
            if (CARD_LOOKUP_CHANNELS.some(ch => paymentChannel.includes(ch))) {
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
                 card_last4 = EXCLUDED.card_last4,
                 items_json = EXCLUDED.items_json,
                 shipping_address_json = EXCLUDED.shipping_address_json,
                 billing_address_json = EXCLUDED.billing_address_json,
                 logistics_json = EXCLUDED.logistics_json,
                 payment_detail_json = EXCLUDED.payment_detail_json,
                 raw_order_json = EXCLUDED.raw_order_json,
                 last_webhook_topic = EXCLUDED.last_webhook_topic,
                 last_webhook_received_at = EXCLUDED.last_webhook_received_at,
                 updated_at = now()`,
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
                storeDomain: buildStoreDomain(normalized.storeSubdomain),
                orderId: normalized.orderId,
                orderNumber: normalized.orderNumber,
                orderedAt: normalized.paidAt,
                customerEmail: normalized.customerEmail,
                customerName: normalized.customerName,
                paymentMethod: normalized.paymentMethod,
                cardLast4: normalized.cardLast4,
                orderAmount: normalized.orderAmount,
                orderCurrency: normalized.orderCurrency,
              });
              console.log(`[webhook] email job ${emailJob.inserted ? 'created' : 'exists'}: ${emailJob.job.email_job_no}`);
            }
            console.log(`[webhook] 订单快照已更新: ${normalized.orderNumber} ${normalized.customerEmail} fulfillment:${normalized.fulfillmentStatus} card:${normalized.cardLast4 || '无'}`);

            // 同步日志
            const upserted = (snapshotResult.rowCount ?? 0) > 0;
            await logSync({
              source: 'webhook',
              action: 'order_upsert',
              storeSubdomain,
              storeName: store.storeName,
              targetId: normalized.orderNumber || normalized.orderId,
              itemsTotal: 1,
              itemsNew: upserted ? 1 : 0,
              itemsUpdated: upserted ? 0 : 1,
              status: 'success',
              detailJson: {
                topic,
                card_last4: normalized.cardLast4 || null,
              },
            });
          } catch (err: any) {
            console.error(`[webhook] 订单处理失败: ${orderId}`, err.message);
            await logSync({
              source: 'webhook',
              action: 'order_upsert',
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
