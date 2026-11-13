import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { PROTECTION_SCHEMA_SQL } from './protection-schema';
import { PROTECTION_NOTIFICATION_SCHEMA_SQL } from './protection-notification-schema';
import { initMailboxSchema } from './mailbox-schema';
import { closeDatabasePools } from './pg';
import { addNote, backfillMailboxOrderLinks, getConversation, importIncomingMessage, linkClaim, linkProtectionOrder, listConversations, queueReply, updateConversation } from './mailbox-store';

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

    const newerOrderId = (await pool.query(`INSERT INTO support_protection_orders
      (store_subdomain,store_name,order_id,order_number,customer_email,customer_name,currency,payment_status,order_status,fulfillment_status,refund_status,paid_at)
      VALUES('shop-a','Shop A','order-new','1002','buyer@example.invalid','Buyer','USD','paid','open','fulfilled','',now()) RETURNING id`)).rows[0].id;

    const unrelated = await importIncomingMessage({ mailbox: 'customersupport@reply.us-seel.com', uidValidity: '7', uid: 5,
      messageId: '<new@example.invalid>', inReplyTo: null, references: [], sender: 'buyer@example.invalid',
      recipient: 'customersupport@reply.us-seel.com', subject: 'Different question', body: 'Please help', sentAt: new Date('2026-11-13T10:02:00Z'), attachments: [] });
    assert.notEqual(unrelated.conversationId, first.conversationId);
    assert.equal((await getConversation(unrelated.conversationId)).protection_order_id, Number(newerOrderId));
    assert.equal((await getConversation(unrelated.conversationId)).order_candidates[0].id, Number(newerOrderId));
    assert.equal((await listConversations({ q: 'Different question' })).items.length, 1);
    assert.equal(typeof (await listConversations({ q: 'Different question' })).items[0].id, 'number');
    assert.equal((await listConversations({ read: false })).items.some((item: any) => item.id === unrelated.conversationId), true);
    assert.equal((await listConversations({ read: true })).items.some((item: any) => item.id === unrelated.conversationId), false);

    detail = await updateConversation(first.conversationId, detail!.version, { assigneeId: 11, markRead: true }, 11);
    assert.equal(detail.assignee_id, 11);
    assert.equal(detail.unread_count, 0);
    assert.equal((await listConversations({ read: true })).items.some((item: any) => item.id === first.conversationId), true);
    detail = await updateConversation(first.conversationId, detail.version, { markUnread: true }, 11);
    assert.equal(detail.unread_count, 1);
    assert.equal((await listConversations({ read: false })).items.some((item: any) => item.id === first.conversationId), true);
    detail = await updateConversation(first.conversationId, detail.version, { markRead: true }, 11);
    await assert.rejects(() => updateConversation(first.conversationId, detail!.version - 1, { status: 'resolved' }, 12), /stale_version/);
    detail = await addNote(first.conversationId, detail.version, 'Internal only', 11);
    assert.equal(detail.notes[0].body_text, 'Internal only');
    detail = await linkClaim(forwarded.conversationId, forwardedDetail!.version, Number(claimId), 11);
    assert.equal(detail.claim_id, Number(claimId));
    assert.deepEqual((await pool.query('SELECT previous_claim_id,new_claim_id FROM support_mailbox_link_events WHERE conversation_id=$1', [forwarded.conversationId])).rows.map(row => [row.previous_claim_id, row.new_claim_id]), [[null, claimId]]);

    const unlinked = await linkProtectionOrder(unrelated.conversationId,
      (await getConversation(unrelated.conversationId)).version, null, 11);
    assert.equal(unlinked.protection_order_id, null);
    const legacyId = Number((await pool.query(`INSERT INTO support_mailbox_conversations(subject,customer_email)
      VALUES('Older conversation','buyer@example.invalid') RETURNING id`)).rows[0].id);
    await backfillMailboxOrderLinks();
    assert.equal((await getConversation(unrelated.conversationId)).protection_order_id, null, 'manual unlink survives schema backfill');
    assert.equal((await getConversation(legacyId)).protection_order_id, Number(newerOrderId), 'older unlinked conversation is matched once');

    await pool.query("UPDATE support_mailbox_conversations SET last_message_at='2026-11-12T10:00:00Z' WHERE id=$1", [first.conversationId]);
    const queued = await queueReply(first.conversationId, (await getConversation(first.conversationId))!.version,
      'buyer@example.invalid', 'We received your photos', [], 11, 'send-1');
    assert.equal(queued.status, 'queued');
    assert.equal((await queueReply(first.conversationId, 999, 'buyer@example.invalid', 'duplicate', [], 11, 'send-1')).id, queued.id);
    assert.equal((await pool.query("SELECT count(*)::int n FROM support_mailbox_messages WHERE direction='outgoing'")).rows[0].n, 1);
    assert.ok(new Date((await getConversation(first.conversationId)).last_message_at).getTime() > new Date('2026-11-12T10:00:00Z').getTime());

    const anotherDirect = await importIncomingMessage({ mailbox: 'customersupport@reply.us-seel.com', uidValidity: '7', uid: 6,
      messageId: '<another-direct@example.invalid>', inReplyTo: '<notice@example.invalid>', references: ['<notice@example.invalid>'],
      sender: 'buyer@example.invalid', recipient: 'customersupport@reply.us-seel.com', subject: 'Re: Claim update', body: 'Another attachment', sentAt: new Date('2026-11-13T10:04:00Z'), attachments: [] });
    assert.equal(anotherDirect.conversationId, first.conversationId);
    const anotherForward = await importIncomingMessage({ mailbox: 'customersupport@reply.us-seel.com', uidValidity: '7', uid: 7,
      messageId: '<another-forward@example.invalid>', inReplyTo: '<notice@example.invalid>', references: ['<notice@example.invalid>'],
      sender: 'friend@example.invalid', recipient: 'customersupport@reply.us-seel.com', subject: 'Fwd: Claim update', body: 'More', sentAt: new Date('2026-11-13T10:05:00Z'), attachments: [] });
    assert.equal(anotherForward.conversationId, forwarded.conversationId);

    const malformed = await importIncomingMessage({ mailbox: 'customersupport@reply.us-seel.com', uidValidity: '7', uid: 8,
      messageId: '<nul@example.invalid>', inReplyTo: null, references: [], sender: 'buyer@example.invalid',
      recipient: 'customersupport@reply.us-seel.com', subject: 'NUL\0subject', body: 'before\0after', sentAt: new Date(), attachments: [] });
    assert.equal((await getConversation(malformed.conversationId)).messages[0].body_text, 'beforeafter');
    const later = await importIncomingMessage({ mailbox: 'customersupport@reply.us-seel.com', uidValidity: '7', uid: 9,
      messageId: '<later@example.invalid>', inReplyTo: null, references: [], sender: 'buyer@example.invalid',
      recipient: 'customersupport@reply.us-seel.com', subject: 'Later', body: 'Still imported', sentAt: new Date(), attachments: [] });
    assert.equal((await getConversation(later.conversationId)).messages[0].body_text, 'Still imported');

    await pool.query(`INSERT INTO support_mailbox_messages
      (conversation_id,direction,mailbox,message_id,sender_email,recipient_email,subject,body_text,sent_at,status)
      SELECT $1,'incoming','customersupport@reply.us-seel.com','<bulk-'||n||'@example.invalid>',
        'buyer@example.invalid','customersupport@reply.us-seel.com','Bulk','Message '||n,
        now()+n*interval '1 second','received' FROM generate_series(1,105) n`, [first.conversationId]);
    const newestPage = await getConversation(first.conversationId);
    assert.equal(newestPage.messages.length, 100);
    assert.equal(newestPage.messages.at(-1).body_text, 'Message 105');
    assert.equal(newestPage.has_older_messages, true);
    const olderPage = await getConversation(first.conversationId, Number(newestPage.messages[0].id));
    assert.equal(olderPage.messages.some((message: any) => message.body_text === 'Message 1'), true);
    assert.equal(olderPage.has_older_messages, false);

    await pool.query(`INSERT INTO support_protection_notification_outbox
      (event_key,event_type,protection_order_id,recipient_email,context_json,status,message_id,subject_snapshot,body_snapshot,sent_at)
      VALUES('shipment-1','shipment',$1,'buyer@example.invalid','{}','sent','<shipment@example.invalid>',
        'Shipment update','Your order shipped',now())`, [orderId]);
    const orderReply = await importIncomingMessage({ mailbox: 'customersupport@reply.us-seel.com', uidValidity: '7', uid: 10,
      messageId: '<order-reply@example.invalid>', inReplyTo: '<shipment@example.invalid>', references: ['<shipment@example.invalid>'],
      sender: 'buyer@example.invalid', recipient: 'customersupport@reply.us-seel.com', subject: 'Re: Shipment update', body: 'Where is it?', sentAt: new Date(), attachments: [] });
    assert.equal((await getConversation(orderReply.conversationId)).protection_order_id, Number(orderId));
    const forwardedOrder = await importIncomingMessage({ mailbox: 'customersupport@reply.us-seel.com', uidValidity: '7', uid: 11,
      messageId: '<forward-order@example.invalid>', inReplyTo: '<shipment@example.invalid>', references: ['<shipment@example.invalid>'],
      sender: 'friend@example.invalid', recipient: 'customersupport@reply.us-seel.com', subject: 'Fwd: Shipment update', body: 'Help', sentAt: new Date(), attachments: [] });
    const candidateOrder = await getConversation(forwardedOrder.conversationId);
    assert.equal(candidateOrder.protection_order_id, null);
    assert.equal(candidateOrder.candidate_notification.protection_order_id, Number(orderId));
    const linkedOrder = await linkProtectionOrder(forwardedOrder.conversationId, candidateOrder.version, Number(orderId), 11);
    assert.equal(linkedOrder.protection_order_id, Number(orderId));
    assert.equal(linkedOrder.notification.body_text, 'Your order shipped');
    assert.deepEqual((await pool.query(`SELECT previous_protection_order_id,new_protection_order_id
      FROM support_mailbox_link_events WHERE conversation_id=$1`, [forwardedOrder.conversationId])).rows.map(row =>
      [row.previous_protection_order_id, row.new_protection_order_id]), [[null, orderId]]);
  } finally {
    await closeDatabasePools();
    await pool.end();
  }
});
