import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import { validateFulfillments } from './fulfillment-service';

const payload = { fulfillment: { id: 'parcel-a', order_id: 'order-1', updated_at: '2026-10-26T01:00:00Z', tracking_number: 'TRACK10001' } };
const store = { store_name: 'Fixture', enabled: true };
const applied = { matched: true, orderNumber: 'ORDER1', added: 0, updated: 1, unchanged: 0, stale: 0, changes: [], trackingNumbers: ['TRACK10001'] };

function load(dependencies: Record<string, unknown> = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/fulfillment-webhook.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mocks: Record<string, unknown> = {
    crypto,
    './pg': { query: async () => { throw new Error('Unexpected database query'); } },
    './store-service': { getStoreBySubdomain: async () => store },
    './fulfillment-service': { applyFulfillmentUpdate: async () => applied, validateFulfillments },
    ...dependencies,
  };
  vm.runInNewContext(code, { module, exports: module.exports, console: { error() {} }, require(name: string) {
    if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
    return mocks[name];
  } });
  return module.exports as typeof import('./fulfillment-webhook');
}

test('logistics payloads use fulfillment.order_id and preserve a second parcel separately', () => {
  const subject = load();
  const one = subject.parseFulfillmentWebhook('fulfillments/update', payload);
  assert.equal(one.orderId, 'order-1');
  assert.equal(one.fulfillments[0].id, 'parcel-a');
  assert.equal(one.fulfillmentStatus, undefined);
  const two = subject.parseFulfillmentWebhook('orders/partially_fulfilled', {
    order: { id: 'order-1', number: 'ORDER1', fulfillment_status: 'partially_shipped',
      fulfillments: [payload.fulfillment, { ...payload.fulfillment, id: 'parcel-b' }] },
  });
  assert.equal(two.fulfillments.length, 2);
  assert.equal(two.fulfillmentStatus, 'partially_shipped');
  for (const invalid of [{}, { fulfillment: {} }, { fulfillment: { id: 'p' } }]) {
    assert.throws(() => subject.parseFulfillmentWebhook('fulfillments/create', invalid), /Invalid fulfillment/);
  }
});

test('delivery IDs deduplicate retries but not another delivery or a later number update', () => {
  const subject = load();
  const key = (body: unknown, id?: string) => subject.fulfillmentEventKey('fixture', 'fulfillments/update', body, id);
  assert.equal(key(payload, 'delivery-a'), key(payload, 'delivery-a'));
  assert.notEqual(key(payload, 'delivery-a'), key(payload, 'delivery-b'));
  assert.notEqual(key(payload), key({ fulfillment: { ...payload.fulfillment, tracking_number: 'TRACK10002' } }));
  assert.equal(key({ b: 2, a: 1 }), key({ a: 1, b: 2 }));
  assert.notEqual(key(payload, 'delivery-a'), subject.fulfillmentEventKey('another-store', 'fulfillments/update', payload, 'delivery-a'));
});

test('enqueue rejects invalid payloads and propagates persistence failure instead of acknowledging success', async () => {
  let writes = 0;
  const subject = load({ './pg': { query: async () => { writes++; throw new Error('database unavailable'); } } });
  await assert.rejects(subject.enqueueFulfillmentWebhook({ storeSubdomain: 'fixture', topic: 'fulfillments/update', payload: {}, headers: {} }), /Invalid fulfillment/);
  assert.equal(writes, 0);
  await assert.rejects(subject.enqueueFulfillmentWebhook({ storeSubdomain: 'fixture', topic: 'fulfillments/update', payload, headers: {} }), /database unavailable/);
  assert.equal(writes, 1);
});

test('saved events exclude request credentials and keep order identity', async () => {
  let values: any[] = [];
  const subject = load({ './pg': { query: async (_sql: string, params: any[]) => { values = params; return { rows: [] }; } } });
  await subject.enqueueFulfillmentWebhook({ storeSubdomain: 'fixture', topic: 'fulfillments/update', payload, headers: {
    'x-shoplazza-deduplication-id': 'delivery-a', authorization: 'secret', cookie: 'secret', 'x-shoplazza-shop-domain': 'fixture.myshoplaza.com',
  } });
  assert.equal(values[3], 'order-1');
  assert.equal(JSON.stringify(values).includes('secret'), false);
  assert.equal(JSON.parse(values[6])['x-shoplazza-deduplication-id'], 'delivery-a');
});

test('worker processes saved logistics without calling the paid/mail workflow', async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  let claims = 0;
  let appliedParams: any;
  const subject = load({
    './pg': { query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('RETURNING *')) return { rows: claims++ === 0 ? [{ id: 42, store_subdomain: 'fixture', topic: 'fulfillments/update', payload_json: payload, attempts: 1 }] : [] };
      return { rows: [] };
    } },
    './fulfillment-service': { applyFulfillmentUpdate: async (params: unknown) => { appliedParams = params; return applied; }, validateFulfillments },
  });
  const result = await subject.processPendingFulfillmentWebhooks();
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(appliedParams.orderId, 'order-1');
  assert.equal(appliedParams.source, 'webhook');
  assert.ok(queries[0].sql.includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(queries.some(q => q.sql.includes("status = 'processed'") && q.params?.[0] === 42));
});

test('an order not yet inserted stays retryable and is never marked processed', async () => {
  let claims = 0;
  const queries: Array<{ sql: string; params?: any[] }> = [];
  const subject = load({
    './pg': { query: async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      return { rows: sql.includes('RETURNING *') && claims++ === 0
        ? [{ id: 42, store_subdomain: 'fixture', topic: 'fulfillments/create', payload_json: payload, attempts: 2 }] : [] };
    } },
    './fulfillment-service': { applyFulfillmentUpdate: async () => ({ ...applied, matched: false }), validateFulfillments },
  });
  const result = await subject.processPendingFulfillmentWebhooks();
  assert.equal(result.failed, 1);
  assert.equal(queries.some(q => q.sql.includes("status = 'processed'")), false);
  const failure = queries.find(q => q.sql.includes("status = 'failed'"));
  assert.equal(failure?.params?.[2], 60);
  assert.match(failure?.params?.[1], /queued for retry/);
});

test('overlapping worker triggers share the active run', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const subject = load({ './pg': { query: async () => { reads++; await gate; return { rows: [] }; } } });
  const first = subject.processPendingFulfillmentWebhooks();
  const second = subject.processPendingFulfillmentWebhooks();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(reads, 1);
});
