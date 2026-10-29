import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireWebhookAuth } from './webhook-security';

export function isShoplazzaWebhookRequest(req: express.Request): boolean {
  // originalUrl keeps the /api prefix while mounted middleware changes req.path.
  const path = req.originalUrl.split('?', 1)[0];
  return req.method === 'POST' && /^\/api\/shoplazza\/webhook\/[^/]+\/?$/i.test(path);
}

export function createApiLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isShoplazzaWebhookRequest,
    message: { ok: false, error: '请求过于频繁，请稍后重试' },
  });
}

export function createWebhookIngressRouter(): express.Router {
  const router = express.Router();
  router.post('/webhook/:storeSubdomain', requireWebhookAuth);
  return router;
}
