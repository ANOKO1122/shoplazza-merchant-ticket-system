import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initMailboxSchema } from './mailbox-schema';
import { createSession } from './auth';
import { closeDatabasePools } from './pg';
import { saveMailboxAttachment } from './mailbox-attachments';
import { createMailboxRouter } from './mailbox-routes';

const databaseUrl = process.env.SUPPORT_MAILBOX_ROUTE_TEST_DATABASE_URL;

test('mailbox API requires agent session and origin, and serves attachments only to agents', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl!).pathname, /_test$/);
  process.env.SUPPORT_DATABASE_URL = databaseUrl;
  const pool = new Pool({ connectionString: databaseUrl });
  const privateDir = await mkdtemp(path.join(os.tmpdir(), 'mailbox-routes-'));
  process.env.SUPPORT_MAILBOX_PRIVATE_DIR = privateDir;
  const app = express();
  app.use(express.json());
  app.use('/api/admin/mailbox', createMailboxRouter());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE support_agents(id BIGINT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,enabled BOOLEAN NOT NULL DEFAULT true);
      CREATE TABLE support_agent_sessions(session_token_hash TEXT PRIMARY KEY,agent_id BIGINT NOT NULL,expires_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE support_protection_orders(id BIGINT PRIMARY KEY,public_no TEXT,order_number TEXT,customer_email TEXT);
      CREATE TABLE support_protection_claims(id BIGINT PRIMARY KEY,public_no TEXT,protection_order_id BIGINT,created_at TIMESTAMPTZ);
      CREATE TABLE support_protection_notification_outbox(id BIGINT PRIMARY KEY,status TEXT,event_type TEXT,recipient_email TEXT,subject_snapshot TEXT,body_snapshot TEXT,sent_at TIMESTAMPTZ);`);
    await initMailboxSchema();
    await pool.query("INSERT INTO support_agents(id,name,role) VALUES(11,'Alice','admin')");
    const token = await createSession(11);
    const cookie = `support_session=${token}`;
    assert.equal((await fetch(`${base}/api/admin/mailbox/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/mailbox/status`, { headers: { Cookie: cookie } })).status, 200);

    const conversationId = Number((await pool.query(`INSERT INTO support_mailbox_conversations(subject,customer_email)
      VALUES('Question','buyer@example.invalid') RETURNING id`)).rows[0].id);
    const messageId = Number((await pool.query(`INSERT INTO support_mailbox_messages
      (conversation_id,direction,mailbox,message_id,sender_email,recipient_email,subject,body_text,status)
      VALUES($1,'incoming','customersupport@reply.us-seel.com','<buyer@example.invalid>','buyer@example.invalid',
      'customersupport@reply.us-seel.com','Question','Help','received') RETURNING id`, [conversationId])).rows[0].id);
    const blocked = await fetch(`${base}/api/admin/mailbox/conversations/${conversationId}/notes`, { method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, body: 'private' }) });
    assert.equal(blocked.status, 403);
    const wrongScheme = await fetch(`${base}/api/admin/mailbox/conversations/${conversationId}/notes`, { method: 'POST',
      headers: { Cookie: cookie, Origin: base.replace('http:', 'https:'), 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, body: 'private' }) });
    assert.equal(wrongScheme.status, 403);
    const accepted = await fetch(`${base}/api/admin/mailbox/conversations/${conversationId}/notes`, { method: 'POST',
      headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, body: 'private' }) });
    assert.equal(accepted.status, 200);
    assert.equal((await pool.query('SELECT count(*)::int n FROM support_mailbox_notes')).rows[0].n, 1);
    const detail = await (await fetch(`${base}/api/admin/mailbox/conversations/${conversationId}`, { headers: { Cookie: cookie } })).json() as any;
    assert.equal(detail.conversation.messages[0].idempotency_key, undefined);
    assert.equal(detail.conversation.messages[0].lease_token, undefined);
    const disabledReply = await fetch(`${base}/api/admin/mailbox/conversations/${conversationId}/replies`, { method: 'POST',
      headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 2, to: 'buyer@example.invalid', body: 'We can help', idempotency_key: 'route-reply-disabled' }) });
    assert.equal(disabledReply.status, 503);
    assert.equal((await pool.query("SELECT count(*)::int n FROM support_mailbox_messages WHERE direction='outgoing'")).rows[0].n, 0);
    process.env.SUPPORT_MAILBOX_ENABLED = 'true';
    process.env.SUPPORT_MAILBOX_USER = 'customersupport@reply.us-seel.com';
    process.env.SUPPORT_MAILBOX_CLIENT_PASSWORD = 'test-only-password';
    const reply = await fetch(`${base}/api/admin/mailbox/conversations/${conversationId}/replies`, { method: 'POST',
      headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 2, to: 'buyer@example.invalid', body: 'We can help', idempotency_key: 'route-reply-1' }) });
    assert.equal(reply.status, 200);
    assert.equal((await pool.query("SELECT count(*)::int n FROM support_mailbox_messages WHERE direction='outgoing' AND status='queued'")).rows[0].n, 1);
    const oversized = new FormData();
    oversized.set('version', '3'); oversized.set('to', 'buyer@example.invalid'); oversized.set('body', 'Attached'); oversized.set('idempotency_key', 'route-reply-big');
    oversized.append('attachments', new Blob([Buffer.alloc(11 * 1024 * 1024)], { type: 'application/pdf' }), 'big.pdf');
    const tooLarge = await fetch(`${base}/api/admin/mailbox/conversations/${conversationId}/replies`, { method: 'POST',
      headers: { Cookie: cookie, Origin: base }, body: oversized });
    assert.equal(tooLarge.status, 400);
    assert.equal((await tooLarge.json() as any).error, 'file_too_large');

    const bytes = Buffer.from('%PDF-1.7\nprivate');
    const saved = await saveMailboxAttachment({ filename: 'report.pdf', contentType: 'application/pdf', bytes, count: 1, totalBytes: bytes.length });
    const attachmentId = Number((await pool.query(`INSERT INTO support_mailbox_attachments(message_id,filename,mime_type,size_bytes,storage_key)
      VALUES($1,'report.pdf','application/pdf',$2,$3) RETURNING id`, [messageId, bytes.length, saved.storageKey])).rows[0].id);
    assert.equal((await fetch(`${base}/api/admin/mailbox/attachments/${attachmentId}`)).status, 401);
    const download = await fetch(`${base}/api/admin/mailbox/attachments/${attachmentId}`, { headers: { Cookie: cookie } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') || '', /attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  } finally {
    server.close();
    await closeDatabasePools();
    await pool.end();
    delete process.env.SUPPORT_MAILBOX_PRIVATE_DIR;
    delete process.env.SUPPORT_MAILBOX_ENABLED;
    delete process.env.SUPPORT_MAILBOX_USER;
    delete process.env.SUPPORT_MAILBOX_CLIENT_PASSWORD;
    await rm(privateDir, { recursive: true, force: true });
  }
});
