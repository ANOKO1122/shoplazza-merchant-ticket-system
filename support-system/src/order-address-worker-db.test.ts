import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as pg from './pg';
import * as guard from './shipping-address-guard';
import { normalizeOrder } from './normalize-order';
import { getStoreBySubdomain } from './store-service';
import { logOperation } from './log-service';
import type { ShoplazzaOrderDetail } from './shoplazza-client';

const testUrl = process.env.SUPPORT_ADDRESS_WORKER_TEST_DATABASE_URL;

test('address worker and snapshot protection with real PostgreSQL and simulated Shoplazza', { skip: !testUrl }, async t => {
  assert.match(new URL(testUrl!).pathname, /_test$/);
  const previousUrl = process.env.SUPPORT_DATABASE_URL;
  process.env.SUPPORT_DATABASE_URL = testUrl;
  const store = 'address-fixture.invalid';
  const orderId = 'address-fixture-order';
  const original = { first_name: 'Test', last_name: 'Customer', email: 'recipient@example.invalid',
    country: 'United States', country_code: 'US', city: 'Before', address: '1 Fixture Road', zip: '12345' };
  const tracking = [{ id: 'fixture-package', tracking_number: 'FIXTURE-TRACK', tracking_number_history: ['FIXTURE-OLD'] }];
  let remote = { id: orderId, number: 'TEST-ORDER', status: 'placed', financial_status: 'paid',
    fulfillment_status: 'waiting', fulfillments: [], line_items: [],
    updated_at: '2026-10-27T01:00:00Z', shipping_address: original } as unknown as ShoplazzaOrderDetail;
  let writes = 0;
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'order-address-service.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const dependencies: Record<string, unknown> = {
    './pg': pg,
    './shipping-address-guard': guard,
    './store-service': { getStoreBySubdomain },
    './log-service': { logOperation },
    './shoplazza-client': {
      ShoplazzaAddressApiError: class extends Error {},
      getOrderAddressAccessScopes: async () => ['read_order', 'write_order'],
      getOrderForAddressUpdate: async () => JSON.parse(JSON.stringify(remote)),
      putOrderShippingAddress: async (_store: unknown, id: string, address: any) => {
        assert.equal(id, orderId);
        assert.equal(address.email, original.email);
        writes++;
        remote = { ...remote, shipping_address: address, updated_at: '2026-10-27T02:00:00Z' };
      },
    },
  };
  vm.runInNewContext(code, { module, exports: module.exports, console, Date,
    require(name: string) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency, real API forbidden: ${name}`);
      return dependencies[name];
    },
  });
  const service = module.exports as typeof import('./order-address-service');
  try {
    assert.match((await pg.query('SELECT current_database() AS name')).rows[0].name, /_test$/);
    await pg.ensureTables();
    await pg.query(`INSERT INTO support_stores(subdomain,store_name,access_token) VALUES($1,'Fixture','not-a-real-token')`, [store]);
    for (const email of ['first@example.invalid', 'second@example.invalid']) {
      await pg.query(`INSERT INTO support_order_snapshots(store_subdomain,order_id,customer_email,shipping_address_json,
        payment_status,order_amount,fulfillment_status,billing_address_json,raw_order_json)
        VALUES($1,$2,$3,$4::jsonb,'paid','99.00','waiting','{"address":"Original billing"}',$5::jsonb)`,
      [store, orderId, email, JSON.stringify(original), JSON.stringify({ ...remote, fulfillments: tracking })]);
    }

    await t.test('confirmed remote save updates every email snapshot and leaves unrelated data intact', async () => {
      const request = await service.submitShippingAddressRequest({ storeSubdomain: store, orderId,
        patch: { city: 'After' }, expectedAddress: original, actor: 'fixture-agent', source: 'admin', idempotencyKey: 'real-db-success-key' });
      const result = await service.processShippingAddressRequest(request.id);
      assert.equal(result?.status, 'succeeded');
      assert.equal(writes, 1);
      const snapshots = await pg.query('SELECT * FROM support_order_snapshots WHERE store_subdomain=$1 AND order_id=$2 ORDER BY id', [store, orderId]);
      assert.equal(snapshots.rowCount, 2);
      for (const snapshot of snapshots.rows) {
        assert.equal(snapshot.shipping_address_json.city, 'After');
        assert.deepEqual(snapshot.shipping_address_json, snapshot.raw_order_json.shipping_address);
        assert.deepEqual(snapshot.raw_order_json.fulfillments, tracking);
        assert.equal(snapshot.billing_address_json.address, 'Original billing');
        assert.equal(snapshot.payment_status, 'paid');
        assert.equal(snapshot.order_amount, '99.00');
      }
      assert.deepEqual(snapshots.rows.map(row => row.customer_email), ['first@example.invalid', 'second@example.invalid']);
      assert.equal((await pg.query('SELECT count(*)::int AS count FROM support_email_jobs')).rows[0].count, 0);
    });

    await t.test('older snapshot events cannot revert the address; later authoritative updates reach all emails', async () => {
      const incoming = normalizeOrder(store, 'Fixture', { ...remote, shipping_address: original, updated_at: '2026-10-27T01:00:00Z' }, []);
      const writer = async (client: any, protectedOrder: any) => client.query(`UPDATE support_order_snapshots
        SET shipping_address_json=$3::jsonb,raw_order_json=jsonb_set(raw_order_json,'{shipping_address}',$3::jsonb)
        WHERE store_subdomain=$1 AND order_id=$2 AND customer_email='first@example.invalid'`,
      [store, orderId, JSON.stringify(protectedOrder.shippingAddressJson)]);
      await guard.withSnapshotShippingAddressGuard(incoming, async () => { throw new Error('Old event must not call provider'); }, writer);
      assert.equal((await pg.query('SELECT shipping_address_json FROM support_order_snapshots WHERE store_subdomain=$1 LIMIT 1', [store])).rows[0].shipping_address_json.city, 'After');
      remote = { ...remote, shipping_address: { ...remote.shipping_address, city: 'External newer' }, updated_at: '2026-10-27T03:00:00Z' };
      await guard.withSnapshotShippingAddressGuard(normalizeOrder(store, 'Fixture', remote, []), async () => remote, writer);
      const snapshots = await pg.query('SELECT shipping_address_json,raw_order_json FROM support_order_snapshots WHERE store_subdomain=$1', [store]);
      assert.equal(snapshots.rowCount, 2);
      for (const snapshot of snapshots.rows) {
        assert.equal(snapshot.shipping_address_json.city, 'External newer');
        assert.deepEqual(snapshot.raw_order_json.fulfillments, tracking);
      }
    });

    await t.test('database failure after provider save rolls back local state and recovers by GET without a second PUT', async () => {
      const expected = remote.shipping_address!;
      // Give this next simulated update a later remote revision.
      (dependencies['./shoplazza-client'] as any).putOrderShippingAddress = async (_store: unknown, _id: string, address: any) => {
        writes++;
        remote = { ...remote, shipping_address: address, updated_at: '2026-10-27T04:00:00Z' };
      };
      await pg.query(`CREATE FUNCTION address_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture local write failure'; END $$;
        CREATE TRIGGER address_fixture_failure BEFORE UPDATE ON support_order_snapshots
          FOR EACH ROW EXECUTE FUNCTION address_fixture_failure();`);
      const request = await service.submitShippingAddressRequest({ storeSubdomain: store, orderId,
        patch: { city: 'Recovered' }, expectedAddress: expected, actor: 'fixture-agent', source: 'admin', idempotencyKey: 'real-db-recovery-key' });
      const result = await service.processShippingAddressRequest(request.id);
      assert.equal(result?.status, 'uncertain');
      assert.equal(writes, 2);
      assert.equal((await pg.query('SELECT address_json FROM support_order_shipping_address_state WHERE store_subdomain=$1', [store])).rows[0].address_json.city, 'External newer');
      const pending = (await pg.query('SELECT * FROM support_shipping_address_requests WHERE id=$1', [request.id])).rows[0];
      assert.ok(pending.write_started_at);
      assert.equal(pending.before_address_json.city, 'External newer');
      assert.equal(pending.desired_address_json.city, 'Recovered');
      const unchanged = await pg.query('SELECT shipping_address_json FROM support_order_snapshots WHERE store_subdomain=$1', [store]);
      assert.equal(unchanged.rowCount, 2);
      assert.ok(unchanged.rows.every(row => row.shipping_address_json.city === 'External newer'));
      await pg.query('DROP TRIGGER address_fixture_failure ON support_order_snapshots; DROP FUNCTION address_fixture_failure();');
      const recovered = await service.processShippingAddressRequest(request.id);
      assert.equal(recovered?.status, 'succeeded');
      assert.equal(writes, 2, 'Recovery must never repeat a possible remote write');
      const restored = await pg.query('SELECT shipping_address_json FROM support_order_snapshots WHERE store_subdomain=$1', [store]);
      assert.equal(restored.rowCount, 2);
      assert.ok(restored.rows.every(row => row.shipping_address_json.city === 'Recovered'));
      assert.equal(recovered?.afterAddress?.city, 'Recovered');
    });
  } finally {
    await pg.query(`DROP TRIGGER IF EXISTS address_fixture_failure ON support_order_snapshots;
      DROP FUNCTION IF EXISTS address_fixture_failure();`).catch(() => {});
    await pg.query('DELETE FROM support_shipping_address_requests WHERE store_subdomain=$1', [store]).catch(() => {});
    await pg.query('DELETE FROM support_order_shipping_address_state WHERE store_subdomain=$1', [store]).catch(() => {});
    await pg.query('DELETE FROM support_order_snapshots WHERE store_subdomain=$1', [store]).catch(() => {});
    await pg.query('DELETE FROM support_operation_logs WHERE store_subdomain=$1', [store]).catch(() => {});
    await pg.query('DELETE FROM support_stores WHERE subdomain=$1', [store]).catch(() => {});
    await pg.closeDatabasePools();
    if (previousUrl === undefined) delete process.env.SUPPORT_DATABASE_URL;
    else process.env.SUPPORT_DATABASE_URL = previousUrl;
  }
});
