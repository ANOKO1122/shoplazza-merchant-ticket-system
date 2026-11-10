import type { PoolClient } from 'pg';
import { normalizeProtectionSnapshot, record, text, type NormalizedProtectionOrder } from './protection-domain';
import { isEmailUnsubscribed, normalizePreferenceEmail } from './email-preferences';

type Db = Pick<PoolClient, 'query'>;
export type ProtectionLifecycleEventType = 'shipment' | 'completion';
interface Milestone { event_type: ProtectionLifecycleEventType; occurred_at: string; tracking_number: string; carrier: string; }
type LifecycleOrder = Pick<NormalizedProtectionOrder, 'payment_status'|'order_status'|'refund_status'|'refund_amount_cents'|'order_amount_cents'|'protection_fee_cents'|'service_fulfillment_status'|'items'|'logistics'|'timeline'|'customer_email'>;
const date = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function isProtectionLifecycleOrderEligible(order: LifecycleOrder): boolean {
  if (!['paid','partially_refunded','refund_failed'].includes(order.payment_status)
    || ['cancelled','canceled'].includes(order.order_status) || order.timeline?.cancelled
    || ['refunded','refunding'].includes(order.refund_status)
    || ['removed','refunded'].includes(order.service_fulfillment_status)
    || order.protection_fee_cents === null || Number(order.protection_fee_cents) <= 0) return false;
  const remaining = (item: any) => Number.isSafeInteger(item.quantity) && item.quantity > Number(item.refunded_quantity || 0);
  if (!order.items.some(item => item.is_protection && remaining(item)) || !order.items.some(item => !item.is_protection && remaining(item))) return false;
  // Do not promise continuing protection after an unverified or full refund.
  if (order.refund_amount_cents === null || Number(order.refund_amount_cents) > 0 && (order.order_amount_cents === null
    || Number(order.order_amount_cents) - Number(order.refund_amount_cents) <= Number(order.protection_fee_cents))) return false;
  return true;
}

/** Only actual merchandise parcels qualify; a service-only fulfillment never does. */
export function protectionLifecycleMilestones(order: LifecycleOrder, now = Date.now()): Milestone[] {
  if (!isProtectionLifecycleOrderEligible(order)) return [];
  const ids = new Set(order.items.filter(item => !item.is_protection && item.quantity > 0).map(item => item.id));
  const parcels = (Array.isArray(order.logistics) ? order.logistics : []).map(record)
    .filter(parcel => ['shipped','finished'].includes(parcel.status) && Array.isArray(parcel.line_items)
      && parcel.line_items.some((value: unknown) => {
        const line = record(value), quantity = line.ship_quantity ?? line.quantity;
        return ids.has(text(line.id || line.line_item_id)) && Number.isSafeInteger(quantity) && quantity > 0;
      }))
    .map(parcel => ({ parcel, at: date(parcel.shipped_at) || date(parcel.created_at) }))
    .filter((value): value is { parcel: Record<string, any>; at: string } => !!value.at)
    .sort((a,b) => a.at.localeCompare(b.at));
  const first = parcels[0], result: Milestone[] = [];
  if (first && Date.parse(first.at) <= now) {
    const tracking = (Array.isArray(first.parcel.tracking_items) ? first.parcel.tracking_items : []).map(record);
    result.push({ event_type:'shipment', occurred_at:first.at,
      tracking_number:text(first.parcel.tracking_number) || tracking.map(row => text(row.tracking_number)).find(Boolean) || '',
      carrier:text(first.parcel.tracking_company) || tracking.map(row => text(row.tracking_company)).find(Boolean) || '' });
  }
  const completed = date(order.timeline?.completed_at);
  if (order.order_status === 'finished' && completed && Date.parse(completed) <= now
    && ['order.finished_at','orders/finished.updated_at'].includes(order.timeline?.completed_source || '')) {
    result.push({ event_type:'completion', occurred_at:completed, tracking_number:first?.parcel ? text(first.parcel.tracking_number) : '', carrier:first?.parcel ? text(first.parcel.tracking_company) : '' });
  }
  return result;
}

function fromRow(row: Record<string, any>): LifecycleOrder {
  return { ...row, items:Array.isArray(row.items_json)?row.items_json:[], logistics:row.logistics_json,
    timeline:row.timeline_json || {} } as LifecycleOrder;
}

/** Called after the normalized order write, in that same transaction. */
export async function enqueueProtectionLifecycleNotifications(client: Db, row: Record<string, any>): Promise<void> {
  const milestones = protectionLifecycleMilestones(fromRow(row));
  if (!milestones.length) return;
  const activation = (await client.query('SELECT activated_at FROM support_protection_notification_activation WHERE id=1')).rows[0];
  if (!activation) return;
  let recipient: string;
  try { recipient = normalizePreferenceEmail(row.customer_email); } catch { return; }
  const unsubscribed = await isEmailUnsubscribed(recipient,'protection',client);
  for (const event of milestones) {
    if (Date.parse(event.occurred_at) < new Date(activation.activated_at).getTime()) continue;
    // Record suppression too: reindexing after resubscribe must not send an old event.
    const context = { store_name:row.store_name, order_number:row.order_number, customer_name:row.customer_name,
      protection_no:row.public_no, ...event };
    const obsoleteShipment = event.event_type === 'shipment' && milestones.some(value => value.event_type === 'completion');
    const cancellationReason = unsubscribed ? 'email_unsubscribed:protection' : obsoleteShipment ? 'order_already_completed' : null;
    await client.query(`INSERT INTO support_protection_notification_outbox(event_key,event_type,protection_order_id,recipient_email,context_json,message_id,status,last_error)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [`protection_${event.event_type}:${row.id}`,event.event_type,row.id,recipient,JSON.stringify(context),
      `<protection-order-${row.id}-${event.event_type}@us-seel.com>`,cancellationReason?'cancelled':'pending',cancellationReason]);
  }
}

/** The index can lag a webhook; consult the latest persisted source before SMTP. */
export async function isProtectionLifecycleNotificationCurrent(client: Db, job: Record<string, any>, row: Record<string, any>): Promise<boolean> {
  if (!['shipment','completion'].includes(job.event_type)) return true;
  const snapshots = await client.query(`SELECT s.*,p.product_ids FROM support_order_snapshots s
    JOIN support_protection_stores p ON p.store_subdomain=s.store_subdomain
    WHERE s.store_subdomain=$1 AND s.order_id=$2 ORDER BY s.updated_at DESC,s.id DESC LIMIT 1`,[row.store_subdomain,row.order_id]);
  const snapshot = snapshots.rows[0];
  const current = snapshot ? normalizeProtectionSnapshot(snapshot,Array.isArray(snapshot.product_ids)?snapshot.product_ids:[]) : fromRow(row);
  if (!current || text(current.customer_email).toLowerCase() !== job.recipient_email) return false;
  const milestones = protectionLifecycleMilestones(current);
  if (job.event_type === 'shipment' && milestones.some(event => event.event_type === 'completion')) return false;
  return milestones.some(event => event.event_type === job.event_type);
}
