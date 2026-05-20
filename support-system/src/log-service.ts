/**
 * 系统日志服务
 *
 * 两张表：
 *  - support_sync_logs    高频（数据同步），30 天自动清理
 *  - support_operation_logs  低频（管理员/系统操作），永久保留
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
  if (params.status && params.status !== 'all') {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.storeSubdomain) {
    conditions.push(`store_subdomain = $${idx++}`);
    values.push(params.storeSubdomain);
  }

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

export async function cleanupSyncLogs(retentionDays: number = 30): Promise<number> {
  try {
    const r = await query(
      `DELETE FROM support_sync_logs WHERE created_at < now() - interval '${retentionDays} days'`,
    );
    if ((r.rowCount || 0) > 0) {
      console.log(`[log-service] 清理了 ${r.rowCount} 条过期同步日志`);
    }
    return r.rowCount || 0;
  } catch (e: any) {
    console.error('[log-service] cleanupSyncLogs failed:', e.message);
    return 0;
  }
}
