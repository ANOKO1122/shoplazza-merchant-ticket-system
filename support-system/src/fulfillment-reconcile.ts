import { getClient } from './pg';
import { getEnabledStores } from './store-service';
import { listOrderFulfillments, listOrderFulfillmentsBatch } from './shoplazza-client';
import { applyFulfillmentUpdate } from './fulfillment-service';
import { logSync } from './log-service';
import { FULFILLMENT_CANDIDATES_SQL, FULFILLMENT_REMAINING_SQL } from './fulfillment-selection';

const PER_STORE_LIMIT = 1000;
const API_BATCH_SIZE = 50;
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
  priority: boolean;
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
  priorityChecked: number;
  apiBatches: number;
  perStoreLimit: number;
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
  priorityChecked: number;
  apiBatches: number;
}

function emptySummary(): FulfillmentReconcileSummary {
  return { checked: 0, failed: 0, changed: 0, added: 0, updated: 0, remainingDue: 0, priorityChecked: 0, apiBatches: 0, skipped: false, stores: [] };
}

/**
 * 每店独立配额：近 30 天下单的已支付订单，以及近 30 天有工单活动的老订单。
 * 重点工单优先，首次检查和到期复查轮转；按订单 ID 批量拉取，不触发订单恢复或邮件。
 */
export async function runFulfillmentReconciliation(options: {
  limit?: number; // Per-store quota; explicit single-order checks remain supported.
  storeSubdomain?: string;
  orderId?: string;
} = {}): Promise<FulfillmentReconcileSummary> {
  const summary = emptySummary();
  if (running) return { ...summary, skipped: true, reason: 'already_running' };
  const requestedLimit = options.limit ?? PER_STORE_LIMIT;
  if (!Number.isFinite(requestedLimit) || requestedLimit < 1) throw new Error('Fulfillment batch limit must be positive');
  const limit = Math.min(PER_STORE_LIMIT, Math.floor(requestedLimit));
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
      const candidates = await client.query(FULFILLMENT_CANDIDATES_SQL, [storeNames, orderId, orderId ? 2 : limit]);
      if (orderId && candidates.rows.length !== 1) {
        throw new Error(candidates.rows.length === 0
          ? 'No paid snapshot matches the requested order'
          : 'Order ID matches multiple stores; specify storeSubdomain');
      }

      const summaries = new Map<string, FulfillmentReconcileStoreSummary>(stores.map(store => [store.subdomain, {
        storeSubdomain: store.subdomain,
        storeName: store.store_name || store.subdomain,
        checked: 0, failed: 0, changed: 0, added: 0, updated: 0, remainingDue: 0, durationMs: 0, items: [],
        priorityChecked: 0, apiBatches: 0, perStoreLimit: limit,
      }]));

      for (const store of storeMap.values()) {
        const result = summaries.get(store.subdomain)!;
        const storeCandidates = candidates.rows.filter(candidate => candidate.store_subdomain === store.subdomain);
        for (let offset = 0; offset < storeCandidates.length; offset += API_BATCH_SIZE) {
          const batch = storeCandidates.slice(offset, offset + API_BATCH_SIZE);
          const batchStartedAt = Date.now();
          const attemptedAt = new Date().toISOString();
          const apiStore = {
            subdomain: store.subdomain,
            storeName: store.store_name || store.subdomain,
            accessToken: store.access_token,
          };
          let fetched = new Map<string, Record<string, unknown>[]>();
          let batchError: unknown;
          result.apiBatches++;
          try {
            fetched = orderId
              ? new Map([[orderId, await listOrderFulfillments(apiStore, orderId)]])
              : await listOrderFulfillmentsBatch(apiStore, batch.map(candidate => candidate.order_id));
          } catch (error) { batchError = error; }
          result.durationMs += Date.now() - batchStartedAt;
          for (const candidate of batch) {
            const checkStartedAt = Date.now();
            const priority = candidate.priority === true;
            result.checked++;
            if (priority) result.priorityChecked++;
            try {
              if (batchError) throw batchError;
              const fulfillments = fetched.get(candidate.order_id);
              if (!fulfillments) throw new Error('Order not returned by batch fulfillment lookup');
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
                 VALUES ($1, $2, $3, now(), now() + make_interval(hours => $4), NULL)
                 ON CONFLICT (store_subdomain, order_id) DO UPDATE SET
                   last_attempt_at = EXCLUDED.last_attempt_at,
                   last_checked_at = EXCLUDED.last_checked_at,
                   next_check_at = EXCLUDED.next_check_at,
                   last_error = NULL`,
                [store.subdomain, candidate.order_id, attemptedAt, priority ? 6 : 24],
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
                priority,
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
                changes: [], trackingNumbers: [], priority, error: message,
              });
            } finally {
              result.durationMs += Date.now() - checkStartedAt;
            }
          }
        }
      }

      const due = await client.query(FULFILLMENT_REMAINING_SQL, [storeNames, null]);
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
        summary.priorityChecked += result.priorityChecked;
        summary.apiBatches += result.apiBatches;
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
