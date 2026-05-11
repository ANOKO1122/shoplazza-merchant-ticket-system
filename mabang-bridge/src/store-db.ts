/**
 * 店匠店铺配置 SQLite 持久化（仅服务端持有 access_token）
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { type OrderIndexPayload, ORDER_INDEX_EXTRA_COLUMNS, orderIndexSelectListSql, fillOrderIndexPayload, orderRecordFromIndexRow } from './order-index-schema';
import { debugSession3700abLog } from './debug-log';

const dataDir = process.env.BRIDGE_DATA_DIR?.trim() || '/data';
const dbPath = path.join(dataDir, 'stores.sqlite');

let dbSingleton: Database.Database | null = null;
let orderIndexUpsertStmt: Database.Statement | null = null;

function openDb(): Database.Database {
  if (!dbSingleton) {
    fs.mkdirSync(dataDir, { recursive: true });
    dbSingleton = new Database(dbPath);
    dbSingleton.exec(`
      CREATE TABLE IF NOT EXISTS stores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subdomain TEXT NOT NULL UNIQUE,
        access_token TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    dbSingleton.exec(`
      CREATE TABLE IF NOT EXISTS order_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_subdomain TEXT NOT NULL,
        order_id TEXT NOT NULL,
        order_number_full TEXT,
        order_number_short TEXT,
        customer_email TEXT,
        created_at TEXT,
        updated_at TEXT,
        processed_at TEXT,
        raw_summary_json TEXT,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(store_subdomain, order_id)
      );
      CREATE INDEX IF NOT EXISTS idx_order_index_customer_email_updated
        ON order_index(customer_email, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_order_index_order_number_full
        ON order_index(order_number_full);
      CREATE INDEX IF NOT EXISTS idx_order_index_order_number_short
        ON order_index(order_number_short);
      CREATE TABLE IF NOT EXISTS order_sync_cursor (
        store_subdomain TEXT PRIMARY KEY,
        last_synced_updated_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    dbSingleton.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT,
        account_id INTEGER,
        conversation_id INTEGER,
        contact_id INTEGER,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at
        ON audit_log(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_log_date
        ON audit_log(date(occurred_at));
    `);
    dbSingleton.exec(`
      CREATE TABLE IF NOT EXISTS audit_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        actor_type TEXT,
        actor_id TEXT,
        actor_name TEXT,
        subject_type TEXT,
        subject_id TEXT,
        account_id INTEGER,
        conversation_id INTEGER,
        contact_id INTEGER,
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_event_occurred_at
        ON audit_event(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_event_date
        ON audit_event(date(occurred_at));
      CREATE INDEX IF NOT EXISTS idx_audit_event_conversation
        ON audit_event(conversation_id, occurred_at DESC);
    `);
    migrateOrderSyncCursorResumeColumns(dbSingleton);
    migrateOrderIndexPayloadColumns(dbSingleton);
    dbSingleton.pragma('journal_mode = WAL');
    dbSingleton.pragma('busy_timeout = 60000');
  }
  return dbSingleton;
}

function migrateOrderSyncCursorResumeColumns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(order_sync_cursor)').all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('resume_list_cursor')) {
    db.exec('ALTER TABLE order_sync_cursor ADD COLUMN resume_list_cursor TEXT');
  }
  if (!names.has('resume_updated_at_min')) {
    db.exec('ALTER TABLE order_sync_cursor ADD COLUMN resume_updated_at_min TEXT');
  }
}

function migrateOrderIndexPayloadColumns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(order_index)').all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  for (const name of ORDER_INDEX_EXTRA_COLUMNS) {
    if (!names.has(name)) {
      db.exec(`ALTER TABLE order_index ADD COLUMN ${name} TEXT`);
    }
  }
}

const ORDER_INDEX_CUSTOMER_EMAIL_JSON_EXPR = `CASE
  WHEN customer IS NOT NULL AND TRIM(customer) != '' AND json_valid(customer)
  THEN LOWER(TRIM(COALESCE(json_extract(customer, '$.email'), '')))
  ELSE ''
END`;
const ORDER_INDEX_SHIPPING_EMAIL_JSON_EXPR = `CASE
  WHEN shipping_address IS NOT NULL AND TRIM(shipping_address) != '' AND json_valid(shipping_address)
  THEN LOWER(TRIM(COALESCE(json_extract(shipping_address, '$.email'), '')))
  ELSE ''
END`;
const ORDER_INDEX_RAW_EMAIL_JSON_EXPR = `CASE
  WHEN raw_summary_json IS NOT NULL AND TRIM(raw_summary_json) != '' AND json_valid(raw_summary_json)
  THEN LOWER(TRIM(COALESCE(json_extract(raw_summary_json, '$.email'), '')))
  ELSE ''
END`;
const ORDER_INDEX_EMAIL_MATCH_SQL = `(
  LOWER(TRIM(COALESCE(customer_email, ''))) = ?
  OR ${ORDER_INDEX_CUSTOMER_EMAIL_JSON_EXPR} = ?
  OR ${ORDER_INDEX_SHIPPING_EMAIL_JSON_EXPR} = ?
  OR ${ORDER_INDEX_RAW_EMAIL_JSON_EXPR} = ?
)`;

export interface OrderSyncResumeState {
  resume_updated_at_min: string | null;
  resume_list_cursor: string | null;
}

export function getOrderSyncResume(storeSubdomain: string): OrderSyncResumeState | null {
  const db = openDb();
  const sub = (storeSubdomain || '').trim();
  if (!sub) return null;
  const row = db
    .prepare('SELECT resume_updated_at_min, resume_list_cursor FROM order_sync_cursor WHERE store_subdomain = ? LIMIT 1')
    .get(sub) as OrderSyncResumeState | undefined;
  if (!row) return null;
  return row;
}

export function setOrderSyncResume(storeSubdomain: string, updatedAtMin: string, listCursor: string): void {
  const db = openDb();
  const sub = (storeSubdomain || '').trim();
  const min = (updatedAtMin || '').trim();
  const cur = (listCursor || '').trim();
  if (!sub || !min || !cur) return;
  db.prepare(`INSERT INTO order_sync_cursor (store_subdomain, last_synced_updated_at, resume_updated_at_min, resume_list_cursor, updated_at)
     VALUES (?, NULL, ?, ?, datetime('now'))
     ON CONFLICT(store_subdomain) DO UPDATE SET
       resume_updated_at_min = excluded.resume_updated_at_min,
       resume_list_cursor = excluded.resume_list_cursor,
       updated_at = datetime('now')`).run(sub, min, cur);
}

export function clearOrderSyncResume(storeSubdomain: string): void {
  const db = openDb();
  const sub = (storeSubdomain || '').trim();
  if (!sub) return;
  db.prepare('UPDATE order_sync_cursor SET resume_updated_at_min = NULL, resume_list_cursor = NULL WHERE store_subdomain = ?').run(sub);
}

export function insertAuditLog(entry: {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip?: string;
  userAgent?: string;
  accountId?: number | null;
  conversationId?: number | null;
  contactId?: number | null;
  details?: Record<string, unknown> | null;
}): void {
  const db = openDb();
  const e = entry || ({} as any);
  const method = String(e.method || '').trim().toUpperCase();
  const path = String(e.path || '').trim();
  const statusCode = Number(e.statusCode) || 0;
  const durationMs = Number(e.durationMs) || 0;
  const ip = e.ip != null ? String(e.ip).trim() : null;
  const userAgent = e.userAgent != null ? String(e.userAgent).trim() : null;
  const accountId = e.accountId != null ? Number(e.accountId) : null;
  const conversationId = e.conversationId != null ? Number(e.conversationId) : null;
  const contactId = e.contactId != null ? Number(e.contactId) : null;
  let detailsJson: string | null = null;
  try {
    if (e.details != null) {
      const s = JSON.stringify(e.details);
      detailsJson = s.length > 8000 ? s.slice(0, 8000) : s;
    }
  } catch (_err) {
    detailsJson = null;
  }
  if (!method || !path || !Number.isFinite(statusCode) || !Number.isFinite(durationMs)) {
    return;
  }
  db.prepare(`INSERT INTO audit_log
    (method, path, status_code, duration_ms, ip, user_agent, account_id, conversation_id, contact_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(method, path, statusCode, durationMs, ip, userAgent, accountId, conversationId, contactId, detailsJson);
}

export function listAuditLogsByDate(date: string, limit: number, offset: number): { rows: unknown[]; total: number } {
  const db = openDb();
  const d = String(date || '').trim();
  const lim = Math.min(500, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return { rows: [], total: 0 };
  }
  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE date(occurred_at) = ?`).get(d) as { c: number } | undefined;
  const total = Number(totalRow?.c) || 0;
  const rows = db
    .prepare(`SELECT
      id, occurred_at, method, path, status_code, duration_ms, ip, user_agent,
      account_id, conversation_id, contact_id, details_json
    FROM audit_log
    WHERE date(occurred_at) = ?
    ORDER BY occurred_at DESC, id DESC
    LIMIT ? OFFSET ?`)
    .all(d, lim, off);
  return { rows, total };
}

export function insertAuditEvent(entry: {
  action: string;
  summary: string;
  actorType?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  accountId?: number | null;
  conversationId?: number | null;
  contactId?: number | null;
  meta?: Record<string, unknown> | null;
}): void {
  const db = openDb();
  const e = entry || ({} as any);
  const action = String(e.action || '').trim();
  const summary = String(e.summary || '').trim();
  if (!action || !summary) return;
  const actorType = e.actorType != null ? String(e.actorType).trim() : null;
  const actorId = e.actorId != null ? String(e.actorId).trim() : null;
  const actorName = e.actorName != null ? String(e.actorName).trim() : null;
  const subjectType = e.subjectType != null ? String(e.subjectType).trim() : null;
  const subjectId = e.subjectId != null ? String(e.subjectId).trim() : null;
  const accountId = e.accountId != null ? Number(e.accountId) : null;
  const conversationId = e.conversationId != null ? Number(e.conversationId) : null;
  const contactId = e.contactId != null ? Number(e.contactId) : null;
  let metaJson: string | null = null;
  try {
    if (e.meta != null) {
      const s = JSON.stringify(e.meta);
      metaJson = s.length > 12000 ? s.slice(0, 12000) : s;
    }
  } catch (_err) {
    metaJson = null;
  }
  db.prepare(`INSERT INTO audit_event
    (action, summary, actor_type, actor_id, actor_name, subject_type, subject_id, account_id, conversation_id, contact_id, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    action, summary, actorType, actorId, actorName, subjectType, subjectId, accountId, conversationId, contactId, metaJson,
  );
}

export function listAuditEventsByDate(date: string, limit: number, offset: number): { rows: unknown[]; total: number } {
  const db = openDb();
  const d = String(date || '').trim();
  const lim = Math.min(500, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return { rows: [], total: 0 };
  }
  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM audit_event WHERE date(occurred_at) = ?`).get(d) as { c: number } | undefined;
  const total = Number(totalRow?.c) || 0;
  const rows = db
    .prepare(`SELECT
      id, occurred_at, action, summary, actor_type, actor_id, actor_name,
      subject_type, subject_id, account_id, conversation_id, contact_id, meta_json
    FROM audit_event
    WHERE date(occurred_at) = ?
    ORDER BY occurred_at DESC, id DESC
    LIMIT ? OFFSET ?`)
    .all(d, lim, off);
  return { rows, total };
}

export function orderIndexMissDiagnostics(normalizedEmail: string, orderNumberHints: string[]): {
  totalRows: number;
  emailRowCount: number;
  orderHintRowCount: number;
  topStoreSubdomain: string;
  topStoreRowCount: number;
} {
  const db = openDb();
  const em = (normalizedEmail || '').trim().toLowerCase();
  const totalRow = db.prepare('SELECT COUNT(*) AS c FROM order_index').get() as { c: number } | undefined;
  let emailRowCount = 0;
  if (em) {
    const er = db
      .prepare(`SELECT COUNT(*) AS c FROM order_index
        WHERE ${ORDER_INDEX_EMAIL_MATCH_SQL}`)
      .get(em, em, em, em) as { c: number } | undefined;
    emailRowCount = Number(er?.c) || 0;
  }
  let orderHintRowCount = 0;
  for (const raw of orderNumberHints) {
    const v = (raw || '').trim().replace(/^#+/, '').toUpperCase();
    if (v.length < 4) continue;
    const orow = db
      .prepare(`SELECT COUNT(*) AS c FROM order_index
        WHERE upper(trim(order_id)) LIKE '%' || ? || '%'
           OR upper(trim(COALESCE(order_number_full,''))) LIKE '%' || ? || '%'`)
      .get(v, v) as { c: number } | undefined;
    orderHintRowCount += Number(orow?.c) || 0;
  }
  const top = db
    .prepare(`SELECT store_subdomain, COUNT(*) AS c FROM order_index
      GROUP BY store_subdomain ORDER BY c DESC LIMIT 1`)
    .get() as { store_subdomain: string; c: number } | undefined;
  return {
    totalRows: Number(totalRow?.c) || 0,
    emailRowCount,
    orderHintRowCount,
    topStoreSubdomain: top?.store_subdomain ?? '',
    topStoreRowCount: Number(top?.c) || 0,
  };
}

export function countStores(): number {
  const db = openDb();
  const row = db.prepare('SELECT COUNT(*) AS c FROM stores').get() as { c: number };
  return Number(row.c) || 0;
}

export function listStoresFromDb(): Array<{ subdomain: string; accessToken: string; label?: string }> {
  const db = openDb();
  const rows = db
    .prepare('SELECT subdomain, access_token, label FROM stores ORDER BY subdomain ASC')
    .all() as Array<{ subdomain: string; access_token: string; label: string | null }>;
  return rows.map((r) => ({
    subdomain: r.subdomain,
    accessToken: r.access_token,
    label: r.label?.trim() || undefined,
  }));
}

export interface StoreRowPublic {
  subdomain: string;
  label: string | null;
  accessTokenPreview: string | null;
  updated_at: string;
}

export function listStoresPublic(): StoreRowPublic[] {
  const db = openDb();
  const rows = db
    .prepare('SELECT subdomain, access_token, label, updated_at FROM stores ORDER BY subdomain ASC')
    .all() as Array<{ subdomain: string; access_token: string; label: string | null; updated_at: string }>;
  return rows.map((r) => ({
    subdomain: r.subdomain,
    label: r.label,
    accessTokenPreview: maskToken(r.access_token),
    updated_at: r.updated_at,
  }));
}

function maskToken(token: string): string | null {
  const t = (token || '').trim();
  if (!t) return null;
  if (t.length <= 4) return '****';
  return `****${t.slice(-4)}`;
}

export function upsertStore(subdomain: string, accessToken: string, label?: string): void {
  const db = openDb();
  const stmt = db.prepare(`
    INSERT INTO stores (subdomain, access_token, label, updated_at)
    VALUES (@subdomain, @access_token, @label, datetime('now'))
    ON CONFLICT(subdomain) DO UPDATE SET
      access_token = excluded.access_token,
      label = excluded.label,
      updated_at = datetime('now')
  `);
  stmt.run({
    subdomain,
    access_token: accessToken.trim(),
    label: label?.trim() || null,
  });
}

export function updateStorePartial(subdomain: string, patch: { accessToken?: string; label?: string | null }): boolean {
  const db = openDb();
  const row = db.prepare('SELECT 1 FROM stores WHERE subdomain = ?').get(subdomain);
  if (!row) return false;
  const hasTok = patch.accessToken !== undefined;
  const hasLab = patch.label !== undefined;
  if (hasTok && hasLab) {
    db.prepare("UPDATE stores SET access_token = ?, label = ?, updated_at = datetime('now') WHERE subdomain = ?").run(
      patch.accessToken!.trim(),
      patch.label === null ? null : patch.label?.trim() ?? null,
      subdomain,
    );
    return true;
  }
  if (hasTok) {
    db.prepare("UPDATE stores SET access_token = ?, updated_at = datetime('now') WHERE subdomain = ?").run(patch.accessToken!.trim(), subdomain);
    return true;
  }
  if (hasLab) {
    db.prepare("UPDATE stores SET label = ?, updated_at = datetime('now') WHERE subdomain = ?").run(
      patch.label === null ? null : patch.label?.trim() ?? null,
      subdomain,
    );
    return true;
  }
  return false;
}

export function deleteStoreBySubdomain(subdomain: string): boolean {
  const db = openDb();
  const r = db.prepare('DELETE FROM stores WHERE subdomain = ?').run(subdomain);
  return r.changes > 0;
}

export function getStoreSecretBySubdomain(subdomain: string): { subdomain: string; accessToken: string; label?: string } | null {
  const db = openDb();
  const row = db
    .prepare('SELECT subdomain, access_token, label FROM stores WHERE subdomain = ? LIMIT 1')
    .get(subdomain) as { subdomain: string; access_token: string; label: string | null } | undefined;
  if (!row) return null;
  return {
    subdomain: row.subdomain,
    accessToken: row.access_token,
    label: row.label?.trim() || undefined,
  };
}

export type OrderIndexRow = {
  store_subdomain: string;
  order_id: string;
  order_number_full: string;
  order_number_short: string;
  customer_email: string;
  created_at: string;
  updated_at: string;
  processed_at: string;
  raw_summary_json: string;
} & OrderIndexPayload;

export type OrderIndexLookupRow = Partial<OrderIndexRow> &
  Pick<OrderIndexRow, 'store_subdomain' | 'order_id'> & {
    order_number_full?: string | null;
    order_number_short?: string | null;
    customer_email?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    processed_at?: string | null;
    raw_summary_json?: string | null;
  };

function buildOrderIndexUpsertStatement(db: Database.Database): Database.Statement {
  const core = [
    'store_subdomain', 'order_id', 'order_number_full', 'order_number_short',
    'customer_email', 'created_at', 'updated_at', 'processed_at', 'raw_summary_json',
  ];
  const allCols = [...core, ...ORDER_INDEX_EXTRA_COLUMNS];
  const placeholders = allCols.map((c) => `@${c}`).join(', ');
  const updates = allCols
    .filter((c) => c !== 'store_subdomain' && c !== 'order_id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const sql = `INSERT INTO order_index (${allCols.join(', ')}, indexed_at) VALUES (${placeholders}, datetime('now'))
    ON CONFLICT(store_subdomain, order_id) DO UPDATE SET ${updates}, indexed_at = datetime('now')`;
  return db.prepare(sql);
}

export function upsertOrderIndexRows(rows: OrderIndexRow[]): number {
  if (rows.length === 0) return 0;
  const db = openDb();
  if (!orderIndexUpsertStmt) {
    orderIndexUpsertStmt = buildOrderIndexUpsertStatement(db);
  }
  const stmt = orderIndexUpsertStmt;
  const tx = db.transaction((items: OrderIndexRow[]) => {
    for (const item of items) stmt.run(item);
  });
  tx(rows);
  return rows.length;
}

export function getLatestIndexedOrdersByEmail(email: string, limit: number = 5000, minIso?: string | null): OrderIndexLookupRow[] {
  const db = openDb();
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) return [];
  const lim = Math.max(1, Math.min(limit, 10000));
  const cut = (minIso || '').trim();
  const timeExpr = `COALESCE(
    NULLIF(TRIM(updated_at), ''),
    NULLIF(TRIM(created_at), ''),
    NULLIF(TRIM(processed_at), ''),
    NULLIF(TRIM(indexed_at), ''),
    datetime('now')
  )`;
  const sel = orderIndexSelectListSql();
  const coreTimeExpr = `COALESCE(
    NULLIF(TRIM(c.updated_at), ''),
    NULLIF(TRIM(c.created_at), ''),
    NULLIF(TRIM(c.processed_at), ''),
    NULLIF(TRIM(c.indexed_at), ''),
    datetime('now')
  )`;
  const coreSel = `
    c.store_subdomain AS store_subdomain,
    c.order_id AS order_id,
    c.order_number_full AS order_number_full,
    c.order_number_short AS order_number_short,
    c.customer_email_primary AS customer_email,
    c.created_at AS created_at,
    c.updated_at AS updated_at,
    c.processed_at AS processed_at,
    c.payload_json AS raw_summary_json
  `;
  let hasOrderCore = false;
  let hasEmailIdx = false;
  try {
    hasOrderCore = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='order_core' LIMIT 1").get();
    hasEmailIdx = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='order_email_index' LIMIT 1").get();
  } catch (_) {
    hasOrderCore = false;
    hasEmailIdx = false;
  }

  function dbg3700(payload: Record<string, unknown>): void {
    const line = JSON.stringify({ sessionId: '3700ab', timestamp: Date.now(), ...payload }) + '\n';
    try { fs.appendFileSync('/bridge-debug/debug-3700ab.log', line); } catch (_) {}
    try {
      fetch('http://localhost:7323/ingest/456b4b9b-9da6-4bd8-a0d9-7e4966fdd0bd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '3700ab' },
        body: JSON.stringify({ sessionId: '3700ab', ...payload, timestamp: Date.now() }),
      }).catch(() => {});
    } catch (_) {}
  }

  const invalidJsonStats = () => {
    const customerInvalid = Number((db
      .prepare(`SELECT COUNT(*) AS c FROM order_index
        WHERE LENGTH(TRIM(COALESCE(customer, ''))) > 0 AND json_valid(customer) = 0`)
      .get() as { c: number }).c) || 0;
    const shippingInvalid = Number((db
      .prepare(`SELECT COUNT(*) AS c FROM order_index
        WHERE LENGTH(TRIM(COALESCE(shipping_address, ''))) > 0 AND json_valid(shipping_address) = 0`)
      .get() as { c: number }).c) || 0;
    const rawInvalid = Number((db
      .prepare(`SELECT COUNT(*) AS c FROM order_index
        WHERE LENGTH(TRIM(COALESCE(raw_summary_json, ''))) > 0 AND json_valid(raw_summary_json) = 0`)
      .get() as { c: number }).c) || 0;
    return { customerInvalid, shippingInvalid, rawInvalid };
  };

  function tryJoinEmailCore(): OrderIndexLookupRow[] {
    if (!hasOrderCore || !hasEmailIdx) return [];
    try {
      if (cut) {
        return db
          .prepare(`SELECT DISTINCT ${coreSel}
            FROM order_email_index e
            JOIN order_core c ON c.store_subdomain = e.store_subdomain AND c.order_id = e.order_id
            WHERE e.email_norm = ?
              AND ${coreTimeExpr} >= ?
            ORDER BY COALESCE(c.updated_at, c.created_at, c.processed_at) DESC, c.indexed_at DESC
            LIMIT ?`)
          .all(normalized, cut, lim) as OrderIndexLookupRow[];
      }
      return db
        .prepare(`SELECT DISTINCT ${coreSel}
          FROM order_email_index e
          JOIN order_core c ON c.store_subdomain = e.store_subdomain AND c.order_id = e.order_id
          WHERE e.email_norm = ?
          ORDER BY COALESCE(c.updated_at, c.created_at, c.processed_at) DESC, c.indexed_at DESC
          LIMIT ?`)
        .all(normalized, lim) as OrderIndexLookupRow[];
    } catch (e: any) {
      dbg3700({ hypothesisId: 'H1', location: 'store-db.ts:tryJoinEmailCore', message: 'join failed', data: { err: String(e?.message || e) } });
      return [];
    }
  }

  function tryCorePrimaryEmail(): OrderIndexLookupRow[] {
    if (!hasOrderCore) return [];
    try {
      if (cut) {
        return db
          .prepare(`SELECT ${coreSel.replace(/\n/g, ' ')}
            FROM order_core c
            WHERE LOWER(TRIM(COALESCE(c.customer_email_primary,''))) = ?
              AND ${coreTimeExpr} >= ?
            ORDER BY COALESCE(c.updated_at, c.created_at, c.processed_at) DESC, c.indexed_at DESC
            LIMIT ?`)
          .all(normalized, cut, lim) as OrderIndexLookupRow[];
      }
      return db
        .prepare(`SELECT ${coreSel.replace(/\n/g, ' ')}
          FROM order_core c
          WHERE LOWER(TRIM(COALESCE(c.customer_email_primary,''))) = ?
          ORDER BY COALESCE(c.updated_at, c.created_at, c.processed_at) DESC, c.indexed_at DESC
          LIMIT ?`)
        .all(normalized, lim) as OrderIndexLookupRow[];
    } catch (e: any) {
      dbg3700({ hypothesisId: 'H3', location: 'store-db.ts:tryCorePrimaryEmail', message: 'core primary failed', data: { err: String(e?.message || e) } });
      return [];
    }
  }

  function tryLegacyOrderIndex(): OrderIndexLookupRow[] {
    if (cut) {
      return db
        .prepare(`SELECT ${sel}
          FROM order_index
          WHERE ${ORDER_INDEX_EMAIL_MATCH_SQL}
            AND ${timeExpr} >= ?
          ORDER BY COALESCE(updated_at, created_at, processed_at) DESC, indexed_at DESC
          LIMIT ?`)
        .all(normalized, normalized, normalized, normalized, cut, lim) as OrderIndexLookupRow[];
    }
    return db
      .prepare(`SELECT ${sel}
        FROM order_index
        WHERE ${ORDER_INDEX_EMAIL_MATCH_SQL}
        ORDER BY COALESCE(updated_at, created_at, processed_at) DESC, indexed_at DESC
        LIMIT ?`)
      .all(normalized, normalized, normalized, normalized, lim) as OrderIndexLookupRow[];
  }

  let rows: OrderIndexLookupRow[] = [];
  let path = 'none';
  if (hasOrderCore && hasEmailIdx) {
    rows = tryJoinEmailCore();
    path = 'join_email_core';
    dbg3700({ hypothesisId: 'H1', location: 'store-db.ts:getLatestIndexedOrdersByEmail', message: 'after join', data: { path, rowCount: rows.length, hasCut: !!cut } });
  }
  if (rows.length === 0 && hasOrderCore) {
    rows = tryCorePrimaryEmail();
    path = 'core_primary_email';
    dbg3700({ hypothesisId: 'H3', location: 'store-db.ts:getLatestIndexedOrdersByEmail', message: 'after core primary', data: { path, rowCount: rows.length } });
  }
  if (rows.length === 0) {
    try {
      rows = tryLegacyOrderIndex();
      path = 'legacy_order_index';
      dbg3700({ hypothesisId: 'H2', location: 'store-db.ts:getLatestIndexedOrdersByEmail', message: 'after legacy', data: { path, rowCount: rows.length } });
    } catch (e: any) {
      const stats = invalidJsonStats();
      debugSession3700abLog({
        runId: 'pre-fix',
        hypothesisId: 'H1-H2',
        location: 'store-db.ts:getLatestIndexedOrdersByEmail:error_legacy',
        message: 'legacy email lookup query failed',
        data: { err: e.message, ...stats },
      });
      throw e;
    }
  }
  debugSession3700abLog({
    runId: 'post-fix',
    hypothesisId: 'H4',
    location: 'store-db.ts:getLatestIndexedOrdersByEmail:success',
    message: 'email lookup query success',
    data: { rows: rows.length, path, hasCut: !!cut },
  });
  dbg3700({ hypothesisId: 'H4', location: 'store-db.ts:getLatestIndexedOrdersByEmail', message: 'lookup result', data: { path, rowCount: rows.length, hasCut: !!cut, runId: 'post-fix' } });
  return rows;
}

function orderNumberVariantsForIndexQuery(raw: string): string[] {
  const n = (raw || '').trim().replace(/^#/, '').replace(/\s+/g, '').toUpperCase();
  if (!n) return [];
  const out = new Set<string>([n]);
  const i = n.indexOf('-');
  if (i > 0 && i < n.length - 1) {
    out.add(n.slice(i + 1));
  }
  return [...out];
}

export function getLatestIndexedOrdersByOrderNumber(raw: string, limit: number = 10): OrderIndexLookupRow[] {
  const variants = orderNumberVariantsForIndexQuery(raw);
  if (variants.length === 0) return [];
  const db = openDb();
  const lim = Math.max(1, Math.min(limit, 10000));
  const ph = variants.map(() => '?').join(',');
  const sel = orderIndexSelectListSql();
  const sql = `
    SELECT ${sel}
      FROM order_index
     WHERE upper(trim(order_id)) IN (${ph})
        OR upper(trim(COALESCE(order_number_full,''))) IN (${ph})
        OR upper(trim(COALESCE(order_number_short,''))) IN (${ph})
     ORDER BY COALESCE(updated_at, created_at, processed_at) DESC, indexed_at DESC
     LIMIT ?
  `;
  const params: unknown[] = [...variants, ...variants, ...variants, lim];
  return db.prepare(sql).all(...params) as OrderIndexLookupRow[];
}

export function getOrderIndexStats(): { totalRows: number; rowsWithEmail: number } {
  const db = openDb();
  const row = db
    .prepare(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE
        WHEN (customer_email IS NOT NULL AND TRIM(customer_email) != '')
          OR ${ORDER_INDEX_CUSTOMER_EMAIL_JSON_EXPR} != ''
          OR ${ORDER_INDEX_SHIPPING_EMAIL_JSON_EXPR} != ''
          OR ${ORDER_INDEX_RAW_EMAIL_JSON_EXPR} != ''
        THEN 1 ELSE 0 END), 0) AS with_email
    FROM order_index`)
    .get() as { total: number; with_email: number } | undefined;
  return {
    totalRows: Number(row?.total) || 0,
    rowsWithEmail: Number(row?.with_email) || 0,
  };
}

export function backfillOrderIndexCustomerEmailFromJson(): number {
  const db = openDb();
  const r = db
    .prepare(`UPDATE order_index
      SET customer_email = LOWER(TRIM(COALESCE(
        NULLIF(${ORDER_INDEX_CUSTOMER_EMAIL_JSON_EXPR}, ''),
        NULLIF(${ORDER_INDEX_SHIPPING_EMAIL_JSON_EXPR}, ''),
        NULLIF(${ORDER_INDEX_RAW_EMAIL_JSON_EXPR}, '')
      )))
    WHERE (customer_email IS NULL OR TRIM(customer_email) = '')
      AND LENGTH(TRIM(COALESCE(
        NULLIF(${ORDER_INDEX_CUSTOMER_EMAIL_JSON_EXPR}, ''),
        NULLIF(${ORDER_INDEX_SHIPPING_EMAIL_JSON_EXPR}, ''),
        NULLIF(${ORDER_INDEX_RAW_EMAIL_JSON_EXPR}, ''),
        ''
      ))) > 0`)
    .run();
  return Number(r.changes) || 0;
}

export function getLastSyncedUpdatedAt(storeSubdomain: string): string | null {
  const db = openDb();
  const row = db
    .prepare('SELECT last_synced_updated_at FROM order_sync_cursor WHERE store_subdomain = ? LIMIT 1')
    .get(storeSubdomain) as { last_synced_updated_at: string | null } | undefined;
  return row?.last_synced_updated_at ?? null;
}

export function deleteOrderIndexOlderThan(storeSubdomain: string, cutoffIso: string): number {
  const db = openDb();
  const sub = (storeSubdomain || '').trim();
  const cut = (cutoffIso || '').trim();
  if (!sub || !cut) return 0;
  const r = db
    .prepare(`DELETE FROM order_index
      WHERE store_subdomain = ?
        AND COALESCE(
          NULLIF(TRIM(updated_at), ''),
          NULLIF(TRIM(created_at), ''),
          NULLIF(TRIM(processed_at), ''),
          '1970-01-01T00:00:00.000Z'
        ) < ?`)
    .run(sub, cut);
  return Number(r.changes) || 0;
}

export function upsertLastSyncedUpdatedAt(storeSubdomain: string, updatedAt: string): void {
  const db = openDb();
  db.prepare(`INSERT INTO order_sync_cursor (store_subdomain, last_synced_updated_at, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(store_subdomain) DO UPDATE SET
      last_synced_updated_at = excluded.last_synced_updated_at,
      updated_at = datetime('now')`).run(storeSubdomain, updatedAt);
}

export function clearOrderSyncCursors(): number {
  const db = openDb();
  const r = db.prepare('DELETE FROM order_sync_cursor').run();
  return Number(r.changes) || 0;
}

export function deleteAllOrderIndexRows(): number {
  const db = openDb();
  const r = db.prepare('DELETE FROM order_index').run();
  return Number(r.changes) || 0;
}
