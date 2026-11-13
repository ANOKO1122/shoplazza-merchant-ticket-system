import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import { convert } from 'html-to-text';
import { query } from './pg';
import { attachmentPolicy, normalizeMailboxAddress, parseMailHeaders } from './mailbox-domain';
import { deleteMailboxAttachment, saveMailboxAttachment } from './mailbox-attachments';
import { importIncomingMessage, IncomingMailInput, MailboxAttachmentInput } from './mailbox-store';

export const SUPPORT_MAILBOX_ADDRESS = 'customersupport@reply.us-seel.com';
const MAX_RAW_BYTES = 36 * 1024 * 1024;

export interface PreparedMail extends Omit<IncomingMailInput, 'attachments'> {
  attachments: Array<MailboxAttachmentInput & { bytes?: Buffer }>;
}

export function mailboxConfigured(): boolean {
  return process.env.SUPPORT_MAILBOX_ENABLED === 'true'
    && process.env.SUPPORT_MAILBOX_USER?.toLowerCase() === SUPPORT_MAILBOX_ADDRESS
    && !!process.env.SUPPORT_MAILBOX_CLIENT_PASSWORD;
}

export function selectImportUids(state: { uidValidity: string | null; lastUid: number }, currentValidity: string, uids: number[]): number[] {
  return [...new Set(uids)].filter(uid => Number.isSafeInteger(uid) && uid > 0 && (state.uidValidity !== currentValidity || uid > state.lastUid))
    .sort((a, b) => a - b).slice(0, 50);
}

export function importSearchPlan(state: { uidValidity: string | null; lastUid: number; initialSince: Date | null },
  currentValidity: string, now: Date): { query: { since: Date } | { uid: string }; initialSince: Date | null } {
  const initialSince = state.uidValidity !== currentValidity
    ? new Date(now.getTime() - 30 * 86400_000) : state.initialSince;
  return { query: initialSince ? { since: initialSince } : { uid: `${state.lastUid + 1}:*` }, initialSince };
}

export function completedBackfillCursor(selectedUids: number[], highWaterUid: number, lastUid: number): number | null {
  return selectedUids.length < 50 ? Math.max(highWaterUid, lastUid) : null;
}

export function cursorForValidity(state: { uidValidity: string | null; lastUid: number }, currentValidity: string): number {
  return state.uidValidity === currentValidity ? state.lastUid : 0;
}

export function sourceComplete(reportedSize: number | undefined, fetchedSize: number): boolean {
  return fetchedSize < MAX_RAW_BYTES && (!reportedSize || fetchedSize >= reportedSize);
}

function bytesOf(content: ArrayBuffer | Uint8Array | string, encoding?: string): Buffer {
  if (typeof content === 'string') return Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
  return Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content));
}

export async function parseIncomingRaw(raw: Buffer, uidValidity: string, uid: number): Promise<PreparedMail> {
  const email = await PostalMime.parse(raw, { maxHeadersSize: 256 * 1024, maxPartCount: 200, maxNestingDepth: 20 });
  const fromAddress = email.from && 'address' in email.from ? email.from.address : '';
  const sender = normalizeMailboxAddress(fromAddress) || 'unknown@invalid.local';
  const recipientAddress = email.to?.find(address => 'address' in address && normalizeMailboxAddress(address.address) === SUPPORT_MAILBOX_ADDRESS);
  const recipient = recipientAddress && 'address' in recipientAddress && recipientAddress.address ? recipientAddress.address : SUPPORT_MAILBOX_ADDRESS;
  const references = parseMailHeaders(email.references);
  const inReplyTo = parseMailHeaders(email.inReplyTo)[0] || null;
  const attachments: PreparedMail['attachments'] = [];
  let totalBytes = 0;
  for (const item of email.attachments.slice(0, 20)) {
    const bytes = bytesOf(item.content, item.encoding);
    totalBytes += bytes.length;
    const filename = item.filename || 'attachment';
    const policy = attachmentPolicy({ filename, contentType: item.mimeType, bytes, count: attachments.length + 1, totalBytes });
    attachments.push(policy.accepted
      ? { filename, mimeType: policy.mimeType, sizeBytes: bytes.length, bytes }
      : { filename, mimeType: item.mimeType, sizeBytes: bytes.length, omittedReason: policy.reason });
  }
  const parsedDate = email.date ? new Date(email.date) : new Date();
  return {
    mailbox: SUPPORT_MAILBOX_ADDRESS, uidValidity, uid, sender, recipient,
    messageId: parseMailHeaders(email.messageId)[0] || null, inReplyTo, references,
    subject: email.subject || '',
    body: email.text || (email.html ? convert(email.html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }) : ''),
    sentAt: Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
    attachments,
  };
}

function stubMail(message: any, uidValidity: string, uid: number): PreparedMail {
  const envelope = message?.envelope;
  return {
    mailbox: SUPPORT_MAILBOX_ADDRESS, uidValidity, uid,
    messageId: parseMailHeaders(envelope?.messageId)[0] || null,
    inReplyTo: null, references: [],
    sender: normalizeMailboxAddress(envelope?.from?.[0]?.address) || 'unknown@invalid.local',
    recipient: SUPPORT_MAILBOX_ADDRESS,
    subject: envelope?.subject || '(Unreadable message)',
    body: 'This message could not be fully imported. Please inspect it in Alibaba Mail.',
    sentAt: envelope?.date instanceof Date && !Number.isNaN(envelope.date.getTime()) ? envelope.date : new Date(),
    attachments: [],
  };
}

