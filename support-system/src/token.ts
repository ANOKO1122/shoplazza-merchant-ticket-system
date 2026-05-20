import crypto from 'crypto';
import { query } from './pg';

export type AccessTokenPurpose = 'support_bootstrap' | 'ticket_access';

export interface AccessTokenPayload {
  purpose: AccessTokenPurpose;
  store_subdomain: string | null;
  order_id: string | null;
  public_ticket_no: string | null;
  customer_email: string;
}

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateOpaqueToken(prefix: 'bt' | 'ta'): string {
  return `${prefix}_${base64urlEncode(crypto.randomBytes(32))}`;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getExpiryDays(purpose: AccessTokenPurpose): number {
  if (purpose === 'support_bootstrap') {
    return Number(process.env.SUPPORT_BOOTSTRAP_TOKEN_DAYS) || 30;
  }
  return Number(process.env.SUPPORT_TICKET_ACCESS_TOKEN_DAYS) || 90;
}

async function storeToken(params: {
  tokenHash: string;
  purpose: AccessTokenPurpose;
  storeSubdomain?: string;
  orderId?: string;
  publicTicketNo?: string;
  customerEmail: string;
}): Promise<string> {
  const days = getExpiryDays(params.purpose);
  await query(
    `INSERT INTO support_access_tokens
      (token_hash, purpose, store_subdomain, order_id, public_ticket_no, customer_email, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval)`,
    [
      params.tokenHash,
      params.purpose,
      params.storeSubdomain || null,
      params.orderId || null,
      params.publicTicketNo || null,
      params.customerEmail,
      String(days),
    ],
  );
  return params.tokenHash;
}

export async function createBootstrapToken(params: {
  storeSubdomain: string;
  orderId: string;
  customerEmail: string;
}): Promise<string> {
  const token = generateOpaqueToken('bt');
  const th = hashToken(token);
  await storeToken({
    tokenHash: th,
    purpose: 'support_bootstrap',
    storeSubdomain: params.storeSubdomain,
    orderId: params.orderId,
    customerEmail: params.customerEmail,
  });
  return token;
}

export async function createTicketAccessToken(params: {
  publicTicketNo: string;
  customerEmail: string;
}): Promise<string> {
  const token = generateOpaqueToken('ta');
  const th = hashToken(token);
  await storeToken({
    tokenHash: th,
    purpose: 'ticket_access',
    publicTicketNo: params.publicTicketNo,
    customerEmail: params.customerEmail,
  });
  return token;
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  try {
    const th = hashToken(token);
    const r = await query(
      `SELECT purpose, store_subdomain, order_id, public_ticket_no, customer_email
       FROM support_access_tokens
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > now()`,
      [th],
    );
    if (r.rows.length === 0) return null;

    await query(
      `UPDATE support_access_tokens SET used_at = now() WHERE token_hash = $1`,
      [th],
    );

    const row = r.rows[0];
    return {
      purpose: row.purpose,
      store_subdomain: row.store_subdomain,
      order_id: row.order_id,
      public_ticket_no: row.public_ticket_no,
      customer_email: row.customer_email,
    };
  } catch {
    return null;
  }
}

export async function revokeToken(tokenHash: string): Promise<void> {
  await query(
    `UPDATE support_access_tokens SET revoked_at = now() WHERE token_hash = $1`,
    [tokenHash],
  );
}
