import fetch from 'node-fetch';
import type { PoolClient } from 'pg';
import { getClient } from './pg';
import { buildApiHost, type ShoplazzaStoreConfig } from './config';
import { getStoreBySubdomain } from './store-service';
import { getOrderAddressAccessScopes, getOrderForStatusUpdate, listOrderFulfillments } from './shoplazza-client';

export { PROTECTION_FULFILLMENT_SCHEMA_SQL } from './protection-fulfillment-schema';

type RemoteOrder = Record<string, any>;
type Line = { id: string; ship_quantity: number };
type Plan = { action: 'create' | 'complete'; lines: Line[]; complete_ids: string[] } | { action: 'skip' | 'blocked' | 'done'; message: string };
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
/** Pure allow-list: never send physical lines, and never complete a mixed package. */
export function planProtectionFulfillment(order: RemoteOrder, parcels: RemoteOrder[], productIds: string[]): Plan {
  if (order.status !== 'finished' || order.financial_status !== 'paid' || order.cancelled_at || order.canceled_at) return { action: 'skip', message: 'Order is not finished and fully paid, or has a refund or cancellation.' };
  if (!Array.isArray(order.line_items) || !productIds.length) return { action: 'blocked', message: 'Protection line configuration is missing.' };
  const own = order.line_items.filter((line: any) => productIds.includes(String(line.product_id))), ids = new Set(own.map((line: any) => String(line.id)));
  if (!own.length) return { action: 'skip', message: 'No configured protection line remains.' };
  if (ids.size !== own.length || own.some((line: any) => !line.id || !Number.isSafeInteger(line.quantity) || line.quantity <= 0)) return { action: 'blocked', message: 'Protection quantities need manual verification.' };
  const shipped: Record<string, number> = {}, completeIds: string[] = [];
  for (const parcel of parcels) {
    if (parcel.status === 'cancelled') continue;
    if (!Array.isArray(parcel.line_items)) return { action: 'blocked', message: 'A fulfillment has incomplete line details.' };
    const service = parcel.line_items.filter((line: any) => ids.has(String(line.id || line.line_item_id)));
    if (!service.length) continue;
    if (!['shipped', 'finished'].includes(parcel.status)) return { action: 'blocked', message: 'A protection fulfillment is not ready to complete.' };
    if (parcel.status !== 'finished' && service.length !== parcel.line_items.length) return { action: 'blocked', message: 'Protection shares a fulfillment with physical goods; manual handling is required.' };
    for (const line of service) {
      const quantity = line.ship_quantity ?? line.quantity;
      if (!Number.isSafeInteger(quantity) || quantity <= 0) return { action: 'blocked', message: 'A protection fulfillment quantity is unknown.' };
      const id = String(line.id || line.line_item_id); shipped[id] = (shipped[id] || 0) + quantity;
    }
    if (parcel.status === 'shipped') {
      if (!parcel.id) return { action: 'blocked', message: 'A protection fulfillment ID is missing.' };
      completeIds.push(String(parcel.id));
    }
  }
  const lines: Line[] = [];
  for (const line of own) {
    const refunded = line.refund_quantity_total ?? 0;
    if (!Number.isSafeInteger(refunded) || refunded < 0 || refunded > line.quantity || (shipped[line.id] || 0) > line.quantity) return { action: 'blocked', message: 'Protection quantities conflict with fulfillment or refund records.' };
    if (line.fulfillment_status === 'finished') continue;
    const remaining = line.quantity - refunded - (shipped[line.id] || 0);
    if (remaining > 0) lines.push({ id: String(line.id), ship_quantity: remaining });
  }
  if (lines.length) return { action: 'create', lines, complete_ids: completeIds };
  if (completeIds.length) return { action: 'complete', lines: [], complete_ids: completeIds };
  return { action: 'done', message: 'Protection service is already completed or no quantity remains.' };
}

