import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import express from 'express';
import ts from 'typescript';

const STORE = { subdomain: 'route-fixture', storeName: 'Fixture', accessToken: 'offline-only' };
const SECRET = 'offline-route-fixture-secret';
const PARCEL = { id: 'parcel-a', order_id: 'order-a', updated_at: '2026-10-26T01:00:00Z', tracking_number: 'TRACK-A' };

// Only pure production modules and the real Express router run. Every database,
// store, API and mail dependency is intercepted before evaluating the module.
function load<T>(filename: string, dependencies: Record<string, unknown>): T {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, filename), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, URL, setTimeout, clearTimeout,
    process: { env: { SUPPORT_WEBHOOK_SECRET: SECRET } },
    console: { log() {}, warn() {}, error() {} },
    require(name: string) {
      if (!(name in dependencies)) throw new Error(`Unexpected external dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename });
  return module.exports as T;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function harness(t: TestContext, persist?: () => Promise<void>, stores?: () => Promise<typeof STORE[]>) {
  const calls = { queued: [] as any[][], paidEvents: [] as any[][], snapshots: [] as any[][], invites: [] as any[], worker: 0, storeLookups: 0 };
  const finished: boolean[] = [];
  let saved = false;
  let pendingPaid: any;
  const paidDone = gate();
  const forbid = () => { throw new Error('Offline route attempted an external API or live database'); };
  const config = {
    loadStoresConfig: async () => { calls.storeLookups++; return stores ? stores() : [STORE]; },
    buildStoreDomain: (subdomain: string) => `${subdomain}.myshoplaza.com`,
  };
  const database = { query: async (sql: string, values: any[]) => {
    if (sql.includes('INSERT INTO shoplazza_webhook_events')) {
      if (String(values[0]).startsWith('fulfillment:')) {
        calls.queued.push(values);
        if (persist) await persist();
        saved = true;
      } else {
        calls.paidEvents.push(values);
        if (String(values[0]).startsWith('paid:')) {
          if (persist) await persist();
          saved = true;
          pendingPaid = { id: 1, attempts: 1, store_subdomain: STORE.subdomain, payload_json: JSON.parse(values[5]) };
        }
      }
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    if (sql.includes("SET status = 'processing'") && sql.includes("LIKE 'paid:%'")) {
      const event = pendingPaid;
      pendingPaid = undefined;
      return { rows: event ? [event] : [], rowCount: event ? 1 : 0 };
    }
    if (sql.includes("SET status = 'processed'")) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO support_order_snapshots')) {
      calls.snapshots.push(values);
      return { rows: [{ is_new: true }], rowCount: 1 };
    }
    return forbid();
  } };
  const receiptDatabase = { ...database, queryWebhook: database.query };
  const core = load<typeof import('./fulfillment-service')>('fulfillment-service.ts', {
    'node:util': { isDeepStrictEqual }, './pg': { getPool: forbid },
  });
  const fulfillment = load<typeof import('./fulfillment-webhook')>('fulfillment-webhook.ts', {
    crypto, './pg': receiptDatabase, './store-service': { getStoreBySubdomain: forbid }, './fulfillment-service': core,
  });
  const security = load<typeof import('./webhook-security')>('webhook-security.ts', { crypto, './config': config });
  const processingDependencies = {
    crypto, './config': config, './pg': receiptDatabase,
    './shoplazza-client': { getOrderByNumber: forbid, getOrderDetail: forbid, getOrderTransactions: forbid },
    './normalize-order': load('normalize-order.ts', {}),
    './shipping-address-guard': { withSnapshotShippingAddressGuard: async (order: any, _fetch: unknown, write: any) => write(database, order) },
    './email-service': {
      extractStoreCustomDomain: () => '',
      createPaidSupportInviteEmailJob: async (params: unknown) => {
        calls.invites.push(params);
        return { inserted: true, job: { email_job_no: 'OFFLINE-ONLY' } };
      },
    },
    './log-service': { logSync: async (entry: any) => { if (entry.action === 'order_paid') paidDone.resolve(); } },
  };
  const paid = load<typeof import('./paid-webhook')>('paid-webhook.ts', processingDependencies);
  const router = load<typeof import('./shoplazza-webhook-routes')>('shoplazza-webhook-routes.ts', {
    ...processingDependencies, express,
    './paid-webhook': paid,
    './webhook-security': security,
    './fulfillment-webhook': {
      ...fulfillment,
      processPendingFulfillmentWebhooks: async () => { calls.worker++; return { processed: 0, failed: 0 }; },
    },
  });
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.on('finish', () => { finished.push(saved); }); next(); });
  app.use('/api/shoplazza', router.createShoplazzaWebhookRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => { server.once('listening', resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const port = (server.address() as { port: number }).port;
  async function post(topic: string, payload: unknown, options: { key?: string; domain?: string; subdomain?: string } = {}) {
    const subdomain = options.subdomain || STORE.subdomain;
    const key = options.key ?? crypto.createHmac('sha256', SECRET).update(`shoplazza-webhook:${subdomain}`).digest('hex');
    const domain = options.domain ?? config.buildStoreDomain(subdomain);
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1', port, method: 'POST',
        path: `/api/shoplazza/webhook/${subdomain}?key=${key}`,
        headers: { 'Content-Type': 'application/json', 'X-Shoplazza-Topic': topic, 'X-Shoplazza-Shop-Domain': domain },
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) }));
      });
      request.on('error', reject);
      request.end(JSON.stringify(payload));
    });
  }
  return { calls, finished, paidDone: paidDone.promise, post };
}

test('HTTP logistics receipt waits for durable INSERT before acknowledging and dispatching', { timeout: 5000 }, async t => {
  const started = gate();
  const commit = gate();
  const subject = await harness(t, async () => { started.resolve(); await commit.promise; });
  const response = subject.post('fulfillments/update', { fulfillment: PARCEL });
  await started.promise;
  try {
    // Let HTTP finish callbacks run while persistence remains deliberately held.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(subject.finished, []);
    assert.equal(subject.calls.worker, 0);
  } finally {
    commit.resolve();
  }
  assert.equal((await response).status, 200);
  assert.deepEqual(subject.finished, [true]);
  assert.equal(subject.calls.worker, 1);
  assert.equal(subject.calls.queued[0][3], 'order-a');
  assert.equal(subject.calls.paidEvents.length + subject.calls.snapshots.length + subject.calls.invites.length, 0);
});

test('HTTP all four logistics topics enter only the durable logistics queue', { timeout: 5000 }, async t => {
  const subject = await harness(t);
  for (const topic of ['fulfillments/create', 'fulfillments/update', 'orders/fulfilled', 'orders/partially_fulfilled']) {
    const payload = topic.startsWith('fulfillments/') ? { fulfillment: PARCEL }
      : { order: { id: 'order-a', number: 'ORDER-A', fulfillments: [PARCEL, { ...PARCEL, id: 'parcel-b', tracking_number: 'TRACK-B' }] } };
    assert.equal((await subject.post(topic, payload)).status, 200, topic);
  }
  assert.equal(subject.calls.queued.length, 4);
  assert.equal(subject.calls.worker, 4);
  assert.equal(subject.calls.paidEvents.length + subject.calls.snapshots.length + subject.calls.invites.length, 0);
});

test('HTTP failed persistence returns retryable 503 without dispatch or secret error text', { timeout: 5000 }, async t => {
  const subject = await harness(t, async () => { throw new Error('offline-sensitive-database-error'); });
  const response = await subject.post('fulfillments/update', { fulfillment: PARCEL });
  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.doesNotMatch(JSON.stringify(response.body), /offline-sensitive/);
  assert.equal(subject.calls.worker, 0);
  assert.deepEqual(subject.finished, [false]);
});

test('HTTP malformed or mixed-order logistics are rejected before any write', { timeout: 5000 }, async t => {
  const subject = await harness(t);
  const invalid = [
    {}, { fulfillment: {} }, { fulfillment: { ...PARCEL, id: 0 } },
    { fulfillment: { ...PARCEL, order_id: '' } },
    { fulfillment: { ...PARCEL, tracking_items: {} } },
    { fulfillment: { ...PARCEL, tracking_items: [null] } },
    { fulfillment: { ...PARCEL, updated_at: 'not-a-date' } },
  ];
  for (const payload of invalid) assert.equal((await subject.post('fulfillments/update', payload)).status, 400, JSON.stringify(payload));
  const mixed = { order: { id: 'order-a', fulfillments: [PARCEL, { ...PARCEL, id: 'parcel-b', order_id: 'order-b' }] } };
  assert.equal((await subject.post('orders/fulfilled', mixed)).status, 400);
  assert.equal(subject.calls.queued.length + subject.calls.paidEvents.length + subject.calls.worker, 0);
});

test('HTTP callback authentication and shop binding still run before logistics handling', { timeout: 5000 }, async t => {
  const subject = await harness(t);
  assert.equal((await subject.post('fulfillments/update', { fulfillment: PARCEL }, { key: '' })).status, 401);
  assert.equal((await subject.post('fulfillments/update', { fulfillment: PARCEL }, { key: '0'.repeat(64) })).status, 401);
  assert.equal((await subject.post('fulfillments/update', { fulfillment: PARCEL }, { domain: 'another.myshoplaza.com' })).status, 403);
  assert.equal((await subject.post('fulfillments/update', { fulfillment: PARCEL }, { subdomain: 'disabled-store' })).status, 404);
  assert.equal(subject.calls.queued.length + subject.calls.paidEvents.length + subject.calls.worker, 0);
});

test('HTTP paid event retains its existing snapshot and invite path without entering logistics', { timeout: 5000 }, async t => {
  const subject = await harness(t);
  const order = {
    id: 'order-a', number: 'ORDER-A', financial_status: 'paid', fulfillment_status: 'waiting',
    customer: { email: 'buyer@example.invalid' }, line_items: [{ title: 'Fixture', quantity: 1 }],
    payment_line: { payment_channel: 'paypal' }, total_price: '12.34', currency: 'USD',
    fulfillments: [PARCEL],
  };
  const response = await subject.post('orders/paid', { order });
  assert.equal(response.status, 200);
  await subject.paidDone;
  assert.equal(subject.calls.paidEvents.length, 1);
  assert.equal(subject.calls.snapshots.length, 1);
  assert.equal(subject.calls.snapshots[0][2], 'order-a');
  assert.equal(subject.calls.snapshots[0][10], 'paid');
  assert.equal(subject.calls.invites.length, 1);
  assert.equal(subject.calls.invites[0].customerEmail, 'buyer@example.invalid');
  assert.equal(subject.calls.queued.length + subject.calls.worker, 0);
});

test('HTTP paid receipt also waits for durable insert and never processes an unsaved event', { timeout: 5000 }, async t => {
  const started = gate(); const commit = gate();
  const subject = await harness(t, async () => { started.resolve(); await commit.promise; });
  const response = subject.post('orders/paid', { order: {
    id: 'order-a', number: 'ORDER-A', financial_status: 'paid', customer: { email: 'offline@example.invalid' },
    line_items: [{ title: 'Fixture' }], payment_line: { payment_channel: 'paypal' },
  } });
  await started.promise;
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(subject.finished, []);
    assert.equal(subject.calls.snapshots.length + subject.calls.invites.length, 0);
  } finally { commit.resolve(); }
  assert.equal((await response).status, 200);
  await subject.paidDone;
  assert.deepEqual(subject.finished, [true]);
  assert.equal(subject.calls.snapshots.length, 1);
  assert.equal(subject.calls.invites.length, 1);
});

test('HTTP paid persistence failure returns retryable 503 before processing', { timeout: 5000 }, async t => {
  const subject = await harness(t, async () => { throw new Error('secret-db-error'); });
  const response = await subject.post('orders/paid', { order: { id: 'order-a' } });
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(response.body), /secret-db-error/);
  assert.equal(subject.calls.snapshots.length + subject.calls.invites.length, 0);
  assert.deepEqual(subject.finished, [false]);
});

test('HTTP paid malformed/auth-failed/disabled requests do not enter either queue', { timeout: 5000 }, async t => {
  const subject = await harness(t);
  for (const payload of [{}, { order: {} }, { order: { id: 0 } }, { order: [] }]) {
    assert.equal((await subject.post('orders/paid', payload)).status, 400);
  }
  assert.equal((await subject.post('orders/paid', { order: { id: 'a' } }, { key: 'wrong' })).status, 401);
  assert.equal((await subject.post('orders/paid', { order: { id: 'a' } }, { subdomain: 'disabled' })).status, 404);
  assert.equal(subject.calls.paidEvents.length + subject.calls.queued.length + subject.calls.invites.length, 0);
});

test('HTTP durable routes bound store lookup time and share one in-flight lookup during a burst', { timeout: 5000 }, async t => {
  const storeGate = gate();
  const subject = await harness(t, undefined, async () => { await storeGate.promise; return [STORE]; });
  try {
    const responses = await Promise.all([
      subject.post('orders/paid', { order: { id: 'order-a' } }),
      subject.post('fulfillments/update', { fulfillment: PARCEL }),
    ]);
    assert.deepEqual(responses.map(response => response.status), [503, 503]);
    assert.equal(subject.calls.storeLookups, 1);
    assert.equal(subject.calls.paidEvents.length + subject.calls.queued.length, 0);
  } finally { storeGate.resolve(); }
});
