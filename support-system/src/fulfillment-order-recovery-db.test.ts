import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import * as pg from './pg';
import * as guard from './shipping-address-guard';
import * as fulfillment from './fulfillment-service';
import * as logService from './log-service';
import { normalizeOrder } from './normalize-order';
import type { ShoplazzaOrderDetail } from './shoplazza-client';

// Explicit, empty, local test database only. Never load .env or contact Shoplazza/SMTP.
const testUrl = process.env.SUPPORT_FULFILLMENT_RECOVERY_TEST_DATABASE_URL;
const store = { subdomain: 'recovery-fixture.invalid', storeName: 'Recovery fixture', accessToken: 'unused-fixture' };
const oldTime = '2026-10-17T01:00:00.000Z';
const currentTime = '2026-10-20T01:00:00.000Z';
const plain = (value: unknown): any => JSON.parse(JSON.stringify(value));

function order(id: string): ShoplazzaOrderDetail {
  return {
    id, number: `#${id}`, status: 'placed', financial_status: 'paid', fulfillment_status: 'shipped',
    payment_method: 'paypal', total_price: '49.00', currency: 'USD',
    created_at: oldTime, placed_at: oldTime, updated_at: currentTime,
    customer: { email: 'recovered@example.invalid', first_name: 'Fixture', last_name: 'Customer', phone: '' },
    shipping_address: { first_name: 'Fixture', email: 'shipping@example.invalid', country_code: 'US',
      city: 'Original', address: '1 Fixture Road' },
    line_items: [{ id: 'item', title: 'Offline fixture', quantity: 1 }],
    fulfillments: [{ id: 'A', tracking_number: 'CURRENT', updated_at: currentTime,
      tracking_number_history: ['UNTRUSTED-API-HISTORY'] }],
  } as unknown as ShoplazzaOrderDetail;
}

function loadModule(filename: string, dependencies: Record<string, unknown>): any {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, filename), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, URL, Date,
    process: { env: { SUPPORT_MAIL_FROM: 'fixture@example.invalid' } },
    require(name: string) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) {
        throw new Error(`Unapproved dependency; real API/mail forbidden: ${name}`);
      }
      return dependencies[name];
    },
  }, { filename });
  return module.exports;
}

function recovery(read: (id: string) => Promise<ShoplazzaOrderDetail | null>) {
  let calls = 0;
  const subject = loadModule('fulfillment-order-recovery.ts', {
    './pg': pg, './normalize-order': { normalizeOrder }, './fulfillment-service': fulfillment,
    './shipping-address-guard': guard, './log-service': logService,
    './shoplazza-client': { getOrderDetail: async (_store: unknown, id: string) => { calls++; return read(id); } },
  });
  return {
    run: (id: string) => subject.recoverMissingFulfillmentOrder({ store, orderId: id, topic: 'fulfillments/update' }),
    calls: () => calls,
  };
}

