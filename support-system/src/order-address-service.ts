import { query, getClient } from './pg';
import { ShoplazzaStoreConfig } from './config';
import { getStoreBySubdomain } from './store-service';
import {
  getOrderForAddressUpdate, getOrderAddressAccessScopes, putOrderShippingAddress,
  ShoplazzaAddressApiError, ShoplazzaOrderDetail,
} from './shoplazza-client';
import { lockOrderShippingAddress } from './shipping-address-guard';
import { logOperation } from './log-service';

export const SHIPPING_ADDRESS_FIELDS = [
  'first_name', 'last_name', 'phone', 'country', 'country_code', 'province', 'province_code',
  'area', 'city', 'address', 'address1', 'company', 'zip', 'phone_area_code',
] as const;
type Address = Record<string, unknown>;
export type ShippingAddressRequestStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'conflict' | 'uncertain';

export class ShippingAddressError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'ShippingAddressError';
  }
}

export interface ShippingAddressRequest {
  id: string;
  storeSubdomain: string;
  orderId: string;
  source: string;
  actor: string;
  status: ShippingAddressRequestStatus;
  patch: Address;
  expectedAddress: Address;
  beforeAddress: Address | null;
  desiredAddress: Address | null;
  afterAddress: Address | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function record(value: unknown): value is Address {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function stringValue(value: unknown): string {
  return value == null ? '' : String(value);
}
function stamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : stringValue(value);
}
function asRequest(row: any): ShippingAddressRequest {
  return {
    id: String(row.id), storeSubdomain: row.store_subdomain, orderId: row.order_id,
    source: row.source, actor: row.actor, status: row.status,
    patch: row.patch_json, expectedAddress: row.expected_address_json,
    beforeAddress: row.before_address_json ?? null, desiredAddress: row.desired_address_json ?? null,
    afterAddress: row.after_address_json ?? null,
    errorCode: row.error_code ?? null, errorMessage: row.error_message ?? null,
    createdAt: stamp(row.created_at), updatedAt: stamp(row.updated_at), completedAt: row.completed_at ? stamp(row.completed_at) : null,
  };
}
function validateInput(patch: unknown, expectedAddress: unknown): asserts patch is Record<string, string> {
  if (!record(patch) || Object.keys(patch).length === 0
    || Object.entries(patch).some(([key, value]) => !(SHIPPING_ADDRESS_FIELDS as readonly string[]).includes(key)
      || typeof value !== 'string' || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new ShippingAddressError('invalid_patch', '地址修改包含不允许的字段或格式；邮箱不可修改。');
  }
  if (!record(expectedAddress) || JSON.stringify(expectedAddress).length > 32768
    || [...SHIPPING_ADDRESS_FIELDS, 'email'].some(key => expectedAddress[key] != null && typeof expectedAddress[key] !== 'string')) {
    throw new ShippingAddressError('invalid_expected_address', '请重新读取订单地址后再提交。');
  }
}
function equalAddress(left: Address, right: Address): boolean {
  return [...SHIPPING_ADDRESS_FIELDS, 'email'].every(key => stringValue(left[key]) === stringValue(right[key]));
}
function hasMeaningfulValue(value: unknown): boolean {
  if (record(value)) return Object.values(value).some(hasMeaningfulValue);
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  return value != null && String(value).trim() !== '';
}
function disabledOrderReason(order: ShoplazzaOrderDetail): { code: string; message: string } | null {
  if (!['opened', 'placed'].includes(String(order.status || '').toLowerCase()) || order.cancelled_at || order.deleted_at) {
    return { code: 'order_not_editable', message: '已取消、已完成或已删除订单不能在此修改地址。' };
  }
  if (!['initialled', 'waiting', 'unfulfilled'].includes(String(order.fulfillment_status || '').toLowerCase())) {
    return { code: 'order_fulfilled', message: '只允许未发货订单修改地址；部分发货或状态不明的订单请到店匠处理。' };
  }
  if (order.fulfillments !== undefined && !Array.isArray(order.fulfillments)) {
    return { code: 'unknown_fulfillment', message: '无法确认发货信息，请到店匠核对。' };
  }
  if (Array.isArray(order.fulfillments) && order.fulfillments.some((item: any) => !record(item)
    || !['pending', 'cancelled'].includes(String(item.status || '').toLowerCase()))) {
    return { code: 'order_fulfilled', message: '订单已有发货记录，请到店匠处理地址。' };
  }
  if (Array.isArray(order.line_items) && order.line_items.some((item: any) => Number(item?.ship_quantity || 0) > 0)) {
    return { code: 'order_fulfilled', message: '订单已有商品发货，请到店匠处理地址。' };
  }
  if (hasMeaningfulValue(order.shipping_address?.extra_info) || hasMeaningfulValue(order.shipping_address?.cpf)
    || hasMeaningfulValue(order.shipping_address?.id_number)) {
    return { code: 'unsupported_address_fields', message: '地址包含税号或证件等特殊信息，请直接到店匠修改，以免丢失这些字段。' };
  }
  return null;
}
function writableAddress(address: Address): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [...SHIPPING_ADDRESS_FIELDS, 'email']) result[key] = stringValue(address[key]);
  return result;
}
function validateDesiredAddress(address: Address): void {
  if (!stringValue(address.first_name).trim() && !stringValue(address.last_name).trim()) {
    throw new ShippingAddressError('invalid_address', '请填写收件人姓名。');
  }
  if (!stringValue(address.address).trim() || !stringValue(address.city).trim()
    || !(stringValue(address.country_code).trim() || stringValue(address.country).trim())) {
    throw new ShippingAddressError('invalid_address', '请填写地址第一行、城市和国家。');
  }
  if (stringValue(address.country_code) && !/^[a-z]{2}$/i.test(stringValue(address.country_code))) {
    throw new ShippingAddressError('invalid_country_code', '国家代码必须为两个英文字母，例如 US。');
  }
}
async function enabledStore(storeSubdomain: string): Promise<ShoplazzaStoreConfig> {
  // Store access tokens are encrypted at rest; use the shared decryption path.
  const row = await getStoreBySubdomain(storeSubdomain);
  if (!row?.enabled) throw new ShippingAddressError('store_disabled', '店铺不存在或已停用。', 409);
  return { subdomain: row.subdomain, storeName: row.store_name || row.subdomain, accessToken: row.access_token };
}

