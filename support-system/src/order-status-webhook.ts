import crypto from 'crypto';
import { query, queryWebhook } from './pg';
import { getStoreBySubdomain } from './store-service';
import { getOrderForStatusUpdate } from './shoplazza-client';
import { applyOrderStatusUpdate } from './order-status-service';
import { logSync } from './log-service';

export const ORDER_STATUS_WEBHOOK_TOPICS: readonly string[] = [
  'orders/partially_refunded', 'orders/refunded', 'orders/cancelled', 'orders/finished',
];

function identifier(value: unknown): string {
  if (typeof value === 'string' && value.trim().length <= 256) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return '';
}

export function parseOrderStatusWebhook(topic: string, payload: any): { orderId: string; orderNumber: string } {
  if (!ORDER_STATUS_WEBHOOK_TOPICS.includes(topic)) throw new Error('Unsupported order status event');
  const order = payload?.order;
  const orderId = identifier(order?.id);
  if (!order || typeof order !== 'object' || Array.isArray(order) || !orderId) {
    throw new Error('Order status event requires an order ID');
  }
  return { orderId, orderNumber: identifier(order.number || order.order_number) };
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function orderStatusEventKey(store: string, topic: string, payload: unknown): string {
  // Provider deduplication headers can be reused. Distinct bodies must keep their own work item.
  return `order-status:v1:${store}:${topic}:${crypto.createHash('sha256').update(stableJson(payload)).digest('hex')}`;
}

export async function enqueueOrderStatusWebhook(params: {
  storeSubdomain: string; topic: string; payload: unknown; headers: Record<string, unknown>;
}): Promise<void> {
  const parsed = parseOrderStatusWebhook(params.topic, params.payload);
  const headers = Object.fromEntries([
    'x-shoplazza-topic', 'x-shoplazza-shop-domain', 'x-shoplazza-api-version',
    'x-shoplazza-deduplication-id', 'content-type', 'user-agent',
  ].filter(name => typeof params.headers[name] === 'string').map(name => [name, params.headers[name]]));
  await queryWebhook(
    `INSERT INTO shoplazza_webhook_events
       (event_key, store_subdomain, topic, order_id, order_number, payload_json, headers_json,
        status, next_attempt_at, delivery_count, last_received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'received', now(), 1, now())
     ON CONFLICT (event_key) DO UPDATE
       SET delivery_count = shoplazza_webhook_events.delivery_count + 1,
           last_received_at = GREATEST(COALESCE(shoplazza_webhook_events.last_received_at,
             shoplazza_webhook_events.received_at), EXCLUDED.last_received_at)`,
    [orderStatusEventKey(params.storeSubdomain, params.topic, params.payload), params.storeSubdomain,
      params.topic, parsed.orderId, parsed.orderNumber || null, JSON.stringify(params.payload), JSON.stringify(headers)],
  );
}

let activeRun: Promise<{ processed: number; failed: number }> | undefined;

/** Drains only received events. There is deliberately no order-list API or periodic status reconciliation. */
export function processPendingOrderStatusWebhooks(options: { limit?: number } = {}): Promise<{ processed: number; failed: number }> {
  if (activeRun) return activeRun;
  const run = async () => {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit || 50)));
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < limit; i++) {
      const claimed = await query(
        `UPDATE shoplazza_webhook_events SET status = 'processing', processing_started_at = now(),
           attempts = attempts + 1, updated_at = now()
         WHERE id = (
           SELECT id FROM shoplazza_webhook_events
           WHERE event_key LIKE 'order-status:%'
             AND ((status IN ('received', 'failed') AND COALESCE(next_attempt_at, received_at) <= now())
               OR (status = 'processing' AND processing_started_at < now() - interval '10 minutes'))
           ORDER BY COALESCE(next_attempt_at, received_at), id
           FOR UPDATE SKIP LOCKED LIMIT 1
         ) RETURNING *`,
      );
      const event = claimed.rows[0];
      if (!event) break;
      const startedAt = Date.now();
      try {
        // Keep already-received history, but retire queued generic updates before
        // any store lookup, provider request or order mutation (including retries).
        if (event.topic === 'orders/update') {
          const ignored = await query(
            `UPDATE shoplazza_webhook_events SET status = 'ignored', processed_at = now(),
               processing_started_at = NULL, next_attempt_at = NULL, error_message = NULL, updated_at = now()
             WHERE id = $1 AND status = 'processing' AND attempts = $2`,
            [event.id, event.attempts],
          );
          if ((ignored.rowCount ?? 0) > 0) processed++;
          continue;
        }
        const store = await getStoreBySubdomain(event.store_subdomain);
        if (!store?.enabled) throw new Error('Store is not enabled');
        const parsed = parseOrderStatusWebhook(event.topic, event.payload_json);
        const existing = await query(
          `SELECT EXISTS (SELECT 1 FROM support_order_snapshots WHERE store_subdomain = $1 AND order_id = $2) AS found`,
          [event.store_subdomain, parsed.orderId],
        );
        let orderNumber = parsed.orderNumber;
        if (existing.rows[0]?.found) {
          const order = await getOrderForStatusUpdate({
            subdomain: event.store_subdomain, storeName: store.store_name, accessToken: store.access_token,
          }, parsed.orderId);
          const notifiedAt = Date.parse(event.payload_json?.order?.updated_at);
          // A lagging API replica must not consume a newer callback as an unchanged order.
          if (Number.isFinite(notifiedAt) && Date.parse(order.updated_at) < notifiedAt) {
            throw new Error('Order lookup has not reached the callback version');
          }
          const result = await applyOrderStatusUpdate({
            storeSubdomain: event.store_subdomain, storeName: store.store_name, order, topic: event.topic,
            completionEvent: event.topic === 'orders/finished' ? event.payload_json?.order : undefined,
          });
          if (event.topic === 'orders/finished' && result.skipReason === 'stale') {
            throw new Error('Current order lookup has not reached the stored version for completion evidence');
          }
          orderNumber = result.orderNumber || orderNumber;
        } else {
          await logSync({ source: 'webhook', action: 'order_status_update',
            storeSubdomain: event.store_subdomain, storeName: store.store_name,
            targetId: orderNumber || parsed.orderId, itemsTotal: 1, itemsSkipped: 1,
            durationMs: Date.now() - startedAt,
            detailJson: { topic: event.topic, reason: 'not_found', matchedRows: 0, changedRows: 0 },
          });
        }
        const completed = await query(
          `UPDATE shoplazza_webhook_events SET status = 'processed', processed_at = now(),
             processing_started_at = NULL, next_attempt_at = NULL, error_message = NULL,
             order_number = COALESCE(NULLIF($2, ''), order_number), updated_at = now()
           WHERE id = $1 AND status = 'processing' AND attempts = $3`,
          [event.id, orderNumber, event.attempts],
        );
        if ((completed.rowCount ?? 0) > 0) processed++;
      } catch (error: any) {
        const message = error?.name === 'ShoplazzaAddressApiError' && Number.isInteger(error.httpStatus) && error.httpStatus > 0
          ? `Shoplazza order lookup HTTP ${error.httpStatus}; queued for retry`
          : 'Order status synchronization failed; queued for retry';
        const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(7, Math.max(0, Number(event.attempts) - 1)));
        const deferred = await query(
          `UPDATE shoplazza_webhook_events SET status = 'failed', error_message = $2,
             processing_started_at = NULL, next_attempt_at = now() + ($3 * interval '1 second'), updated_at = now()
           WHERE id = $1 AND status = 'processing' AND attempts = $4`,
          [event.id, message, delaySeconds, event.attempts],
        );
        if ((deferred.rowCount ?? 0) > 0) {
          failed++;
          await logSync({ source: 'webhook', action: 'order_status_update', storeSubdomain: event.store_subdomain,
            targetId: event.order_number || event.order_id, itemsTotal: 1, status: 'failed', errorMessage: message,
            durationMs: Date.now() - startedAt,
            detailJson: { topic: event.topic, reason: 'retry', eventId: event.id, retryAfterSeconds: delaySeconds },
          });
          console.error(`[order-status-worker] event ${event.id} failed; retry in ${delaySeconds}s`);
        }
      }
    }
    return { processed, failed };
  };
  activeRun = run().finally(() => { activeRun = undefined; });
  return activeRun;
}
