import crypto from 'crypto';
import type { Request, RequestHandler } from 'express';
import { buildStoreDomain } from './config';

// 独立于店匠应用的 HMAC 签名：通过 HTTPS 回调地址携带每店密钥。
// 当前部署没有店匠 Client Secret，不能把 Access Token 当作签名密钥。
function callbackKey(storeSubdomain: string): string {
  const secret = process.env.SUPPORT_WEBHOOK_SECRET || process.env.SUPPORT_TOKEN_SECRET;
  if (!secret) throw new Error('Webhook authentication secret is not configured');
  return crypto.createHmac('sha256', secret)
    .update(`shoplazza-webhook:${storeSubdomain}`)
    .digest('hex');
}

export function buildWebhookCallbackUrl(baseUrl: string, storeSubdomain: string): string {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/shoplazza/webhook/${encodeURIComponent(storeSubdomain)}`);
  if (url.protocol !== 'https:') throw new Error('Webhook callback must use HTTPS');
  url.searchParams.set('key', callbackKey(storeSubdomain));
  return url.toString();
}

export function redactWebhookAddress(address: string): string {
  try {
    const url = new URL(address);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '[invalid webhook address]';
  }
}

const REJECTION_REASONS = [
  'missing_key', 'malformed_key', 'key_mismatch', 'store_mismatch',
  'rate_limited', 'store_disabled', 'invalid_payload', 'persist_failed',
  'payload_too_large', 'invalid_json',
] as const;

export type WebhookRejectionReason = typeof REJECTION_REASONS[number];

function safeShop(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  // Header/path values are untrusted: reject URLs, emails, control characters and credential-like tokens.
  return /^[a-z0-9][a-z0-9.-]{0,127}$/i.test(value) && !/[a-f0-9]{32,}/i.test(value)
    ? value.toLowerCase() : '[invalid]';
}

/** Deliberately accepts no URL/query/body/error fields; delivery identifiers are only logged as hashes. */
export function logWebhookRejection(req: Pick<Request, 'params' | 'get'>, reason: WebhookRejectionReason): void {
  const topic = req.get('X-Shoplazza-Topic');
  const deliveryId = req.get('X-Shoplazza-Deduplication-Id');
  console.warn('[webhook-rejected]', JSON.stringify({
    reason: REJECTION_REASONS.includes(reason) ? reason : 'unknown_rejection',
    shop: safeShop(req.params.storeSubdomain),
    headerShop: safeShop(req.get('X-Shoplazza-Shop-Domain')),
    topic: topic ? (/^[a-z_]{1,24}\/[a-z_]{1,32}$/.test(topic) ? topic : '[invalid]') : undefined,
    deliveryIdHash: deliveryId ? crypto.createHash('sha256').update(deliveryId).digest('hex').slice(0, 16) : undefined,
  }));
}

export const requireWebhookAuth: RequestHandler = (req, res, next) => {
  const key = req.query.key;
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
    logWebhookRejection(req, key === undefined ? 'missing_key' : 'malformed_key');
    res.status(401).json({ ok: false, error: 'Invalid webhook authentication' });
    return;
  }
  try {
    const expected = callbackKey(req.params.storeSubdomain);
    if (!crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(expected, 'hex'))) {
      logWebhookRejection(req, 'key_mismatch');
      res.status(401).json({ ok: false, error: 'Invalid webhook authentication' });
      return;
    }
    const domain = req.get('X-Shoplazza-Shop-Domain');
    if (!domain || domain.toLowerCase() !== buildStoreDomain(req.params.storeSubdomain).toLowerCase()) {
      logWebhookRejection(req, 'store_mismatch');
      res.status(403).json({ ok: false, error: 'Webhook store mismatch' });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
};
