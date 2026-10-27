import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { Pool } from 'pg';
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
    './pg': {
      query: async () => { throw new Error('Unexpected worker database query'); },
      queryWebhook: async () => { throw new Error('Unexpected receipt database query'); },
    },
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

test('a reused provider header cannot collapse different orders or later number updates', () => {
  const subject = load();
  const key = (body: unknown, id?: string) => subject.fulfillmentEventKey('fixture', 'fulfillments/update', body, id);
  assert.equal(key(payload, 'delivery-a'), key(payload, 'delivery-a'));
  assert.equal(key(payload, 'delivery-a'), key(payload, 'delivery-b'));
  assert.equal(key(payload), key(payload, 'delivery-a'));
  assert.notEqual(key(payload, 'reused-header'), key({ fulfillment: { ...payload.fulfillment, order_id: 'order-2' } }, 'reused-header'));
  assert.notEqual(key(payload, 'reused-header'), key({ fulfillment: { ...payload.fulfillment, tracking_number: 'TRACK10002' } }, 'reused-header'));
  assert.notEqual(key(payload, 'reused-header'), key({ fulfillment: { ...payload.fulfillment, id: 'parcel-b' } }, 'reused-header'));
  assert.equal(key({ b: 2, a: 1 }), key({ a: 1, b: 2 }));
  assert.notEqual(key(payload, 'delivery-a'), subject.fulfillmentEventKey('another-store', 'fulfillments/update', payload, 'delivery-a'));
  assert.notEqual(key(payload), subject.fulfillmentEventKey('fixture', 'fulfillments/create', payload));
  assert.match(key(payload), /^fulfillment:v2:/);
});

test('enqueue rejects invalid payloads and propagates persistence failure instead of acknowledging success', async () => {
  let writes = 0;
  const subject = load({ './pg': { queryWebhook: async () => { writes++; throw new Error('database unavailable'); } } });
  await assert.rejects(subject.enqueueFulfillmentWebhook({ storeSubdomain: 'fixture', topic: 'fulfillments/update', payload: {}, headers: {} }), /Invalid fulfillment/);
  assert.equal(writes, 0);
  await assert.rejects(subject.enqueueFulfillmentWebhook({ storeSubdomain: 'fixture', topic: 'fulfillments/update', payload, headers: {} }), /database unavailable/);
  assert.equal(writes, 1);
});

