/**
 * 兜底任务（订单自动增量查漏）
 *
 * 每小时/手动触发，扫描所有启用店铺的已支付订单，
 * 按 updated_at 增量拉取，补全快照 & 邮件任务。
 *
 * 策略：
 *  - 列表接口只拉 financial_status=paid + updated_at 范围内的订单
 *  - 只对 shoplazzapayment 渠道查 transactions（拿卡号后四位）
 *  - 第三方支付（paypal/shoplazzaapple 等）跳过交易查询
 *  - snapshot 幂等 UPSERT，email job 幂等 INSERT（event_key 去重）
 *  - 首次同步（last_synced_at 为空）时，拉取最近 24 小时的订单
 */
import { getEnabledStores, StoreRecord } from './store-service';
import { query } from './pg';
import { listPaidOrdersCreatedSince, getOrderTransactions, ShoplazzaOrderDetail } from './shoplazza-client';
import { normalizeOrder } from './normalize-order';
import { createPaidSupportInviteEmailJob } from './email-service';
import { logSync, logOperation } from './log-service';
import { buildStoreDomain } from './config';

// ── 状态管理 ──

export interface BackfillState {
  storeSubdomain: string;
  lastSyncedAt: string | null;
  lastStatus: string;
  lastResultJson: Record<string, unknown> | null;
}

export async function getBackfillState(storeSubdomain: string): Promise<BackfillState | null> {
  const r = await query(
    `SELECT store_subdomain, last_synced_at, last_status, last_result_json
     FROM support_backfill_state WHERE store_subdomain = $1`,
    [storeSubdomain],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    storeSubdomain: row.store_subdomain,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastStatus: row.last_status,
    lastResultJson: row.last_result_json || null,
  };
}

export async function getAllBackfillStates(): Promise<BackfillState[]> {
  const r = await query(
    `SELECT store_subdomain, last_synced_at, last_status, last_result_json
     FROM support_backfill_state ORDER BY store_subdomain`,
  );
  return r.rows.map(row => ({
    storeSubdomain: row.store_subdomain,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastStatus: row.last_status,
    lastResultJson: row.last_result_json || null,
  }));
}

// ── 自动兜底开关 ──

export async function getAutoBackfillEnabled(): Promise<boolean> {
  const r = await query(`SELECT auto_backfill_enabled FROM support_email_settings WHERE id = 1`);
  return r.rows[0]?.auto_backfill_enabled ?? false;
}

export async function setAutoBackfillEnabled(enabled: boolean): Promise<void> {
  await query(
    `UPDATE support_email_settings SET auto_backfill_enabled = $1, updated_at = now() WHERE id = 1`,
    [enabled],
  );
}

async function setBackfillStatus(storeSubdomain: string, status: string): Promise<void> {
  await query(
    `INSERT INTO support_backfill_state (store_subdomain, last_status, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (store_subdomain) DO UPDATE SET last_status = $2, updated_at = now()`,
    [storeSubdomain, status],
  );
}

