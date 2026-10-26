import crypto from 'crypto';
import { query } from './pg';
import { getStoreBySubdomain } from './store-service';
import { applyFulfillmentUpdate, validateFulfillments } from './fulfillment-service';

export const FULFILLMENT_WEBHOOK_TOPICS = [
  'orders/fulfilled', 'orders/partially_fulfilled',
  'fulfillments/create', 'fulfillments/update',
];

function identifier(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return '';
}

export function parseFulfillmentWebhook(topic: string, payload: any) {
  if (!FULFILLMENT_WEBHOOK_TOPICS.includes(topic)) throw new Error('Unsupported fulfillment event');
  const individual = topic.startsWith('fulfillments/');
  const orderId = identifier(individual ? payload?.fulfillment?.order_id : payload?.order?.id);
  const fulfillments = individual ? [payload?.fulfillment] : payload?.order?.fulfillments;
  if (!orderId || !Array.isArray(fulfillments) || (individual && !fulfillments.length)
    || fulfillments.some(item => !item || typeof item !== 'object' || Array.isArray(item) || !identifier(item.id))) {
    throw new Error('Invalid fulfillment payload: order and fulfillment IDs are required');
  }
  if (fulfillments.some(item => item.order_id !== undefined && identifier(item.order_id) !== orderId)) {
    throw new Error('Invalid fulfillment payload: mixed order IDs');
  }
  const validated = validateFulfillments(fulfillments);
  return {
    orderId,
    orderNumber: individual ? '' : identifier(payload.order.number || payload.order.order_number),
    fulfillments: validated,
    fulfillmentStatus: individual ? undefined : identifier(payload.order.fulfillment_status),
  };
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function fulfillmentEventKey(store: string, topic: string, payload: unknown, deduplicationId?: string): string {
  const identity = deduplicationId?.trim() ? `delivery:${deduplicationId.trim()}` : `payload:${stableJson(payload)}`;
  return `fulfillment:${store}:${topic}:${crypto.createHash('sha256').update(identity).digest('hex')}`;
}

/** Persist before acknowledging receipt. Processing and retries never enter the paid/mail path. */
export async function enqueueFulfillmentWebhook(params: {
  storeSubdomain: string;
  topic: string;
  payload: unknown;
  headers: Record<string, unknown>;
}): Promise<void> {
  const parsed = parseFulfillmentWebhook(params.topic, params.payload);
  const dedup = params.headers['x-shoplazza-deduplication-id'];
  const key = fulfillmentEventKey(params.storeSubdomain, params.topic, params.payload, typeof dedup === 'string' ? dedup : undefined);
  const headers = Object.fromEntries([
    'x-shoplazza-topic', 'x-shoplazza-shop-domain', 'x-shoplazza-api-version',
    'x-shoplazza-deduplication-id', 'content-type', 'user-agent',
  ].filter(name => typeof params.headers[name] === 'string').map(name => [name, params.headers[name]]));
  await query(
    `INSERT INTO shoplazza_webhook_events
       (event_key, store_subdomain, topic, order_id, order_number, payload_json, headers_json, status, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'received', now())
     ON CONFLICT (event_key) DO NOTHING`,
    [key, params.storeSubdomain, params.topic, parsed.orderId, parsed.orderNumber || null,
      JSON.stringify(params.payload), JSON.stringify(headers)],
  );
}

let activeRun: Promise<{ processed: number; failed: number }> | undefined;

export function processPendingFulfillmentWebhooks(options: { limit?: number } = {}): Promise<{ processed: number; failed: number }> {
  if (activeRun) return activeRun;
  const run = async () => {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit || 50)));
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < limit; i++) {
      // SKIP LOCKED and the atomic claim also protect against a second worker process.
      const claimed = await query(
        `UPDATE shoplazza_webhook_events SET status = 'processing', processing_started_at = now(),
           attempts = attempts + 1, updated_at = now()
         WHERE id = (
           SELECT id FROM shoplazza_webhook_events
           WHERE event_key LIKE 'fulfillment:%'
             AND ((status IN ('received', 'failed') AND COALESCE(next_attempt_at, received_at) <= now())
               OR (status = 'processing' AND processing_started_at < now() - interval '10 minutes'))
           ORDER BY COALESCE(next_attempt_at, received_at), id
           FOR UPDATE SKIP LOCKED LIMIT 1
         ) RETURNING *`,
      );
      const event = claimed.rows[0];
      if (!event) break;
      try {
        const store = await getStoreBySubdomain(event.store_subdomain);
        if (!store?.enabled) throw new Error('Store is not currently enabled');
        const parsed = parseFulfillmentWebhook(event.topic, event.payload_json);
        const result = await applyFulfillmentUpdate({
          storeSubdomain: event.store_subdomain,
          storeName: store.store_name,
          ...parsed,
          source: 'webhook',
          topic: event.topic,
        });
        if (!result.matched) throw new Error('Order snapshot is not available yet; queued for retry');
        await query(
          `UPDATE shoplazza_webhook_events SET status = 'processed', processed_at = now(),
             processing_started_at = NULL, next_attempt_at = NULL, error_message = NULL,
             order_number = COALESCE(NULLIF($2, ''), order_number), updated_at = now() WHERE id = $1`,
          [event.id, result.orderNumber],
        );
        processed++;
      } catch (error: any) {
        const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(7, Math.max(0, Number(event.attempts) - 1)));
        await query(
          `UPDATE shoplazza_webhook_events SET status = 'failed', error_message = $2,
             processing_started_at = NULL, next_attempt_at = now() + ($3 * interval '1 second'),
             updated_at = now() WHERE id = $1`,
          [event.id, String(error.message || 'Fulfillment processing failed').slice(0, 500), delaySeconds],
        );
        failed++;
        console.error(`[fulfillment-worker] event ${event.id} failed; retry in ${delaySeconds}s`);
      }
    }
    return { processed, failed };
  };
  activeRun = run().finally(() => { activeRun = undefined; });
  return activeRun;
}
