import crypto from 'crypto';
import type { RequestHandler } from 'express';
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

export const requireWebhookAuth: RequestHandler = (req, res, next) => {
  const key = req.query.key;
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
    res.status(401).json({ ok: false, error: 'Invalid webhook authentication' });
    return;
  }
  try {
    const expected = callbackKey(req.params.storeSubdomain);
    if (!crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(expected, 'hex'))) {
      res.status(401).json({ ok: false, error: 'Invalid webhook authentication' });
      return;
    }
    const domain = req.get('X-Shoplazza-Shop-Domain');
    if (!domain || domain.toLowerCase() !== buildStoreDomain(req.params.storeSubdomain).toLowerCase()) {
      res.status(403).json({ ok: false, error: 'Webhook store mismatch' });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
};
