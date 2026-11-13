import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { initMailboxSchema } from './mailbox-schema';
import { closeDatabasePools } from './pg';
import { queueReply } from './mailbox-store';
import { processMailboxReplies } from './mailbox-smtp';

const databaseUrl = process.env.SUPPORT_MAILBOX_SMTP_TEST_DATABASE_URL;

test('reply worker sends once with the original mail thread and records SMTP uncertainty', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl!).pathname, /_test$/);
  process.env.SUPPORT_DATABASE_URL = databaseUrl;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE support_agents(id BIGINT PRIMARY KEY,name TEXT NOT NULL,enabled BOOLEAN NOT NULL DEFAULT true);
      CREATE TABLE support_protection_orders(id BIGINT PRIMARY KEY,public_no TEXT,order_number TEXT,customer_email TEXT);
      CREATE TABLE support_protection_claims(id BIGINT PRIMARY KEY,public_no TEXT,protection_order_id BIGINT,created_at TIMESTAMPTZ);
      CREATE TABLE support_protection_notification_outbox(id BIGINT PRIMARY KEY,status TEXT,event_type TEXT,recipient_email TEXT,subject_snapshot TEXT,body_snapshot TEXT,sent_at TIMESTAMPTZ);`);
    await initMailboxSchema();
    await pool.query("INSERT INTO support_agents(id,name) VALUES(11,'Alice')");
    const conversationId = Number((await pool.query(`INSERT INTO support_mailbox_conversations(subject,customer_email)
      VALUES('Claim update','buyer@example.invalid') RETURNING id`)).rows[0].id);
    await pool.query(`INSERT INTO support_mailbox_messages(conversation_id,direction,mailbox,message_id,sender_email,recipient_email,subject,body_text,status)
      VALUES($1,'incoming','customersupport@reply.us-seel.com','<customer@example.invalid>','buyer@example.invalid',
      'customersupport@reply.us-seel.com','Claim update','Question','received')`, [conversationId]);
    const queued = await queueReply(conversationId, 1, 'buyer@example.invalid', 'We can help', [], 11, 'reply-1');
    const sent: any[] = [];
    await new Promise(resolve => setTimeout(resolve, 10));
    const first = await processMailboxReplies(async mail => { sent.push(mail); });
    assert.equal(first.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'buyer@example.invalid');
    assert.equal(sent[0].from, 'Customer Support <customersupport@reply.us-seel.com>');
    assert.equal(sent[0].inReplyTo, '<customer@example.invalid>');
    assert.equal(sent[0].messageId, queued.message_id);
    assert.equal((await pool.query('SELECT status FROM support_mailbox_messages WHERE id=$1', [queued.id])).rows[0].status, 'sent');
    const activity = (await pool.query(`SELECT c.last_message_at,m.sent_at FROM support_mailbox_conversations c
      JOIN support_mailbox_messages m ON m.conversation_id=c.id WHERE m.id=$1`, [queued.id])).rows[0];
    assert.ok(activity.last_message_at >= activity.sent_at, 'sent reply must set the conversation activity to its actual send time');
    await processMailboxReplies(async mail => { sent.push(mail); });
    assert.equal(sent.length, 1);

    const second = await queueReply(conversationId, 2, 'buyer@example.invalid', 'Another answer', [], 11, 'reply-2');
    const failed = await processMailboxReplies(async () => { throw new Error('connection reset after DATA'); });
    assert.equal(failed.unknown, 1);
    assert.equal((await pool.query('SELECT status FROM support_mailbox_messages WHERE id=$1', [second.id])).rows[0].status, 'unknown');
    await processMailboxReplies(async mail => { sent.push(mail); });
    assert.equal(sent.length, 1, 'unknown delivery must not be retried automatically');
  } finally {
    await closeDatabasePools();
    await pool.end();
  }
});
