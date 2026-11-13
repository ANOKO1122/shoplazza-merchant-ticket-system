import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { getClient, query } from './pg';
import { readMailboxAttachment } from './mailbox-attachments';
import { SUPPORT_MAILBOX_ADDRESS, mailboxConfigured } from './mailbox-imap';

export interface MailboxMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments: Array<{ filename: string; contentType: string; content: Buffer }>;
}

async function sendMailboxEmail(mail: MailboxMail): Promise<void> {
  if (!mailboxConfigured()) throw new Error('mailbox_not_configured');
  const transport = nodemailer.createTransport({ host: 'smtp.qiye.aliyun.com', port: 465, secure: true,
    auth: { user: SUPPORT_MAILBOX_ADDRESS, pass: process.env.SUPPORT_MAILBOX_CLIENT_PASSWORD! },
    connectionTimeout: 10_000, greetingTimeout: 5000, socketTimeout: 20_000 });
  try {
    const result = await transport.sendMail(mail);
    if (result.rejected?.length) throw new Error('smtp_recipient_rejected');
  } finally { transport.close(); }
}

async function leaseReply(): Promise<any | null> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`SELECT * FROM support_mailbox_messages
      WHERE direction='outgoing' AND status='queued' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (!row) { await client.query('COMMIT'); return null; }
    const leaseToken = crypto.randomUUID();
    await client.query(`UPDATE support_mailbox_messages SET status='sending',lease_token=$2,
      lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=$1`, [row.id, leaseToken]);
    await client.query('COMMIT');
    return { ...row, lease_token: leaseToken };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function processMailboxReplies(send: (mail: MailboxMail) => Promise<void> = sendMailboxEmail, limit = 10): Promise<{ sent: number; unknown: number }> {
  await query(`UPDATE support_mailbox_messages SET status='unknown',error_code='delivery_unconfirmed',
    lease_token=NULL,lease_until=NULL,updated_at=now()
    WHERE direction='outgoing' AND status='sending' AND lease_until<now()`);
  let sent = 0;
  let unknown = 0;
  for (let index = 0; index < Math.min(20, Math.max(1, limit)); index++) {
    const row = await leaseReply();
    if (!row) break;
    try {
      const attachments = (await query(`SELECT filename,mime_type,storage_key FROM support_mailbox_attachments
        WHERE message_id=$1 AND storage_key IS NOT NULL ORDER BY id`, [row.id])).rows;
      const mail: MailboxMail = {
        from: `Customer Support <${SUPPORT_MAILBOX_ADDRESS}>`, to: row.recipient_email,
        subject: row.subject, text: row.body_text, messageId: row.message_id,
        ...(row.in_reply_to ? { inReplyTo: row.in_reply_to } : {}),
        references: Array.isArray(row.references_json) ? row.references_json : [],
        attachments: await Promise.all(attachments.map(async attachment => ({ filename: attachment.filename,
          contentType: attachment.mime_type, content: await readMailboxAttachment(attachment.storage_key) }))),
      };
      await send(mail);
      await query(`WITH sent AS (
        UPDATE support_mailbox_messages SET status='sent',sent_at=now(),error_code=NULL,
          lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2
          RETURNING conversation_id,sent_at
      ) UPDATE support_mailbox_conversations c SET last_message_at=GREATEST(c.last_message_at,sent.sent_at),updated_at=now()
        FROM sent WHERE c.id=sent.conversation_id`, [row.id, row.lease_token]);
      sent++;
    } catch {
      await query(`UPDATE support_mailbox_messages SET status='unknown',error_code='delivery_unconfirmed',
        lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`, [row.id, row.lease_token]);
      unknown++;
    }
  }
  return { sent, unknown };
}