export async function getOrderShippingAddress(params: { storeSubdomain: string; orderId: string }) {
  const activeRequest = await getActiveShippingAddressRequest(params);
  try {
    const store = await enabledStore(params.storeSubdomain);
    const scopes = await getOrderAddressAccessScopes(store);
    const order = await getOrderForAddressUpdate(store, params.orderId);
    const reason = disabledOrderReason(order);
    const hasWriteScope = scopes.includes('write_order');
    return {
      address: order.shipping_address!, fulfillmentStatus: stringValue(order.fulfillment_status),
      editable: hasWriteScope && !reason && !activeRequest,
      disabledReason: activeRequest ? '该订单已有待处理或待确认的地址请求。'
        : !hasWriteScope ? '该店铺尚未授权订单写权限（write_order）。' : reason?.message,
      updatedAt: stringValue(order.updated_at), hasWriteScope, activeRequest,
    };
  } catch (error) {
    if (activeRequest) return {
      address: activeRequest.beforeAddress || activeRequest.expectedAddress, fulfillmentStatus: '', editable: false,
      disabledReason: '暂时无法读取店匠订单，正在展示已有改址请求。', updatedAt: '', hasWriteScope: false, activeRequest,
    };
    if (error instanceof ShippingAddressError) throw error;
    throw new ShippingAddressError('provider_unavailable', '暂时无法读取店匠订单或权限，请稍后重试。', 502);
  }
}

export async function getActiveShippingAddressRequest(params: { storeSubdomain: string; orderId: string }): Promise<ShippingAddressRequest | null> {
  const result = await query(`SELECT * FROM support_shipping_address_requests WHERE store_subdomain=$1 AND order_id=$2
    AND status IN ('pending','processing','uncertain') ORDER BY id DESC LIMIT 1`, [params.storeSubdomain, params.orderId]);
  return result.rows[0] ? asRequest(result.rows[0]) : null;
}

