import type { ShoplazzaStoreConfig } from './config';
import { query } from './pg';
import { getOrderDetail } from './shoplazza-client';
import { normalizeOrder } from './normalize-order';
import { mergeFulfillments, validateFulfillments } from './fulfillment-service';
import { withSnapshotShippingAddressGuard } from './shipping-address-guard';
import { logSync } from './log-service';

/** Recover data only. Never enter the paid webhook, email, or token workflow. */
export async function recoverMissingFulfillmentOrder(params: {
  store: ShoplazzaStoreConfig;
  orderId: string;
  topic?: string;
}): Promise<{ recovered: boolean; orderNumber: string }> {
  const { store, orderId, topic } = params;
  if (!store.subdomain.trim() || !orderId.trim()) throw new Error('Order recovery requires store and order IDs');
  const existing = await query(
    `SELECT order_number FROM support_order_snapshots WHERE store_subdomain = $1 AND order_id = $2 LIMIT 1`,
    [store.subdomain, orderId],
  );
  if (existing.rows.length) return { recovered: false, orderNumber: existing.rows[0].order_number || orderId };

  const started = Date.now();
  try {
    // A historical delivery is not authoritative enough to create an entire order.
    const detail = await getOrderDetail(store, orderId);
    if (!detail || String(detail.id) !== orderId) {
      throw new Error('Current order detail is unavailable or mismatched; queued for retry');
    }
    const normalized = normalizeOrder(store.subdomain, store.storeName, detail, []);
    if (!['paid', 'partially_refunded', 'refunded'].includes(normalized.paymentStatus)) {
      throw new Error('Current payment status is ineligible for fulfillment recovery; queued for retry');
    }
    if (!normalized.customerEmail || !Array.isArray(detail.line_items)) {
      throw new Error('Current paid order detail is incomplete; queued for retry');
    }
    const fulfillments = mergeFulfillments([], validateFulfillments(detail.fulfillments ?? []), { source: 'backfill' }).fulfillments;
    normalized.rawOrderJson = { ...normalized.rawOrderJson, fulfillments };

    const result = await withSnapshotShippingAddressGuard(normalized, () => getOrderDetail(store, orderId), async (client, guarded) => {
      // The guard holds the business-order advisory lock. Recheck ALL email rows
      // after acquiring it so a concurrent paid/backfill insert wins unchanged.
      const inserted = await client.query(
        `INSERT INTO support_order_snapshots
          (store_subdomain, store_name, order_id, order_number, customer_email, customer_name,
           order_status, fulfillment_status, order_amount, order_currency,
           payment_status, payment_method, paid_at, refund_status, refund_amount,
           transaction_id_masked, card_last4, items_json, shipping_address_json,
           billing_address_json, logistics_json, payment_detail_json, raw_order_json, snapshot_source)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                $18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb,'fulfillment_recovery'
         WHERE NOT EXISTS (
           SELECT 1 FROM support_order_snapshots WHERE store_subdomain = $1 AND order_id = $3
         )
         ON CONFLICT (store_subdomain, order_id, customer_email) DO NOTHING
         RETURNING id`,
        [guarded.storeSubdomain, guarded.storeName, guarded.orderId, guarded.orderNumber,
          guarded.customerEmail, guarded.customerName, guarded.orderStatus, guarded.fulfillmentStatus,
          guarded.orderAmount, guarded.orderCurrency, guarded.paymentStatus, guarded.paymentMethod,
          guarded.paidAt, guarded.refundStatus, guarded.refundAmount, guarded.transactionIdMasked,
          guarded.cardLast4, JSON.stringify(guarded.itemsJson), JSON.stringify(guarded.shippingAddressJson),
          JSON.stringify(guarded.billingAddressJson), JSON.stringify(guarded.logisticsJson),
          JSON.stringify(guarded.paymentDetailJson), JSON.stringify(guarded.rawOrderJson)],
      );
      if (inserted.rowCount) {
        // Commit the snapshot and notification policy together. The marker survives
        // later paid/backfill upserts, email changes, and email-job cleanup.
        await client.query(
          `INSERT INTO support_order_notification_suppressions (store_subdomain, order_id, reason)
           VALUES ($1, $2, 'fulfillment_recovery') ON CONFLICT (store_subdomain, order_id) DO NOTHING`,
          [store.subdomain, orderId],
        );
      }
      return inserted;
    });
    const recovered = (result.rowCount ?? 0) > 0;
    if (recovered) {
      await logSync({ source: 'webhook', action: 'fulfillment_order_recovered', storeSubdomain: store.subdomain,
        storeName: store.storeName, targetId: normalized.orderNumber || orderId, itemsTotal: 1, itemsNew: 1,
        status: 'success', durationMs: Date.now() - started,
        detailJson: { topic, orderId, notificationsSuppressed: true, emailJobsCreated: 0 } });
    }
    return { recovered, orderNumber: normalized.orderNumber || orderId };
  } catch (error) {
    await logSync({ source: 'webhook', action: 'fulfillment_order_recovered', storeSubdomain: store.subdomain,
      storeName: store.storeName, targetId: orderId, itemsTotal: 1, status: 'failed', durationMs: Date.now() - started,
      errorMessage: error instanceof Error ? error.message : 'Order recovery failed; queued for retry',
      detailJson: { topic, orderId, emailJobsCreated: 0 } });
    throw error;
  }
}