async function storePreparedMail(prepared: PreparedMail): Promise<void> {
  const saved: MailboxAttachmentInput[] = [];
  const storedKeys: string[] = [];
  try {
    for (const attachment of prepared.attachments) {
      if (attachment.bytes) {
        const file = await saveMailboxAttachment({ filename: attachment.filename, contentType: attachment.mimeType || '',
          bytes: attachment.bytes, count: saved.length + 1, totalBytes: saved.reduce((sum, item) => sum + item.sizeBytes, 0) + attachment.sizeBytes });
        saved.push(file);
        if (file.storageKey) storedKeys.push(file.storageKey);
      } else {
        saved.push({ filename: attachment.filename, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes,
          omittedReason: attachment.omittedReason || 'unsupported_type' });
      }
    }
    const result = await importIncomingMessage({ ...prepared, attachments: saved });
    if (result.duplicate) await Promise.all(storedKeys.map(deleteMailboxAttachment));
  } catch (error) {
    await Promise.all(storedKeys.map(deleteMailboxAttachment));
    throw error;
  }
}

export async function mailboxSyncStatus() {
  const row = (await query('SELECT uid_validity,last_uid,last_success_at,last_error FROM support_mailbox_sync_state WHERE mailbox=$1', [SUPPORT_MAILBOX_ADDRESS])).rows[0];
  return { configured: mailboxConfigured(), last_success_at: row?.last_success_at || null, last_error: row?.last_error || null };
}

export async function syncMailboxOnce(): Promise<{ imported: number; configured: boolean }> {
  if (!mailboxConfigured()) return { imported: 0, configured: false };
  const imap = new ImapFlow({ host: 'imap.qiye.aliyun.com', port: 993, secure: true,
    auth: { user: SUPPORT_MAILBOX_ADDRESS, pass: process.env.SUPPORT_MAILBOX_CLIENT_PASSWORD! },
    logger: false, socketTimeout: 30_000 });
  imap.on('error', () => undefined);
  let imported = 0;
  try {
    await imap.connect();
    const lock = await imap.getMailboxLock('INBOX', { readOnly: true });
    try {
      const uidValidity = String(imap.mailbox && imap.mailbox.uidValidity || '');
      if (!uidValidity) throw new Error('missing_uidvalidity');
      const row = (await query('SELECT uid_validity,last_uid,initial_since FROM support_mailbox_sync_state WHERE mailbox=$1', [SUPPORT_MAILBOX_ADDRESS])).rows[0];
      const state = { uidValidity: row?.uid_validity || null, lastUid: Number(row?.last_uid || 0),
        initialSince: row?.initial_since || null };
      const plan = importSearchPlan(state, uidValidity, new Date());
      if (state.uidValidity !== uidValidity) {
        await query(`INSERT INTO support_mailbox_sync_state(mailbox,uid_validity,last_uid,initial_since)
          VALUES($1,$2,0,$3) ON CONFLICT(mailbox) DO UPDATE SET uid_validity=$2,last_uid=0,initial_since=$3,updated_at=now()`,
          [SUPPORT_MAILBOX_ADDRESS, uidValidity, plan.initialSince]);
      }
      const highWaterUid = Number(imap.mailbox && imap.mailbox.uidNext) - 1;
      if (!Number.isSafeInteger(highWaterUid) || highWaterUid < 0) throw new Error('invalid_uidnext');
      const remoteUids = await imap.search(plan.query, { uid: true });
      const uids = selectImportUids(state, uidValidity, remoteUids || []);
      for (const uid of uids) {
        const info = await imap.fetchOne(String(uid), { envelope: true, size: true }, { uid: true });
        if (!info) continue;
        let prepared: PreparedMail;
        if (info.size && info.size > MAX_RAW_BYTES) prepared = stubMail(info, uidValidity, uid);
        else {
          const full = await imap.fetchOne(String(uid), { source: { start: 0, maxLength: MAX_RAW_BYTES }, envelope: true }, { uid: true });
          try { prepared = full && full.source && sourceComplete(info.size, full.source.length)
            ? await parseIncomingRaw(full.source, uidValidity, uid) : stubMail(info, uidValidity, uid); }
          catch { prepared = stubMail(info, uidValidity, uid); }
        }
        await storePreparedMail(prepared);
        await query(`UPDATE support_mailbox_sync_state SET last_uid=$2,updated_at=now() WHERE mailbox=$1`, [SUPPORT_MAILBOX_ADDRESS, uid]);
        imported++;
      }
      if (plan.initialSince) {
        const finalCursor = completedBackfillCursor(uids, highWaterUid,
          uids.at(-1) || cursorForValidity(state, uidValidity));
        if (finalCursor != null) await query(`UPDATE support_mailbox_sync_state SET last_uid=GREATEST(last_uid,$2),
          initial_since=NULL,updated_at=now() WHERE mailbox=$1`, [SUPPORT_MAILBOX_ADDRESS, finalCursor]);
      }
      await query(`UPDATE support_mailbox_sync_state SET last_success_at=now(),last_error=NULL,updated_at=now() WHERE mailbox=$1`, [SUPPORT_MAILBOX_ADDRESS]);
    } finally { lock.release(); }
    return { imported, configured: true };
  } catch (error) {
    await query(`INSERT INTO support_mailbox_sync_state(mailbox,last_error) VALUES($1,'connection_or_sync_failed')
      ON CONFLICT(mailbox) DO UPDATE SET last_error='connection_or_sync_failed',updated_at=now()`, [SUPPORT_MAILBOX_ADDRESS]).catch(() => undefined);
    throw error;
  } finally { await imap.logout().catch(() => undefined); }
}