async function saveBackfillResult(
  storeSubdomain: string,
  result: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO support_backfill_state (store_subdomain, last_status, last_synced_at, last_result_json, updated_at)
     VALUES ($1, 'idle', $2, $3, now())
     ON CONFLICT (store_subdomain)
     DO UPDATE SET last_status = 'idle', last_synced_at = $2, last_result_json = $3, updated_at = now()`,
    [storeSubdomain, result.syncedAt, JSON.stringify(result)],
  );
}

// ── 兜底同步核心 ──

/** 需要查卡号的支付渠道（店匠自有支付） */
const CARD_LOOKUP_CHANNELS = ['shoplazzapayment'];

export interface BackfillResult {
  storeSubdomain: string;
  syncedAt: string;
  pages: number;
  ordersFound: number;
  snapshotsInserted: number;
  snapshotsUpdated: number;
  emailJobsCreated: number;
  cardLookups: number;
  errors: string[];
}

async function backfillOneStore(
  store: StoreRecord,
  createdAtMin: string,
  createdAtMax: string,
  onProgress?: (msg: string) => void,
): Promise<BackfillResult> {
  const log = (msg: string) => {
    console.log(`[backfill:${store.subdomain}] ${msg}`);
    if (onProgress) onProgress(`[${store.subdomain}] ${msg}`);
  };

  const errors: string[] = [];
  let pages = 0;
  let cardLookups = 0;
  let snapshotsInserted = 0;
  let snapshotsUpdated = 0;
  let emailJobsCreated = 0;

  const storeConfig = {
    subdomain: store.subdomain,
    storeName: store.store_name || store.subdomain,
    accessToken: store.access_token,
  };

  // Step 1: 按 created_at（下单时间）增量拉取已支付订单列表
  log(`开始增量拉取（按下单时间）: ${createdAtMin} → ${createdAtMax}`);
  let accumulatedOrders = 0;
  const allOrders = await listPaidOrdersCreatedSince(
    storeConfig,
    createdAtMin,
    createdAtMax,
    (page, pageOrders) => {
      pages = page;
      accumulatedOrders += pageOrders.length;
      log(`第 ${page} 页: ${pageOrders.length} 条, 累计 ${accumulatedOrders} 条`);
    },
  );
  log(`拉取完成: ${pages} 页, 共 ${allOrders.length} 条已支付订单`);

  // 记录列表拉取汇总
  const t0 = Date.now();

  // Step 2: 逐条处理
  for (const order of allOrders) {
    try {
      const orderId = String(order.id || '').trim();
      const orderNumber = String(order.number || order.order_number || '').trim();
      if (!orderId) continue;

      // 判断是否需要查卡号（已存在快照则跳过，节省 API 次数）
      const existingSnapshot = await query(
        `SELECT card_last4 FROM support_order_snapshots WHERE store_subdomain=$1 AND order_id=$2 AND customer_email=$3`,
        [store.subdomain, orderId, String((order as any)?.customer?.email || (order as any)?.shipping_address?.email || (order as any)?.billing_address?.email || '').trim().toLowerCase()]
      ).catch(() => ({ rows: [] }));
      
      const paymentChannel = String(
        (order.payment_line as any)?.payment_channel || ''
      ).toLowerCase();

      let cardTransactions: any[] = [];
      if (existingSnapshot.rows.length === 0 && CARD_LOOKUP_CHANNELS.some(ch => paymentChannel.includes(ch))) {
        cardLookups++;
        cardTransactions = await getOrderTransactions(storeConfig, orderId);
      }

      // 标准化
      const normalized = normalizeOrder(
        store.subdomain,
        store.store_name || store.subdomain,
        order,
        cardTransactions,
      );

      // Step 3: 幂等写入快照（区分新增 vs 更新）
      const upsertResult = await query(
        `INSERT INTO support_order_snapshots
          (store_subdomain, store_name, order_id, order_number, customer_email, customer_name,
           order_status, fulfillment_status, order_amount, order_currency,
           payment_status, payment_method, paid_at, refund_status, refund_amount,
           transaction_id_masked, card_last4,
           items_json, shipping_address_json, billing_address_json, logistics_json,
           payment_detail_json, raw_order_json,
           snapshot_source, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
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
           snapshot_source = 'backfill_sync',
           updated_at = now()
         RETURNING (xmax = 0) AS is_insert`,
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
          'backfill_sync',
          new Date().toISOString(),
        ],
      );
      if (upsertResult.rows[0]?.is_insert) {
        snapshotsInserted++;
      } else {
        snapshotsUpdated++;
      }

      // Step 4: 幂等创建邮件任务（仅 paid 状态）
      if (normalized.paymentStatus === 'paid' && normalized.customerEmail) {
        const { inserted } = await createPaidSupportInviteEmailJob({
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
          jobSource: 'backfill',
        });
        if (inserted) emailJobsCreated++;
      }
    } catch (e: any) {
      const errMsg = `订单 ${order.id || '?'} 处理失败: ${e.message}`;
      log(errMsg);
      errors.push(errMsg);
    }
  }

  return {
    storeSubdomain: store.subdomain,
    syncedAt: createdAtMax,
    pages,
    ordersFound: allOrders.length,
    snapshotsInserted,
    snapshotsUpdated,
    emailJobsCreated,
    cardLookups,
    errors,
  };
}

/** 内部用的包装：附带日志记录 */
async function backfillOneStoreWithLogging(
  store: StoreRecord,
  createdAtMin: string,
  createdAtMax: string,
  onProgress?: (msg: string) => void,
): Promise<BackfillResult> {
  const startMs = Date.now();
  const result = await backfillOneStore(store, createdAtMin, createdAtMax, onProgress);
  const durationMs = Date.now() - startMs;

  // sync_log: 兜底汇总
  await logSync({
    source: 'backfill',
    action: 'backfill_summary',
    storeSubdomain: store.subdomain,
    storeName: store.store_name || store.subdomain,
    targetId: `${store.subdomain} (${result.pages}页)`,
    itemsTotal: result.ordersFound,
    itemsNew: result.snapshotsInserted,
    itemsUpdated: result.snapshotsUpdated,
    itemsSkipped: 0,
    status: result.errors.length > 0 ? 'partial' : 'success',
    errorMessage: result.errors.slice(0, 3).join('; ') || undefined,
    durationMs,
    detailJson: {
      pages: result.pages,
      cardLookups: result.cardLookups,
      emailJobsCreated: result.emailJobsCreated,
      errors: result.errors,
    },
  });

  // operation_log: 兜底完成
  await logOperation({
    category: 'backfill',
    action: 'backfill_store_complete',
    actor: 'system',
    storeSubdomain: store.subdomain,
    summary: `兜底同步完成: ${result.ordersFound} 订单, ${result.snapshotsInserted} 新增, ${result.snapshotsUpdated} 更新, ${result.emailJobsCreated} 新邮件${result.errors.length ? `, ${result.errors.length} 个错误` : ''}`,
    status: result.errors.length > 0 ? 'partial' : 'success',
    detailJson: {
      ordersFound: result.ordersFound,
      snapshotsInserted: result.snapshotsInserted,
      snapshotsUpdated: result.snapshotsUpdated,
      emailJobsCreated: result.emailJobsCreated,
      cardLookups: result.cardLookups,
      pages: result.pages,
      durationMs,
      errors: result.errors,
    },
  });

  return result;
}

/**
 * 对单个店铺执行兜底同步（供 API 调用）。
 * 自动计算时间范围：从上次同步时间到当前时间。
 */
export async function runBackfillForStore(
  storeSubdomain: string,
  onProgress?: (msg: string) => void,
): Promise<BackfillResult | null> {
  const stores = await getEnabledStores();
  const store = stores.find(s => s.subdomain === storeSubdomain);
  if (!store) {
    if (onProgress) onProgress(`店铺 ${storeSubdomain} 未找到或已禁用`);
    return null;
  }

  // 设置运行中状态
  await setBackfillStatus(storeSubdomain, 'running');

  // 计算时间范围：按 created_at（下单时间），上次同步时间为空时 → 最近 24 小时
  const existing = await getBackfillState(storeSubdomain);
  const now = new Date();
  const createdAtMax = now.toISOString();
  let createdAtMin: string;
  if (existing?.lastSyncedAt) {
    createdAtMin = existing.lastSyncedAt;
  } else {
    // 首次同步：回退 24 小时
    const ago = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    createdAtMin = ago.toISOString();
  }

  try {
    const result = await backfillOneStoreWithLogging(store, createdAtMin, createdAtMax, onProgress);
    await saveBackfillResult(storeSubdomain, {
      syncedAt: result.syncedAt,
      pages: result.pages,
      ordersFound: result.ordersFound,
      snapshotsInserted: result.snapshotsInserted,
      snapshotsUpdated: result.snapshotsUpdated,
      emailJobsCreated: result.emailJobsCreated,
      cardLookups: result.cardLookups,
      errors: result.errors.length,
      lastError: result.errors.slice(0, 3).join('; '),
    });
    return result;
  } catch (e: any) {
    await setBackfillStatus(storeSubdomain, 'failed');
    throw e;
  }
}

/**
 * 对所有启用店铺执行兜底同步。
 */
export async function runBackfillForAllStores(
  onProgress?: (msg: string) => void,
): Promise<BackfillResult[]> {
  const stores = await getEnabledStores();
  const results: BackfillResult[] = [];

  for (const store of stores) {
    try {
      const result = await runBackfillForStore(store.subdomain, onProgress);
      if (result) results.push(result);
    } catch (e: any) {
      if (onProgress) onProgress(`[${store.subdomain}] 兜底失败: ${e.message}`);
      await setBackfillStatus(store.subdomain, 'failed');
    }
  }

  return results;
}
