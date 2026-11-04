import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { getClient, query } from './pg';
import { renderEmailFromTemplate } from './email-service';
import { emailHtmlToText } from './email-text';
import type { SupportMail } from './mailer';
import { digest, PROTECTION_ACCESS_LINK_DAYS, protectionPublicBaseUrl } from './protection-customer-auth';
import { PROTECTION_CLAIM_UPDATE_EMAIL_TYPE, PROTECTION_CLAIM_UPDATE_TEMPLATE } from './protection-email-template';
import { PROTECTION_NOTIFICATION_SCHEMA_SQL } from './protection-notification-schema';
import { protectionMailReadiness, sendProtectionNotificationEmail } from './protection-notification-mailer';
import { decorateEmailWithUnsubscribe, isEmailUnsubscribed, normalizePreferenceEmail, withEmailPreferenceGuard } from './email-preferences';

type Db = Pick<PoolClient, 'query'>;
export interface ProtectionClaimUpdateEvent { claimId: string; revision: number; previousStatus: string; status: string; }
export interface ProtectionNotificationDelivery { ready: boolean; send: (mail: SupportMail) => Promise<{ messageId: string }>; }
const TARGET_STATUSES = ['needs_info', 'approved', 'rejected', 'closed'];

export async function initProtectionNotificationSchema(): Promise<void> {
  await query(PROTECTION_NOTIFICATION_SCHEMA_SQL);
  await query(`INSERT INTO support_email_templates(email_type,subject_template,body_template) VALUES($1,$2,$3) ON CONFLICT(email_type) DO NOTHING`, [PROTECTION_CLAIM_UPDATE_EMAIL_TYPE, PROTECTION_CLAIM_UPDATE_TEMPLATE.subject, PROTECTION_CLAIM_UPDATE_TEMPLATE.body]);
  await query(`INSERT INTO support_email_template_presets(email_type,preset_name,subject_template,body_template) VALUES($1,'申请更新通知（物流保障）',$2,$3) ON CONFLICT(email_type,preset_name) DO NOTHING`, [PROTECTION_CLAIM_UPDATE_EMAIL_TYPE, PROTECTION_CLAIM_UPDATE_TEMPLATE.subject, PROTECTION_CLAIM_UPDATE_TEMPLATE.body]);
}

/** The caller must use the SAME transaction as the successful claim status update. */
export async function enqueueProtectionClaimUpdate(client: Db, event: ProtectionClaimUpdateEvent): Promise<void> {
  if (event.previousStatus === event.status || !TARGET_STATUSES.includes(event.status)) return;
  if (!/^[1-9]\d*$/.test(event.claimId) || !Number.isSafeInteger(event.revision) || event.revision < 2) throw new Error('Invalid protection notification event');
  const rawRecipient = (await client.query(`SELECT o.customer_email FROM support_protection_claims c
    JOIN support_protection_orders o ON o.id=c.protection_order_id WHERE c.id=$1 AND c.revision=$2 AND c.status=$3`,
    [event.claimId,event.revision,event.status])).rows[0]?.customer_email;
  let recipient:string;try{recipient=normalizePreferenceEmail(rawRecipient);}catch{return;}
  if (await isEmailUnsubscribed(recipient,'protection',client)) return;
  await client.query(`INSERT INTO support_protection_notification_outbox(event_key,claim_id,protection_order_id,revision,target_status,recipient_email,context_json,message_id)
    SELECT $4,c.id,o.id,$2,$3,lower(trim(o.customer_email)),jsonb_build_object('store_name',o.store_name,'order_number',o.order_number,'customer_name',o.customer_name,'claim_no',c.public_no,'protection_no',o.public_no),$5
    FROM support_protection_claims c JOIN support_protection_orders o ON o.id=c.protection_order_id
    WHERE c.id=$1 AND c.revision=$2 AND c.status=$3
    ON CONFLICT(claim_id,revision) DO NOTHING`, [event.claimId, event.revision, event.status, `protection_claim_update:${event.claimId}:${event.revision}`, `<protection-claim-${event.claimId}-${event.revision}@us-seel.com>`]);
}

