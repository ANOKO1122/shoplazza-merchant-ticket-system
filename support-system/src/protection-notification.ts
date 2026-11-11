import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { getClient, query } from './pg';
import { renderEmailFromTemplate } from './email-service';
import { emailHtmlToText } from './email-text';
import type { SupportMail } from './mailer';
import { digest, PROTECTION_ACCESS_LINK_DAYS, protectionPublicBaseUrl } from './protection-customer-auth';
import { PROTECTION_CLAIM_UPDATE_EMAIL_TYPE, PROTECTION_CLAIM_UPDATE_TEMPLATE, PROTECTION_COMPLETION_EMAIL_TYPE, PROTECTION_COMPLETION_TEMPLATE, PROTECTION_SHIPMENT_EMAIL_TYPE, PROTECTION_SHIPMENT_TEMPLATE } from './protection-email-template';
import { PROTECTION_NOTIFICATION_SCHEMA_SQL } from './protection-notification-schema';
import { protectionMailReadiness, sendProtectionNotificationEmail } from './protection-notification-mailer';
import { decorateEmailWithUnsubscribe, isEmailUnsubscribed, normalizePreferenceEmail, withEmailPreferenceGuard } from './email-preferences';
import { isProtectionLifecycleNotificationCurrent } from './protection-lifecycle-notification';
import { ProtectionError } from './protection-domain';
import { extractStoreCustomDomain } from './email-service';

type Db = Pick<PoolClient, 'query'>;
export interface ProtectionClaimUpdateEvent { claimId: string; revision: number; previousStatus: string; status: string; }
export interface ProtectionNotificationDelivery { ready: boolean; send: (mail: SupportMail) => Promise<{ messageId: string }>; }
const TARGET_STATUSES = ['needs_info', 'approved', 'rejected', 'closed'];
// The original default templates were copied into editable database rows. Upgrade
// only those exact defaults; leave every staff-edited template and preset intact.
const LEGACY_DEFAULT_HASHES: Record<string, string[]> = {
  [PROTECTION_SHIPMENT_EMAIL_TYPE]: ['791c67a1d8f5d48ea03570c3e306212abf710c92449b997008143abc409b878a','1ea91f24ec224bdc6e510df7ffb466ee2ef028dc1e7611d27f9af5511d33ba3f'],
  [PROTECTION_COMPLETION_EMAIL_TYPE]: ['930c480bb98439bb6505e0ab754de331d79dc57823adf12342fdd181a449643e','7ebc97033f50684877a47241cac6d2cfb5cfd9ab8deec01271adbe3759e81427'],
  [PROTECTION_CLAIM_UPDATE_EMAIL_TYPE]: ['a5926a93aec93f1016d5b59531e85f3e46e14985b8cb8db4bafc6f08135de33b','e630ef7bb3255b1c586f6af056a76e27f16369c8e38acfa51cc84ccf3e0024a7'],
};
function isLegacyDefault(type: string, subject: string, body: string): boolean {
  return LEGACY_DEFAULT_HASHES[type]?.includes(crypto.createHash('sha256').update(`${subject}\0${body}`).digest('hex')) || false;
}
function customerFacingDomain(rawOrder: unknown): string {
  const value = extractStoreCustomDomain(rawOrder).trim().toLowerCase();
  return value.length <= 253 && /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) && value.includes('.') && !value.includes('..') ? value : '';
}

export async function initProtectionNotificationSchema(): Promise<void> {
  await query(PROTECTION_NOTIFICATION_SCHEMA_SQL);
  for (const [type, name, template] of [
    [PROTECTION_CLAIM_UPDATE_EMAIL_TYPE,'申请更新通知（物流保障）',PROTECTION_CLAIM_UPDATE_TEMPLATE],
    [PROTECTION_SHIPMENT_EMAIL_TYPE,'发货通知（物流保障）',PROTECTION_SHIPMENT_TEMPLATE],
    [PROTECTION_COMPLETION_EMAIL_TYPE,'完成模板（物流保障）',PROTECTION_COMPLETION_TEMPLATE],
  ] as const) {
    await query(`INSERT INTO support_email_templates(email_type,subject_template,body_template) VALUES($1,$2,$3) ON CONFLICT(email_type) DO NOTHING`, [type,template.subject,template.body]);
    await query(`INSERT INTO support_email_template_presets(email_type,preset_name,subject_template,body_template) VALUES($1,$2,$3,$4) ON CONFLICT(email_type,preset_name) DO NOTHING`, [type,name,template.subject,template.body]);
    for (const table of ['support_email_templates', 'support_email_template_presets'] as const) {
      const rows = await query(`SELECT subject_template,body_template FROM ${table} WHERE email_type=$1${table.endsWith('presets') ? ' AND preset_name=$2' : ''}`, table.endsWith('presets') ? [type,name] : [type]);
      const old = rows.rows[0];
      if (old && isLegacyDefault(type,old.subject_template,old.body_template)) {
        await query(`UPDATE ${table} SET subject_template=$2,body_template=$3 WHERE email_type=$1 AND subject_template=$4 AND body_template=$5${table.endsWith('presets') ? ' AND preset_name=$6' : ''}`, table.endsWith('presets') ? [type,template.subject,template.body,old.subject_template,old.body_template,name] : [type,template.subject,template.body,old.subject_template,old.body_template]);
      }
    }
  }
}