test('missing fulfillment orders recover safely in real PostgreSQL without notifications', { skip: !testUrl, timeout: 45_000 }, async t => {
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
  let tokenCalls = 0;
  const forbidden = async () => { throw new Error('SMTP and real provider calls are forbidden'); };
  const mail = loadModule('email-service.ts', {
    crypto, './pg': pg, './log-service': logService,
    './config': { loadConfig: () => ({ publicBaseUrl: 'https://fixture.invalid' }), buildStoreDomain: () => store.subdomain },
    './mailer': { sendSupportEmail: forbidden },
    './token': { createBootstrapToken: async () => { tokenCalls++; return 'offline-fixture-token'; },
      createTicketAccessToken: forbidden, hashToken: (token: string) => crypto.createHash('sha256').update(token).digest('hex') },
  });
  const rows = async (id: string) => (await pool.query(
    'SELECT *, xmin::text AS row_version FROM support_order_snapshots WHERE store_subdomain=$1 AND order_id=$2 ORDER BY id',
    [store.subdomain, id],
  )).rows;
  const suppression = async (id: string) => (await pool.query(
    'SELECT reason FROM support_order_notification_suppressions WHERE store_subdomain=$1 AND order_id=$2', [store.subdomain, id],
  )).rows;
  const notifications = async (id: string) => (await pool.query(
    `SELECT (SELECT count(*)::int FROM support_email_jobs WHERE store_subdomain=$1 AND order_id=$2) AS jobs,
            (SELECT count(*)::int FROM support_access_tokens WHERE store_subdomain=$1 AND order_id=$2) AS tokens`,
    [store.subdomain, id],
  )).rows[0];
  const invite = (id: string, email = 'recovered@example.invalid') => mail.createPaidSupportInviteEmailJob({
    storeSubdomain: store.subdomain, storeName: store.storeName, orderId: id,
    orderNumber: `#${id}`, customerEmail: email, orderedAt: oldTime, jobSource: 'backfill',
  });
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, database);
    assert.equal(Number((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count), 0,
      'use a new empty test database; existing tables must not be touched');
    await pg.ensureTables();

    await t.test('old paid order keeps its original date, current and late tracking, and suppresses later invitations', async () => {
      const id = 'RECOVER-OLD';
      const subject = recovery(async requested => plain(order(requested)));
      assert.deepEqual(plain(await subject.run(id)), { recovered: true, orderNumber: `#${id}` });
      let saved = (await rows(id))[0];
      assert.equal(saved.paid_at.toISOString(), oldTime);
      assert.equal(saved.snapshot_source, 'fulfillment_recovery');
      assert.equal(saved.payment_status, 'paid');
      assert.deepEqual(saved.raw_order_json.fulfillments[0].tracking_number_history, ['CURRENT']);
      const result = await fulfillment.applyFulfillmentUpdate({ storeSubdomain: store.subdomain, orderId: id,
        source: 'webhook', topic: 'fulfillments/update', fulfillments: [
          { id: 'A', tracking_number: 'EARLIER', updated_at: oldTime },
          { id: 'B', tracking_number: 'SECOND', updated_at: oldTime },
        ] });
      assert.equal(result.matched, true);
      assert.deepEqual(new Set(result.trackingNumbers), new Set(['CURRENT', 'EARLIER', 'SECOND']));
      saved = (await rows(id))[0];
      assert.equal(saved.raw_order_json.fulfillments.length, 2);
      assert.equal(saved.raw_order_json.fulfillments[0].tracking_number, 'CURRENT');
      assert.deepEqual(saved.raw_order_json.fulfillments[0].tracking_number_history, ['CURRENT', 'EARLIER']);
      assert.deepEqual(await suppression(id), [{ reason: 'fulfillment_recovery' }]);
      assert.deepEqual(await notifications(id), { jobs: 0, tokens: 0 });
      const before = plain(await rows(id));
      assert.equal((await subject.run(id)).recovered, false);
      assert.equal(subject.calls(), 1, 'existing business order must skip the provider');
      assert.deepEqual(plain(await rows(id)), before);
      assert.equal((await invite(id)).inserted, false);
      assert.equal((await invite(id, 'changed-email@example.invalid')).inserted, false);
      assert.equal(tokenCalls, 0, 'suppression must stop even token generation');
      assert.deepEqual(await notifications(id), { jobs: 0, tokens: 0 });
    });

    await t.test('two workers with different API emails serialize and recover only one business order', async () => {
      const id = 'RECOVER-CONCURRENT';
      let reads = 0;
      const subject = recovery(async requested => {
        const result = order(requested);
        result.customer!.email = `race-${++reads}@example.invalid`;
        return plain(result);
      });
      const blocker = await pool.connect();
      let pending: Promise<any[]> | undefined;
      try {
        await blocker.query('BEGIN');
        await guard.lockOrderShippingAddress(blocker, store.subdomain, id);
        pending = Promise.all([subject.run(id), subject.run(id)]);
        pending.catch(() => {});
        let waiting = 0;
        for (let attempt = 0; attempt < 100 && waiting < 2; attempt++) {
          waiting = Number((await pool.query(`SELECT count(*) FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
              AND query LIKE '%pg_advisory_xact_lock%'`)).rows[0].count);
          if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(waiting, 2, 'both workers must wait on the real business-order advisory lock');
        await blocker.query('COMMIT');
        const result = await pending;
        assert.deepEqual(result.map(value => value.recovered).sort(), [false, true]);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (pending) await pending;
      }
      assert.equal(subject.calls(), 2);
      assert.equal((await rows(id)).length, 1);
      assert.equal((await suppression(id)).length, 1);
      assert.deepEqual(await notifications(id), { jobs: 0, tokens: 0 });
    });

    await t.test('normal paid insert during GET wins even with another email and still permits its invitation', async () => {
      const id = 'RECOVER-PAID-RACE';
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const providerStarted = new Promise<void>(resolve => { started = resolve; });
      const subject = recovery(async requested => { started(); await gate; return plain(order(requested)); });
      const pending = subject.run(id);
      pending.catch(() => {});
      let before: any;
      try {
        await providerStarted;
        const actual = order(id);
        actual.customer!.email = 'normal-paid@example.invalid';
        actual.shipping_address = { ...actual.shipping_address, city: 'Paid writer wins' };
        actual.fulfillments = [{ id: 'PAID-PACKAGE', tracking_number: 'KEEP', tracking_number_history: ['KEEP-OLD'] }];
        await guard.withSnapshotShippingAddressGuard(normalizeOrder(store.subdomain, store.storeName, actual, []), forbidden,
          (client, guarded) => client.query(`INSERT INTO support_order_snapshots
            (store_subdomain,order_id,order_number,customer_email,payment_status,shipping_address_json,raw_order_json,snapshot_source)
            VALUES($1,$2,$3,$4,'paid',$5::jsonb,$6::jsonb,'shoplazza_webhook') RETURNING id`,
          [store.subdomain, id, `#${id}`, guarded.customerEmail, JSON.stringify(guarded.shippingAddressJson), JSON.stringify(guarded.rawOrderJson)]));
        before = plain(await rows(id));
      } finally { release(); }
      assert.equal((await pending).recovered, false);
      assert.deepEqual(plain(await rows(id)), before, 'recovery must leave the concurrent paid snapshot untouched');
      assert.deepEqual(await suppression(id), []);
      assert.equal((await invite(id, 'normal-paid@example.invalid')).inserted, true);
      assert.deepEqual(await notifications(id), { jobs: 1, tokens: 0 });
    });

    await t.test('recovery respects a newer confirmed address state in both JSON copies', async () => {
      const id = 'RECOVER-ADDRESS';
      const confirmed = { ...order(id).shipping_address, city: 'Confirmed newer address' };
      await pool.query(`INSERT INTO support_order_shipping_address_state
        (store_subdomain,order_id,address_json,provider_updated_at,revision) VALUES($1,$2,$3::jsonb,$4,7)`,
      [store.subdomain, id, JSON.stringify(confirmed), '2026-10-21T01:00:00Z']);
      const subject = recovery(async requested => plain(order(requested)));
      assert.equal((await subject.run(id)).recovered, true);
      const saved = (await rows(id))[0];
      assert.deepEqual(saved.shipping_address_json, confirmed);
      assert.deepEqual(saved.raw_order_json.shipping_address, confirmed);
      assert.equal(subject.calls(), 1, 'older provider time should preserve state without a second GET');
      const state = (await pool.query('SELECT revision::text,address_json FROM support_order_shipping_address_state WHERE store_subdomain=$1 AND order_id=$2', [store.subdomain, id])).rows[0];
      assert.deepEqual(state, { revision: '7', address_json: confirmed });
      assert.deepEqual(await notifications(id), { jobs: 0, tokens: 0 });
    });

    await t.test('suppression failure rolls back the new snapshot and a retry succeeds without mail', async () => {
      const id = 'RECOVER-ROLLBACK';
      const subject = recovery(async requested => plain(order(requested)));
      await pool.query("ALTER TABLE support_order_notification_suppressions ADD CONSTRAINT recovery_fixture_failure CHECK(order_id <> 'RECOVER-ROLLBACK')");
      try {
        await assert.rejects(subject.run(id));
        assert.deepEqual(await rows(id), []);
        assert.deepEqual(await suppression(id), []);
        assert.deepEqual(await notifications(id), { jobs: 0, tokens: 0 });
      } finally { await pool.query('ALTER TABLE support_order_notification_suppressions DROP CONSTRAINT recovery_fixture_failure'); }
      assert.equal((await subject.run(id)).recovered, true);
      assert.equal((await rows(id)).length, 1);
      assert.equal((await suppression(id)).length, 1);
    });

    await t.test('failed API, missing or mismatched ID, unpaid and incomplete results never create an order or suppression', async () => {
      const variants: Array<(id: string) => Promise<ShoplazzaOrderDetail | null>> = [
        async () => { throw new Error('Fixture API unavailable'); }, async () => null,
        async id => ({ ...order(id), id: '' }), async id => ({ ...order(id), id: 'WRONG-ORDER' }),
        async id => ({ ...order(id), financial_status: 'waiting' }),
        async id => ({ ...order(id), customer: null, shipping_address: {}, billing_address: {} }),
        async id => ({ ...order(id), line_items: undefined } as unknown as ShoplazzaOrderDetail),
      ];
      for (let i = 0; i < variants.length; i++) {
        const id = `RECOVER-INVALID-${i}`;
        await assert.rejects(recovery(variants[i]).run(id));
        assert.deepEqual(await rows(id), []);
        assert.deepEqual(await suppression(id), []);
        assert.deepEqual(await notifications(id), { jobs: 0, tokens: 0 });
      }
    });
  } finally {
    await pg.closeDatabasePools();
    if (previousUrl === undefined) delete process.env.SUPPORT_DATABASE_URL;
    else process.env.SUPPORT_DATABASE_URL = previousUrl;
    if (previousPoolSize === undefined) delete process.env.SUPPORT_PG_POOL_MAX;
    else process.env.SUPPORT_PG_POOL_MAX = previousPoolSize;
  }
});
