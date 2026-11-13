import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { PROTECTION_SCHEMA_SQL } from './protection-schema';
import { PROTECTION_NOTIFICATION_SCHEMA_SQL } from './protection-notification-schema';
import { initMailboxSchema } from './mailbox-schema';
import { closeDatabasePools } from './pg';
import { addNote, getConversation, importIncomingMessage, linkClaim, listConversations, queueReply, updateConversation } from './mailbox-store';

const databaseUrl = process.env.SUPPORT_MAILBOX_TEST_DATABASE_URL;

test('inbox import, assignment, notes, claim links and reply queue remain consistent', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl!).pathname, /_test$/);
  process.env.SUPPORT_DATABASE_URL = databaseUrl;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE support_agents(id BIGINT PRIMARY KEY, name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true);
      CREATE TABLE support_protection_stores(store_subdomain TEXT PRIMARY KEY);
      CREATE TABLE support_order_snapshots(id BIGSERIAL PRIMARY KEY,store_subdomain TEXT,order_id TEXT);`);
    await pool.query(PROTECTION_SCHEMA_SQL);
    await pool.query(PROTECTION_NOTIFICATION_SCHEMA_SQL);
    await initMailboxSchema();
    await pool.query("INSERT INTO support_agents(id,name) VALUES(11,'Alice'),(12,'Bob')");
    const orderId = (await pool.query(`INSERT INTO support_protection_orders
      (store_subdomain,store_name,order_id,order_number,customer_email,customer_name,currency,payment_status,order_status,fulfillment_status,refund_status)
      VALUES('shop-a','Shop A','order-a','1001','buyer@example.invalid','Buyer','USD','paid','open','fulfilled','') RETURNING id`)).rows[0].id;
    const claimId = (await pool.query(`INSERT INTO support_protection_claims
      (protection_order_id,reason,description,status,requested_amount_cents,currency,item_ids)
      VALUES($1,'damaged','private claim note','needs_info',1000,'USD','[]') RETURNING id`, [orderId])).rows[0].id;
    await pool.query(`INSERT INTO support_protection_notification_outbox
      (event_key,event_type,claim_id,protection_order_id,revision,target_status,recipient_email,context_json,status,message_id,subject_snapshot,body_snapshot,sent_at)
      VALUES('claim-1','claim_update',$1,$2,1,'needs_info','buyer@example.invalid','{}','sent','<notice@example.invalid>','Claim update','Please send photos',now())`, [claimId, orderId]);

    const first = await importIncomingMessage({ mailbox: 'customersupport@reply.us-seel.com', uidValidity: '7', uid: 3,
      messageId: '<reply@example.invalid>', inReplyTo: '<notice@example.invalid>', references: ['<notice@example.invalid>'],
      sender: 'buyer@example.invalid', recipient: 'customersupport@reply.us-seel.com', subject: 'Re: Claim update', body: 'Here are photos', sentAt: new Date('2026-11-13T10:00:00Z'), attachments: [] });
    assert.equal(first.duplicate, false);
    const duplicate = await importIncomingMessage({ mailbox: 'customersupport@reply.us-seel.com', uidValidity: '7', uid: 3,
      messageId: '<reply@example.invalid>', inReplyTo: '<notice@example.invalid>', references: ['<notice@example.invalid>'],
      sender: 'buyer@example.invalid', recipient: 'customersupport@reply.us-seel.com', subject: 'Re: Claim update', body: 'Here are photos', sentAt: new Date('2026-11-13T10:00:00Z'), attachments: [] });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.conversationId, first.conversationId);
    let detail = await getConversation(first.conversationId);
    assert.equal(detail?.claim_id, Number(claimId));
    assert.equal(detail?.notification?.body_text, 'Please send photos');
    assert.equal(detail?.messages.length, 1);
    assert.equal(detail?.unread_count, 1);

    const forwarded = await importIncomingMessage({ mailbox: 'customersupport@reply.us-seel.com', uidValidity: '7', uid: 4,
      messageId: '<forward@example.invalid>', inReplyTo: '<notice@example.invalid>', references: ['<notice@example.invalid>'],
      sender: 'friend@example.invalid', recipient: 'customersupport@reply.us-seel.com', subject: 'Fwd: Claim update', body: 'Help', sentAt: new Date('2026-11-13T10:01:00Z'), attachments: [] });
    const forwardedDetail = await getConversation(forwarded.conversationId);
    assert.equal(forwardedDetail?.claim_id, null);
    assert.equal(forwardedDetail?.link_candidate_notification_id != null, true);
    assert.equal(forwardedDetail?.candidate_notification?.claim_id, Number(claimId));
    assert.notEqual(forwarded.conversationId, first.conversationId);

    const unrelated = await importIncomingMessage({ mailbox: 'customersupport@reply.us-seel.com', uidValidity: '7', uid: 5,
      messageId: '<new@example.invalid>', inReplyTo: null, references: [], sender: 'buyer@example.invalid',
      recipient: 'customersupport@reply.us-seel.com', subject: 'Different question', body: 'Please help', sentAt: new Date('2026-11-13T10:02:00Z'), attachments: [] });
    assert.notEqual(unrelated.conversationId, first.conversationId);
    assert.equal((await listConversations({ q: 'Different question' })).items.length, 1);

    detail = await updateConversation(first.conversationId, detail!.version, { assigneeId: 11, markRead: true }, 11);
    assert.equal(detail.assignee_id, 11);
    assert.equal(detail.unread_count, 0);
    await assert.rejects(() => updateConversation(first.conversationId, detail!.version - 1, { status: 'resolved' }, 12), /stale_version/);
    detail = await addNote(first.conversationId, detail.version, 'Internal only', 11);
    assert.equal(detail.notes[0].body_text, 'Internal only');
    detail = await linkClaim(forwarded.conversationId, forwardedDetail!.version, Number(claimId), 11);
    assert.equal(detail.claim_id, Number(claimId));
    assert.deepEqual((await pool.query('SELECT previous_claim_id,new_claim_id FROM support_mailbox_link_events WHERE conversation_id=$1', [forwarded.conversationId])).rows.map(row => [row.previous_claim_id, row.new_claim_id]), [[null, claimId]]);

    const queued = await queueReply(first.conversationId, (await getConversation(first.conversationId))!.version,
      'buyer@example.invalid', 'We received your photos', [], 11, 'send-1');
    assert.equal(queued.status, 'queued');
    assert.equal((await queueReply(first.conversationId, 999, 'buyer@example.invalid', 'duplicate', [], 11, 'send-1')).id, queued.id);
    assert.equal((await pool.query("SELECT count(*)::int n FROM support_mailbox_messages WHERE direction='outgoing'")).rows[0].n, 1);
  } finally {
    await closeDatabasePools();
    await pool.end();
  }
});
