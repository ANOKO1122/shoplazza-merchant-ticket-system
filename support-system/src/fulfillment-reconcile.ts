import { getClient } from './pg';
import { getEnabledStores } from './store-service';
import { listOrderFulfillments } from './shoplazza-client';
import { applyFulfillmentUpdate } from './fulfillment-service';
import { logSync } from './log-service';

const BATCH_LIMIT = 200;
const LOCK_NAMESPACE = 0x534650;
const LOCK_ID = 1;
let running = false;

export interface FulfillmentReconcileItem {
  orderId: string;
  orderNumber: string;
  status: 'changed' | 'unchanged' | 'failed';
  added: number;
  updated: number;
  unchanged: number;
  stale: number;
  trackingNumbers: string[];
  changes: unknown[];
  error?: string;
}

export interface FulfillmentReconcileStoreSummary {
  storeSubdomain: string;
  storeName: string;
  checked: number;
  failed: number;
  changed: number;
  added: number;
  updated: number;
  remainingDue: number;
  durationMs: number;
  items: FulfillmentReconcileItem[];
}

export interface FulfillmentReconcileSummary {
  checked: number;
  failed: number;
  changed: number;
  added: number;
  updated: number;
  remainingDue: number;
  skipped: boolean;
  reason?: 'already_running' | 'locked_by_another_process';
  stores: FulfillmentReconcileStoreSummary[];
}

function emptySummary(): FulfillmentReconcileSummary {
  return { checked: 0, failed: 0, changed: 0, added: 0, updated: 0, remainingDue: 0, skipped: false, stores: [] };
}

/**
 * 对全部已支付快照按订单去重选单，不使用下单时间增量游标。
 * 首次待查与到期复查交错选择：初次优先近期订单，重试和老订单按到期时间轮转。
 */
