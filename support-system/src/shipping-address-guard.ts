import type { PoolClient } from 'pg';
import { getClient } from './pg';
import type { NormalizedOrder } from './normalize-order';

type Address = Record<string, unknown>;
type LatestOrder = { id?: unknown; updated_at?: unknown; shipping_address?: unknown };
type AddressState = {
  address_json: Address;
  provider_updated_at: Date | string | null;
  revision: string | number;
};

/** Shared with customer-service edits, including orders without a state row yet. */
export async function lockOrderShippingAddress(client: PoolClient, storeSubdomain: string, orderId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [`support.shipping-address:${storeSubdomain}`, orderId]);
}

function timestamp(value: unknown): number | null {
  if (!(value instanceof Date) && (typeof value !== 'string' || !value.trim())) return null;
  const parsed = new Date(value as string).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function address(value: unknown, saved: Address): Address | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) return null;
  const candidate = value as Address;
  const hasStreet = (item: Address) => ['address', 'address1'].some(key => typeof item[key] === 'string' && item[key].trim());
  // A partial event containing only the recipient/email cannot erase a street.
  return hasStreet(saved) && !hasStreet(candidate) ? null : candidate;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Address)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Keep normalized/raw addresses together and serialize with the final edit commit.
 * Only confirmed edits create state rows; ordinary orders retain their original upsert.
 * Ambiguous events are verified outside the transaction, then checked against the
 * same state revision. An unsuccessful verification never blocks the paid workflow.
 */
export async function withSnapshotShippingAddressGuard<T extends { rowCount: number | null }>(
  incoming: NormalizedOrder,
  fetchLatestOrder: () => Promise<LatestOrder | null>,
  writeSnapshot: (client: PoolClient, guarded: NormalizedOrder) => Promise<T>,
): Promise<T> {
  let verification: { revision: string; order: LatestOrder | null } | undefined;
  while (true) {
    const client = await getClient();
    let active = false;
    let releaseError: Error | undefined;
    let verifyRevision: string | undefined;
    try {
      await client.query('BEGIN');
      active = true;
      await lockOrderShippingAddress(client, incoming.storeSubdomain, incoming.orderId);
      // This must be a separate statement AFTER acquiring the lock: its READ
      // COMMITTED snapshot must include an edit that committed while we waited.
      const result = await client.query<AddressState>(
        `SELECT address_json, provider_updated_at, revision
         FROM support_order_shipping_address_state WHERE store_subdomain = $1 AND order_id = $2`,
        [incoming.storeSubdomain, incoming.orderId],
      );
      const state = result.rows[0];
      let guarded = incoming;
      let acceptedAddress: Address | null = null;
      let acceptedTime: number | null = null;
      if (state) {
        const candidate = address(incoming.rawOrderJson.shipping_address, state.address_json);
        const candidateTime = timestamp(incoming.rawOrderJson.updated_at);
        const savedTime = timestamp(state.provider_updated_at);
        const differs = candidate && canonical(candidate) !== canonical(state.address_json);
        if (verification) {
          const verified = verification.order;
          const verifiedAddress = address(verified?.shipping_address, state.address_json);
          const verifiedTime = timestamp(verified?.updated_at);
          if (String(state.revision) === verification.revision && verifiedAddress
            && String(verified?.id || '') === incoming.orderId
            && !(savedTime !== null && verifiedTime !== null && verifiedTime < savedTime)) {
            acceptedAddress = verifiedAddress;
            acceptedTime = verifiedTime ?? savedTime;
          }
        } else if (candidate && savedTime !== null && candidateTime !== null && candidateTime > savedTime) {
          acceptedAddress = candidate;
          acceptedTime = candidateTime;
        } else if (differs && (savedTime === null || candidateTime === null || candidateTime === savedTime)) {
          verifyRevision = String(state.revision);
        }
        const resolved = acceptedAddress || state.address_json;
        guarded = { ...incoming, shippingAddressJson: resolved,
          rawOrderJson: { ...incoming.rawOrderJson, shipping_address: resolved } };
      }
      if (verifyRevision !== undefined) {
        await client.query('COMMIT');
        active = false;
      } else {
        const advances = state && acceptedAddress
          && (canonical(acceptedAddress) !== canonical(state.address_json)
            || acceptedTime !== timestamp(state.provider_updated_at));
        if (advances) {
          // The fulfillment merger locks all email snapshots in ID order too.
          // Lock before the single-email upsert to avoid opposite row lock order.
          await client.query(
            `SELECT id FROM support_order_snapshots WHERE store_subdomain = $1 AND order_id = $2 ORDER BY id FOR UPDATE`,
            [incoming.storeSubdomain, incoming.orderId],
          );
        }
        const written = await writeSnapshot(client, guarded);
        // In particular, a waiting event rejected by the paid-row WHERE clause
        // must not advance the protected address or its revision.
        if (advances && (written.rowCount ?? 0) > 0) {
          await client.query(
            `UPDATE support_order_shipping_address_state
             SET address_json = $3::jsonb, provider_updated_at = $4, revision = revision + 1, updated_at = now()
             WHERE store_subdomain = $1 AND order_id = $2`,
            [incoming.storeSubdomain, incoming.orderId, JSON.stringify(acceptedAddress),
              acceptedTime === null ? null : new Date(acceptedTime).toISOString()],
          );
          await client.query(
            `UPDATE support_order_snapshots SET shipping_address_json = $3::jsonb,
               raw_order_json = jsonb_set(COALESCE(raw_order_json, '{}'::jsonb), '{shipping_address}', $3::jsonb, true),
               updated_at = now()
             WHERE store_subdomain = $1 AND order_id = $2`,
            [incoming.storeSubdomain, incoming.orderId, JSON.stringify(acceptedAddress)],
          );
        }
        await client.query('COMMIT');
        active = false;
        return written;
      }
    } catch (error) {
      if (active) {
        try { await client.query('ROLLBACK'); }
        catch { releaseError = new Error('Shipping-address transaction rollback failed'); }
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
    // No database connection or transaction is held during the provider call.
    let latest: LatestOrder | null = null;
    try { latest = await fetchLatestOrder(); } catch { /* Keep the last confirmed address; future conflicts can retry. */ }
    verification = { revision: verifyRevision!, order: latest };
  }
}
