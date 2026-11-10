import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PROTECTION_SCHEMA_SQL } from './protection-schema';
import { PROTECTION_CUSTOMER_SCHEMA_SQL } from './protection-customer-schema';
import { EMAIL_PREFERENCES_SCHEMA_SQL } from './email-preferences-schema';
import { PROTECTION_NOTIFICATION_SCHEMA_SQL } from './protection-notification-schema';
import { normalizeProtectionSnapshot } from './protection-domain';
import { enqueueProtectionLifecycleNotifications, protectionLifecycleMilestones } from './protection-lifecycle-notification';
import { initProtectionNotificationSchema, processProtectionNotifications } from './protection-notification';
import { syncProtectionOrders } from './protection-service';
import { closeDatabasePools } from './pg';
import { withEmailPreferenceGuard } from './email-preferences';
import type { SupportMail } from './mailer';

const now=Date.now(), activation=new Date(now-3600000).toISOString(), shipped=new Date(now-60000).toISOString(), finished=new Date(now-30000).toISOString(), old=new Date(now-86400000).toISOString();
const lines=[{id:'coat',product_id:'merchandise',quantity:2,total_price:'100.00'}, {id:'protection',product_id:'protection-product',quantity:1,total_price:'3.00'}];
const parcel=(id='coat',at=shipped,quantity=1)=>({id:`parcel-${id}`,status:'shipped',shipped_at:at,created_at:at,tracking_number:'TRACK-FIRST',tracking_company:'Fixture Carrier',line_items:[{id,ship_quantity:quantity}]});
const fixture=(overrides:Record<string,unknown>={})=>({store_subdomain:'fixture',store_name:'Fixture Store',order_id:'fixture-order',order_number:'1042',customer_email:'customer@example.invalid',customer_name:'Customer',order_currency:'USD',order_amount:'103.00',refund_amount:'0',payment_status:'paid',order_status:'placed',fulfillment_status:'partial',refund_status:'',paid_at:old,items_json:lines,raw_order_json:{created_at:old,total_discount:'0',fulfillments:[parcel()]},shipping_address_json:{},...overrides});
const normalized=(overrides:Record<string,unknown>={})=>normalizeProtectionSnapshot(fixture(overrides),['protection-product'])!;

test('order email milestones require real merchandise shipments and trusted completion',()=>{
  assert.deepEqual(protectionLifecycleMilestones(normalized()).map(e=>e.event_type),['shipment'],'First partial merchandise shipment qualifies');
  for(const fulfillments of [[parcel('protection')],[{...parcel(),status:'cancelled'}],[parcel('coat',shipped,0)],[{...parcel(),line_items:[{id:'unknown',ship_quantity:1}]}]])
    assert.deepEqual(protectionLifecycleMilestones(normalized({raw_order_json:{fulfillments}})),[]);
  assert.deepEqual(protectionLifecycleMilestones(normalized({order_status:'finished',raw_order_json:{finished_at:finished,fulfillments:[parcel()]}})).map(e=>e.event_type),['shipment','completion']);
  for(const override of [{order_status:'placed',raw_order_json:{finished_at:finished}},{order_status:'finished',raw_order_json:{_support_completed_at:finished,_support_completed_source:'untrusted'}},{order_status:'finished',raw_order_json:{delivered_at:finished}},{order_status:'finished',raw_order_json:{finished_at:new Date(now+3600000).toISOString()}}])
    assert.deepEqual(protectionLifecycleMilestones(normalized(override)),[]);
  assert.equal(protectionLifecycleMilestones(normalized({raw_order_json:{fulfillments:[parcel('coat',shipped),parcel('coat',old)]}}))[0].occurred_at,old,'Use the first shipment, never a later parcel for historical backfill');
  assert.equal(protectionLifecycleMilestones(normalized({raw_order_json:{fulfillments:[{...parcel(),tracking_number:null,tracking_items:[{tracking_number:'NESTED-TRACKING'}]}]}}))[0].tracking_number,'NESTED-TRACKING');
  for(const override of [{payment_status:'pending'},{payment_status:'refunded'},{order_status:'cancelled'},{refund_status:'refunded'},{refund_amount:'103.00'}, {items_json:lines.map(l=>l.id==='protection'?{...l,refund_quantity_total:1}:l)}])
    assert.deepEqual(protectionLifecycleMilestones(normalized(override)),[]);
});

