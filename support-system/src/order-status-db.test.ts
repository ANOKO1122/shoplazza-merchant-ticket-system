import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import * as pg from './pg';
import * as guard from './shipping-address-guard';
import * as fulfillment from './fulfillment-service';
import * as logService from './log-service';
import { normalizeOrder, normalizeRefundAmount, refundStatusFromFinancialStatus } from './normalize-order';
import type { ShoplazzaOrderDetail } from './shoplazza-client';

// Opt in with an empty, local, disposable database. Never load .env or use live HTTP/SMTP.
const testUrl = process.env.SUPPORT_ORDER_STATUS_TEST_DATABASE_URL;
const store = { subdomain: 'status-fixture.invalid', storeName: 'Status fixture', accessToken: 'unused-fixture' };
const beforeTime = '2026-10-20T01:00:00.000Z';
const firstTime = '2026-10-21T01:00:00.000Z';
const secondTime = '2026-10-22T01:00:00.000Z';
const plain = (value: unknown): any => JSON.parse(JSON.stringify(value));
const forbidden = async (): Promise<never> => { throw new Error('Real provider, mail and token calls are forbidden'); };

function order(id: string, financial = 'paid', updatedAt = beforeTime): ShoplazzaOrderDetail {
  return {
    id, number: `#${id}`, status: 'placed', financial_status: financial, fulfillment_status: 'shipped',
    total_price: '49.00', total_refund_price: '0.00', currency: 'USD', payment_method: 'paypal',
    payment_line: { payment_channel: 'paypal' }, created_at: beforeTime, placed_at: beforeTime,
    updated_at: updatedAt, customer: { email: 'first@example.invalid', first_name: 'Fixture', last_name: 'Customer', phone: '' },
    shipping_address: { first_name: 'Confirmed', country_code: 'US', city: 'Original', address: '1 Fixture Road' },
    billing_address: { city: 'Billing fixture' }, shipping_line: { title: 'Fixture shipping' },
    line_items: [{ id: 'fixture-item', title: 'Fixture', quantity: 1 }],
    fulfillments: [{ id: 'fixture-parcel', tracking_number: 'OVERSEAS', updated_at: beforeTime,
      tracking_number_history: ['DOMESTIC', 'OVERSEAS'] }],
    untouched_fixture: { keep: true },
  } as unknown as ShoplazzaOrderDetail;
}

function loadModule(filename: string, dependencies: Record<string, unknown>): any {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, filename), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Date, Buffer, URL, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require(name: string) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) {
        throw new Error(`Unapproved dependency; live API/mail forbidden: ${name}`);
      }
      return dependencies[name];
    },
  }, { filename });
  return module.exports;
}

function preserved(row: any) {
  return {
    customerEmail: row.customer_email, customerName: row.customer_name,
    shipping: row.shipping_address_json, billing: row.billing_address_json,
    logistics: row.logistics_json, items: row.items_json, payment: row.payment_detail_json,
    rawShipping: row.raw_order_json.shipping_address, rawBilling: row.raw_order_json.billing_address,
    rawItems: row.raw_order_json.line_items, rawCustomer: row.raw_order_json.customer,
    fulfillments: row.raw_order_json.fulfillments, untouched: row.raw_order_json.untouched_fixture,
  };
}

