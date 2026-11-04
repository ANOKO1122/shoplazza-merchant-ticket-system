import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { Pool } from 'pg';
import { PROTECTION_SCHEMA_SQL } from './protection-schema';
import { PROTECTION_CUSTOMER_SCHEMA_SQL } from './protection-customer-schema';
import { closeDatabasePools } from './pg';
import { initProtectionNotificationSchema, enqueueProtectionClaimUpdate, processProtectionNotifications } from './protection-notification';
import type { SupportMail } from './mailer';
import { EMAIL_PREFERENCES_SCHEMA_SQL } from './email-preferences-schema';
import { decorateEmailWithUnsubscribe, getEmailUnsubscribePreference, unsubscribeEmailByToken, withEmailPreferenceGuard } from './email-preferences';

const databaseUrl = process.env.SUPPORT_PROTECTION_NOTIFICATION_TEST_DATABASE_URL;
test('claim notification outbox preserves transaction, identity, dedupe and retry boundaries', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /_test$/);
  process.env.SUPPORT_DATABASE_URL = databaseUrl;
  process.env.SUPPORT_PROTECTION_PUBLIC_BASE_URL = 'https://us-seel.com';
  process.env.SUPPORT_PROTECTION_MAIL_MODE = 'disabled';
  const pool = new Pool({ connectionString: databaseUrl });
  const sent: SupportMail[] = [];
  const delivery = { ready: true, send: async (mail: SupportMail) => { sent.push(mail); return { messageId: mail.messageId || 'fixture' }; } };
  try {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE support_agents(id BIGINT PRIMARY KEY); CREATE TABLE support_protection_stores(store_subdomain TEXT PRIMARY KEY);
      CREATE TABLE support_order_snapshots(id BIGSERIAL PRIMARY KEY,store_subdomain TEXT,order_id TEXT);
      CREATE TABLE support_email_templates(email_type TEXT PRIMARY KEY,subject_template TEXT,body_template TEXT,active_preset_name TEXT,updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE support_email_template_presets(id BIGSERIAL PRIMARY KEY,email_type TEXT,preset_name TEXT,subject_template TEXT,body_template TEXT,UNIQUE(email_type,preset_name));`);
    await pool.query(PROTECTION_SCHEMA_SQL); await pool.query(PROTECTION_CUSTOMER_SCHEMA_SQL); await pool.query(EMAIL_PREFERENCES_SCHEMA_SQL);
    const order = (await pool.query(`INSERT INTO support_protection_orders(store_subdomain,store_name,order_id,order_number,customer_email,customer_name,currency,payment_status,order_status,fulfillment_status,refund_status)
      VALUES('fixture','<Fixture Store>','one','1042','customer@example.invalid','<Alex>','USD','paid','finished','fulfilled','') RETURNING id`)).rows[0].id;
    const createClaim = async (status = 'submitted',orderId=order) => String((await pool.query(`INSERT INTO support_protection_claims(protection_order_id,reason,description,status,requested_amount_cents,currency,item_ids)
      VALUES($1,'damaged','PRIVATE INTERNAL INFORMATION',$2,1000,'USD','["item"]') RETURNING id`, [orderId, status])).rows[0].id);
    const addOrder=async(email:string,store='fixture')=>(await pool.query(`INSERT INTO support_protection_orders(store_subdomain,store_name,order_id,order_number,customer_email,customer_name,currency,payment_status,order_status,fulfillment_status,refund_status)
      VALUES($1,'Fixture',$2,'1042',$3,'Alex','USD','paid','finished','fulfilled','') RETURNING id`,[store,crypto.randomUUID(),email])).rows[0].id;
    const footerToken=(html:string)=>html.match(/token=(eu_[A-Za-z0-9_-]{43})/)![1];
    const unsubscribe=async(email:string,category:'ticket'|'protection')=>{
      const mail=await decorateEmailWithUnsubscribe({to:email,subject:'Fixture',html:'<p>Fixture</p>',text:'Fixture'},category,'https://us-seel.com');
      await unsubscribeEmailByToken(footerToken(mail.html));
    };
    await createClaim('approved');
    await initProtectionNotificationSchema(); await initProtectionNotificationSchema();
    assert.equal((await pool.query('SELECT count(*)::int n FROM support_protection_notification_outbox')).rows[0].n, 0, 'Initializing must not sweep historical claims');
    const change = async (claimId: string, previousStatus: string, status: string, revision: number, rollback = false) => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query('UPDATE support_protection_claims SET status=$2,revision=$3 WHERE id=$1', [claimId, status, revision]);
        await enqueueProtectionClaimUpdate(client, { claimId, revision, previousStatus, status }); await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
      } finally { client.release(); }
    };
    const claim = await createClaim();
    await t.test('only new target transitions enqueue, duplicate revisions dedupe and rollbacks leave no work', async () => {
      await change(claim, 'submitted', 'reviewing', 2);
      await change(claim, 'reviewing', 'reviewing', 3);
      await change(claim, 'reviewing', 'needs_info', 4, true);
      assert.equal((await pool.query('SELECT count(*)::int n FROM support_protection_notification_outbox')).rows[0].n, 0);
      await change(claim, 'reviewing', 'needs_info', 4);
      await enqueueProtectionClaimUpdate(pool, { claimId: claim, revision: 4, previousStatus: 'reviewing', status: 'needs_info' });
      assert.equal((await pool.query('SELECT count(*)::int n FROM support_protection_notification_outbox')).rows[0].n, 1);
      await processProtectionNotifications();
      assert.equal((await pool.query('SELECT attempts FROM support_protection_notification_outbox')).rows[0].attempts, 0, 'Disabled delivery does not lease or send');
    });
    await t.test('a failed delivery retries the same message and capability; concurrent workers send once', async () => {
      let failedMail: SupportMail | undefined;
      await processProtectionNotifications({ delivery: { ready: true, send: async mail => { failedMail = mail; throw new Error('fixture SMTP unavailable'); } } });
      const failed = (await pool.query('SELECT * FROM support_protection_notification_outbox')).rows[0];
      assert.equal(failed.status, 'pending'); assert.equal(failed.attempts, 1); assert.ok(failed.next_attempt_at > failed.created_at);
      await pool.query("UPDATE support_protection_notification_outbox SET next_attempt_at=now()-interval '1 second'");
      const results = await Promise.all([processProtectionNotifications({ delivery }), processProtectionNotifications({ delivery })]);
      assert.equal(results.reduce((sum, r) => sum + r.sent, 0), 1); assert.equal(sent.length, 1);
      assert.equal(sent[0].messageId, failedMail!.messageId); assert.equal(sent[0].html, failedMail!.html);assert.equal(sent[0].text,failedMail!.text);
      assert.match(sent[0].html,/unsubscribe/i); assert.match(sent[0].text,/unsubscribe/i);
      assert.equal((await getEmailUnsubscribePreference(footerToken(sent[0].html)))?.category,'protection');
      assert.match(sent[0].html, /&lt;Fixture Store&gt;/); assert.doesNotMatch(sent[0].html, /PRIVATE INTERNAL INFORMATION|approved|rejected|insurance|underwrit|\/ticket\?/i);
      const raw = sent[0].html.match(/https:\/\/us-seel\.com\/protection#access=(pa_[A-Za-z0-9_-]+)/)![1];
      const token = (await pool.query('SELECT * FROM support_protection_access_tokens WHERE token_hash=$1', [crypto.createHash('sha256').update(raw).digest('hex')])).rows[0];
      assert.equal(String(token.protection_order_id), String(order)); assert.equal(token.customer_email, 'customer@example.invalid');
      assert.equal(token.expires_at.getTime()-token.created_at.getTime(),90*86400000);
      assert.equal(token.expires_at.getTime(),failed.token_expires_at.getTime(),'Retry keeps the original capability expiry');
      assert.equal((await pool.query('SELECT status FROM support_protection_notification_outbox')).rows[0].status, 'sent');
      await processProtectionNotifications({ delivery }); assert.equal(sent.length, 1);
    });
    await t.test('changed recipients are cancelled before mail and stale worker leases can recover', async () => {
      await change(claim, 'needs_info', 'rejected', 5);
      await pool.query("UPDATE support_protection_orders SET customer_email='replacement@example.invalid' WHERE id=$1", [order]);
      await processProtectionNotifications({ delivery }); assert.equal(sent.length, 1);
      assert.equal((await pool.query('SELECT status FROM support_protection_notification_outbox WHERE revision=5')).rows[0].status, 'cancelled');
      const other = await createClaim(); await change(other, 'submitted', 'needs_info', 2);
      await pool.query("UPDATE support_protection_notification_outbox SET status='sending',lease_until=now()-interval '1 minute',lease_token=$1 WHERE claim_id=$2", [crypto.randomUUID(), other]);
      await processProtectionNotifications({ delivery }); assert.equal(sent.length, 2); assert.equal(sent[1].to, 'replacement@example.invalid');
    });
    await t.test('registered templates remain editable across schema initialization and are used for new events', async () => {
      await pool.query("UPDATE support_email_templates SET subject_template='Store update {{claim_no}}',body_template='<p>{{store_name}}</p><a href=\"{{protection_link}}\">View update {{claim_no}}</a>' WHERE email_type='protection_claim_update'");
      await initProtectionNotificationSchema();
      const other = await createClaim(); await change(other, 'submitted', 'rejected', 2);
      await processProtectionNotifications({ delivery }); assert.equal(sent.length, 3); assert.match(sent[2].subject, /^Store update CL-/); assert.match(sent[2].html, /View update CL-/);
    });
    await t.test('approved and closed transitions each notify once while same-status edits remain silent', async () => {
      const other = await createClaim();
      await change(other, 'submitted', 'approved', 2);
      await change(other, 'approved', 'approved', 3);
      await change(other, 'approved', 'closed', 4);
      await change(other, 'closed', 'closed', 5);
      assert.deepEqual((await pool.query('SELECT target_status FROM support_protection_notification_outbox WHERE claim_id=$1 ORDER BY revision', [other])).rows.map(r => r.target_status), ['approved', 'closed']);
      const result = await processProtectionNotifications({ delivery }); assert.equal(result.sent, 2);
    });
    await t.test('an elapsed lease cannot duplicate a still-running sender', async () => {
      const other = await createClaim(); await change(other, 'submitted', 'needs_info', 2);
      let started!: () => void; const inSend = new Promise<void>(resolve => { started = resolve; });
      let finish!: () => void; const release = new Promise<void>(resolve => { finish = resolve; });
      let deliveries = 0;
      const slow = { ready: true, send: async (mail: SupportMail) => { deliveries++; started(); await release; return { messageId: mail.messageId! }; } };
      const first = processProtectionNotifications({ delivery: slow }); await inSend;
      await pool.query("UPDATE support_protection_notification_outbox SET lease_until=now()-interval '1 minute' WHERE claim_id=$1", [other]);
      try { const second = await processProtectionNotifications({ delivery: slow }); assert.equal(second.picked, 0); assert.equal(deliveries, 1); }
      finally { finish(); }
      assert.equal((await first).sent, 1);
    });
    await t.test('ticket opt-out still permits protection, while protection opt-out suppresses new claims across stores',async()=>{
      const email='category@example.invalid',orderId=await addOrder(email),before=sent.length;
      await unsubscribe(email,'ticket');
      const claimId=await createClaim('submitted',orderId);await change(claimId,'submitted','needs_info',2);
      assert.equal((await processProtectionNotifications({delivery})).sent,1);assert.equal(sent.length,before+1);
      await unsubscribe(email,'protection');
      await change(claimId,'needs_info','rejected',3);
      assert.equal((await pool.query('SELECT count(*)::int n FROM support_protection_notification_outbox WHERE claim_id=$1 AND revision=3',[claimId])).rows[0].n,0);
      const other=await createClaim('submitted',await addOrder(' CATEGORY@example.invalid ','other-store'));
      await change(other,'submitted','approved',2);
      assert.equal((await pool.query('SELECT count(*)::int n FROM support_protection_notification_outbox WHERE claim_id=$1',[other])).rows[0].n,0);
    });
    await t.test('queued-before-unsubscribe mail cancels without delivery, retry or token generation',async()=>{
      const email='queued@example.invalid',claimId=await createClaim('submitted',await addOrder(email));
      await change(claimId,'submitted','needs_info',2);await unsubscribe(email,'protection');
      const result=await processProtectionNotifications({delivery:{ready:true,send:async()=>assert.fail('Unsubscribed mail must not be sent')}});
      assert.equal(result.cancelled,1);assert.equal(result.failed,0);assert.equal(result.sent,0);
      const job=(await pool.query('SELECT * FROM support_protection_notification_outbox WHERE claim_id=$1',[claimId])).rows[0];
      assert.equal(job.status,'cancelled');assert.equal(job.last_error,'email_unsubscribed:protection');assert.equal(job.access_token_hash,null);
    });
    await t.test('unsubscribe after a failed attempt cancels the retry without changing the persisted capability',async()=>{
      const email='retry-optout@example.invalid',claimId=await createClaim('submitted',await addOrder(email));
      await change(claimId,'submitted','needs_info',2);let failed:SupportMail|undefined;
      await processProtectionNotifications({delivery:{ready:true,send:async mail=>{failed=mail;throw new Error('Fixture rejected delivery');}}});
      const original=(await pool.query('SELECT * FROM support_protection_notification_outbox WHERE claim_id=$1',[claimId])).rows[0];
      await unsubscribeEmailByToken(footerToken(failed!.html));
      await pool.query('UPDATE support_protection_notification_outbox SET next_attempt_at=now() WHERE claim_id=$1',[claimId]);
      const result=await processProtectionNotifications({delivery:{ready:true,send:async()=>assert.fail('Unsubscribed retry must not be sent')}});
      assert.equal(result.cancelled,1);assert.equal(result.failed,0);
      const cancelled=(await pool.query('SELECT * FROM support_protection_notification_outbox WHERE claim_id=$1',[claimId])).rows[0];
      assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.last_error,'email_unsubscribed:protection');
      assert.equal(cancelled.access_token_hash,original.access_token_hash);assert.equal(cancelled.body_snapshot,original.body_snapshot);
    });
    await t.test('final preference guard suppresses a change after the body snapshot was prepared',async()=>{
      const email='late-optout@example.invalid',claimId=await createClaim('submitted',await addOrder(email));
      await change(claimId,'submitted','needs_info',2);
      let processing:ReturnType<typeof processProtectionNotifications>|undefined;
      try{
        await withEmailPreferenceGuard(email,'protection',async()=>{
          processing=processProtectionNotifications({delivery:{ready:true,send:async()=>assert.fail('Final guard must suppress delivery')}});
          let prepared=false;
          for(let i=0;i<100;i++){
            const row=(await pool.query('SELECT body_snapshot,status FROM support_protection_notification_outbox WHERE claim_id=$1',[claimId])).rows[0];
            if(row.body_snapshot&&row.status==='sending'){prepared=true;break;}
            await new Promise(resolve=>setTimeout(resolve,10));
          }
          assert.equal(prepared,true,'Preparation commits before the final preference lock');
          await pool.query("INSERT INTO support_email_preferences(category,email) VALUES('protection',$1)",[email]);
        });
        const result=await processing!;assert.equal(result.cancelled,1);assert.equal(result.failed,0);
        const job=(await pool.query('SELECT status,last_error FROM support_protection_notification_outbox WHERE claim_id=$1',[claimId])).rows[0];
        assert.equal(job.status,'cancelled');assert.equal(job.last_error,'email_unsubscribed:protection');
      }finally{if(processing)await processing;}
    });
    await t.test('legacy prepared snapshots gain a persisted footer without changing their access capability',async()=>{
      const claimId=await createClaim('submitted',await addOrder('legacy-queued@example.invalid'));await change(claimId,'submitted','needs_info',2);
      await processProtectionNotifications({delivery:{ready:true,send:async()=>{throw new Error('Fixture transport unavailable');}}});
      const original=(await pool.query('SELECT * FROM support_protection_notification_outbox WHERE claim_id=$1',[claimId])).rows[0];
      const legacy=original.body_snapshot.replace(/<!-- email-unsubscribe:start -->[\s\S]*?<!-- email-unsubscribe:end -->/g,'');
      await pool.query('UPDATE support_protection_notification_outbox SET body_snapshot=$2,next_attempt_at=now() WHERE claim_id=$1',[claimId,legacy]);
      const result=await processProtectionNotifications({delivery});assert.equal(result.sent,1);
      const updated=(await pool.query('SELECT * FROM support_protection_notification_outbox WHERE claim_id=$1',[claimId])).rows[0];
      assert.equal(updated.access_token_hash,original.access_token_hash);assert.equal(updated.message_id,original.message_id);
      assert.equal(updated.body_snapshot.match(/email-unsubscribe:start/g)?.length,1);assert.equal(sent.at(-1)!.html,updated.body_snapshot);
    });
    await t.test('invalid stored recipients do not abort the staff review transaction',async()=>{
      const claimId=await createClaim('submitted',await addOrder('not<a@valid.example'));
      await change(claimId,'submitted','needs_info',2);
      assert.equal((await pool.query('SELECT count(*)::int n FROM support_protection_notification_outbox WHERE claim_id=$1',[claimId])).rows[0].n,0);
    });
  } finally { await pool.end(); await closeDatabasePools(); }
});