export async function runFulfillmentReconciliation(options: {
  limit?: number;
  storeSubdomain?: string;
  orderId?: string;
} = {}): Promise<FulfillmentReconcileSummary> {
  const summary = emptySummary();
  if (running) return { ...summary, skipped: true, reason: 'already_running' };
  const requestedLimit = options.limit ?? BATCH_LIMIT;
  if (!Number.isFinite(requestedLimit) || requestedLimit < 1) throw new Error('Fulfillment batch limit must be positive');
  const limit = Math.min(BATCH_LIMIT, Math.floor(requestedLimit));
  const orderId = options.orderId?.trim() || null;
  const storeSubdomain = options.storeSubdomain?.trim() || null;
  running = true;
  const startedAt = Date.now();

  try {
    const client = await getClient();
    let locked = false;
    let releaseError: Error | undefined;
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [LOCK_NAMESPACE, LOCK_ID]);
      locked = lock.rows[0]?.locked === true;
      if (!locked) return { ...summary, skipped: true, reason: 'locked_by_another_process' };

      const stores = (await getEnabledStores()).filter(store => !storeSubdomain || store.subdomain === storeSubdomain);
      if (storeSubdomain && stores.length === 0) throw new Error(`Store is missing or disabled: ${storeSubdomain}`);
      if (stores.length === 0) return summary;
      const storeMap = new Map(stores.map(store => [store.subdomain, store]));
      const storeNames = stores.map(store => store.subdomain);
      const candidates = await client.query(
        `WITH paid_orders AS (
           SELECT snapshot.store_subdomain, snapshot.order_id,
                  MAX(snapshot.order_number) AS order_number,
                  MAX(COALESCE(snapshot.paid_at, snapshot.created_at)) AS ordered_at
           FROM support_order_snapshots snapshot
           WHERE snapshot.payment_status IN ('paid', 'partially_refunded')
             AND snapshot.store_subdomain = ANY($1::text[])
             AND ($2::text IS NULL OR snapshot.order_id = $2)
           GROUP BY snapshot.store_subdomain, snapshot.order_id
         ), due_orders AS (
           SELECT paid.*, state.last_attempt_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY (state.last_attempt_at IS NULL)
                    ORDER BY
                      CASE WHEN state.last_attempt_at IS NOT NULL THEN state.next_check_at END ASC NULLS FIRST,
                      CASE WHEN state.last_attempt_at IS NULL THEN paid.ordered_at END DESC NULLS LAST,
                      paid.store_subdomain, paid.order_id
                  ) AS queue_position
           FROM paid_orders paid
           LEFT JOIN support_fulfillment_sync_state state
             ON state.store_subdomain = paid.store_subdomain AND state.order_id = paid.order_id
           WHERE $2::text IS NOT NULL OR state.next_check_at IS NULL OR state.next_check_at <= now()
         )
         SELECT store_subdomain, order_id, order_number
         FROM due_orders
         ORDER BY queue_position, (last_attempt_at IS NULL), store_subdomain, order_id
         LIMIT $3`,
        [storeNames, orderId, orderId ? 2 : limit],
      );
      if (orderId && candidates.rows.length !== 1) {
        throw new Error(candidates.rows.length === 0
          ? 'No paid snapshot matches the requested order'
          : 'Order ID matches multiple stores; specify storeSubdomain');
      }

      const summaries = new Map<string, FulfillmentReconcileStoreSummary>(stores.map(store => [store.subdomain, {
        storeSubdomain: store.subdomain,
        storeName: store.store_name || store.subdomain,
        checked: 0, failed: 0, changed: 0, added: 0, updated: 0, remainingDue: 0, durationMs: 0, items: [],
      }]));

      for (const candidate of candidates.rows) {
        const store = storeMap.get(candidate.store_subdomain)!;
        const result = summaries.get(store.subdomain)!;
        const checkStartedAt = Date.now();
        const attemptedAt = new Date().toISOString();
        result.checked++;
        try {
          const fulfillments = await listOrderFulfillments({
            subdomain: store.subdomain,
            storeName: store.store_name || store.subdomain,
            accessToken: store.access_token,
          }, candidate.order_id);
          const applied = await applyFulfillmentUpdate({
            storeSubdomain: store.subdomain,
            storeName: result.storeName,
            orderId: candidate.order_id,
            orderNumber: candidate.order_number || candidate.order_id,
            fulfillments,
            source: 'backfill',
          });
          if (!applied.matched) throw new Error('No order snapshot matched the fulfillment update');
          await client.query(
            `INSERT INTO support_fulfillment_sync_state
               (store_subdomain, order_id, last_attempt_at, last_checked_at, next_check_at, last_error)
             VALUES ($1, $2, $3, now(), now() + interval '24 hours', NULL)
             ON CONFLICT (store_subdomain, order_id) DO UPDATE SET
               last_attempt_at = EXCLUDED.last_attempt_at,
               last_checked_at = EXCLUDED.last_checked_at,
               next_check_at = EXCLUDED.next_check_at,
               last_error = NULL`,
            [store.subdomain, candidate.order_id, attemptedAt],
          );
          const changed = applied.added + applied.updated > 0;
          result.changed += changed ? 1 : 0;
          result.added += applied.added;
          result.updated += applied.updated;
          result.items.push({
            orderId: candidate.order_id,
            orderNumber: candidate.order_number || candidate.order_id,
            status: changed ? 'changed' : 'unchanged',
            added: applied.added,
            updated: applied.updated,
            unchanged: applied.unchanged,
            stale: applied.stale,
            changes: applied.changes,
            trackingNumbers: applied.trackingNumbers,
          });
        } catch (error: any) {
          const message = String(error?.message || error).slice(0, 1000);
          // 失败仅记重试时间，保留最近一次成功检查时间。
          await client.query(
            `INSERT INTO support_fulfillment_sync_state
               (store_subdomain, order_id, last_attempt_at, next_check_at, last_error)
             VALUES ($1, $2, $3, now() + interval '1 hour', $4)
             ON CONFLICT (store_subdomain, order_id) DO UPDATE SET
               last_attempt_at = EXCLUDED.last_attempt_at,
               next_check_at = EXCLUDED.next_check_at,
               last_error = EXCLUDED.last_error`,
            [store.subdomain, candidate.order_id, attemptedAt, message],
          );
          result.failed++;
          result.items.push({
            orderId: candidate.order_id,
            orderNumber: candidate.order_number || candidate.order_id,
            status: 'failed', added: 0, updated: 0, unchanged: 0, stale: 0,
            changes: [], trackingNumbers: [], error: message,
          });
        } finally {
          result.durationMs += Date.now() - checkStartedAt;
        }
      }

      const due = await client.query(
        `SELECT paid.store_subdomain, COUNT(*)::int AS remaining_due
         FROM (
           SELECT DISTINCT store_subdomain, order_id
           FROM support_order_snapshots
           WHERE payment_status IN ('paid', 'partially_refunded') AND store_subdomain = ANY($1::text[])
         ) paid
         LEFT JOIN support_fulfillment_sync_state state
           ON state.store_subdomain = paid.store_subdomain AND state.order_id = paid.order_id
         WHERE state.next_check_at IS NULL OR state.next_check_at <= now()
         GROUP BY paid.store_subdomain`,
        [storeNames],
      );
      for (const row of due.rows) summaries.get(row.store_subdomain)!.remainingDue = Number(row.remaining_due);
      summary.stores = [...summaries.values()];
      const batchDurationMs = Date.now() - startedAt;
      for (const result of summary.stores) {
        summary.checked += result.checked;
        summary.failed += result.failed;
        summary.changed += result.changed;
        summary.added += result.added;
        summary.updated += result.updated;
        summary.remainingDue += result.remainingDue;
        if (result.checked === 0) continue;
        await logSync({
          source: 'backfill',
          action: 'fulfillment_reconcile_summary',
          storeSubdomain: result.storeSubdomain,
          storeName: result.storeName,
          itemsTotal: result.checked,
          itemsNew: result.items.filter(item => item.added > 0).length,
          itemsUpdated: result.items.filter(item => item.added === 0 && item.updated > 0).length,
          itemsSkipped: result.checked - result.failed - result.changed,
          status: result.failed === 0 ? 'success' : result.failed === result.checked ? 'failed' : 'partial',
          errorMessage: result.items.filter(item => item.error).slice(0, 3).map(item => item.error).join('; ') || undefined,
          durationMs: result.durationMs,
          detailJson: { ...result, batchDurationMs },
        });
      }
      return summary;
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, LOCK_ID]);
        } catch (error: any) {
          releaseError = error instanceof Error ? error : new Error(String(error));
          console.error('[fulfillment-reconcile] Failed to release database lock:', releaseError.message);
        }
      }
      // 销毁无法解锁的连接，避免把仍持有 session lock 的连接放回池中。
      client.release(releaseError);
    }
  } finally {
    running = false;
  }
}
