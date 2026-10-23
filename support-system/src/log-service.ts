/**
 * 系统日志服务
 *
 * 两张表：
 *  - support_sync_logs       高频（数据同步），默认保留 60 天
 *  - support_operation_logs  管理员/系统操作，默认保留 60 天
 */
import { query } from './pg';

// ══════════════════════════════════════════════════
// 同步日志（高频）
// ══════════════════════════════════════════════════

export interface SyncLogParams {
  source: 'webhook' | 'backfill' | 'api';
  action: string;
  storeSubdomain: string;
  storeName?: string;
  targetId?: string;
  itemsTotal?: number;
  itemsNew?: number;
  itemsUpdated?: number;
  itemsSkipped?: number;
  status?: 'success' | 'partial' | 'failed';
  errorMessage?: string;
  durationMs?: number;
  detailJson?: Record<string, unknown>;
}

export async function logSync(params: SyncLogParams): Promise<void> {
  try {
    await query(
      `INSERT INTO support_sync_logs
        (source, action, store_subdomain, store_name, target_id,
         items_total, items_new, items_updated, items_skipped,
         status, error_message, duration_ms, detail_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        params.source,
        params.action,
        params.storeSubdomain,
        params.storeName || null,
        params.targetId || null,
        params.itemsTotal ?? 0,
        params.itemsNew ?? 0,
        params.itemsUpdated ?? 0,
        params.itemsSkipped ?? 0,
        params.status || 'success',
        params.errorMessage || null,
        params.durationMs ?? null,
        JSON.stringify(params.detailJson || {}),
      ],
    );
  } catch (e: any) {
    console.error('[log-service] logSync failed:', e.message);
  }
}

// ══════════════════════════════════════════════════
// 操作日志（低频，永久）
// ══════════════════════════════════════════════════

export interface OperationLogParams {
  category: 'email' | 'ticket' | 'store' | 'webhook' | 'config' | 'backfill';
  action: string;
  actor: string;
  actorIp?: string;
  storeSubdomain?: string;
  target?: string;
  summary: string;
  status: 'success' | 'partial' | 'failed';
  failedAtStep?: string;
  detailJson?: Record<string, unknown>;
}

export async function logOperation(params: OperationLogParams): Promise<void> {
  try {
    await query(
      `INSERT INTO support_operation_logs
        (category, action, actor, actor_ip, store_subdomain, target,
         summary, status, failed_at_step, detail_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        params.category,
        params.action,
        params.actor,
        params.actorIp || null,
        params.storeSubdomain || null,
        params.target || null,
        params.summary,
        params.status,
        params.failedAtStep || null,
        JSON.stringify(params.detailJson || {}),
      ],
    );
  } catch (e: any) {
    console.error('[log-service] logOperation failed:', e.message);
  }
}

// ══════════════════════════════════════════════════
// 查询
// ══════════════════════════════════════════════════

