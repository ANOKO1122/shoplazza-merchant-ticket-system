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
import { listPaidOrdersCreatedSince, listWaitingOrdersUpdatedSince, getOrderTransactions, ShoplazzaOrderDetail } from './shoplazza-client';
import { normalizeOrder } from './normalize-order';
import { createPaidSupportInviteEmailJob, extractStoreCustomDomain } from './email-service';
import { logSync, logOperation } from './log-service';
import { buildStoreDomain } from './config';

// ── 状态管理 ──

export interface BackfillState {
  storeSubdomain: string;
  lastSyncedAt: string | null;
  lastUnpaidSyncedAt: string | null;
  lastStatus: string;
  lastResultJson: Record<string, unknown> | null;
}

export async function getBackfillState(storeSubdomain: string): Promise<BackfillState | null> {
  const r = await query(
    `SELECT store_subdomain, last_synced_at, last_unpaid_synced_at, last_status, last_result_json
     FROM support_backfill_state WHERE store_subdomain = $1`,
    [storeSubdomain],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    storeSubdomain: row.store_subdomain,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastUnpaidSyncedAt: row.last_unpaid_synced_at ? new Date(row.last_unpaid_synced_at).toISOString() : null,
    lastStatus: row.last_status,
    lastResultJson: row.last_result_json || null,
  };
}

