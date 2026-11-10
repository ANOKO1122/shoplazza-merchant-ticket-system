import { query } from './pg';
import { ProtectionError } from './protection-domain';
import type { ProtectionEmailEventType, ProtectionEmailRecord, ProtectionEmailStatus, ProtectionList } from './protection-types';

export interface ProtectionEmailFilters {
 q?: string; store?: string; from?: string; to?: string;
 status?: string; event_type?: string; page?: number; page_size?: number;
}
const eventTypes: ProtectionEmailEventType[] = ['shipment', 'completion', 'claim_update'];
const statuses: ProtectionEmailStatus[] = ['pending', 'sending', 'sent', 'cancelled'];
const safeErrors = new Set([
  'delivery_or_preparation_failed', 'manual_delivery_enabled', 'recipient_changed_or_invalid',
  'recipient_or_order_changed', 'order_no_longer_eligible_for_event', 'email_unsubscribed:protection',
]);
const iso = (value: unknown): string | null => value ? new Date(value as string).toISOString() : null;

export async function listProtectionEmailRecords(filters: ProtectionEmailFilters = {}): Promise<ProtectionList<ProtectionEmailRecord>> {
  const page = Number(filters.page ?? 1), pageSize = Number(filters.page_size ?? 20);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ProtectionError('分页参数无效');
  const args: unknown[] = [], conditions: string[] = [];
  const add = (sql: string, value: unknown) => { args.push(value); conditions.push(sql.replace('?', `$${args.length}`)); };
  if (filters.store) {
    if (filters.store.length > 255) throw new ProtectionError('店铺参数无效');
    add('o.store_subdomain=?', filters.store);
  }
  if (filters.q) {
    if (filters.q.length > 200) throw new ProtectionError('搜索内容过长');
    args.push(`%${filters.q.replace(/[\\%_]/g, '\\$&')}%`);
    conditions.push(`(o.order_number ILIKE $${args.length} OR o.public_no ILIKE $${args.length} OR c.public_no ILIKE $${args.length} OR n.recipient_email ILIKE $${args.length})`);
  }
  for (const key of ['from', 'to'] as const) if (filters[key]) {
    const date = filters[key]!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new ProtectionError('日期格式无效');
    add(`n.created_at ${key === 'from' ? '>=' : '<'} ?::date${key === 'to' ? " + interval '1 day'" : ''}`, date);
  }
  if (filters.from && filters.to && filters.from > filters.to) throw new ProtectionError('开始日期不能晚于结束日期');
  if (filters.status) {
    if (!statuses.includes(filters.status as ProtectionEmailStatus)) throw new ProtectionError('邮件状态无效');
    add('n.status=?', filters.status);
  }
  if (filters.event_type) {
    if (!eventTypes.includes(filters.event_type as ProtectionEmailEventType)) throw new ProtectionError('邮件类型无效');
    add('n.event_type=?', filters.event_type);
  }
  const from = 'FROM support_protection_notification_outbox n JOIN support_protection_orders o ON o.id=n.protection_order_id LEFT JOIN support_protection_claims c ON c.id=n.claim_id';
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [count, rows] = await Promise.all([
    query(`SELECT count(*)::int AS total ${from} ${where}`, args),
    query(`SELECT n.id,n.event_type,n.status,n.protection_order_id,o.public_no AS protection_public_no,n.claim_id,c.public_no AS claim_public_no,
      o.store_subdomain,o.store_name,o.order_number,n.recipient_email,n.target_status,n.attempts,
      n.created_at,n.updated_at,n.sent_at,n.next_attempt_at,n.manual_requested_at,n.last_error
      ${from} ${where} ORDER BY n.created_at DESC,n.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, pageSize, (page - 1) * pageSize]),
  ]);
  return { ok: true, total: count.rows[0].total, page, page_size: pageSize, items: rows.rows.map(row => ({
    id: String(row.id), event_type: row.event_type, status: row.status,
    protection_order_id: String(row.protection_order_id), protection_public_no: row.protection_public_no,
    claim_id: row.claim_id == null ? null : String(row.claim_id), claim_public_no: row.claim_public_no,
    store_subdomain: row.store_subdomain, store_name: row.store_name, order_number: row.order_number,
    recipient_email: row.recipient_email, target_status: row.target_status,
    attempts: Number(row.attempts), created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!,
    sent_at: iso(row.sent_at), next_attempt_at: row.status === 'pending' ? iso(row.next_attempt_at) : null,
    manual_requested_at: iso(row.manual_requested_at),
    last_error_code: row.last_error ? (safeErrors.has(row.last_error) ? row.last_error : 'unknown') : null,
  })) };
}
