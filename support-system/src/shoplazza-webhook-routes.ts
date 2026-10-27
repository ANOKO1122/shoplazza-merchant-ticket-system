import express from 'express';
import { loadStoresConfig } from './config';
import { query } from './pg';
import { requireWebhookAuth, logWebhookRejection } from './webhook-security';
import { FULFILLMENT_WEBHOOK_TOPICS, parseFulfillmentWebhook, enqueueFulfillmentWebhook, processPendingFulfillmentWebhooks } from './fulfillment-webhook';
import { parsePaidWebhook, enqueuePaidWebhook, processPendingPaidWebhooks } from './paid-webhook';
import { ORDER_STATUS_WEBHOOK_TOPICS, parseOrderStatusWebhook, enqueueOrderStatusWebhook, processPendingOrderStatusWebhooks } from './order-status-webhook';

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
    console.log(`[webhook] 重复事件已跳过: ${params.topic}`);
  }
  return { inserted };
}

export function createShoplazzaWebhookRouter(): express.Router {
  const router = express.Router();

  let config: Awaited<ReturnType<typeof loadStoresConfig>> | null = null;
  let configFetchedAt = 0;
  const CONFIG_TTL_MS = 30_000; // 30 秒刷新一次，启停可及时生效

  let configLoading: Promise<Awaited<ReturnType<typeof loadStoresConfig>>> | undefined;
  async function ensureStores() {
    if (config && Date.now() - configFetchedAt <= CONFIG_TTL_MS) return config;
    if (!configLoading) {
      configLoading = loadStoresConfig().then(stores => {
        config = stores;
        configFetchedAt = Date.now();
        return stores;
      }).finally(() => { configLoading = undefined; });
    }
    return configLoading;
  }

  async function ensureStoresForReceipt() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        ensureStores(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Store lookup timed out')), 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  router.post('/webhook/:storeSubdomain', requireWebhookAuth, async (req, res) => {
    const { storeSubdomain } = req.params;
    const payload = req.body;
    const topic = String(req.headers['x-shoplazza-topic'] || payload?.topic || '').trim();

    if (FULFILLMENT_WEBHOOK_TOPICS.includes(topic)) {
      try {
        parseFulfillmentWebhook(topic, payload);
      } catch {
        logWebhookRejection(req, 'invalid_payload');
        res.status(400).json({ ok: false, error: 'Invalid fulfillment payload' });
        return;
      }
      try {
        const stores = await ensureStoresForReceipt();
        if (!stores.some(store => store.subdomain === storeSubdomain)) {
          logWebhookRejection(req, 'store_disabled');
          res.status(404).json({ ok: false, error: 'Store is not enabled' });
          return;
        }
        await enqueueFulfillmentWebhook({ storeSubdomain, topic, payload, headers: req.headers });
      } catch {
        // Shoplazza retries server failures when durable receipt failed.
        logWebhookRejection(req, 'persist_failed');
        res.status(503).json({ ok: false, error: 'Could not save fulfillment event' });
        return;
      }
      res.status(200).json({ ok: true });
      processPendingFulfillmentWebhooks().catch(() => console.error('[fulfillment-worker] processing failed; scheduled retry remains enabled'));
      return;
    }

    if (topic === 'orders/paid') {
      try {
        parsePaidWebhook(payload);
      } catch {
        logWebhookRejection(req, 'invalid_payload');
        res.status(400).json({ ok: false, error: 'Invalid paid order payload' });
        return;
      }
      try {
        const stores = await ensureStoresForReceipt();
        if (!stores.some(store => store.subdomain === storeSubdomain)) {
          logWebhookRejection(req, 'store_disabled');
          res.status(404).json({ ok: false, error: 'Store is not enabled' });
          return;
        }
        await enqueuePaidWebhook({ storeSubdomain, payload, headers: req.headers });
      } catch {
        logWebhookRejection(req, 'persist_failed');
        res.status(503).json({ ok: false, error: 'Could not save paid event' });
        return;
      }
      res.status(200).json({ ok: true });
      processPendingPaidWebhooks().catch(() => console.error('[paid-worker] processing failed; scheduled retry remains enabled'));
      return;
    }

    if (ORDER_STATUS_WEBHOOK_TOPICS.includes(topic)) {
      try {
        parseOrderStatusWebhook(topic, payload);
      } catch {
        logWebhookRejection(req, 'invalid_payload');
        res.status(400).json({ ok: false, error: 'Invalid order status payload' });
        return;
      }
      try {
        const stores = await ensureStoresForReceipt();
        if (!stores.some(store => store.subdomain === storeSubdomain)) {
          logWebhookRejection(req, 'store_disabled');
          res.status(404).json({ ok: false, error: 'Store is not enabled' });
          return;
        }
        await enqueueOrderStatusWebhook({ storeSubdomain, topic, payload, headers: req.headers });
      } catch {
        logWebhookRejection(req, 'persist_failed');
        res.status(503).json({ ok: false, error: 'Could not save order status event' });
        return;
      }
      res.status(200).json({ ok: true });
      processPendingOrderStatusWebhooks().catch(() => console.error('[order-status-worker] processing failed; scheduled retry remains enabled'));
      return;
    }

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

      if (topic === 'orders/create') {
        return;
      }

      if (inserted) {
        console.log(`[webhook] 收到事件: ${topic}`);

      }
    } catch (err: any) {
      console.error(`[webhook] 入库失败: ${topic}`);
    }
  });

  return router;
}