test('order status updates and legacy writers remain safe in real PostgreSQL', { skip: !testUrl, timeout: 60_000 }, async t => {
  const url = new URL(testUrl!);
  const database = decodeURIComponent(url.pathname.slice(1));
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.match(database, /^support_[a-z0-9_]*_test$/i);
  assert.equal(url.search, '', 'test URL options are forbidden');
  const previousUrl = process.env.SUPPORT_DATABASE_URL;
  const previousPoolSize = process.env.SUPPORT_PG_POOL_MAX;
  process.env.SUPPORT_DATABASE_URL = testUrl;
  process.env.SUPPORT_PG_POOL_MAX = '8';
  const pool = pg.getPool();
  const status = loadModule('order-status-service.ts', {
    './pg': pg, './log-service': logService, './shipping-address-guard': guard,
    './normalize-order': { normalizeRefundAmount, refundStatusFromFinancialStatus },
    'node:util': { isDeepStrictEqual },
  });
  const apply = (incoming: ShoplazzaOrderDetail, topic = 'orders/partially_refunded') => status.applyOrderStatusUpdate({
    storeSubdomain: store.subdomain, storeName: store.storeName, order: incoming, topic,
  });
  const rows = async (id: string) => (await pool.query(
    'SELECT * FROM support_order_snapshots WHERE store_subdomain=$1 AND order_id=$2 ORDER BY id', [store.subdomain, id],
  )).rows;
  const states = async (id: string) => (await pool.query(
    'SELECT * FROM support_order_status_state WHERE store_subdomain=$1 AND order_id=$2', [store.subdomain, id],
  )).rows;
  const notifications = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM support_email_jobs) AS jobs,
    (SELECT count(*)::int FROM support_access_tokens) AS tokens`)).rows[0];
  async function seed(id: string, emails = ['first@example.invalid', 'second@example.invalid']) {
    for (const email of emails) {
      const fixture = order(id);
      fixture.customer!.email = email;
      await pool.query(`INSERT INTO support_order_snapshots
        (store_subdomain,store_name,order_id,order_number,customer_email,customer_name,
         order_status,payment_status,fulfillment_status,order_amount,order_currency,refund_status,refund_amount,
         shipping_address_json,billing_address_json,logistics_json,items_json,payment_detail_json,raw_order_json,paid_at)
        VALUES($1,$2,$3,$4,$5,'Fixture Customer','placed','paid','shipped','49.00','USD','','',
          $6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,'{"keep":"payment"}'::jsonb,$10::jsonb,$11)`,
      [store.subdomain, store.storeName, id, `#${id}`, email, JSON.stringify(fixture.shipping_address),
        JSON.stringify(fixture.billing_address), JSON.stringify(fixture.shipping_line),
        JSON.stringify(fixture.line_items), JSON.stringify(fixture), beforeTime]);
    }
  }
  function refunded(id: string, full = false, time = firstTime): ShoplazzaOrderDetail {
    return { ...order(id, full ? 'refunded' : 'partially_refunded', time),
      total_refund_price: full ? '49.00' : '10.00', fulfillment_status: 'waiting' };
  }
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, database);
    assert.equal(Number((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count), 0,
      'use a fresh empty test database; existing tables must not be touched');
    await pg.ensureTables();

    await t.test('all email snapshots receive partial and full refunds without changing address, tracking or customer identity', async () => {
      const id = 'STATUS-MULTI-EMAIL';
      await seed(id);
      const original = (await rows(id)).map(preserved);
      const partial = refunded(id);
      partial.shipping_address = { address: 'Unrelated provider address' };
      partial.fulfillments = [];
      partial.customer!.email = 'provider-changed@example.invalid';
      const result = await apply(partial, 'orders/partially_refunded');
      assert.equal(result.matched, true); assert.equal(result.changed, true);
      let saved = await rows(id);
      assert.equal(saved.length, 2);
      for (const row of saved) {
        assert.equal(row.payment_status, 'partially_refunded');
        assert.equal(row.refund_status, 'partially_refunded');
        assert.equal(Number(row.refund_amount), 10);
        assert.equal(row.order_status, 'placed', 'a refund is not an order cancellation');
        assert.equal(row.fulfillment_status, 'shipped');
        assert.equal(row.raw_order_json.financial_status, 'partially_refunded');
        assert.equal(Number(row.raw_order_json.total_refund_price), 10);
      }
      assert.deepEqual(saved.map(preserved), original);
      await apply(refunded(id, true, secondTime), 'orders/refunded');
      saved = await rows(id);
      assert.ok(saved.every(row => row.payment_status === 'refunded' && row.refund_status === 'refunded'));
      assert.ok(saved.every(row => Number(row.refund_amount) === 49 && row.order_status === 'placed'));
      assert.deepEqual(saved.map(preserved), original);
      assert.equal((await states(id)).length, 1);
      assert.deepEqual(await notifications(), { jobs: 0, tokens: 0 });
    });

    await t.test('unknown orders are skipped without creating snapshots or protection state', async () => {
      const id = 'STATUS-UNKNOWN';
      const result = await apply(refunded(id, true));
      assert.equal(result.matched, false); assert.equal(result.skipReason, 'not_found');
      assert.deepEqual(await rows(id), []); assert.deepEqual(await states(id), []);
      assert.deepEqual(await notifications(), { jobs: 0, tokens: 0 });
    });

    await t.test('missing and older provider timestamps cannot undo a confirmed refund', async () => {
      const id = 'STATUS-STALE';
      await seed(id);
      await apply(refunded(id, true, secondTime));
      const before = plain(await rows(id));
      const older = await apply(order(id, 'paid', firstTime));
      assert.equal(older.changed, false); assert.equal(older.skipReason, 'stale');
      const missing = order(id, 'waiting');
      delete (missing as any).updated_at;
      const result = await apply(missing);
      assert.equal(result.changed, false); assert.equal(result.skipReason, 'missing_updated_at');
      assert.deepEqual(plain(await rows(id)), before);
    });

    await t.test('successive partial and full refunds within one provider second can still advance', async () => {
      const id = 'STATUS-SAME-SECOND';
      await seed(id);
      await apply(refunded(id), 'orders/partially_refunded');
      await apply(refunded(id, true), 'orders/refunded');
      assert.ok((await rows(id)).every(row => row.payment_status === 'refunded' && Number(row.refund_amount) === 49));
      await apply(refunded(id), 'orders/partially_refunded');
      assert.ok((await rows(id)).every(row => row.payment_status === 'refunded' && Number(row.refund_amount) === 49),
        'an older partial-refund view at the same timestamp cannot undo the full refund');
    });

    await t.test('cancellation is applied explicitly while retaining its separate financial state', async () => {
      const id = 'STATUS-CANCELLED';
      await seed(id);
      const result = await apply({ ...order(id, 'paid', firstTime), status: 'cancelled', cancelled_at: firstTime }, 'orders/cancelled');
      assert.equal(result.changed, true);
      assert.ok((await rows(id)).every(row => row.order_status === 'cancelled' && row.payment_status === 'paid'));
      assert.deepEqual(await notifications(), { jobs: 0, tokens: 0 });
    });

    await t.test('concurrent same-order changes serialize and the newest provider version wins', async () => {
      const id = 'STATUS-CONCURRENT';
      await seed(id);
      const blocker = await pool.connect();
      let pending: Promise<any[]> | undefined;
      try {
        await blocker.query('BEGIN');
        await guard.lockOrderShippingAddress(blocker, store.subdomain, id);
        pending = Promise.all([apply(refunded(id, true, secondTime)), apply(refunded(id, false, firstTime))]);
        pending.catch(() => {});
        let waiting = 0;
        for (let attempt = 0; attempt < 100 && waiting < 2; attempt++) {
          waiting = Number((await pool.query(`SELECT count(*) FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
              AND query LIKE '%pg_advisory_xact_lock%'`)).rows[0].count);
          if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(waiting, 2, 'both updates must wait on the shared business-order lock');
        await blocker.query('COMMIT');
        await pending;
      } finally {
        await blocker.query('ROLLBACK'); blocker.release();
        if (pending) await pending;
      }
      assert.ok((await rows(id)).every(row => row.payment_status === 'refunded' && Number(row.refund_amount) === 49));
      assert.equal((await states(id))[0].provider_updated_at.toISOString(), secondTime);
    });

    for (const source of ['paid-webhook', 'paid-backfill', 'unpaid-backfill']) {
      await t.test(`${source} cannot roll back refund state or create a late payment invitation`, async () => {
        const id = `STATUS-${source}`;
        await seed(id);
        await apply(refunded(id, true, secondTime));
        const incoming = order(id, source === 'unpaid-backfill' ? 'waiting' : 'paid');
        let invites = 0;
        const dependencies = {
          crypto, './pg': pg, './shipping-address-guard': guard, './order-status-service': status,
          './normalize-order': { normalizeOrder }, './log-service': logService,
          './config': { buildStoreDomain: () => store.subdomain },
          './store-service': { getEnabledStores: async () => [{ subdomain: store.subdomain, store_name: store.storeName, access_token: store.accessToken }] },
          './shoplazza-client': { getOrderDetail: forbidden, getOrderForAddressUpdate: forbidden,
            getOrderByNumber: forbidden, getOrderTransactions: forbidden,
            listPaidOrdersCreatedSince: async () => source === 'paid-backfill' ? [plain(incoming)] : [],
            listWaitingOrdersUpdatedSince: async () => source === 'unpaid-backfill' ? [plain(incoming)] : [] },
          './email-service': { extractStoreCustomDomain: () => '', createPaidSupportInviteEmailJob: async () => {
            invites++; throw new Error('A refunded order must not request a paid invitation');
          } },
        };
        await pool.query(`INSERT INTO support_backfill_state(store_subdomain,last_synced_at,last_unpaid_synced_at)
          VALUES($1,now()-interval '2 seconds',now()-interval '2 seconds') ON CONFLICT(store_subdomain)
          DO UPDATE SET last_synced_at=EXCLUDED.last_synced_at,last_unpaid_synced_at=EXCLUDED.last_unpaid_synced_at`, [store.subdomain]);
        if (source === 'paid-webhook') {
          await loadModule('paid-webhook.ts', dependencies).processOrderWebhook({ store, topic: 'orders/paid', payload: { order: plain(incoming) } });
        } else {
          const backfill = loadModule('backfill-jobs.ts', dependencies);
          if (source === 'paid-backfill') {
            const result = await backfill.runBackfillForStore(store.subdomain);
            assert.deepEqual(plain(result.errors), []);
          } else await backfill.runUnpaidBackfillOnly(store.subdomain);
        }
        const saved = await rows(id);
        assert.equal(saved.length, 2);
        assert.ok(saved.every(row => row.payment_status === 'refunded' && row.refund_status === 'refunded' && Number(row.refund_amount) === 49));
        assert.ok(saved.every(row => row.raw_order_json.financial_status === 'refunded' && Number(row.raw_order_json.total_refund_price) === 49));
        assert.ok(saved.every(row => row.raw_order_json.fulfillments[0].tracking_number_history.join(',') === 'DOMESTIC,OVERSEAS'));
        assert.equal(invites, 0);
        assert.deepEqual(await notifications(), { jobs: 0, tokens: 0 });
      });
    }

    await t.test('partially refunded orders remain eligible for the real logistics candidate query', async () => {
      const id = 'STATUS-PARTIAL-LOGISTICS';
      await seed(id);
      await apply(refunded(id));
      const checked: string[] = [];
      const reconcile = loadModule('fulfillment-reconcile.ts', {
        './pg': pg, './fulfillment-service': fulfillment, './log-service': logService,
        './store-service': { getEnabledStores: async () => [{ subdomain: store.subdomain, store_name: store.storeName, access_token: store.accessToken }] },
        './shoplazza-client': { listOrderFulfillments: async (_store: unknown, requested: string) => {
          checked.push(requested); return [];
        } },
      });
      const result = await reconcile.runFulfillmentReconciliation({ storeSubdomain: store.subdomain, orderId: id });
      assert.deepEqual(checked, [id]); assert.equal(result.checked, 1); assert.equal(result.failed, 0);
      assert.ok((await rows(id)).every(row => row.payment_status === 'partially_refunded'));
      assert.deepEqual(await notifications(), { jobs: 0, tokens: 0 });
    });

    await t.test('queue keeps successive bodies despite reused delivery IDs, and workers update status without mail', async () => {
      const id = 'STATUS-QUEUE';
      await seed(id);
      let reads = 0;
      const queue = loadModule('order-status-webhook.ts', {
        crypto, './pg': pg, './order-status-service': status, './log-service': logService,
        './store-service': { getStoreBySubdomain: async () => ({ subdomain: store.subdomain,
          store_name: store.storeName, access_token: store.accessToken, enabled: true }) },
        './shoplazza-client': { getOrderForStatusUpdate: async () => {
          reads++; return refunded(id, reads > 1, reads > 1 ? secondTime : firstTime);
        } },
      });
      const first = { order: refunded(id) };
      const second = { order: refunded(id, true, secondTime) };
      const enqueue = (payload: unknown) => queue.enqueueOrderStatusWebhook({
        storeSubdomain: store.subdomain, topic: 'orders/partially_refunded', payload,
        headers: { 'x-shoplazza-deduplication-id': 'same-fixture-delivery', 'authorization': 'must-not-be-persisted' },
      });
      await enqueue(first); await enqueue(second); await enqueue(first);
      const events = (await pool.query(`SELECT delivery_count,headers_json FROM shoplazza_webhook_events
        WHERE store_subdomain=$1 AND order_id=$2 ORDER BY id`, [store.subdomain, id])).rows;
      assert.equal(events.length, 2);
      assert.deepEqual(events.map(event => event.delivery_count), [2, 1]);
      assert.ok(events.every(event => !('authorization' in event.headers_json)));
      assert.equal((await queue.processPendingOrderStatusWebhooks({ limit: 1 })).processed, 1);
      assert.ok((await rows(id)).every(row => row.payment_status === 'partially_refunded'));
      assert.equal((await queue.processPendingOrderStatusWebhooks({ limit: 1 })).processed, 1);
      assert.ok((await rows(id)).every(row => row.payment_status === 'refunded'));
      assert.equal(reads, 2);
      assert.deepEqual(await notifications(), { jobs: 0, tokens: 0 });
    });

    await t.test('retired generic updates leave orders unchanged and terminate all retryable queue states', async () => {
      const id = 'STATUS-RETIRED';
      await seed(id);
      const before = plain(await rows(id));
      const queue = loadModule('order-status-webhook.ts', {
        crypto, './pg': pg, './order-status-service': { applyOrderStatusUpdate: forbidden },
        './log-service': { logSync: forbidden }, './store-service': { getStoreBySubdomain: forbidden },
        './shoplazza-client': { getOrderForStatusUpdate: forbidden },
      });
      for (const initialStatus of ['received', 'failed', 'processing']) {
        await pool.query(`INSERT INTO shoplazza_webhook_events
          (event_key,store_subdomain,topic,order_id,payload_json,status,processing_started_at)
          VALUES ($1,$2,'orders/update',$3,'{}'::jsonb,$4,now()-interval '11 minutes')`,
        [`order-status:retired:${initialStatus}`, store.subdomain, id, initialStatus]);
      }
      assert.deepEqual(plain(await queue.processPendingOrderStatusWebhooks()), { processed: 3, failed: 0 });
      const retired = (await pool.query(`SELECT status,next_attempt_at,processing_started_at,processed_at
        FROM shoplazza_webhook_events WHERE store_subdomain=$1 AND order_id=$2`, [store.subdomain, id])).rows;
      assert.equal(retired.length, 3);
      assert.ok(retired.every(event => event.status === 'ignored' && event.processed_at
        && event.next_attempt_at === null && event.processing_started_at === null));
      assert.deepEqual(plain(await queue.processPendingOrderStatusWebhooks()), { processed: 0, failed: 0 });
      assert.deepEqual(plain(await rows(id)), before);
      assert.deepEqual(await notifications(), { jobs: 0, tokens: 0 });
    });

    await t.test('queue skips unknown orders before GET and defers a known order after provider failure', async () => {
      const known = 'STATUS-QUEUE-FAILED';
      const unknown = 'STATUS-QUEUE-UNKNOWN';
      await seed(known);
      const before = plain(await rows(known));
      const reads: string[] = [];
      const queue = loadModule('order-status-webhook.ts', {
        crypto, './pg': pg, './order-status-service': status, './log-service': logService,
        './store-service': { getStoreBySubdomain: async () => ({ subdomain: store.subdomain,
          store_name: store.storeName, access_token: store.accessToken, enabled: true }) },
        './shoplazza-client': { getOrderForStatusUpdate: async (_store: unknown, id: string) => {
          reads.push(id); throw new Error('Fixture provider failure');
        } },
      });
      for (const id of [unknown, known]) await queue.enqueueOrderStatusWebhook({
        storeSubdomain: store.subdomain, topic: 'orders/refunded', payload: { order: refunded(id, true) }, headers: {},
      });
      const result = await queue.processPendingOrderStatusWebhooks({ limit: 3 });
      assert.deepEqual(plain(result), { processed: 1, failed: 1 });
      assert.deepEqual(reads, [known]);
      assert.deepEqual(await rows(unknown), []); assert.deepEqual(await states(unknown), []);
      assert.deepEqual(plain(await rows(known)), before);
      const failed = (await pool.query(`SELECT status,attempts,next_attempt_at>now() AS retry_pending
        FROM shoplazza_webhook_events WHERE store_subdomain=$1 AND order_id=$2`, [store.subdomain, known])).rows[0];
      assert.deepEqual(failed, { status: 'failed', attempts: 1, retry_pending: true });
      assert.deepEqual(await notifications(), { jobs: 0, tokens: 0 });
    });
  } finally {
    await pg.closeDatabasePools();
    if (previousUrl === undefined) delete process.env.SUPPORT_DATABASE_URL;
    else process.env.SUPPORT_DATABASE_URL = previousUrl;
    if (previousPoolSize === undefined) delete process.env.SUPPORT_PG_POOL_MAX;
    else process.env.SUPPORT_PG_POOL_MAX = previousPoolSize;
  }
});
