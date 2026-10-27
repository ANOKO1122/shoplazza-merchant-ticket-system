import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool, PoolClient } from 'pg';
import { ORDER_ADDRESS_SCHEMA_SQL } from './order-address-schema';

const testUrl = process.env.SUPPORT_ADDRESS_TEST_DATABASE_URL;

test('address submission SQL contract and least-privilege external access', { skip: !testUrl }, async t => {
  const url = new URL(testUrl!);
  assert.match(url.pathname, /_test$/, 'Use an isolated database whose name ends in _test');
  const pool = new Pool({ connectionString: testUrl, max: 4 });
  const client = await pool.connect();
  const submitSql = 'SELECT public.support_submit_shipping_address_change($1,$2,$3,$4,$5,$6) AS id';
  const original = { first_name: 'Fixture', last_name: 'Customer', country_code: 'US', city: 'Old city', address: '1 Test Road' };
  const args = (key = 'fixture-key-1', patch: any = { city: 'New city' }) =>
    ['fixture.invalid', 'fixture-order', patch, original, 'maildesk:fixture-agent', key];
  async function rejected(c: PoolClient, sql: string, params: any[], pattern: RegExp) {
    await c.query('SAVEPOINT expected_failure');
    await assert.rejects(c.query(sql, params), pattern);
    await c.query('ROLLBACK TO SAVEPOINT expected_failure');
  }
  try {
    const db = await client.query('SELECT current_database() AS name');
    assert.match(db.rows[0].name, /_test$/);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.support_stores (subdomain TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL);
      CREATE TABLE IF NOT EXISTS public.support_order_snapshots (
        id BIGSERIAL PRIMARY KEY, store_subdomain TEXT NOT NULL, order_id TEXT NOT NULL,
        shipping_address_json JSONB NOT NULL DEFAULT '{}', customer_email TEXT NOT NULL DEFAULT 'fixture@example.invalid'
      );
    `);
    await client.query(ORDER_ADDRESS_SCHEMA_SQL);
    await client.query(ORDER_ADDRESS_SCHEMA_SQL); // Repeated startup must preserve the contract.
    await client.query(`CREATE ROLE address_contract_test NOLOGIN;
      GRANT USAGE ON SCHEMA public TO address_contract_test;
      GRANT SELECT ON public.support_order_snapshots, public.support_shipping_address_requests TO address_contract_test;
      GRANT EXECUTE ON FUNCTION public.support_submit_shipping_address_change(TEXT,TEXT,JSONB,JSONB,TEXT,TEXT) TO address_contract_test;
      INSERT INTO public.support_stores (subdomain,enabled) VALUES ('fixture.invalid',true);
      INSERT INTO public.support_order_snapshots (store_subdomain,order_id) VALUES ('fixture.invalid','fixture-order');
    `);

    await t.test('external account submits and reads a request but cannot mutate orders or forge outcomes', async () => {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE address_contract_test');
      const result = await client.query(submitSql, args());
      const stored = await client.query('SELECT * FROM public.support_shipping_address_requests WHERE id=$1', [result.rows[0].id]);
      assert.equal(stored.rows[0].source, 'maildesk');
      assert.equal(stored.rows[0].status, 'pending');
      assert.deepEqual(stored.rows[0].patch_json, { city: 'New city' });
      await rejected(client, "UPDATE public.support_order_snapshots SET shipping_address_json='{}'", [], /permission denied/);
      await rejected(client, "UPDATE public.support_shipping_address_requests SET status='succeeded'", [], /permission denied/);
      await rejected(client, 'DELETE FROM public.support_shipping_address_requests', [], /permission denied/);
      await rejected(client, "SELECT public.support_submit_shipping_address_request($1,$2,$3,$4,$5,'admin',$6)", args('forge-admin-key'), /permission denied/);
      await rejected(client, 'SELECT * FROM public.support_stores', [], /permission denied/);
      await rejected(client, 'SELECT * FROM public.support_order_shipping_address_state', [], /permission denied/);
      await client.query('ROLLBACK');
    });

    await t.test('idempotent retry returns one request; another edit cannot bypass an unresolved request', async () => {
      await client.query('BEGIN');
      const first = await client.query(submitSql, args());
      const retry = await client.query(submitSql, args());
      assert.equal(first.rows[0].id, retry.rows[0].id);
      await rejected(client, submitSql, args('fixture-key-1', { city: 'Different' }), /idempotency_key_reused/);
      await rejected(client, submitSql, args('fixture-key-2'), /active_address_request_exists/);
      await client.query("UPDATE public.support_shipping_address_requests SET status='uncertain' WHERE id=$1", [first.rows[0].id]);
      await rejected(client, submitSql, args('fixture-key-3'), /active_address_request_exists/);
      await client.query("UPDATE public.support_shipping_address_requests SET status='failed' WHERE id=$1", [first.rows[0].id]);
      const next = await client.query(submitSql, args('fixture-key-4'));
      assert.notEqual(first.rows[0].id, next.rows[0].id);
      await client.query('ROLLBACK');
    });

    await t.test('SQL submission rejects unsupported fields, invalid payloads and unknown orders', async () => {
      await client.query('BEGIN');
      for (const patch of [{ email: 'changed@example.invalid' }, { country_code: 1 }, { address2: 'wrong field' }, { city: null }]) {
        await rejected(client, submitSql, args('invalid-field-key', patch), /invalid_address_field/);
      }
      await rejected(client, submitSql, args('invalid-empty-key', {}), /invalid_address_payload/);
      await rejected(client, submitSql, args('invalid-size-key', { city: 'a'.repeat(1001) }), /invalid_address_field/);
      const missing = args('unknown-order-key'); missing[1] = 'missing-order';
      await rejected(client, submitSql, missing, /order_not_found/);
      await client.query("UPDATE public.support_stores SET enabled=false WHERE subdomain='fixture.invalid'");
      await rejected(client, submitSql, args('disabled-store-key'), /store_unavailable/);
      await client.query('ROLLBACK');
    });

    await t.test('concurrent retries share an id and distinct simultaneous edits conflict', async () => {
      const retries = await Promise.all([pool.query(submitSql, args('parallel-retry-key')), pool.query(submitSql, args('parallel-retry-key'))]);
      assert.equal(retries[0].rows[0].id, retries[1].rows[0].id);
      await client.query('DELETE FROM public.support_shipping_address_requests');
      const competing = await Promise.allSettled([pool.query(submitSql, args('parallel-edit-one')), pool.query(submitSql, args('parallel-edit-two'))]);
      assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
      const failure = competing.find(result => result.status === 'rejected') as PromiseRejectedResult;
      assert.match(String(failure.reason), /active_address_request_exists/);
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`DELETE FROM public.support_shipping_address_requests WHERE store_subdomain='fixture.invalid';
      DELETE FROM public.support_order_snapshots WHERE store_subdomain='fixture.invalid';
      DELETE FROM public.support_stores WHERE subdomain='fixture.invalid';
      DROP OWNED BY address_contract_test;
      DROP ROLE address_contract_test;
    `).catch(() => {});
    client.release();
    await pool.end();
  }
});
