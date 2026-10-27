import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { createApiLimiter, createWebhookIngressRouter } from './api-rate-limits';

const SECRET = 'offline-rate-limit-test-only';

async function harness(t: TestContext) {
  const oldSecret = process.env.SUPPORT_WEBHOOK_SECRET;
  process.env.SUPPORT_WEBHOOK_SECRET = SECRET;
  t.after(() => {
    if (oldSecret === undefined) delete process.env.SUPPORT_WEBHOOK_SECRET;
    else process.env.SUPPORT_WEBHOOK_SECRET = oldSecret;
  });
  t.mock.method(console, 'warn', () => {});
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/', createApiLimiter());
  app.use('/api/shoplazza', createWebhookIngressRouter());
  let accepted = 0;
  app.post('/api/shoplazza/webhook/:storeSubdomain', (_req, res) => {
    accepted++;
    res.json({ ok: true });
  });
  app.get('/api/admin/fixture', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  async function request(store?: string, validKey = true): Promise<number> {
    const key = validKey
      ? crypto.createHmac('sha256', SECRET).update(`shoplazza-webhook:${store}`).digest('hex')
      : 'invalid';
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, method: store ? 'POST' : 'GET',
        path: store ? `/api/shoplazza/webhook/${store}?key=${key}` : '/api/admin/fixture',
        headers: { 'X-Forwarded-For': '172.20.0.1', 'X-Shoplazza-Shop-Domain': store || '' },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.end();
    });
  }
  return { request, accepted: () => accepted };
}

test('a webhook burst sharing the admin IP does not consume the interactive API allowance', async t => {
  const h = await harness(t);
  for (let i = 0; i < 235; i++) {
    assert.equal(await h.request(i % 2 ? 'a.myshoplaza.com' : 'b.myshoplaza.com'), 200);
  }
  for (let i = 0; i < 100; i++) assert.equal(await h.request(), 200);
  assert.equal(await h.request(), 429);
  assert.equal(await h.request('a.myshoplaza.com'), 200);
  assert.equal(h.accepted(), 236);
});

test('authenticated stores have separate budgets and overload gets a retryable 503', async t => {
  const h = await harness(t);
  for (let i = 0; i < 20; i++) assert.equal(await h.request('a.myshoplaza.com', false), 401);
  for (let i = 0; i < 600; i++) assert.equal(await h.request('a.myshoplaza.com'), 200);
  assert.equal(await h.request('a.myshoplaza.com'), 503);
  assert.equal(await h.request('b.myshoplaza.com'), 200);
  assert.equal(h.accepted(), 601);
});
