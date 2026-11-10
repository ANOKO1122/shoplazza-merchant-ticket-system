import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PROTECTION_SCHEMA_SQL } from './protection-schema';
import { PROTECTION_NOTIFICATION_SCHEMA_SQL } from './protection-notification-schema';
import { closeDatabasePools } from './pg';
import { listProtectionEmailRecords } from './protection-email-records';

const databaseUrl = process.env.SUPPORT_PROTECTION_EMAIL_RECORDS_TEST_DATABASE_URL;
test('protection email records are filterable and never expose message bodies or private links', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl!).pathname, /_test$/);
  process.env.SUPPORT_DATABASE_URL = databaseUrl;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE support_agents(id BIGINT PRIMARY KEY);
      CREATE TABLE support_protection_stores(store_subdomain TEXT PRIMARY KEY);
      CREATE TABLE support_order_snapshots(id BIGSERIAL PRIMARY KEY,store_subdomain TEXT,order_id TEXT);`);
    await pool.query(PROTECTION_SCHEMA_SQL);
    await pool.query(PROTECTION_NOTIFICATION_SCHEMA_SQL);
    const order = (await pool.query(`INSERT INTO support_protection_orders
      (store_subdomain,store_name,order_id,order_number,customer_email,customer_name,currency,payment_status,order_status,fulfillment_status,refund_status)
      VALUES('shop-a','Shop A','order-a','1001','buyer@example.invalid','Buyer','USD','paid','open','fulfilled','') RETURNING id`)).rows[0].id;
    const claim = (await pool.query(`INSERT INTO support_protection_claims
      (protection_order_id,reason,description,status,requested_amount_cents,currency,item_ids)
      VALUES($1,'damaged','private claim note','needs_info',1000,'USD','[]') RETURNING id`, [order])).rows[0].id;
    const add = (event: string, status: string, created: string, claimId: string | null = null) => pool.query(`INSERT INTO support_protection_notification_outbox
      (event_key,event_type,claim_id,protection_order_id,revision,target_status,recipient_email,context_json,status,
       message_id,subject_snapshot,body_snapshot,access_token_hash,last_error,created_at,manual_requested_at,sent_at)
      VALUES($1,$2,$3,$4,$5,$6,'buyer@example.invalid','{}',$7,$8,'Order update',
             '<a href="https://example.invalid/private?token=secret">secret</a>','private-hash',$9,$10,$11,$12)`,
      [event, event, claimId, order, claimId ? 2 : null, claimId ? 'needs_info' : null, status, `<${event}@example.invalid>`, status === 'pending' ? 'delivery_or_preparation_failed' : null, created, claimId ? created : null, status === 'sent' ? created : null]);
    await add('shipment', 'sent', '2026-11-07T12:00:00Z');
    await add('completion', 'pending', '2026-11-08T12:00:00Z');
    await add('claim_update', 'cancelled', '2026-11-09T12:00:00Z', claim);

    const all = await listProtectionEmailRecords({ page: 1, page_size: 2 });
    assert.equal(all.total, 3);
    assert.deepEqual(all.items.map(item => item.event_type), ['claim_update', 'completion']);
    assert.equal(all.items[0].claim_public_no?.startsWith('CL-'), true);
    assert.equal(all.items[0].protection_public_no?.startsWith('SP-'), true);
    assert.equal(all.items[1].last_error_code, 'delivery_or_preparation_failed');
    assert.doesNotMatch(JSON.stringify(all), /private\?token|private-hash|body_snapshot|subject_snapshot|access_token_hash|message_id/);
    assert.deepEqual((await listProtectionEmailRecords({ status: 'sent' })).items.map(item => item.event_type), ['shipment']);
    assert.deepEqual((await listProtectionEmailRecords({ event_type: 'claim_update', q: '1001' })).items.map(item => item.status), ['cancelled']);
    assert.equal((await listProtectionEmailRecords({ store: 'shop-b' })).total, 0);
    assert.equal((await listProtectionEmailRecords({ from: '2026-11-09', to: '2026-11-09' })).total, 1);
    assert.equal((await listProtectionEmailRecords({ page: 2, page_size: 2 })).items.length, 1);
    await assert.rejects(() => listProtectionEmailRecords({ status: 'failed' }), /状态/);
  } finally {
    await closeDatabasePools();
    await pool.end();
  }
});