/** No automatic write retries here: the durable worker must reconcile ambiguous creates. */
export async function writeProtectionFulfillment(store: ShoplazzaStoreConfig, orderId: string, lines?: Line[], fulfillmentId?: string): Promise<void> {
  const suffix = fulfillmentId ? `/${encodeURIComponent(fulfillmentId)}/complete` : '';
  if (!fulfillmentId && (!lines?.length || lines.some(line => !line.id || !Number.isSafeInteger(line.ship_quantity) || line.ship_quantity <= 0))) throw new Error('Invalid protection fulfillment payload');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(`https://${buildApiHost(store.subdomain)}/openapi/2026-07/orders/${encodeURIComponent(orderId)}/fulfillments${suffix}`, {
      method: 'POST', headers: { 'Access-Token': store.accessToken, 'Content-Type': 'application/json' },
      ...(fulfillmentId ? {} : { body: JSON.stringify({ fulfillment: { line_items: lines } }) }),
      signal: controller.signal as any, timeout: 18000, size: 5 * 1024 * 1024,
    });
    if (!response.ok) { (response.body as any)?.destroy?.(); throw new Error(`Shoplazza fulfillment HTTP ${response.status}`); }
    const body = record(await response.json()), result = record(record(body.data).fulfillment);
    if (body.code !== 'Success' || !result.id || String(result.order_id) !== orderId || (fulfillmentId && result.status !== 'finished')) throw new Error('Shoplazza fulfillment result could not be verified');
  } finally { clearTimeout(timer); }
}