test('saved events exclude request credentials and keep order identity', async () => {
  let values: any[] = [];
  const subject = load({ './pg': {
    query: async () => { throw new Error('Receipt must use its bounded dedicated pool'); },
    queryWebhook: async (_sql: string, params: any[]) => { values = params; return { rows: [] }; },
  } });
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
      return { rows: [], rowCount: 1 };
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
        ? [{ id: 42, store_subdomain: 'fixture', topic: 'fulfillments/create', payload_json: payload, attempts: 2 }] : [], rowCount: 1 };
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

// Optional real-SQL coverage uses an explicit, empty localhost test database.
// No .env is loaded and the application database URL is never consulted.
const queueTestDsn = process.env.FULFILLMENT_QUEUE_TEST_DATABASE_URL;
test('receipt SQL preserves every changed body and counts concurrent repeats without resetting workers', {
  skip: !queueTestDsn,
}, async t => {
  const target = new URL(queueTestDsn!);
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(decodeURIComponent(target.pathname.slice(1)), 'support_fulfillment_queue_test');
  assert.equal(target.search, '');
  const pool = new Pool({ connectionString: queueTestDsn, max: 6, connectionTimeoutMillis: 1000 });
  let created = false;
  try {
    const existing = await pool.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'");
    assert.equal(existing.rows[0].count, 0, 'integration database must be empty');
    await pool.query(`CREATE TABLE shoplazza_webhook_events (
      id BIGSERIAL PRIMARY KEY, event_key TEXT UNIQUE NOT NULL,
      store_subdomain TEXT NOT NULL, topic TEXT NOT NULL, order_id TEXT, order_number TEXT,
      payload_json JSONB NOT NULL, headers_json JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_received_at TIMESTAMPTZ,
      delivery_count INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'received',
      next_attempt_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0,
      processed_at TIMESTAMPTZ, processing_started_at TIMESTAMPTZ, error_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    created = true;
    const subject = load({ './pg': {
      query: async () => { throw new Error('Receipt must not run worker SQL'); },
      queryWebhook: (sql: string, values: any[]) => pool.query(sql, values),
    } });
    const receive = (storeSubdomain: string, body: unknown, header = 'reused-provider-header') => subject.enqueueFulfillmentWebhook({
      storeSubdomain, topic: 'fulfillments/update', payload: body,
      headers: { 'x-shoplazza-deduplication-id': header },
    });

    await t.test('same header across orders and later numbers stays distinct while repeats count atomically', async () => {
      const secondOrder = { fulfillment: { ...payload.fulfillment, order_id: 'order-2' } };
      const changedNumber = { fulfillment: { ...payload.fulfillment, tracking_number: 'TRACK10002' } };
      await Promise.all([
        ...Array.from({ length: 20 }, () => receive('concurrent', payload)),
        receive('concurrent', secondOrder), receive('concurrent', changedNumber),
      ]);
      const { rows } = await pool.query("SELECT * FROM shoplazza_webhook_events WHERE store_subdomain='concurrent'");
      assert.equal(rows.length, 3);
      const first = rows.find(row => row.order_id === 'order-1' && row.payload_json.fulfillment.tracking_number === 'TRACK10001');
      assert.equal(first.delivery_count, 20);
      assert.ok(rows.every(row => row.last_received_at && row.event_key.startsWith('fulfillment:v2:')));
      assert.equal(rows.reduce((sum, row) => sum + row.delivery_count, 0), 22);

      await pool.query("UPDATE shoplazza_webhook_events SET status='processed', attempts=4, received_at='2020-01-01', last_received_at='2020-01-01', processed_at='2020-01-02' WHERE id=$1", [first.id]);
      const reordered = { fulfillment: Object.fromEntries(Object.entries(payload.fulfillment).reverse()) };
      await receive('concurrent', reordered, 'a-different-provider-header');
      const saved = (await pool.query('SELECT * FROM shoplazza_webhook_events WHERE id=$1', [first.id])).rows[0];
      assert.equal(saved.delivery_count, 21);
      assert.equal(saved.status, 'processed');
      assert.equal(saved.attempts, 4);
      assert.equal(saved.received_at.toISOString(), '2020-01-01T00:00:00.000Z');
      assert.equal(saved.processed_at.toISOString(), '2020-01-02T00:00:00.000Z');
      assert.ok(saved.last_received_at > saved.received_at);
      assert.deepEqual(saved.payload_json, payload);
    });

    await t.test('legacy keys only absorb identical bodies and retain every processing state', async () => {
      for (const status of ['received', 'processing', 'failed', 'processed']) {
        const storeSubdomain = `legacy-${status}`;
        const legacyKey = `fulfillment:${storeSubdomain}:fulfillments/update:${crypto.createHash('sha256').update('delivery:old-header').digest('hex')}`;
        const inserted = await pool.query(`INSERT INTO shoplazza_webhook_events
          (event_key,store_subdomain,topic,order_id,payload_json,headers_json,status,attempts,
           received_at,next_attempt_at,processing_started_at,error_message)
          VALUES ($1,$2,'fulfillments/update','order-1',$3::jsonb,'{}'::jsonb,$4,3,
                  '2020-01-01','2030-01-01','2020-01-02','original marker') RETURNING id`,
        [legacyKey, storeSubdomain, JSON.stringify(payload), status]);
        const id = inserted.rows[0].id;
        await Promise.all(Array.from({ length: 5 }, () => receive(storeSubdomain, payload, 'changed-header')));
        const saved = (await pool.query('SELECT * FROM shoplazza_webhook_events WHERE id=$1', [id])).rows[0];
        assert.equal(saved.event_key, legacyKey);
        assert.equal(saved.delivery_count, 6);
        assert.equal(saved.status, status);
        assert.equal(saved.attempts, 3);
        assert.equal(saved.error_message, 'original marker');
        assert.equal(saved.next_attempt_at.toISOString(), '2030-01-01T00:00:00.000Z');
        assert.equal(saved.processing_started_at.toISOString(), '2020-01-02T00:00:00.000Z');
        assert.ok(saved.last_received_at > saved.received_at);

        await receive(storeSubdomain, { fulfillment: { ...payload.fulfillment, order_id: 'order-2' } }, 'old-header');
        await receive(storeSubdomain, { fulfillment: { ...payload.fulfillment, tracking_number: 'CHANGED' } }, 'old-header');
        const count = await pool.query('SELECT count(*)::int AS count FROM shoplazza_webhook_events WHERE store_subdomain=$1', [storeSubdomain]);
        assert.equal(count.rows[0].count, 3, 'the old header must not swallow another order or a changed number');
      }
    });

    for (const fails of [false, true]) {
      await t.test(`an expired worker cannot ${fails ? 'fail' : 'complete'} a newer claim`, async () => {
        await pool.query('TRUNCATE shoplazza_webhook_events');
        await receive('ownership-fixture', payload);
        let started!: () => void;
        let release!: () => void;
        const processing = new Promise<void>(resolve => { started = resolve; });
        const completion = new Promise<void>(resolve => { release = resolve; });
        const worker = load({
          './pg': { query: (sql: string, values: any[]) => pool.query(sql, values) },
          './fulfillment-service': {
            validateFulfillments,
            applyFulfillmentUpdate: async () => {
              started();
              await completion;
              if (fails) throw new Error('expired worker failure');
              return applied;
            },
          },
        });
        const run = worker.processPendingFulfillmentWebhooks({ limit: 1 });
        await processing;
        try {
          // Model another process taking over this row after its lease expires.
          await pool.query(`UPDATE shoplazza_webhook_events SET attempts=attempts+1,
            status='processing', processing_started_at=now(), order_number='NEW-OWNER',
            error_message='new owner marker' WHERE store_subdomain='ownership-fixture'`);
        } finally { release(); }
        const result = await run;
        assert.equal(result.processed, 0);
        assert.equal(result.failed, 0);
        const saved = (await pool.query("SELECT * FROM shoplazza_webhook_events WHERE store_subdomain='ownership-fixture'")).rows[0];
        assert.equal(saved.attempts, 2);
        assert.equal(saved.status, 'processing');
        assert.equal(saved.order_number, 'NEW-OWNER');
        assert.equal(saved.error_message, 'new owner marker');
        assert.ok(saved.processing_started_at);
      });
    }
  } finally {
    if (created) await pool.query('DROP TABLE shoplazza_webhook_events');
    await pool.end();
  }
});