export async function listSyncLogs(params: {
  source?: string;
  action?: string;
  status?: string;
  storeSubdomain?: string;
  page: number;
  pageSize: number;
}) {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.source && params.source !== 'all') {
    conditions.push(`source = $${idx++}`);
    values.push(params.source);
  }
  if (params.action === 'order_paid') {
    conditions.push(`(action = 'order_paid' OR (action = 'order_upsert' AND COALESCE(detail_json->>'topic', '') = 'orders/paid'))`);
  } else if (params.action === 'order_unpaid') {
    conditions.push(`(action = 'order_unpaid' OR (action = 'order_upsert' AND COALESCE(detail_json->>'topic', '') = 'orders/create'))`);
  } else if (params.action && params.action !== 'all') {
    conditions.push(`action = $${idx++}`);
    values.push(params.action);
  }
  if (params.status && params.status !== 'all') {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.storeSubdomain) {
    conditions.push(`store_subdomain = $${idx++}`);
    values.push(params.storeSubdomain);
  }

  conditions.push(`NOT (source = 'backfill' AND action = 'order_unpaid')`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const countR = await query(`SELECT COUNT(*) FROM support_sync_logs ${where}`, values);
  const total = Number(countR.rows[0].count);
  const offset = (params.page - 1) * params.pageSize;

  const rows = await query(
    `SELECT * FROM support_sync_logs ${where}
     ORDER BY id DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, params.pageSize, offset],
  );
  return { total, logs: rows.rows };
}

export async function getUnpaidSummaryOrders(id: number): Promise<{ orders: Array<{ orderNumber: string; kind: string }>; legacy: boolean } | null> {
  const r = await query(
    `SELECT action, store_subdomain, created_at, duration_ms, detail_json
     FROM support_sync_logs WHERE id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row || row.action !== 'unpaid_summary') return null;
  const embedded = row.detail_json && Array.isArray(row.detail_json.orders) ? row.detail_json.orders : null;
  if (embedded) {
    return {
      legacy: false,
      orders: embedded
        .map((item: any) => ({ orderNumber: String(item.orderNumber || ''), kind: String(item.kind || '') }))
        .filter((item: { orderNumber: string }) => item.orderNumber),
    };
  }
  const duration = Math.max(0, Number(row.duration_ms) || 0);
  const windowMs = duration + 15000;
  const children = await query(
    `SELECT target_id, items_new, items_updated, items_skipped
     FROM support_sync_logs
     WHERE source = 'backfill'
       AND action = 'order_unpaid'
       AND store_subdomain = $1
       AND created_at <= $2
       AND created_at >= $2 - ($3 * interval '1 millisecond')
     ORDER BY id ASC
     LIMIT 1000`,
    [row.store_subdomain, row.created_at, windowMs],
  );
  return {
    legacy: true,
    orders: children.rows.map((child: any) => ({
      orderNumber: String(child.target_id || ''),
      kind: Number(child.items_skipped) > 0 ? 'kept' : Number(child.items_new) > 0 ? 'new' : 'updated',
    })).filter((item: { orderNumber: string }) => item.orderNumber),
  };
}

export async function listOperationLogs(params: {
  category?: string;
  status?: string;
  storeSubdomain?: string;
  q?: string;
  page: number;
  pageSize: number;
}) {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.category && params.category !== 'all') {
    conditions.push(`category = $${idx++}`);
    values.push(params.category);
  }
  if (params.status && params.status !== 'all') {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.storeSubdomain) {
    conditions.push(`store_subdomain = $${idx++}`);
    values.push(params.storeSubdomain);
  }
  if (params.q) {
    const q = `%${params.q}%`;
    conditions.push(`(target ILIKE $${idx} OR summary ILIKE $${idx + 1} OR actor ILIKE $${idx + 2})`);
    values.push(q, q, q);
    idx += 3;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const countR = await query(`SELECT COUNT(*) FROM support_operation_logs ${where}`, values);
  const total = Number(countR.rows[0].count);
  const offset = (params.page - 1) * params.pageSize;

  const rows = await query(
    `SELECT * FROM support_operation_logs ${where}
     ORDER BY id DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, params.pageSize, offset],
  );
  return { total, logs: rows.rows };
}

// ══════════════════════════════════════════════════
// 清理
// ══════════════════════════════════════════════════

function normalizeRetentionDays(value: number, fallback: number): number {
  const days = Math.floor(Number(value));
  if (!Number.isFinite(days) || days < 1 || days > 3650) return fallback;
  return days;
}

async function deleteOlderThan(table: 'support_sync_logs' | 'support_operation_logs', retentionDays: number): Promise<number> {
  const days = normalizeRetentionDays(retentionDays, 60);
  const r = await query(
    `DELETE FROM ${table} WHERE created_at < now() - ($1::int * interval '1 day')`,
    [days],
  );
  return r.rowCount || 0;
}

export async function cleanupSyncLogs(retentionDays: number = 60): Promise<number> {
  try {
    const removed = await deleteOlderThan('support_sync_logs', retentionDays);
    if (removed > 0) console.log(`[log-service] 清理了 ${removed} 条超过 ${normalizeRetentionDays(retentionDays, 60)} 天的同步日志`);
    return removed;
  } catch (e: any) {
    console.error('[log-service] cleanupSyncLogs failed:', e.message);
    return 0;
  }
}

export async function cleanupOperationLogs(retentionDays: number = 60): Promise<number> {
  try {
    const removed = await deleteOlderThan('support_operation_logs', retentionDays);
    if (removed > 0) console.log(`[log-service] 清理了 ${removed} 条超过 ${normalizeRetentionDays(retentionDays, 60)} 天的操作日志`);
    return removed;
  } catch (e: any) {
    console.error('[log-service] cleanupOperationLogs failed:', e.message);
    return 0;
  }
}