export interface ProtectionFulfillmentProvider {
  getOrder: typeof getOrderForStatusUpdate;
  list: typeof listOrderFulfillments;
  scopes: typeof getOrderAddressAccessScopes;
  write: typeof writeProtectionFulfillment;
}
const provider: ProtectionFulfillmentProvider = { getOrder: getOrderForStatusUpdate, list: listOrderFulfillments, scopes: getOrderAddressAccessScopes, write: writeProtectionFulfillment };
async function finishJob(client: PoolClient, id: string, status: string, message: string) {
  await client.query('UPDATE support_protection_fulfillment_jobs SET status=$2,message=$3,updated_at=now() WHERE id=$1', [id, status, message]);
}
async function reconcileLater(client: PoolClient, job: any, message: string) {
  await client.query("UPDATE support_protection_fulfillment_jobs SET status=$2,message=$3,next_attempt_at=now()+interval '5 minutes',updated_at=now() WHERE id=$1", [job.id, job.attempts >= 10 ? 'blocked' : 'retry', message]);
}
/** Future-only activation, durable work, and reconciliation before every remote mutation. */
export async function processProtectionFulfillments(api: ProtectionFulfillmentProvider = provider): Promise<void> {
  if (process.env.SUPPORT_PROTECTION_FULFILLMENT_ENABLED !== 'true') return;
  const client = await getClient(); let locked = false;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('protection-fulfillment-worker')) AS locked")).rows[0].locked;
    if (!locked) return;
    await client.query('UPDATE support_protection_fulfillment_control SET activated_at=COALESCE(activated_at,now()) WHERE id=1');
    await client.query(`INSERT INTO support_protection_fulfillment_store_activation(store_subdomain)
      SELECT p.store_subdomain FROM support_protection_stores p JOIN support_stores s ON s.subdomain=p.store_subdomain
      WHERE p.fulfillment_enabled=true AND s.enabled=true ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO support_protection_fulfillment_jobs(protection_order_id)
      SELECT o.id FROM support_protection_orders o JOIN support_protection_stores s ON s.store_subdomain=o.store_subdomain
      JOIN support_protection_fulfillment_store_activation a ON a.store_subdomain=o.store_subdomain
      CROSS JOIN support_protection_fulfillment_control c WHERE s.fulfillment_enabled=true AND o.order_status='finished'
        AND o.payment_status='paid' AND o.service_fulfillment_status NOT IN('completed','removed','refunded')
        AND (o.timeline_json->>'completed_at')::timestamptz>=GREATEST(c.activated_at,a.activated_at)
      ON CONFLICT(protection_order_id) DO NOTHING`);
    await client.query("UPDATE support_protection_fulfillment_jobs SET status='retry',next_attempt_at=now(),updated_at=now() WHERE status='processing' AND updated_at<now()-interval '10 minutes'");
    const job = (await client.query(`UPDATE support_protection_fulfillment_jobs SET status='processing',attempts=attempts+1,updated_at=now()
      WHERE id=(SELECT id FROM support_protection_fulfillment_jobs WHERE status IN('pending','retry') AND next_attempt_at<=now() ORDER BY id LIMIT 1) RETURNING *`)).rows[0];
    if (!job) return;
    try {
      const saved = (await client.query(`SELECT o.*,s.product_ids,s.fulfillment_enabled FROM support_protection_orders o
        JOIN support_protection_stores s ON s.store_subdomain=o.store_subdomain WHERE o.id=$1`, [job.protection_order_id])).rows[0];
      const store = saved && await getStoreBySubdomain(saved.store_subdomain);
      if (!saved?.fulfillment_enabled || !store?.enabled) { await finishJob(client, job.id, 'skipped', 'Store fulfillment automation is disabled.'); return; }
      const config = { subdomain: store.subdomain, storeName: store.store_name, accessToken: store.access_token };
      const scopes = await api.scopes(config);
      if (!scopes.includes('write_order')) { await finishJob(client, job.id, 'blocked', 'The app needs write_order permission.'); return; }
      const current = await api.getOrder(config, saved.order_id);
      if (['placed','opened'].includes(current.status) && current.financial_status==='paid' && !current.cancelled_at && !current.canceled_at) {
        await reconcileLater(client,job,'Current order lookup has not confirmed the recorded completion; no service write was made.');return;
      }
      const plan = planProtectionFulfillment(current, await api.list(config, saved.order_id), saved.product_ids);
      if (plan.action === 'skip' || plan.action === 'blocked' || plan.action === 'done') { await finishJob(client, job.id, plan.action === 'skip' ? 'skipped' : plan.action, plan.message); return; }
      if (plan.action === 'create') {
        if (job.create_attempted) { await reconcileLater(client,job,'A prior creation result is uncertain; reconciling without repeating creation.'); return; }
        // Persist uncertainty BEFORE the request; a crash must never blindly create twice.
        await client.query('UPDATE support_protection_fulfillment_jobs SET create_attempted=true,updated_at=now() WHERE id=$1', [job.id]);
        await api.write(config, saved.order_id, plan.lines);
      }
      // Refresh authoritative package membership before completing anything.
      const postWriteOrder=await api.getOrder(config,saved.order_id);
      if(['placed','opened'].includes(postWriteOrder.status)&&postWriteOrder.financial_status==='paid'&&!postWriteOrder.cancelled_at&&!postWriteOrder.canceled_at){
        await reconcileLater(client,job,'Post-write order lookup has not confirmed the recorded completion; no additional service write was made.');return;
      }
      const verified = planProtectionFulfillment(postWriteOrder, await api.list(config, saved.order_id), saved.product_ids);
      if (verified.action === 'complete') for (const id of verified.complete_ids) await api.write(config, saved.order_id, undefined, id);
      else if (verified.action === 'create') {
        await reconcileLater(client,job,'The created service fulfillment is not yet visible; reconciling without repeating creation.');return;
      }
      else if (verified.action !== 'done') {
        await finishJob(client, job.id, 'blocked', 'Service completion needs manual verification after the provider update.'); return;
      }
      const finalState = planProtectionFulfillment(await api.getOrder(config, saved.order_id), await api.list(config, saved.order_id), saved.product_ids);
      if (finalState.action !== 'done') {
        await client.query("UPDATE support_protection_fulfillment_jobs SET status=$2,message='Provider completion is not yet reflected; rechecking before further writes.',next_attempt_at=now()+interval '5 minutes',updated_at=now() WHERE id=$1", [job.id, job.attempts >= 10 ? 'blocked' : 'retry']);
        return;
      }
      await finishJob(client, job.id, 'done', 'Protection service fulfillment completed.');
    } catch (error) {
      const message = error instanceof Error && /^Shoplazza fulfillment HTTP \d+$/.test(error.message) ? error.message : 'Protection fulfillment failed; authoritative records will be checked before retry.';
      await client.query(`UPDATE support_protection_fulfillment_jobs SET status=$2,message=$3,next_attempt_at=now()+interval '5 minutes',updated_at=now() WHERE id=$1`, [job.id, job.attempts >= 10 ? 'blocked' : 'retry', message]);
    }
  } finally { if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('protection-fulfillment-worker'))"); client.release(); }
}
