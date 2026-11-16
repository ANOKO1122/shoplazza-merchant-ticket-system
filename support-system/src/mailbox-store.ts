import crypto from 'crypto';
import { getClient, query } from './pg';
import { matchNotificationThread, normalizeMailboxAddress } from './mailbox-domain';

export interface MailboxAttachmentInput {
  filename: string;
  mimeType?: string | null;
  sizeBytes: number;
  storageKey?: string | null;
  omittedReason?: string | null;
}

export interface IncomingMailInput {
  mailbox: string;
  uidValidity: string;
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  sentAt: Date;
  attachments: MailboxAttachmentInput[];
}

export type ConversationChange = { assigneeId?: number | null; status?: 'open' | 'resolved'; markRead?: boolean; markUnread?: boolean };

function numberId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid_id');
  return id;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').slice(0, max) : '';
}

export async function importIncomingMessage(input: IncomingMailInput): Promise<{ conversationId: number; messageId: number; duplicate: boolean }> {
  const sender = normalizeMailboxAddress(input.sender);
  const recipient = normalizeMailboxAddress(input.recipient);
  const mailbox = normalizeMailboxAddress(input.mailbox);
  if (!sender || !recipient || !mailbox || !Number.isSafeInteger(input.uid) || input.uid <= 0 || !input.uidValidity) throw new Error('invalid_incoming_mail');
  const refs = [...new Set([...input.references, input.inReplyTo].filter((value): value is string => !!value).map(value => value.toLowerCase()))].slice(0, 50);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const duplicate = (await client.query(`SELECT id,conversation_id FROM support_mailbox_messages
      WHERE direction='incoming' AND mailbox=$1 AND ((uid_validity=$2 AND imap_uid=$3) OR (message_id IS NOT NULL AND message_id=$4)) LIMIT 1`,
      [mailbox, input.uidValidity, input.uid, input.messageId?.toLowerCase() || null])).rows[0];
    if (duplicate) {
      await client.query('COMMIT');
      return { conversationId: Number(duplicate.conversation_id), messageId: Number(duplicate.id), duplicate: true };
    }

    let conversationId: number | null = null;
    if (refs.length) {
      const existing = (await client.query(`SELECT m.conversation_id FROM support_mailbox_messages m
        JOIN support_mailbox_conversations c ON c.id=m.conversation_id
        WHERE m.message_id=ANY($1::text[]) AND c.customer_email=$2
        ORDER BY m.id DESC LIMIT 1`, [refs, sender])).rows[0];
      if (existing) conversationId = Number(existing.conversation_id);
    }
    let verifiedNotification: any = null;
    let candidateNotification: any = null;
    if (!conversationId && refs.length) {
      const notices = (await client.query(`SELECT id,message_id,recipient_email,status,claim_id,protection_order_id
        FROM support_protection_notification_outbox WHERE status='sent' AND lower(message_id)=ANY($1::text[])
        ORDER BY sent_at DESC NULLS LAST LIMIT 1`, [refs])).rows;
      const notice = notices[0];
      if (notice) {
        const match = matchNotificationThread({ sender, references: refs, notification: { messageId: notice.message_id, recipient: notice.recipient_email, status: notice.status } });
        if (match === 'verified') verifiedNotification = notice;
        if (match === 'candidate') candidateNotification = notice;
      }
    }
    if (!conversationId && (verifiedNotification || candidateNotification)) {
      const notice = verifiedNotification || candidateNotification;
      const column = verifiedNotification ? 'notification_id=$1' : '(link_candidate_notification_id=$1 OR notification_id=$1)';
      const existing = (await client.query(`SELECT id FROM support_mailbox_conversations
        WHERE ${column} AND customer_email=$2 ORDER BY id DESC LIMIT 1`, [notice.id, sender])).rows[0];
      if (existing) conversationId = Number(existing.id);
    }
    if (!conversationId) {
      const latestOrder = !verifiedNotification && !candidateNotification
        ? (await client.query(`SELECT id FROM support_protection_orders WHERE lower(customer_email)=$1
            ORDER BY paid_at DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`, [sender])).rows[0] : null;
      const created = (await client.query(`INSERT INTO support_mailbox_conversations
        (subject,customer_email,unread_count,last_message_at,claim_id,protection_order_id,notification_id,link_candidate_notification_id,auto_link_attempted)
        VALUES($1,$2,1,$3,$4,$5,$6,$7,true) RETURNING id`,
        [text(input.subject, 500), sender, input.sentAt, verifiedNotification?.claim_id || null,
          verifiedNotification?.protection_order_id || latestOrder?.id || null, verifiedNotification?.id || null, candidateNotification?.id || null])).rows[0];
      conversationId = Number(created.id);
    } else {
      await client.query(`UPDATE support_mailbox_conversations SET status='open',unread_count=unread_count+1,
        last_message_at=GREATEST(last_message_at,$2),version=version+1,updated_at=now() WHERE id=$1`, [conversationId, input.sentAt]);
    }
    const inserted = (await client.query(`INSERT INTO support_mailbox_messages
      (conversation_id,direction,mailbox,uid_validity,imap_uid,message_id,in_reply_to,references_json,sender_email,recipient_email,subject,body_text,sent_at,status)
      VALUES($1,'incoming',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'received') RETURNING id`,
      [conversationId, mailbox, input.uidValidity, input.uid, input.messageId?.toLowerCase() || null,
        input.inReplyTo?.toLowerCase() || null, JSON.stringify(refs), sender, recipient, text(input.subject, 500), text(input.body, 100_000), input.sentAt])).rows[0];
    for (const attachment of input.attachments.slice(0, 20)) {
      await client.query(`INSERT INTO support_mailbox_attachments(message_id,filename,mime_type,size_bytes,storage_key,omitted_reason)
        VALUES($1,$2,$3,$4,$5,$6)`, [inserted.id, text(attachment.filename, 255), attachment.mimeType ? text(attachment.mimeType, 255) : null,
        attachment.sizeBytes, attachment.storageKey || null, attachment.omittedReason || null]);
    }
    await client.query('COMMIT');
    return { conversationId, messageId: Number(inserted.id), duplicate: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function backfillMailboxOrderLinks(): Promise<void> {
  await query(`UPDATE support_mailbox_conversations c SET
    protection_order_id=COALESCE(c.protection_order_id,CASE WHEN c.claim_id IS NULL AND c.link_candidate_notification_id IS NULL THEN
      (SELECT po.id FROM support_protection_orders po WHERE lower(po.customer_email)=c.customer_email
       ORDER BY po.paid_at DESC NULLS LAST,po.created_at DESC,po.id DESC LIMIT 1) END),
    auto_link_attempted=true,version=version+1,updated_at=now()
    WHERE c.auto_link_attempted=false`);
}

// Read state, notes and unsent drafts never determine whether the customer has been answered.
const handlingStatusSql = `CASE WHEN (SELECT m.direction FROM support_mailbox_messages m
  WHERE m.conversation_id=c.id AND (m.direction='incoming' OR m.status='sent')
  ORDER BY m.sent_at DESC,m.id DESC LIMIT 1)='outgoing' THEN 'resolved' ELSE 'open' END`;
const customerTagsSql = `COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.name,t.id)
  FROM support_mailbox_customer_tags ct JOIN support_mailbox_tags t ON t.id=ct.tag_id
  WHERE ct.customer_email=lower(c.customer_email)), '[]'::jsonb)`;

export async function listConversations(filters: { q?: string; status?: 'open' | 'resolved'; assigneeId?: number | null; unread?: boolean; read?: boolean; tagId?: number; limit?: number; offset?: number } = {}) {
  const where = ['1=1'];
  const args: unknown[] = [];
  const add = (sql: string, value: unknown) => { args.push(value); where.push(sql.replace('?', `$${args.length}`)); };
  if (filters.status) add(`(${handlingStatusSql})=?`, filters.status);
  if (filters.assigneeId === null) where.push('c.assignee_id IS NULL');
  else if (filters.assigneeId != null) add('c.assignee_id=?', numberId(filters.assigneeId));
  if (filters.read === true) where.push('c.unread_count=0');
  else if (filters.read === false || filters.unread) where.push('c.unread_count>0');
  if (filters.tagId != null) add('EXISTS(SELECT 1 FROM support_mailbox_customer_tags ct WHERE ct.customer_email=lower(c.customer_email) AND ct.tag_id=?)', numberId(filters.tagId));
  if (filters.q?.trim()) {
    args.push(`%${filters.q.trim().slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(c.customer_email ILIKE $${args.length} ESCAPE '\\' OR c.subject ILIKE $${args.length} ESCAPE '\\'
      OR EXISTS(SELECT 1 FROM support_mailbox_messages m WHERE m.conversation_id=c.id AND m.body_text ILIKE $${args.length} ESCAPE '\\')
      OR EXISTS(SELECT 1 FROM support_protection_claims cl WHERE cl.id=c.claim_id AND cl.public_no ILIKE $${args.length} ESCAPE '\\')
      OR EXISTS(SELECT 1 FROM support_protection_orders po WHERE po.id=c.protection_order_id AND (po.public_no ILIKE $${args.length} ESCAPE '\\' OR po.order_number ILIKE $${args.length} ESCAPE '\\')))`);
  }
  const limit = Math.min(100, Math.max(1, Number(filters.limit) || 30));
  const offset = Math.max(0, Number(filters.offset) || 0);
  const total = Number((await query(`SELECT count(*)::int n FROM support_mailbox_conversations c WHERE ${where.join(' AND ')}`, args)).rows[0].n);
  const items = (await query(`SELECT c.*,${handlingStatusSql} AS status,${customerTagsSql} AS tags,a.name AS assignee_name,cl.public_no AS claim_no,po.public_no AS protection_no
    FROM support_mailbox_conversations c LEFT JOIN support_agents a ON a.id=c.assignee_id
    LEFT JOIN support_protection_claims cl ON cl.id=c.claim_id
    LEFT JOIN support_protection_orders po ON po.id=c.protection_order_id
    WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC,c.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    [...args, limit, offset])).rows;
  return { total, items: items.map(item => ({ ...item, id: Number(item.id) })) };
}

export async function getConversation(id: number, beforeMessageId?: number): Promise<any | null> {
  numberId(id);
  const conversation = (await query(`SELECT c.*,${handlingStatusSql} AS status,${customerTagsSql} AS tags,a.name AS assignee_name,cl.public_no AS claim_no,po.public_no AS protection_no
    FROM support_mailbox_conversations c LEFT JOIN support_agents a ON a.id=c.assignee_id
    LEFT JOIN support_protection_claims cl ON cl.id=c.claim_id
    LEFT JOIN support_protection_orders po ON po.id=c.protection_order_id WHERE c.id=$1`, [id])).rows[0];
  if (!conversation) return null;
  const messageRows = (await query(`SELECT m.id,m.direction,m.sender_email,m.recipient_email,m.subject,m.body_text,
    m.sent_at,m.status,a.name AS agent_name FROM support_mailbox_messages m
    LEFT JOIN support_agents a ON a.id=m.agent_id WHERE m.conversation_id=$1
      AND ($2::bigint IS NULL OR m.id<$2) ORDER BY m.id DESC LIMIT 101`,
    [id, beforeMessageId == null ? null : numberId(beforeMessageId)])).rows;
  const hasOlderMessages = messageRows.length > 100;
  const messages = messageRows.slice(0, 100).sort((a, b) =>
    new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime() || Number(a.id) - Number(b.id));
  const notes = (await query(`SELECT n.*,a.name AS agent_name FROM support_mailbox_notes n
    JOIN support_agents a ON a.id=n.agent_id WHERE n.conversation_id=$1 ORDER BY n.created_at,n.id LIMIT 500`, [id])).rows;
  const attachments = messages.length ? (await query(`SELECT id,message_id,filename,mime_type,size_bytes,omitted_reason,storage_key IS NOT NULL AS available
    FROM support_mailbox_attachments WHERE message_id=ANY($1::bigint[]) ORDER BY id`, [messages.map(message => message.id)])).rows : [];
  for (const message of messages) message.attachments = attachments.filter(item => Number(item.message_id) === Number(message.id));
  let notification: any = null;
  if (conversation.notification_id) {
    const row = (await query(`SELECT id,event_type,recipient_email,subject_snapshot,body_snapshot,sent_at
      FROM support_protection_notification_outbox WHERE id=$1 AND status='sent'`, [conversation.notification_id])).rows[0];
    if (row) notification = { id: Number(row.id), event_type: row.event_type, recipient_email: row.recipient_email,
      subject: row.subject_snapshot, sent_at: row.sent_at, body_text: text(String(row.body_snapshot || '').replace(/<[^>]*>/g, ' ').replace(/(?:pa|ta|bt|eu)_[A-Za-z0-9_-]{20,}/g, '[redacted]'), 100_000) };
  }
  let candidateNotification: any = null;
  if (conversation.link_candidate_notification_id) {
    const row = (await query(`SELECT n.id,n.claim_id,n.protection_order_id,n.recipient_email,n.subject_snapshot,
      cl.public_no AS claim_no,po.order_number FROM support_protection_notification_outbox n
      LEFT JOIN support_protection_claims cl ON cl.id=n.claim_id
      LEFT JOIN support_protection_orders po ON po.id=n.protection_order_id
      WHERE n.id=$1 AND n.status='sent'`, [conversation.link_candidate_notification_id])).rows[0];
    if (row) candidateNotification = { id: Number(row.id), claim_id: row.claim_id == null ? null : Number(row.claim_id),
      protection_order_id: Number(row.protection_order_id), recipient_email: row.recipient_email,
      subject: row.subject_snapshot, claim_no: row.claim_no, order_number: row.order_number };
  }
  const candidates = (await query(`SELECT cl.id,cl.public_no,po.order_number FROM support_protection_claims cl
    JOIN support_protection_orders po ON po.id=cl.protection_order_id WHERE lower(po.customer_email)=$1 ORDER BY cl.created_at DESC LIMIT 10`, [conversation.customer_email])).rows;
  const orderCandidates = (await query(`SELECT po.id,po.public_no,po.order_number FROM support_protection_orders po
    WHERE lower(po.customer_email)=$1 ORDER BY po.paid_at DESC NULLS LAST,po.created_at DESC,po.id DESC LIMIT 10`, [conversation.customer_email])).rows;
  return { ...conversation, id: Number(conversation.id), version: Number(conversation.version),
    claim_id: conversation.claim_id == null ? null : Number(conversation.claim_id),
    protection_order_id: conversation.protection_order_id == null ? null : Number(conversation.protection_order_id),
    unread_count: Number(conversation.unread_count), assignee_id: conversation.assignee_id == null ? null : Number(conversation.assignee_id),
    messages, has_older_messages: hasOlderMessages, notes, notification, candidate_notification: candidateNotification,
    candidates: candidates.map(item => ({ ...item, id: Number(item.id) })),
    order_candidates: orderCandidates.map(item => ({ ...item, id: Number(item.id) })) };
}

async function mutateConversation(id: number, version: number, sql: string, args: unknown[]): Promise<void> {
  const changed = await query(`UPDATE support_mailbox_conversations SET ${sql},version=version+1,updated_at=now()
    WHERE id=$1 AND version=$2 RETURNING id`, [numberId(id), version, ...args]);
  if (!changed.rowCount) throw new Error('stale_version');
}

export async function updateConversation(id: number, version: number, change: ConversationChange, _agentId: number): Promise<any> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if ('assigneeId' in change) {
    if (change.assigneeId != null) numberId(change.assigneeId);
    args.push(change.assigneeId ?? null); sets.push(`assignee_id=$${args.length + 2}`);
  }
  if (change.status) { args.push(change.status); sets.push(`status=$${args.length + 2}`); }
  if (change.markRead) sets.push('unread_count=0');
  if (change.markUnread) sets.push('unread_count=GREATEST(unread_count,1)');
  if (!sets.length) throw new Error('empty_change');
  await mutateConversation(id, version, sets.join(','), args);
  return getConversation(id);
}

export async function addNote(id: number, version: number, body: string, agentId: number): Promise<any> {
  const content = text(body, 20_000).trim();
  if (!content) throw new Error('empty_note');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const changed = await client.query(`UPDATE support_mailbox_conversations SET version=version+1,updated_at=now()
      WHERE id=$1 AND version=$2 RETURNING id`, [numberId(id), version]);
    if (!changed.rowCount) throw new Error('stale_version');
    await client.query(`INSERT INTO support_mailbox_notes(conversation_id,agent_id,body_text) VALUES($1,$2,$3)`, [id, numberId(agentId), content]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  return getConversation(id);
}

export async function linkClaim(id: number, version: number, claimId: number | null, agentId: number): Promise<any> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const before = (await client.query(`SELECT claim_id,protection_order_id,notification_id,link_candidate_notification_id
      FROM support_mailbox_conversations WHERE id=$1 FOR UPDATE`, [numberId(id)])).rows[0];
    if (!before) throw new Error('conversation_not_found');
    let orderId: number | null = null;
    if (claimId != null) {
      const claim = (await client.query('SELECT protection_order_id FROM support_protection_claims WHERE id=$1', [numberId(claimId)])).rows[0];
      if (!claim) throw new Error('claim_not_found');
      orderId = Number(claim.protection_order_id);
    }
    let confirmedNoticeId = before.claim_id == claimId ? before.notification_id : null;
    if (before.link_candidate_notification_id && claimId != null) {
      const candidate = (await client.query('SELECT claim_id FROM support_protection_notification_outbox WHERE id=$1',
        [before.link_candidate_notification_id])).rows[0];
      if (Number(candidate?.claim_id) === claimId) confirmedNoticeId = before.link_candidate_notification_id;
    }
    const changed = (await client.query(`UPDATE support_mailbox_conversations SET claim_id=$3,protection_order_id=$4,
      notification_id=$5,link_candidate_notification_id=NULL,auto_link_attempted=true,version=version+1,updated_at=now()
      WHERE id=$1 AND version=$2 RETURNING id`, [numberId(id), version, claimId, orderId, confirmedNoticeId])).rows[0];
    if (!changed) throw new Error('stale_version');
    await client.query(`INSERT INTO support_mailbox_link_events(conversation_id,agent_id,previous_claim_id,new_claim_id,
      previous_protection_order_id,new_protection_order_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [id, numberId(agentId), before.claim_id, claimId, before.protection_order_id, orderId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  return getConversation(id);
}

export async function linkProtectionOrder(id: number, version: number, orderId: number | null, agentId: number): Promise<any> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const before = (await client.query(`SELECT claim_id,protection_order_id,notification_id,link_candidate_notification_id
      FROM support_mailbox_conversations WHERE id=$1 FOR UPDATE`, [numberId(id)])).rows[0];
    if (!before) throw new Error('conversation_not_found');
    if (orderId != null) {
      const order = (await client.query('SELECT id FROM support_protection_orders WHERE id=$1', [numberId(orderId)])).rows[0];
      if (!order) throw new Error('order_not_found');
    }
    let confirmedNoticeId = before.claim_id == null && before.protection_order_id == orderId ? before.notification_id : null;
    if (before.link_candidate_notification_id && orderId != null) {
      const candidate = (await client.query(`SELECT claim_id,protection_order_id FROM support_protection_notification_outbox WHERE id=$1`,
        [before.link_candidate_notification_id])).rows[0];
      if (candidate?.claim_id == null && Number(candidate?.protection_order_id) === orderId) confirmedNoticeId = before.link_candidate_notification_id;
    }
    const changed = (await client.query(`UPDATE support_mailbox_conversations SET claim_id=NULL,protection_order_id=$3,
      notification_id=$4,link_candidate_notification_id=NULL,auto_link_attempted=true,version=version+1,updated_at=now()
      WHERE id=$1 AND version=$2 RETURNING id`, [numberId(id), version, orderId, confirmedNoticeId])).rows[0];
    if (!changed) throw new Error('stale_version');
    await client.query(`INSERT INTO support_mailbox_link_events(conversation_id,agent_id,previous_claim_id,new_claim_id,
      previous_protection_order_id,new_protection_order_id) VALUES($1,$2,$3,NULL,$4,$5)`,
      [id, numberId(agentId), before.claim_id, before.protection_order_id, orderId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  return getConversation(id);
}

export async function queueReply(id: number, version: number, recipientValue: string, body: string,
  attachments: MailboxAttachmentInput[], agentId: number, idempotencyKey: string): Promise<any> {
  const recipient = normalizeMailboxAddress(recipientValue);
  const content = text(body, 100_000).trim();
  if (!recipient || !content || !idempotencyKey || idempotencyKey.length > 128) throw new Error('invalid_reply');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const duplicate = (await client.query('SELECT * FROM support_mailbox_messages WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
    if (duplicate) { await client.query('COMMIT'); return duplicate; }
    const conversation = (await client.query('SELECT * FROM support_mailbox_conversations WHERE id=$1 FOR UPDATE', [numberId(id)])).rows[0];
    if (!conversation) throw new Error('conversation_not_found');
    if (Number(conversation.version) !== version) throw new Error('stale_version');
    const incoming = (await client.query(`SELECT * FROM support_mailbox_messages WHERE conversation_id=$1 AND direction='incoming'
      ORDER BY sent_at DESC,id DESC LIMIT 1`, [id])).rows[0];
    if (!incoming || recipient !== incoming.sender_email) throw new Error('recipient_mismatch');
    const references = [...new Set([...(incoming.references_json || []), incoming.message_id].filter(Boolean))].slice(-50);
    const messageId = `<${crypto.randomUUID()}@reply.us-seel.com>`;
    const subject = /^re:/i.test(conversation.subject) ? conversation.subject : `Re: ${conversation.subject}`;
    const result = (await client.query(`INSERT INTO support_mailbox_messages
      (conversation_id,direction,mailbox,message_id,in_reply_to,references_json,sender_email,recipient_email,subject,body_text,status,agent_id,idempotency_key)
      VALUES($1,'outgoing',$2,$3,$4,$5,$2,$6,$7,$8,'queued',$9,$10) RETURNING *`,
      [id, 'customersupport@reply.us-seel.com', messageId, incoming.message_id, JSON.stringify(references), recipient,
        text(subject, 500), content, numberId(agentId), idempotencyKey])).rows[0];
    for (const attachment of attachments) await client.query(`INSERT INTO support_mailbox_attachments
      (message_id,filename,mime_type,size_bytes,storage_key,omitted_reason) VALUES($1,$2,$3,$4,$5,$6)`,
      [result.id, attachment.filename, attachment.mimeType || null, attachment.sizeBytes, attachment.storageKey || null, attachment.omittedReason || null]);
    await client.query(`UPDATE support_mailbox_conversations SET assignee_id=COALESCE(assignee_id,$2),
      last_message_at=GREATEST(last_message_at,$3),version=version+1,updated_at=now() WHERE id=$1`, [id, agentId, result.sent_at]);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