export async function getShippingAddressRequest(id: string): Promise<ShippingAddressRequest | null> {
  if (!validRequestId(id)) throw new ShippingAddressError('invalid_request_id', '无效的地址修改请求编号。');
  const result = await query('SELECT * FROM support_shipping_address_requests WHERE id=$1', [id]);
  return result.rows[0] ? asRequest(result.rows[0]) : null;
}

export async function submitShippingAddressRequest(params: {
  storeSubdomain: string; orderId: string; patch: unknown; expectedAddress: unknown;
  actor: string; source: string; idempotencyKey: string;
}): Promise<ShippingAddressRequest> {
  validateInput(params.patch, params.expectedAddress);
  if (!params.storeSubdomain || !params.orderId || !params.actor || !params.source || !params.idempotencyKey) {
    throw new ShippingAddressError('invalid_request', '缺少地址修改请求信息。');
  }
  try {
    const result = await query('SELECT support_submit_shipping_address_request($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7) AS id', [
      params.storeSubdomain, params.orderId, JSON.stringify(params.patch), JSON.stringify(params.expectedAddress),
      params.actor, params.source, params.idempotencyKey,
    ]);
    const request = await getShippingAddressRequest(String(result.rows[0]?.id));
    if (!request) throw new ShippingAddressError('request_not_found', '地址请求未保存，请稍后重试。', 503);
    return request;
  } catch (error: any) {
    if (error instanceof ShippingAddressError) throw error;
    if (error?.code === '23505' || error?.code === '55000') throw new ShippingAddressError('request_in_progress', '该订单已有地址修改请求，或请求编号已使用；请先核对已有请求。', 409);
    if (error?.code === '22023' || error?.code === 'P0001') throw new ShippingAddressError('request_rejected', '请求信息无效、订单不可用或同一请求编号已用于不同修改，请刷新后核对。', 409);
    throw new ShippingAddressError('queue_unavailable', '暂时无法保存地址修改请求，请稍后重试。', 503);
  }
}

type Client = Awaited<ReturnType<typeof getClient>>;
async function finish(client: Client, row: any, status: ShippingAddressRequestStatus, code: string | null, message: string | null, after?: Address): Promise<void> {
  const updated = await client.query(`UPDATE support_shipping_address_requests SET status=$3,error_code=$4,error_message=$5,
    after_address_json=COALESCE($6::jsonb,after_address_json),updated_at=now(),
    completed_at=CASE WHEN $3 IN ('succeeded','failed','conflict') THEN now() ELSE NULL END
    WHERE id=$1 AND attempts=$2 AND status='processing'`, [row.id, row.attempts, status, code, message, after ? JSON.stringify(after) : null]);
  if (updated.rowCount !== 1) throw new ShippingAddressError('ownership_lost', '请求处理权已变更，等待重新核对。', 409);
}

async function readStateRevision(client: Client, row: any): Promise<string | null> {
  const state = await client.query('SELECT revision FROM support_order_shipping_address_state WHERE store_subdomain=$1 AND order_id=$2', [row.store_subdomain, row.order_id]);
  return state.rows[0] ? String(state.rows[0].revision) : null;
}