/** Only an explicit staff request may create a claim notification. */
export async function enqueueProtectionClaimUpdate(client: Db, event: ProtectionClaimUpdateEvent): Promise<void> {
  if (event.previousStatus === event.status || !TARGET_STATUSES.includes(event.status)) return;
  if (!/^[1-9]\d*$/.test(event.claimId) || !Number.isSafeInteger(event.revision) || event.revision < 2) throw new Error('Invalid protection notification event');
  const rawRecipient = (await client.query(`SELECT o.customer_email FROM support_protection_claims c
    JOIN support_protection_orders o ON o.id=c.protection_order_id WHERE c.id=$1 AND c.revision=$2 AND c.status=$3`,
    [event.claimId,event.revision,event.status])).rows[0]?.customer_email;
  let recipient:string;try{recipient=normalizePreferenceEmail(rawRecipient);}catch{return;}
  if (await isEmailUnsubscribed(recipient,'protection',client)) return;
  await client.query(`INSERT INTO support_protection_notification_outbox(event_key,claim_id,protection_order_id,revision,target_status,recipient_email,context_json,message_id,manual_requested_at)
    SELECT $4,c.id,o.id,$2,$3,lower(trim(o.customer_email)),jsonb_build_object('order_number',o.order_number,'customer_name',o.customer_name,'claim_no',c.public_no,'protection_no',o.public_no),$5,now()
    FROM support_protection_claims c JOIN support_protection_orders o ON o.id=c.protection_order_id
    WHERE c.id=$1 AND c.revision=$2 AND c.status=$3
    ON CONFLICT(claim_id,revision) DO NOTHING`, [event.claimId, event.revision, event.status, `protection_claim_update:${event.claimId}:${event.revision}`, `<protection-claim-${event.claimId}-${event.revision}@us-seel.com>`]);
}

