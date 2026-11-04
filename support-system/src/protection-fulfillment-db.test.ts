import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PROTECTION_SCHEMA_SQL } from './protection-schema';
import { PROTECTION_STORE_SCHEMA_SQL } from './protection-store-schema';
import { PROTECTION_FULFILLMENT_SCHEMA_SQL, processProtectionFulfillments, type ProtectionFulfillmentProvider } from './protection-fulfillment';
import { closeDatabasePools } from './pg';
const databaseUrl = process.env.SUPPORT_PROTECTION_POLICY_TEST_DATABASE_URL;

test('future-only durable fulfillment reconciles lost responses without touching physical goods', { skip: !databaseUrl }, async t => {
  const url = new URL(databaseUrl!); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.match(url.pathname, /_test$/);
  process.env.SUPPORT_DATABASE_URL = databaseUrl; process.env.SUPPORT_PROTECTION_FULFILLMENT_ENABLED = 'true';
  const pool = new Pool({ connectionString: databaseUrl });
  const remote = new Map<string, any>(), calls: any[] = [];
  let loseResponse = '', failCreate = '';
  const api: ProtectionFulfillmentProvider = {
    scopes: async () => ['read_order', 'write_order'],
    getOrder: async (_store, id) => {const state=remote.get(id);if(state.staleOrderReads>0){state.staleOrderReads--;return {...state.order,status:'placed'};}return state.order;},
    list: async (_store, id) => {const state=remote.get(id);if(state.hiddenReads>0){state.hiddenReads--;return [];}return JSON.parse(JSON.stringify(state.parcels));},
    write: async (_store, id, lines, parcelId) => {
      calls.push({ id, lines, parcelId }); const state = remote.get(id);
      if (lines) {
        assert.ok(lines.every(line => line.id === 'service'), 'physical goods must never be sent');
        if (id === failCreate) throw new Error('ambiguous timeout');
        state.parcels.push({ id: `parcel-${id}`, status: 'shipped', line_items: lines.map(line => ({ ...line })) });
        if(id==='delayed-read')state.hiddenReads=1;
        if(id==='stale-order-after-create')state.staleOrderReads=1;
        if (id === loseResponse) throw new Error('response lost after commit');
      } else state.parcels.find((p: any) => p.id === parcelId).status = 'finished';
    },
  };
  try {
    await pool.query(`DROP TABLE IF EXISTS support_protection_fulfillment_store_activation,support_protection_fulfillment_jobs,support_protection_fulfillment_control,support_protection_claim_events,support_protection_claims,support_protection_orders,support_protection_sync_state,support_protection_sync_dirty,support_protection_install_jobs,support_protection_stores,support_stores,support_order_snapshots,support_agents CASCADE;
      CREATE TABLE support_agents(id bigint PRIMARY KEY);
      CREATE TABLE support_stores(id serial,subdomain text PRIMARY KEY,store_name text,enabled boolean,access_token text);
      INSERT INTO support_stores VALUES(1,'fixture','Fixture',true,'fixture-only');
      CREATE TABLE support_order_snapshots(id bigserial,store_subdomain text,order_id text,updated_at timestamptz DEFAULT now());`);
    await pool.query(PROTECTION_STORE_SCHEMA_SQL); await pool.query(PROTECTION_SCHEMA_SQL); await pool.query(PROTECTION_FULFILLMENT_SCHEMA_SQL);
    await pool.query(`INSERT INTO support_protection_stores(store_subdomain,product_ids,fulfillment_enabled) VALUES('fixture','["p"]',true)`);
    await processProtectionFulfillments(api);
    const activation = new Date((await pool.query("SELECT GREATEST(c.activated_at,a.activated_at) AS activated_at FROM support_protection_fulfillment_control c CROSS JOIN support_protection_fulfillment_store_activation a WHERE a.store_subdomain='fixture'")).rows[0].activated_at).getTime();
    const add = async (id: string, completed: number, parcels: any[] = []) => {
      remote.set(id, { order: { id, status: 'finished', financial_status: 'paid', line_items: [{ id: 'goods', product_id: 'g', quantity: 1 }, { id: 'service', product_id: 'p', quantity: 1 }] }, parcels });
      await pool.query(`INSERT INTO support_protection_orders(store_subdomain,store_name,order_id,order_number,customer_email,customer_name,currency,payment_status,order_status,fulfillment_status,refund_status,timeline_json)
        VALUES('fixture','Fixture',$1,$1,'fixture@example.invalid','Fixture','USD','paid','finished','shipped','',$2)`, [id, JSON.stringify({ completed_at: new Date(completed).toISOString() })]);
    };
    await t.test('first activation excludes historical finished orders and repeat runs do not duplicate service', async () => {
      await add('historical', activation - 86400000); await add('new', activation + 1);
      await processProtectionFulfillments(api); await processProtectionFulfillments(api);
      assert.equal(calls.filter(c => c.id === 'historical').length, 0);
      assert.equal(calls.filter(c => c.id === 'new' && c.lines).length, 1);
      assert.equal(calls.filter(c => c.id === 'new' && c.parcelId).length, 1);
      assert.equal((await pool.query("SELECT status FROM support_protection_fulfillment_jobs j JOIN support_protection_orders o ON o.id=j.protection_order_id WHERE o.order_id='new'")).rows[0].status, 'done');
    });
    await t.test('a lost create response is reconciled to its existing service package', async () => {
      loseResponse = 'lost-response'; await add(loseResponse, activation + 2); await processProtectionFulfillments(api);
      await pool.query("UPDATE support_protection_fulfillment_jobs SET next_attempt_at=now() WHERE status='retry'");
      await processProtectionFulfillments(api);
      assert.equal(calls.filter(c => c.id === loseResponse && c.lines).length, 1);
      assert.equal(calls.filter(c => c.id === loseResponse && c.parcelId).length, 1);
    });
    await t.test('successful create with a delayed read remains reconcilable without a second creation',async()=>{
      await add('delayed-read',activation+3);await processProtectionFulfillments(api);
      assert.equal((await pool.query("SELECT status FROM support_protection_fulfillment_jobs j JOIN support_protection_orders o ON o.id=j.protection_order_id WHERE o.order_id='delayed-read'")).rows[0].status,'retry');
      await pool.query("UPDATE support_protection_fulfillment_jobs SET next_attempt_at=now() WHERE status='retry'");await processProtectionFulfillments(api);
      assert.equal(calls.filter(c=>c.id==='delayed-read'&&c.lines).length,1);assert.equal(calls.filter(c=>c.id==='delayed-read'&&c.parcelId).length,1);
    });
    await t.test('post-create stale order status retries without repeating the creation',async()=>{
      await add('stale-order-after-create',activation+3);await processProtectionFulfillments(api);
      assert.equal((await pool.query("SELECT status FROM support_protection_fulfillment_jobs j JOIN support_protection_orders o ON o.id=j.protection_order_id WHERE o.order_id='stale-order-after-create'")).rows[0].status,'retry');
      await pool.query("UPDATE support_protection_fulfillment_jobs SET next_attempt_at=now() WHERE status='retry'");await processProtectionFulfillments(api);
      assert.equal(calls.filter(c=>c.id==='stale-order-after-create'&&c.lines).length,1);assert.equal(calls.filter(c=>c.id==='stale-order-after-create'&&c.parcelId).length,1);
    });
    await t.test('uncertain missing creation and mixed packages stop for review instead of repeating writes', async () => {
      failCreate = 'uncertain'; await add(failCreate, activation + 3); await processProtectionFulfillments(api);
      await pool.query("UPDATE support_protection_fulfillment_jobs SET next_attempt_at=now(),attempts=9 WHERE status='retry'");
      await processProtectionFulfillments(api);
      assert.equal(calls.filter(c => c.id === failCreate && c.lines).length, 1);
      await add('mixed', activation + 4, [{ id: 'mixed-parcel', status: 'shipped', line_items: [{ id: 'goods', ship_quantity: 1 }, { id: 'service', ship_quantity: 1 }] }]);
      await processProtectionFulfillments(api);
      assert.equal(calls.filter(c => c.id === 'mixed').length, 0);
      assert.equal(Number((await pool.query("SELECT count(*) FROM support_protection_fulfillment_jobs WHERE status='blocked'")).rows[0].count), 2);
    });
    await t.test('a store enabled later does not sweep completions from before its own activation',async()=>{
      await pool.query("INSERT INTO support_stores VALUES(2,'late-store','Late fixture',true,'fixture-only');INSERT INTO support_protection_stores(store_subdomain,product_ids,fulfillment_enabled) VALUES('late-store','[\"p\"]',true)");
      await add('late-history',activation+1);await pool.query("UPDATE support_protection_orders SET store_subdomain='late-store' WHERE order_id='late-history'");
      await processProtectionFulfillments(api);
      assert.equal(calls.filter(c=>c.id==='late-history').length,0);
      assert.equal(Number((await pool.query("SELECT count(*) FROM support_protection_fulfillment_jobs j JOIN support_protection_orders o ON o.id=j.protection_order_id WHERE o.order_id='late-history'")).rows[0].count),0);
    });
  } finally { await pool.end(); await closeDatabasePools(); delete process.env.SUPPORT_PROTECTION_FULFILLMENT_ENABLED; }
});
