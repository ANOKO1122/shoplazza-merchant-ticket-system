import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PROTECTION_SCHEMA_SQL } from './protection-schema';
import { PROTECTION_NOTIFICATION_SCHEMA_SQL } from './protection-notification-schema';
import { EMAIL_PREFERENCES_SCHEMA_SQL } from './email-preferences-schema';
import { PROTECTION_CUSTOMER_SCHEMA_SQL } from './protection-customer-schema';
import { createProtectionClaim, updateProtectionClaim, getProtectionClaim, listProtectionOrders, getProtectionStats, syncProtectionOrders } from './protection-service';
import { closeDatabasePools } from './pg';
import express from 'express';
import crypto from 'node:crypto';
import { createProtectionRouter } from './protection-routes';

const databaseUrl = process.env.SUPPORT_PROTECTION_TEST_DATABASE_URL;
test('protection data and review lifecycle retain one contract and serialize competing decisions', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /_test$/, 'Requires an isolated test database');
  process.env.SUPPORT_DATABASE_URL = databaseUrl;
  process.env.SUPPORT_PROTECTION_POLICY_BASIS = 'shipment';
  const pool = new Pool({ connectionString: databaseUrl });
  const actor = { agentId: 1, name: 'Fixture reviewer', role: 'admin' };
  const rawItems = [
    { id: 'coat', product_id: 'goods', quantity: 1, total_price: '50.00', product_title: 'Fixture coat' },
    { id: 'hat', product_id: 'goods-2', quantity: 1, total_price: '20.00', product_title: 'Fixture hat' },
    { id: 'service', product_id: 'protection', quantity: 1, price: '2.10', product_title: 'Fixture service' },
  ];
  try {
    await pool.query(`
      DROP TABLE IF EXISTS support_protection_notification_outbox,support_protection_evidence, support_protection_capture_sessions, support_protection_customer_messages, support_protection_customer_sessions, support_protection_access_tokens, support_protection_claim_events, support_protection_claims, support_protection_orders, support_protection_sync_state, support_protection_sync_dirty, support_protection_stores, support_order_snapshots, support_agents CASCADE;
      CREATE TABLE support_agents(id BIGINT PRIMARY KEY,name TEXT,enabled BOOLEAN DEFAULT true);
      INSERT INTO support_agents VALUES (1,'Fixture reviewer',true);
      CREATE TABLE support_protection_stores(store_subdomain TEXT PRIMARY KEY, product_ids JSONB,enabled BOOLEAN DEFAULT true,config_json JSONB DEFAULT '{}');
      INSERT INTO support_protection_stores VALUES('fixture-store','["protection"]',true,'{}');
      CREATE TABLE support_order_snapshots(id BIGSERIAL PRIMARY KEY,store_subdomain TEXT,store_name TEXT,order_id TEXT,order_number TEXT,
        customer_email TEXT,customer_name TEXT,order_amount TEXT,order_currency TEXT,payment_status TEXT,order_status TEXT,
        fulfillment_status TEXT,refund_status TEXT,refund_amount TEXT,paid_at TIMESTAMPTZ,items_json JSONB,raw_order_json JSONB,
        shipping_address_json JSONB,updated_at TIMESTAMPTZ DEFAULT now(),fetched_at TIMESTAMPTZ DEFAULT now());
    `);
    await pool.query(PROTECTION_SCHEMA_SQL);
    await pool.query(PROTECTION_SCHEMA_SQL);
    await pool.query(PROTECTION_CUSTOMER_SCHEMA_SQL);
    await pool.query(PROTECTION_NOTIFICATION_SCHEMA_SQL);
    await pool.query(EMAIL_PREFERENCES_SCHEMA_SQL);
    const insert = (id: string, email: string,db:Pick<Pool,'query'>=pool) => db.query(`INSERT INTO support_order_snapshots
      (store_subdomain,store_name,order_id,order_number,customer_email,customer_name,order_amount,order_currency,payment_status,order_status,fulfillment_status,refund_status,refund_amount,paid_at,items_json,raw_order_json,shipping_address_json)
      VALUES ('fixture-store','Fixture store',$1,$1,$2,'Fixture customer','72.10','USD','paid','placed','waiting','','0',now(),$3,$4,'{}')`, [id,email,JSON.stringify(rawItems),JSON.stringify({total_discount:'0',created_at:new Date(Date.now()-80*86400000).toISOString(),_support_completed_at:new Date(Date.now()-86400000).toISOString(),_support_completed_source:'orders/finished.updated_at',fulfillments:[{id:'fixture-parcel',status:'shipped',created_at:new Date(Date.now()-70*86400000).toISOString(),line_items:rawItems.filter(i=>i.product_id!=='protection').map(i=>({id:i.id,ship_quantity:i.quantity}))}]})]);
    await insert('order-a','first@example.invalid');
    await insert('order-a','latest@example.invalid');
    await insert('order-b','second@example.invalid');

    await t.test('bounded sync deduplicates alternate-email snapshots and advances beyond the first page', async () => {
      const first = await syncProtectionOrders(1);
      assert.equal(first.scanned, 1);
      await syncProtectionOrders(1);
      await syncProtectionOrders(1);
      const list = await listProtectionOrders({ page: 1, page_size: 20 });
      assert.equal(list.total, 2);
      assert.equal(list.items.find(o => o.order_id === 'order-a')!.customer_email, 'latest@example.invalid');
      assert.equal((await getProtectionStats({})).protected_orders, 2);
      assert.equal((await getProtectionStats({})).currencies[0].protection_fee_cents, 420);
    });
    const order = (await listProtectionOrders({ q: 'order-a', page: 1, page_size: 20 })).items[0];
    const body = { protection_order_id: order.id, item_ids: ['coat'], reason: 'lost', description: 'Fixture loss', requested_amount_cents: 4000 };
    let claim: any;
    await t.test('parallel submissions cannot create overlapping active claims', async () => {
      const attempts = await Promise.allSettled([createProtectionClaim(body,actor),createProtectionClaim(body,actor)]);
      assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
      const success = attempts.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>;
      claim=success.value;
      assert.equal(claim.protection_public_no,order.public_no);
    });
    await t.test('parallel review uses revision checks and creates only one decision event', async () => {
      const attempts=await Promise.allSettled([
        updateProtectionClaim(claim.id,{revision:claim.revision,status:'rejected',note:'Insufficient evidence'},actor),
        updateProtectionClaim(claim.id,{revision:claim.revision,status:'rejected',note:'Duplicate review'},actor),
      ]);
      assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
      const detail=await getProtectionClaim(claim.id);
      assert.equal(detail!.events.length,2);
      assert.equal(detail!.claim.status,'rejected');
    });
    await t.test('a rejected issue permits another ID under the same contract; closed approvals consume selected-item balance', async () => {
      const replacement=await createProtectionClaim(body,actor);
      assert.notEqual(replacement.public_no,claim.public_no);
      assert.equal(replacement.protection_public_no,order.public_no);
      const approved=await updateProtectionClaim(replacement.id,{revision:replacement.revision,status:'approved',approved_amount_cents:4000,note:'Reviewed evidence'},actor);
      await assert.rejects(createProtectionClaim(body,actor),/处理中/);
      const closed=await updateProtectionClaim(approved.id,{revision:approved.revision,status:'closed',note:'External completion confirmed',external_reference:'offline-fixture-1'},actor);
      assert.equal(closed.approved_amount_cents,4000);
      await assert.rejects(createProtectionClaim({...body,requested_amount_cents:1001},actor),/余额/);
      const next=await createProtectionClaim({...body,requested_amount_cents:1000},actor);
      assert.notEqual(next.public_no,replacement.public_no);
      await createProtectionClaim({...body,item_ids:['hat'],requested_amount_cents:2000},actor);
      const totals=await getProtectionStats({});
      assert.equal(totals.currencies[0].approved_amount_cents,4000);
    });
    await t.test('unknown selected amount and stale order refund facts cannot produce an approval', async () => {
      const orderB=(await listProtectionOrders({q:'order-b'})).items[0];
      const c=await createProtectionClaim({...body,protection_order_id:orderB.id,requested_amount_cents:5000},actor);
      // A fresh webhook changed the source; the periodic protection index has not run yet.
      await pool.query(`UPDATE support_order_snapshots SET refund_amount='50.00',payment_status='partially_refunded',updated_at=now() WHERE order_id='order-b'`);
      await assert.rejects(updateProtectionClaim(c.id,{revision:c.revision,status:'approved',approved_amount_cents:5000},actor),/退款.*明细/);
      // The old coat row still says no refunded units. It must not borrow the
      // untouched hat's $20 through the order-level remaining balance.
      await assert.rejects(updateProtectionClaim(c.id,{revision:c.revision,status:'approved',approved_amount_cents:2000},actor),/退款.*明细/);
      const untouched=await getProtectionClaim(c.id);
      assert.equal(untouched!.claim.revision,1);
      assert.equal(untouched!.events.length,1);
    });
    await t.test('HTTP API protects reads, rejects cross-origin writes, and exports formula-safe CSV', async () => {
      const token='fixture-session';
      await pool.query(`CREATE TABLE IF NOT EXISTS support_agent_sessions(session_token_hash TEXT,agent_id BIGINT,expires_at TIMESTAMPTZ);
        ALTER TABLE support_agents ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'admin';`);
      await pool.query(`INSERT INTO support_agent_sessions VALUES($1,1,now()+interval '1 hour')`,[crypto.createHash('sha256').update(token).digest('hex')]);
      const app=express();app.use(express.json());app.use('/api/admin/protection',createProtectionRouter());
      const server=app.listen(0,'127.0.0.1');
      await new Promise<void>(resolve=>server.once('listening',resolve));
      const base=`http://127.0.0.1:${(server.address() as any).port}`;
      const headers={cookie:`support_session=${token}`};
      try{
        assert.equal((await fetch(base+'/api/admin/protection/orders')).status,401);
        const denied=await fetch(base+'/api/admin/protection/claims',{method:'POST',headers:{...headers,'content-type':'application/json',Origin:'https://evil.example'},body:JSON.stringify(body)});
        assert.equal(denied.status,403);
        const list=await fetch(base+'/api/admin/protection/orders',{headers});
        assert.equal(list.status,200);assert.equal((await list.json() as any).total,2);
        const invalid=await fetch(base+'/api/admin/protection/claims?status=invalid',{headers});assert.equal(invalid.status,400);
        await pool.query(`UPDATE support_protection_orders SET customer_name='=SUM(A1)' WHERE id=$1`,[order.id]);
        const exportResponse=await fetch(base+'/api/admin/protection/orders/export',{headers});
        assert.equal(exportResponse.status,200);assert.match(await exportResponse.text(),/"'=SUM\(A1\)"/);
        const agents=await fetch(base+'/api/admin/protection/agents',{headers});assert.equal((await agents.json() as any).items[0].name,'Fixture reviewer');
      }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
    });
    await t.test('aggregate money is unknown when one of the included orders has an unknown amount', async () => {
      await pool.query(`UPDATE support_protection_orders SET protection_fee_cents=NULL,protected_value_cents=NULL WHERE id=$1`,[order.id]);
      const stats=await getProtectionStats({});
      assert.equal(stats.currencies[0].protection_fee_cents,null);
      assert.equal(stats.currencies[0].protected_value_cents,null);
      assert.equal(stats.currencies[0].unknown_orders,1);
      assert.equal(stats.currencies[0].approved_amount_cents,4000);
    });
    await t.test('a late commit is discovered even after another transaction advanced the history cursor', async () => {
      const late=await pool.connect();
      try{
        await late.query('BEGIN');
        await insert('late-commit','late@example.invalid',late);
        await new Promise(resolve=>setTimeout(resolve,25));
        await insert('early-commit','early@example.invalid');
        await syncProtectionOrders(100);
        assert.equal((await listProtectionOrders({q:'late-commit'})).total,0);
        await late.query('COMMIT');
        await syncProtectionOrders(100);
        assert.equal((await listProtectionOrders({q:'late-commit'})).total,1);
      }finally{await late.query('ROLLBACK').catch(()=>{});late.release();}
    });
    await t.test('request windows apply to staff too; an eligible review survives the later new-request deadline', async () => {
      await insert('policy-review','policy@example.invalid');await syncProtectionOrders(100);
      const subject=(await listProtectionOrders({q:'policy-review'})).items[0];
      const input={...body,protection_order_id:subject.id};
      await assert.rejects(createProtectionClaim({...input,reason:'other'},actor),/outside shipping protection/);
      await pool.query(`UPDATE support_protection_orders SET timeline_json=jsonb_set(timeline_json,'{items,coat,shipped_at}',to_jsonb((now()-interval '55 days')::text)) WHERE id=$1`,[subject.id]);
      await assert.rejects(createProtectionClaim(input,actor),/not opened/);
      await pool.query(`UPDATE support_protection_orders SET timeline_json=jsonb_set(timeline_json,'{items,coat,shipped_at}',to_jsonb((now()-interval '70 days')::text)) WHERE id=$1`,[subject.id]);
      const created=await createProtectionClaim(input,actor);
      await pool.query(`UPDATE support_protection_orders SET timeline_json=jsonb_set(timeline_json,'{ordered_at}',to_jsonb((now()-interval '100 days')::text)) WHERE id=$1`,[subject.id]);
      const approved=await updateProtectionClaim(created.id,{revision:created.revision,status:'approved',approved_amount_cents:4000,note:'Eligible when submitted'},actor);
      assert.equal(approved.status,'approved');
      const evidence=(await pool.query('SELECT policy_snapshot_json FROM support_protection_claims WHERE id=$1',[created.id])).rows[0].policy_snapshot_json;
      assert.equal(evidence.window.status,'open');assert.equal(evidence.window.reason,'lost');
      assert.equal(Number((await pool.query('SELECT count(*) FROM support_protection_notification_outbox WHERE claim_id=$1',[created.id])).rows[0].count),1);
    });
  } finally { await pool.end(); await closeDatabasePools(); }
});