async function saveConfirmed(client: Client, row: any, order: ShoplazzaOrderDetail, expectedRevision: string | null): Promise<void> {
  const updatedAt = Number.isFinite(Date.parse(order.updated_at || '')) ? new Date(order.updated_at).toISOString() : null;
  await client.query('BEGIN');
  try {
    await lockOrderShippingAddress(client, row.store_subdomain, row.order_id);
    const owner = await client.query("SELECT id FROM support_shipping_address_requests WHERE id=$1 AND attempts=$2 AND status='processing' FOR UPDATE", [row.id, row.attempts]);
    if (!owner.rows.length) throw new ShippingAddressError('ownership_lost', '请求处理权已变更，等待重新核对。', 409);
    const state = await client.query('SELECT provider_updated_at,revision FROM support_order_shipping_address_state WHERE store_subdomain=$1 AND order_id=$2', [row.store_subdomain, row.order_id]);
    if ((state.rows[0] ? String(state.rows[0].revision) : null) !== expectedRevision) {
      throw new ShippingAddressError('address_revision_changed', '读取后又收到新的地址信息，等待再次核对。', 409);
    }
    if (state.rows[0]?.provider_updated_at && updatedAt && Date.parse(stamp(state.rows[0].provider_updated_at)) > Date.parse(updatedAt)) {
      throw new ShippingAddressError('newer_address_seen', '已收到较新的订单信息，等待再次核对地址。', 409);
    }
    // A revision-checked authoritative GET may omit updated_at. Preserve the known
    // provider time as a lower bound instead of stranding a verified request forever.
    const providerUpdatedAt = updatedAt || state.rows[0]?.provider_updated_at || null;
    const address = JSON.stringify(order.shipping_address);
    await client.query(`INSERT INTO support_order_shipping_address_state
      (store_subdomain,order_id,address_json,provider_updated_at,revision,confirmed_at,updated_at)
      VALUES ($1,$2,$3::jsonb,$4,1,now(),now())
      ON CONFLICT (store_subdomain,order_id) DO UPDATE SET address_json=EXCLUDED.address_json,
        provider_updated_at=EXCLUDED.provider_updated_at,revision=support_order_shipping_address_state.revision+1,
        confirmed_at=now(),updated_at=now()`, [row.store_subdomain, row.order_id, address, providerUpdatedAt]);
    // Match the fulfillment and guarded snapshot writers' row order across emails.
    await client.query('SELECT id FROM support_order_snapshots WHERE store_subdomain=$1 AND order_id=$2 ORDER BY id FOR UPDATE', [row.store_subdomain, row.order_id]);
    const snapshots = await client.query(`UPDATE support_order_snapshots SET shipping_address_json=$3::jsonb,
      raw_order_json=jsonb_set(COALESCE(raw_order_json,'{}'::jsonb),'{shipping_address}',$3::jsonb,true),updated_at=now()
      WHERE store_subdomain=$1 AND order_id=$2`, [row.store_subdomain, row.order_id, address]);
    if (!snapshots.rowCount) throw new ShippingAddressError('local_order_missing', '店匠地址已读回，但本地订单记录不存在，暂时无法完成确认。', 409);
    await finish(client, row, 'succeeded', null, null, order.shipping_address!);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function confirmWrite(client: Client, row: any, store: ShoplazzaStoreConfig, rejection?: unknown): Promise<void> {
  const revision = await readStateRevision(client, row);
  const current = await getOrderForAddressUpdate(store, row.order_id);
  if (record(row.desired_address_json) && equalAddress(current.shipping_address!, row.desired_address_json)) {
    await saveConfirmed(client, row, current, revision);
  } else if (rejection instanceof ShoplazzaAddressApiError && [400,401,403,404,422,429].includes(rejection.httpStatus)
    && record(row.before_address_json) && equalAddress(current.shipping_address!, row.before_address_json)) {
    await finish(client, row, 'failed', 'provider_rejected', '店匠拒绝了地址修改，回读地址仍为原值。请核对权限和地址后重新提交。', current.shipping_address!);
  } else {
    await finish(client, row, 'uncertain', 'confirmation_mismatch', '店匠当前地址尚未与本次请求一致；系统只会继续读取核对，不会重复写入。', current.shipping_address!);
  }
}

let running = false;
function validRequestId(id: string): boolean {
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
}
/** A single session lock covers GET/PUT/GET. Recovery of a possible write is always read-only. */
export async function processShippingAddressRequest(id?: string): Promise<ShippingAddressRequest | null> {
  if (running) return null;
  if (id !== undefined && !validRequestId(id)) throw new ShippingAddressError('invalid_request_id', '无效的地址修改请求编号。');
  running = true;
  let client: Client | undefined;
  let locked = false;
  let releaseError: Error | undefined;
  let row: any;
  try {
    client = await getClient();
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('support.shipping-address.worker'),0) AS acquired");
    locked = lock.rows[0]?.acquired === true;
    if (!locked) return null;
    const claim = await client.query(`WITH candidate AS (
      SELECT id FROM support_shipping_address_requests WHERE ($1::bigint IS NULL OR id=$1)
        AND (status='pending' OR (status='processing' AND locked_at < now()-interval '5 minutes')
          OR (status='uncertain' AND ($1::bigint IS NOT NULL OR updated_at < now()-interval '5 minutes')))
      ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE support_shipping_address_requests r SET status='processing',attempts=attempts+1,locked_at=now(),updated_at=now()
      FROM candidate WHERE r.id=candidate.id RETURNING r.*`, [id ?? null]);
    row = claim.rows[0];
    if (!row) return null;
    try {
      const store = await enabledStore(row.store_subdomain);
      if (row.write_started_at) {
        await confirmWrite(client, row, store);
      } else {
        validateInput(row.patch_json, row.expected_address_json);
        const scopes = await getOrderAddressAccessScopes(store);
        if (!scopes.includes('write_order')) throw new ShippingAddressError('missing_write_scope', '该店铺尚未授权订单写权限（write_order）。', 403);
        const revision = await readStateRevision(client, row);
        const current = await getOrderForAddressUpdate(store, row.order_id);
        const reason = disabledOrderReason(current);
        if (reason) throw new ShippingAddressError(reason.code, reason.message, 409);
        if (!equalAddress(current.shipping_address!, row.expected_address_json)) {
          await finish(client, row, 'conflict', 'address_changed', '店匠地址已被其他操作修改，请读取最新地址后重新提交。', current.shipping_address!);
        } else {
          const desired = { ...writableAddress(current.shipping_address!), ...row.patch_json };
          validateDesiredAddress(desired);
          const changed = !equalAddress(current.shipping_address!, desired);
          const prepared = await client.query(`UPDATE support_shipping_address_requests SET before_address_json=$3::jsonb,
            desired_address_json=$4::jsonb,write_started_at=CASE WHEN $5 THEN now() ELSE NULL END,updated_at=now()
            WHERE id=$1 AND attempts=$2 AND status='processing' RETURNING *`,
          [row.id, row.attempts, JSON.stringify(current.shipping_address), JSON.stringify(desired), changed]);
          if (!prepared.rows.length) return null;
          row = prepared.rows[0];
          if (!changed) {
            await saveConfirmed(client, row, current, revision);
          } else {
            let rejection: unknown;
            try { await putOrderShippingAddress(store, row.order_id, desired); } catch (error) { rejection = error; }
            await confirmWrite(client, row, store, rejection);
          }
        }
      }
    } catch (error) {
      const uncertain = Boolean(row.write_started_at);
      const safe = error instanceof ShippingAddressError ? error : null;
      await finish(client, row, uncertain ? 'uncertain' : 'failed', safe?.code || (uncertain ? 'confirmation_unavailable' : 'provider_unavailable'),
        safe?.message || (uncertain ? '修改结果暂时无法确认；系统会继续读取核对，不会重复写入。' : '暂时无法校验店匠订单或权限，未提交地址修改。'));
    }
    const result = await getShippingAddressRequest(String(row.id));
    if (result && result.status !== 'processing') {
      await logOperation({ category: 'ticket', action: 'shipping_address_update', actor: row.actor,
        storeSubdomain: row.store_subdomain, target: row.order_id,
        summary: result.status === 'succeeded' ? '订单收货地址已在店匠确认' : `订单改址请求：${result.status}`,
        status: result.status === 'succeeded' ? 'success' : result.status === 'uncertain' ? 'partial' : 'failed',
        detailJson: { requestId: String(row.id), source: row.source, status: result.status, errorCode: result.errorCode,
          changedFields: Object.keys(row.patch_json) },
      });
    }
    return result;
  } finally {
    if (client && locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext('support.shipping-address.worker'),0)"); }
      catch { releaseError = new Error('Address worker lock release failed'); }
    }
    client?.release(releaseError);
    running = false;
  }
}

export async function processPendingShippingAddressRequests(limit = 5): Promise<number> {
  let processed = 0;
  for (let index = 0; index < Math.min(20, Math.max(1, limit)); index++) {
    if (!await processShippingAddressRequest()) break;
    processed++;
  }
  return processed;
}