async function prepareMail(client: PoolClient, job: any, leaseToken: string): Promise<SupportMail | null> {
  await client.query('BEGIN');
  try {
    // Match the claim writer's lock order: order first, then its outbox row.
    const order = (await client.query('SELECT customer_email FROM support_protection_orders WHERE id=$1 FOR UPDATE', [job.protection_order_id])).rows[0];
    const current = (await client.query("SELECT * FROM support_protection_notification_outbox WHERE id=$1 AND status='sending' AND lease_token=$2 FOR UPDATE", [job.id, leaseToken])).rows[0];
    if (!current) { await client.query('COMMIT'); return null; }
    if (!order || String(order.customer_email).trim().toLowerCase() !== job.recipient_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.recipient_email)) {
      await client.query("UPDATE support_protection_notification_outbox SET status='cancelled',last_error='recipient_changed_or_invalid',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [job.id]);
      await client.query('COMMIT'); return null;
    }
    if (await isEmailUnsubscribed(job.recipient_email,'protection',client)) {
      await client.query("UPDATE support_protection_notification_outbox SET status='cancelled',last_error='email_unsubscribed:protection',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id]);
      await client.query('COMMIT'); return null;
    }
    let subject = current.subject_snapshot, html = current.body_snapshot;
    const validToken = current.access_token_hash ? (await client.query("SELECT 1 FROM support_protection_access_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()+interval '1 day'", [current.access_token_hash])).rowCount : 0;
    if (!subject || !html || !validToken) {
      const token = `pa_${crypto.randomBytes(32).toString('base64url')}`;
      const tokenHash = digest(token);
      const link = `${protectionPublicBaseUrl()}/protection#access=${token}`;
      const rendered = await renderEmailFromTemplate(PROTECTION_CLAIM_UPDATE_EMAIL_TYPE, { ...current.context_json, customer_name: current.context_json.customer_name?.trim() || 'Customer', protection_link: link });
      subject = rendered.subject; html = rendered.html;
      if (!subject.trim() || !html.includes(link)) throw new Error('Protection notification template must contain its secure link');
      const tokenRow = (await client.query(`INSERT INTO support_protection_access_tokens(token_hash,protection_order_id,customer_email,expires_at) VALUES($1,$2,$3,now()+make_interval(days=>$4::int)) RETURNING expires_at`, [tokenHash, job.protection_order_id, job.recipient_email,PROTECTION_ACCESS_LINK_DAYS])).rows[0];
      await client.query(`UPDATE support_protection_notification_outbox SET subject_snapshot=$2,body_snapshot=$3,access_token_hash=$4,token_expires_at=$5,updated_at=now() WHERE id=$1`, [job.id, subject, html, tokenHash, tokenRow.expires_at]);
    }
    const mail = await decorateEmailWithUnsubscribe({to:job.recipient_email,subject,html,text:emailHtmlToText(html),messageId:job.message_id},'protection',protectionPublicBaseUrl(),client);
    if (mail.html!==html) await client.query('UPDATE support_protection_notification_outbox SET body_snapshot=$2,updated_at=now() WHERE id=$1',[job.id,mail.html]);
    await client.query('COMMIT');
    return mail;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

/** Separate from ticket mail settings/jobs. The default delivery mode is disabled. */
export async function processProtectionNotifications(options: { limit?: number; delivery?: ProtectionNotificationDelivery } = {}): Promise<{ picked: number; sent: number; failed: number; cancelled: number; disabled: boolean }> {
  const delivery = options.delivery || { ready: protectionMailReadiness().ready, send: sendProtectionNotificationEmail };
  const result = { picked: 0, sent: 0, failed: 0, cancelled: 0, disabled: !delivery.ready };
  if (!delivery.ready) return result;
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit || 10)));
  const candidates = await query(`SELECT id FROM support_protection_notification_outbox WHERE (status='pending' AND next_attempt_at<=now()) OR (status='sending' AND lease_until<now()) ORDER BY next_attempt_at,id LIMIT $1`, [limit]);
  for (const candidate of candidates.rows) {
    const client = await getClient(); const leaseToken = crypto.randomUUID(); let locked = false, accepted = false;
    try {
      // A session advisory lock also prevents an active slow worker from being
      // duplicated when its durable lease timestamp has elapsed.
      locked = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('protection-notification:' || $1::text,0)) AS locked", [String(candidate.id)])).rows[0].locked;
      if (!locked) continue;
      const job = (await client.query(`UPDATE support_protection_notification_outbox SET status='sending',lease_token=$2,lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now()
        WHERE id=$1 AND ((status='pending' AND next_attempt_at<=now()) OR (status='sending' AND lease_until<now())) RETURNING *`, [candidate.id, leaseToken])).rows[0];
      if (!job) continue;
      result.picked++;
      const mail = await prepareMail(client, job, leaseToken);
      if (!mail) { result.cancelled++; continue; }
      const guarded = await withEmailPreferenceGuard(job.recipient_email,'protection',async()=>{
        // Recheck identity after any wait for the recipient/category lock too.
        const identity = await client.query('SELECT 1 FROM support_protection_orders WHERE id=$1 AND lower(trim(customer_email))=$2', [job.protection_order_id, job.recipient_email]);
        if (!identity.rowCount) return null;
        const receipt = await delivery.send(mail); accepted = true; return receipt;
      });
      if (guarded.suppressed || !guarded.value) {
        await client.query("UPDATE support_protection_notification_outbox SET status='cancelled',last_error=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[job.id,leaseToken,guarded.suppressed?'email_unsubscribed:protection':'recipient_changed']);
        result.cancelled++; continue;
      }
      await client.query("UPDATE support_protection_notification_outbox SET status='sent',sent_at=now(),provider_message_id=$3,last_error=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2", [job.id, leaseToken, guarded.value.messageId]);
      result.sent++;
    } catch {
      result.failed++;
      // Do not requeue a known-accepted message because later bookkeeping failed.
      // SMTP cannot atomically commit with PostgreSQL; a process crash at that
      // boundary remains at-least-once, with the same Message-ID on recovery.
      if (!accepted) await client.query(`UPDATE support_protection_notification_outbox SET status='pending',next_attempt_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,7)))::int),last_error='delivery_or_preparation_failed',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`, [candidate.id, leaseToken]);
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('protection-notification:' || $1::text,0))", [String(candidate.id)]).catch(() => {});
      client.release();
    }
  }
  return result;
}