const databaseUrl=process.env.SUPPORT_PROTECTION_LIFECYCLE_TEST_DATABASE_URL;
test('automatic order mail persists transactional milestones without historical or duplicate delivery',{skip:!databaseUrl},async t=>{
  assert.match(new URL(databaseUrl!).pathname,/_test$/);
  process.env.SUPPORT_DATABASE_URL=databaseUrl;
  process.env.SUPPORT_PROTECTION_PUBLIC_BASE_URL='https://us-seel.com';
  const pool=new Pool({connectionString:databaseUrl});
  const sent:SupportMail[]=[];
  const delivery={ready:true,send:async(mail:SupportMail)=>{sent.push(mail);return{messageId:mail.messageId!};}};
  const snapshots=new Map<string,Record<string,any>>();
  const write=async(id:string,overrides:Record<string,unknown>={},sync=true)=>{
    const source:Record<string,any>={...(snapshots.get(id)||fixture()),order_id:id,customer_email:`${id}@example.invalid`,...overrides};snapshots.set(id,source);
    const columns=['store_subdomain','store_name','order_id','order_number','customer_email','customer_name','order_amount','order_currency','payment_status','order_status','fulfillment_status','refund_status','refund_amount','paid_at','items_json','raw_order_json','shipping_address_json'];
    await pool.query(`INSERT INTO support_order_snapshots(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,columns.map(c=>['items_json','raw_order_json','shipping_address_json'].includes(c)?JSON.stringify(source[c]):source[c]));
    if(sync)await syncProtectionOrders(200);
  };
  const order=async(id:string)=>(await pool.query('SELECT * FROM support_protection_orders WHERE order_id=$1',[id])).rows[0];
  const jobs=async(id:string)=>(await pool.query('SELECT n.* FROM support_protection_notification_outbox n JOIN support_protection_orders o ON o.id=n.protection_order_id WHERE o.order_id=$1 ORDER BY n.id',[id])).rows;
  try{
    await pool.query(`DROP SCHEMA public CASCADE;CREATE SCHEMA public;
      CREATE TABLE support_agents(id BIGINT PRIMARY KEY);
      CREATE TABLE support_protection_stores(store_subdomain TEXT PRIMARY KEY,product_ids JSONB);
      INSERT INTO support_protection_stores VALUES('fixture','["protection-product"]');
      CREATE TABLE support_order_snapshots(id BIGSERIAL PRIMARY KEY,store_subdomain TEXT,store_name TEXT,order_id TEXT,order_number TEXT,customer_email TEXT,customer_name TEXT,order_amount TEXT,order_currency TEXT,payment_status TEXT,order_status TEXT,fulfillment_status TEXT,refund_status TEXT,refund_amount TEXT,paid_at TIMESTAMPTZ,items_json JSONB,raw_order_json JSONB,shipping_address_json JSONB,updated_at TIMESTAMPTZ DEFAULT clock_timestamp());
      CREATE TABLE support_email_templates(email_type TEXT PRIMARY KEY,subject_template TEXT,body_template TEXT,active_preset_name TEXT,updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE support_email_template_presets(id BIGSERIAL PRIMARY KEY,email_type TEXT,preset_name TEXT,subject_template TEXT,body_template TEXT,UNIQUE(email_type,preset_name));`);
    await pool.query(PROTECTION_SCHEMA_SQL);await pool.query(PROTECTION_CUSTOMER_SCHEMA_SQL);await pool.query(EMAIL_PREFERENCES_SCHEMA_SQL);
    // Exercise upgrading the previous claim-only schema rather than only a fresh CREATE.
    await pool.query(PROTECTION_NOTIFICATION_SCHEMA_SQL.split('ALTER TABLE support_protection_notification_outbox ADD COLUMN')[0]);
    await initProtectionNotificationSchema();
    const originalActivation=(await pool.query('SELECT activated_at FROM support_protection_notification_activation')).rows[0].activated_at;
    await initProtectionNotificationSchema();
    assert.equal((await pool.query('SELECT activated_at FROM support_protection_notification_activation')).rows[0].activated_at.getTime(),originalActivation.getTime());
    await pool.query('UPDATE support_protection_notification_activation SET activated_at=$1',[activation]);
    await t.test('historical completed orders remain silent across startup and repeated indexing',async()=>{
      await write('historical',{order_status:'finished',raw_order_json:{created_at:old,finished_at:old,fulfillments:[parcel('coat',old)]}});
      await initProtectionNotificationSchema();await syncProtectionOrders(200);
      assert.equal((await jobs('historical')).length,0);assert.equal((await processProtectionNotifications({delivery})).picked,0);
    });
    await t.test('paid waiting order sends once on first physical partial shipment, then once on completion',async()=>{
      await write('live',{raw_order_json:{created_at:old,total_discount:'0',fulfillments:[]}});assert.equal((await jobs('live')).length,0);
      await write('live',{raw_order_json:{created_at:old,total_discount:'0',fulfillments:[parcel('protection')]}});assert.equal((await jobs('live')).length,0);
      await write('live',{raw_order_json:{created_at:old,total_discount:'0',fulfillments:[parcel('protection'),parcel()]}});
      await write('live');await syncProtectionOrders(200);
      assert.equal((await jobs('live')).length,1);assert.equal((await jobs('live'))[0].claim_id,null);
      let failed:SupportMail|undefined;
      const failure=await processProtectionNotifications({delivery:{ready:true,send:async mail=>{failed=mail;throw new Error('Fixture SMTP failure');}}});assert.equal(failure.failed,1);
      await pool.query("UPDATE support_protection_notification_outbox SET next_attempt_at=now() WHERE status='pending'");
      const results=await Promise.all([processProtectionNotifications({delivery}),processProtectionNotifications({delivery})]);
      assert.equal(results.reduce((sum,r)=>sum+r.sent,0),1);assert.equal(sent[0].messageId,failed!.messageId);assert.equal(sent[0].html,failed!.html);
      assert.match(sent[0].html,/A shipment from your protected order/i);assert.match(sent[0].html,/https:\/\/us-seel.com\/protection#access=pa_/);assert.match(sent[0].html,/Unsubscribe/);
      assert.equal((await order('live')).service_fulfillment_status,'fulfilled','Mail does not complete the service on shipment');
      await write('live',{order_status:'finished',raw_order_json:{created_at:old,total_discount:'0',finished_at:finished,fulfillments:[parcel()]}});
      await write('live');assert.equal((await processProtectionNotifications({delivery})).sent,1);
      assert.deepEqual((await jobs('live')).map(j=>[j.event_type,j.status]),[['shipment','sent'],['completion','sent']]);
      assert.match(sent[1].html,/marked your order as complete/i);assert.doesNotMatch(sent[1].html,/your order has been delivered/i);
    });
    await t.test('late old source snapshots cannot revert the current indexed order or duplicate milestones',async()=>{
      const source=fixture({order_id:'live',customer_email:'live@example.invalid',order_status:'placed',raw_order_json:{fulfillments:[]}});
      await pool.query(`INSERT INTO support_order_snapshots(store_subdomain,order_id,customer_email,items_json,raw_order_json,updated_at) VALUES($1,$2,$3,$4,$5,$6)`,[source.store_subdomain,'live',source.customer_email,JSON.stringify(lines),JSON.stringify(source.raw_order_json),old]);
      await syncProtectionOrders(200);assert.equal((await order('live')).order_status,'finished');assert.equal((await jobs('live')).length,2);
    });
    await t.test('a shipment retry becomes obsolete when completion arrives; only completion is sent',async()=>{
      await write('completed-before-retry');
      assert.equal((await processProtectionNotifications({delivery:{ready:true,send:async()=>{throw new Error('Fixture SMTP failure');}}})).failed,1);
      await write('completed-before-retry',{order_status:'finished',raw_order_json:{created_at:old,total_discount:'0',finished_at:finished,fulfillments:[parcel()]}});
      await pool.query("UPDATE support_protection_notification_outbox SET next_attempt_at=now() WHERE status='pending'");
      const before=sent.length,result=await processProtectionNotifications({delivery});
      assert.equal(result.cancelled,1);assert.equal(result.sent,1);assert.equal(sent.length,before+1);assert.match(sent.at(-1)!.html,/marked your order as complete/i);
      assert.deepEqual((await jobs('completed-before-retry')).map(j=>[j.event_type,j.status]),[['shipment','cancelled'],['completion','sent']]);
      await write('first-seen-complete',{order_status:'finished',raw_order_json:{created_at:old,total_discount:'0',finished_at:finished,fulfillments:[parcel()]}});
      assert.equal((await jobs('first-seen-complete'))[0].last_error,'order_already_completed');assert.equal((await processProtectionNotifications({delivery})).sent,1);
    });
    await t.test('transaction rollback leaves no event behind',async()=>{
      await write('rollback',{raw_order_json:{fulfillments:[]}});const row=await order('rollback');
      const client=await pool.connect();try{await client.query('BEGIN');await enqueueProtectionLifecycleNotifications(client,{...row,logistics_json:[parcel()]});await client.query('ROLLBACK');}finally{client.release();}
      assert.equal((await jobs('rollback')).length,0);
    });
    await t.test('invalid payment, revoked service and cancellation suppress notification creation',async()=>{
      for(const [id,overrides] of [['unpaid',{payment_status:'pending'}],['revoked',{items_json:lines.map(l=>l.id==='protection'?{...l,refund_quantity_total:1}:l)}],['cancelled',{order_status:'cancelled'}]] as const){await write(id,overrides);assert.equal((await jobs(id)).length,0);}
    });
    await t.test('a refund in a newer snapshot cancels queued mail before the index catches up',async()=>{
      await write('refund');await write('refund',{payment_status:'refunded',refund_status:'refunded',refund_amount:'103.00'},false);
      const result=await processProtectionNotifications({delivery});assert.equal(result.cancelled,1);assert.equal(result.sent,0);assert.equal((await jobs('refund'))[0].access_token_hash,null);
      await syncProtectionOrders(200);
    });
    await t.test('protection unsubscribe at enqueue is durable; ticket unsubscribe does not suppress protection',async()=>{
      await pool.query("INSERT INTO support_email_preferences(category,email) VALUES('protection','optout@example.invalid'),('ticket','ticket-only@example.invalid')");
      await write('optout');assert.equal((await jobs('optout'))[0].status,'cancelled');
      await pool.query("DELETE FROM support_email_preferences WHERE email='optout@example.invalid'");await write('optout');assert.equal((await jobs('optout'))[0].status,'cancelled');
      await write('ticket-only');assert.equal((await processProtectionNotifications({delivery})).sent,1);
    });
    await t.test('queued mail checks unsubscribe again immediately before delivery',async()=>{
      await write('queued-optout');await pool.query("INSERT INTO support_email_preferences(category,email) VALUES('protection','queued-optout@example.invalid')");
      assert.equal((await processProtectionNotifications({delivery})).cancelled,1);assert.equal((await jobs('queued-optout'))[0].access_token_hash,null);
    });
    await t.test('latest payment state is checked again after the final recipient lock wait',async()=>{
      await write('late-refund');let processing:ReturnType<typeof processProtectionNotifications>|undefined;
      try{
        await withEmailPreferenceGuard('late-refund@example.invalid','protection',async()=>{
          processing=processProtectionNotifications({delivery:{ready:true,send:async()=>assert.fail('Revoked protection must not send')}});
          let prepared=false;for(let i=0;i<100;i++){if((await jobs('late-refund'))[0].body_snapshot){prepared=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
          assert.equal(prepared,true);await write('late-refund',{payment_status:'refunded',refund_amount:'103.00'},false);
        });
        assert.equal((await processing!).cancelled,1);assert.equal((await jobs('late-refund'))[0].status,'cancelled');
      }finally{if(processing)await processing;}
    });
  }finally{await pool.end();await closeDatabasePools();}
});
