import express from 'express';
import rateLimit from 'express-rate-limit';
import { logWebhookRejection, requireWebhookAuth } from './webhook-security';

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
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    // Only authenticated requests reach this limiter. A shared provider/proxy
    // address must not make different stores consume the same receipt budget.
    keyGenerator: req => req.params.storeSubdomain.toLowerCase(),
    handler: (req, res) => {
      logWebhookRejection(req, 'rate_limited');
      // Shoplazza retries explicit 5xx responses, not 429 responses.
      res.status(503).json({ ok: false, error: 'Webhook receiver busy; retry later' });
    },
  });
  router.post('/webhook/:storeSubdomain', requireWebhookAuth, limiter);
  return router;
}