export async function requestProtectionClaimUpdate(claimId: string, revision: number): Promise<{id:number;status:string}> {
  if (!/^[1-9]\d{0,18}$/.test(claimId)) throw new ProtectionError('无效的申请编号');
  if (!Number.isSafeInteger(revision) || revision < 2) throw new ProtectionError('请先保存申请更新');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const claim=(await client.query(`SELECT c.id,c.revision,c.status,o.customer_email
      FROM support_protection_claims c JOIN support_protection_orders o ON o.id=c.protection_order_id
      WHERE c.id=$1 FOR UPDATE OF c`,[claimId])).rows[0];
    if (!claim) throw new ProtectionError('申请不存在',404);
    if (claim.revision !== revision) throw new ProtectionError('申请已被更新，请刷新后再发送通知',409);
    if (!TARGET_STATUSES.includes(claim.status)) throw new ProtectionError('当前申请状态无需发送更新通知',409);
    let recipient:string;try{recipient=normalizePreferenceEmail(claim.customer_email);}catch{throw new ProtectionError('顾客邮箱无效，无法发送通知',409);}
    if (await isEmailUnsubscribed(recipient,'protection',client)) throw new ProtectionError('顾客已退订物流保障邮件，未发送通知',409);
    let job=(await client.query('SELECT id,status,manual_requested_at,last_error FROM support_protection_notification_outbox WHERE claim_id=$1 AND revision=$2',[claimId,revision])).rows[0];
    if (job?.status==='cancelled' && job.last_error==='manual_delivery_enabled') {
      job=(await client.query(`UPDATE support_protection_notification_outbox SET status='pending',manual_requested_at=now(),recipient_email=$3,
        attempts=0,next_attempt_at=now(),subject_snapshot=NULL,body_snapshot=NULL,access_token_hash=NULL,token_expires_at=NULL,
        last_error=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE claim_id=$1 AND revision=$2 RETURNING id,status`,[claimId,revision,recipient])).rows[0];
    } else if (job?.status==='pending' && !job.manual_requested_at) {
      job=(await client.query(`UPDATE support_protection_notification_outbox SET manual_requested_at=now(),updated_at=now()
        WHERE claim_id=$1 AND revision=$2 RETURNING id,status`,[claimId,revision])).rows[0];
    } else if (!job) {
      await enqueueProtectionClaimUpdate(client,{claimId,revision,previousStatus:'manual-request',status:claim.status});
      job=(await client.query('SELECT id,status FROM support_protection_notification_outbox WHERE claim_id=$1 AND revision=$2',[claimId,revision])).rows[0];
    }
    if (!job) throw new ProtectionError('未能创建通知，顾客邮箱可能已失效',409);
    if (job.status==='cancelled') throw new ProtectionError('这次通知已取消，请保存新更新后再发送',409);
    await client.query('COMMIT');
    return {id:Number(job.id),status:job.status};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function prepareMail(client: PoolClient, job: any, leaseToken: string): Promise<SupportMail | null> {
  await client.query('BEGIN');
  try {
    // Match the claim writer's lock order: order first, then its outbox row.
    const order = (await client.query('SELECT * FROM support_protection_orders WHERE id=$1 FOR UPDATE', [job.protection_order_id])).rows[0];
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
    if (!await isProtectionLifecycleNotificationCurrent(client,current,order)) {
      await client.query("UPDATE support_protection_notification_outbox SET status='cancelled',last_error='order_no_longer_eligible_for_event',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id]);
      await client.query('COMMIT'); return null;
    }
    let subject = current.subject_snapshot, html = current.body_snapshot;
    const validToken = current.access_token_hash ? (await client.query("SELECT 1 FROM support_protection_access_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()+interval '1 day'", [current.access_token_hash])).rowCount : 0;
    if (!subject || !html || !validToken) {
      const token = `pa_${crypto.randomBytes(32).toString('base64url')}`;
      const tokenHash = digest(token);
      const link = `${protectionPublicBaseUrl()}/protection#access=${token}`;
      const type = current.event_type === 'shipment' ? PROTECTION_SHIPMENT_EMAIL_TYPE : current.event_type === 'completion' ? PROTECTION_COMPLETION_EMAIL_TYPE : PROTECTION_CLAIM_UPDATE_EMAIL_TYPE;
      const snapshot = (await client.query('SELECT raw_order_json FROM support_order_snapshots WHERE id=$1 AND store_subdomain=$2', [order.source_snapshot_id,order.store_subdomain])).rows[0];
      const storeDomain = customerFacingDomain(snapshot?.raw_order_json);
      const rendered = await renderEmailFromTemplate(type, { ...current.context_json, store_domain: storeDomain, store_name: storeDomain || 'Shipping Protection', customer_name: current.context_json.customer_name?.trim() || 'Customer', protection_link: link });
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
export async function processProtectionNotifications(options: { limit?: number; onlyJobId?: number; delivery?: ProtectionNotificationDelivery } = {}): Promise<{ picked: number; sent: number; failed: number; cancelled: number; disabled: boolean }> {
  const delivery = options.delivery || { ready: protectionMailReadiness().ready, send: sendProtectionNotificationEmail };
  const result = { picked: 0, sent: 0, failed: 0, cancelled: 0, disabled: !delivery.ready };
  if (!delivery.ready) return result;
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit || 10)));
  const candidates = await query(`SELECT id FROM support_protection_notification_outbox
    WHERE ((status='pending' AND next_attempt_at<=now()) OR (status='sending' AND lease_until<now()))
      AND (event_type<>'claim_update' OR manual_requested_at IS NOT NULL)
      AND ($2::bigint IS NULL OR id=$2)
    ORDER BY next_attempt_at,id LIMIT $1`, [limit,options.onlyJobId ?? null]);
  for (const candidate of candidates.rows) {
    const client = await getClient(); const leaseToken = crypto.randomUUID(); let locked = false, accepted = false;
    try {
      // A session advisory lock also prevents an active slow worker from being
      // duplicated when its durable lease timestamp has elapsed.
      locked = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('protection-notification:' || $1::text,0)) AS locked", [String(candidate.id)])).rows[0].locked;
      if (!locked) continue;
      const job = (await client.query(`UPDATE support_protection_notification_outbox SET status='sending',lease_token=$2,lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now()
        WHERE id=$1 AND (event_type<>'claim_update' OR manual_requested_at IS NOT NULL)
          AND ((status='pending' AND next_attempt_at<=now()) OR (status='sending' AND lease_until<now())) RETURNING *`, [candidate.id, leaseToken])).rows[0];
      if (!job) continue;
      result.picked++;
      const mail = await prepareMail(client, job, leaseToken);
      if (!mail) { result.cancelled++; continue; }
      const guarded = await withEmailPreferenceGuard(job.recipient_email,'protection',async()=>{
        // Recheck identity after any wait for the recipient/category lock too.
        const identity = await client.query('SELECT * FROM support_protection_orders WHERE id=$1 AND lower(trim(customer_email))=$2', [job.protection_order_id, job.recipient_email]);
        if (!identity.rowCount) return null;
        if (!await isProtectionLifecycleNotificationCurrent(client,job,identity.rows[0])) return null;
        const receipt = await delivery.send(mail); accepted = true; return receipt;
      });
      if (guarded.suppressed || !guarded.value) {
        await client.query("UPDATE support_protection_notification_outbox SET status='cancelled',last_error=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[job.id,leaseToken,guarded.suppressed?'email_unsubscribed:protection':'recipient_or_order_changed']);
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