export async function getAllBackfillStates(): Promise<BackfillState[]> {
  const r = await query(
    `SELECT store_subdomain, last_synced_at, last_unpaid_synced_at, last_status, last_result_json
     FROM support_backfill_state ORDER BY store_subdomain`,
  );
  return r.rows.map(row => ({
    storeSubdomain: row.store_subdomain,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastUnpaidSyncedAt: row.last_unpaid_synced_at ? new Date(row.last_unpaid_synced_at).toISOString() : null,
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

      // 判断是否需要查卡号
      // 策略：快照不存在 → 查；快照存在但 card_last4 为空且是店匠自有支付 → 补查
      const existingSnapshot = await query(
        `SELECT card_last4 FROM support_order_snapshots WHERE store_subdomain=$1 AND order_id=$2 AND customer_email=$3`,
        [store.subdomain, orderId, String((order as any)?.customer?.email || (order as any)?.shipping_address?.email || (order as any)?.billing_address?.email || '').trim().toLowerCase()]
      ).catch(() => ({ rows: [] }));
      
      const paymentChannel = String(
        (order.payment_line as any)?.payment_channel
        || (Array.isArray(order.payment_lines) && order.payment_lines[0] ? (order.payment_lines[0] as any)?.payment_channel : '')
        || ''
      ).toLowerCase();

      const isShoplazzaPayment = CARD_LOOKUP_CHANNELS.some(ch => paymentChannel.includes(ch));
      const existingCardLast4 = existingSnapshot.rows[0]?.card_last4 || '';
      const needCardLookup = isShoplazzaPayment && (
        existingSnapshot.rows.length === 0 || !existingCardLast4
      );

      let cardTransactions: any[] = [];
      if (needCardLookup) {
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
           card_last4 = CASE WHEN EXCLUDED.card_last4 <> '' THEN EXCLUDED.card_last4 ELSE support_order_snapshots.card_last4 END,
           items_json = EXCLUDED.items_json,
           shipping_address_json = EXCLUDED.shipping_address_json,
           billing_address_json = EXCLUDED.billing_address_json,
           logistics_json = EXCLUDED.logistics_json,
           payment_detail_json = CASE WHEN EXCLUDED.payment_detail_json::text <> '{}'::text THEN EXCLUDED.payment_detail_json ELSE support_order_snapshots.payment_detail_json END,
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

const UNPAID_OVERLAP_MS = 5 * 60 * 1000;
const UNPAID_FIRST_WINDOW_MS = 60 * 60 * 1000;
const UNPAID_MAX_WINDOW_MS = 60 * 60 * 1000;
const UNPAID_MIN_WINDOW_MS = 1000;
const unpaidRuns = new Map<string, Promise<void>>();

async function saveUnpaidCursor(storeSubdomain: string, syncedAt: string): Promise<void> {
  await query(
    `INSERT INTO support_backfill_state (store_subdomain, last_status, last_unpaid_synced_at, updated_at)
     VALUES ($1, 'idle', $2, now())
     ON CONFLICT (store_subdomain) DO UPDATE SET
       last_unpaid_synced_at = GREATEST(support_backfill_state.last_unpaid_synced_at, EXCLUDED.last_unpaid_synced_at),
       updated_at = now()`,
    [storeSubdomain, syncedAt],
  );
}

/** 未支付订单按更新时间补进快照。没有邮箱的跳过，不打详情，不发邮件，也不改已支付进度。 */
async function backfillUnpaidWindow(
  store: StoreRecord,
  updatedAtMin: string,
  updatedAtMax: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const log = (msg: string) => {
    console.log(`[backfill-unpaid:${store.subdomain}] ${msg}`);
    if (onProgress) onProgress(`[${store.subdomain}] ${msg}`);
  };
  log(`未支付增量（按更新时间）: ${updatedAtMin} → ${updatedAtMax}`);

  const storeConfig = {
    subdomain: store.subdomain,
    storeName: store.store_name || store.subdomain,
    accessToken: store.access_token,
  };
  const started = Date.now();
  const orders = await listWaitingOrdersUpdatedSince(storeConfig, updatedAtMin, updatedAtMax);
  let saved = 0;
  let updated = 0;
  let skipped = 0;
  let keptPaid = 0;
  const orderLines: Array<{ orderNumber: string; kind: 'new' | 'updated' | 'kept' | 'skipped' }> = [];

  for (const order of orders) {
    const normalized = normalizeOrder(store.subdomain, store.store_name || store.subdomain, order, []);
    if (!normalized.orderId || !normalized.customerEmail || normalized.paymentStatus !== 'waiting') {
      skipped++;
      const skippedNo = normalized.orderNumber || normalized.orderId;
      if (skippedNo) orderLines.push({ orderNumber: skippedNo, kind: 'skipped' });
      continue;
    }
    const snapshotResult = await query(
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
         customer_name = CASE WHEN EXCLUDED.customer_name <> '' THEN EXCLUDED.customer_name ELSE support_order_snapshots.customer_name END,
         order_status = EXCLUDED.order_status,
         fulfillment_status = CASE WHEN EXCLUDED.fulfillment_status <> '' THEN EXCLUDED.fulfillment_status ELSE support_order_snapshots.fulfillment_status END,
         order_amount = EXCLUDED.order_amount,
         order_currency = EXCLUDED.order_currency,
         payment_status = EXCLUDED.payment_status,
         payment_method = EXCLUDED.payment_method,
         items_json = EXCLUDED.items_json,
         shipping_address_json = EXCLUDED.shipping_address_json,
         billing_address_json = EXCLUDED.billing_address_json,
         logistics_json = EXCLUDED.logistics_json,
         raw_order_json = EXCLUDED.raw_order_json,
         updated_at = now()
       WHERE support_order_snapshots.payment_status IS DISTINCT FROM 'paid'
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
        null,
        normalized.refundStatus,
        normalized.refundAmount,
        '',
        '',
        JSON.stringify(normalized.itemsJson),
        JSON.stringify(normalized.shippingAddressJson),
        JSON.stringify(normalized.billingAddressJson),
        JSON.stringify(normalized.logisticsJson),
        '{}',
        JSON.stringify(normalized.rawOrderJson),
        'backfill_unpaid',
        new Date().toISOString(),
      ],
    );
    const isNew = Boolean(snapshotResult.rows[0]?.is_new);
    const kept = (snapshotResult.rowCount ?? 0) === 0;
    if (kept) keptPaid++;
    else if (isNew) saved++;
    else updated++;
    orderLines.push({
      orderNumber: normalized.orderNumber || normalized.orderId,
      kind: kept ? 'kept' : isNew ? 'new' : 'updated',
    });
  }

  await saveUnpaidCursor(store.subdomain, updatedAtMax);
  await logSync({
    source: 'backfill',
    action: 'unpaid_summary',
    storeSubdomain: store.subdomain,
    storeName: store.store_name || store.subdomain,
    itemsTotal: orders.length,
    itemsNew: saved,
    itemsUpdated: updated,
    itemsSkipped: skipped,
    status: 'success',
    durationMs: Date.now() - started,
    detailJson: { updatedAtMin, updatedAtMax, keptPaid, orders: orderLines },
  });
  log(`未支付完成: 列表 ${orders.length}, 新写入 ${saved}, 更新 ${updated}, 无邮箱跳过 ${skipped}, 已支付未覆盖 ${keptPaid}`);
}

/** 每个完整时间片单独保存进度；积压或失败不会让已完成的时间片重新从头拉取。 */
async function backfillUnpaidForStore(
  store: StoreRecord,
  updatedAtMax: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const running = unpaidRuns.get(store.subdomain);
  if (running) return running;

  const run = (async () => {
    // 在获得本店执行权后读取最新进度，避免手动查漏与定时查漏使用旧游标。
    const existing = await getBackfillState(store.subdomain);
    const maxMs = new Date(updatedAtMax).getTime();
    let startMs = existing?.lastUnpaidSyncedAt
      ? new Date(existing.lastUnpaidSyncedAt).getTime() - UNPAID_OVERLAP_MS
      : maxMs - UNPAID_FIRST_WINDOW_MS;
    let windowMs = UNPAID_MAX_WINDOW_MS;

    while (startMs < maxMs) {
      const endMs = Math.min(startMs + windowMs, maxMs);
      try {
        await backfillUnpaidWindow(store, new Date(startMs).toISOString(), new Date(endMs).toISOString(), onProgress);
      } catch (error: any) {
        if (error.code !== 'WAITING_WINDOW_TOO_LARGE' || endMs - startMs <= UNPAID_MIN_WINDOW_MS) throw error;
        windowMs = Math.max(UNPAID_MIN_WINDOW_MS, Math.floor((endMs - startMs) / 2));
        const message = `[${store.subdomain}] 未支付窗口超过分页上限，缩小至 ${windowMs / 1000} 秒重试`;
        console.warn(message);
        if (onProgress) onProgress(message);
        continue;
      }
      startMs = endMs;
      windowMs = UNPAID_MAX_WINDOW_MS;
    }
  })();

  unpaidRuns.set(store.subdomain, run);
  try {
    await run;
  } finally {
    unpaidRuns.delete(store.subdomain);
  }
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
    try {
      await backfillUnpaidForStore(store, createdAtMax, onProgress);
    } catch (unpaidError: any) {
      console.error(`[backfill-unpaid:${storeSubdomain}] 未支付同步失败，已支付进度不变: ${unpaidError.message}`);
      if (onProgress) onProgress(`[${storeSubdomain}] 未支付同步失败: ${unpaidError.message}`);
      await logSync({
        source: 'backfill',
        action: 'unpaid_summary',
        storeSubdomain,
        storeName: store.store_name || store.subdomain,
        status: 'failed',
        errorMessage: unpaidError.message,
      });
    }
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

/** 只跑未支付增量，不动已支付进度。 */
export async function runUnpaidBackfillOnly(storeSubdomain: string): Promise<void> {
  const stores = await getEnabledStores();
  const store = stores.find(s => s.subdomain === storeSubdomain);
  if (!store) throw new Error(`店铺 ${storeSubdomain} 未找到或已禁用`);
  await backfillUnpaidForStore(store, new Date().toISOString());
}
