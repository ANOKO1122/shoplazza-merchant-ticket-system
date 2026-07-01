import crypto from 'crypto';
import { loadConfig, buildStoreDomain } from './config';
import { query } from './pg';
import { sendSupportEmail } from './mailer';
import { createBootstrapToken, createTicketAccessToken, hashToken } from './token';
import { logOperation } from './log-service';

export type EmailJobStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'skipped';
export type EmailType = 'paid_support_invite' | 'agent_reply_notice' | 'ticket_closed_notice' | 'customer_complaint_invite';

const AUTO_SEND_TYPES: EmailType[] = ['paid_support_invite'];

/** 格式化为美国东部时间 (America/New_York) */
export function formatEasternTime(date: string | Date | null | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export async function getAutoSendEnabled(): Promise<boolean> {
  const r = await query(`SELECT auto_send_enabled FROM support_email_settings WHERE id = 1`);
  return r.rows[0]?.auto_send_enabled ?? false;
}

export async function setAutoSendEnabled(enabled: boolean): Promise<void> {
  await query(
    `UPDATE support_email_settings SET auto_send_enabled = $1, updated_at = now() WHERE id = 1`,
    [enabled],
  );
}

// ── 系统设置（运行时覆盖 .env）──

export async function getSystemSetting(key: string): Promise<string | null> {
  const r = await query(`SELECT value FROM support_system_settings WHERE key = $1`, [key]);
  return r.rows[0]?.value ?? null;
}

export async function setSystemSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO support_system_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, value],
  );
}

export async function getMailTestMode(): Promise<boolean> {
  const v = await getSystemSetting('mail_test_mode');
  return v === 'true';
}

export async function setMailTestMode(enabled: boolean): Promise<void> {
  await setSystemSetting('mail_test_mode', enabled ? 'true' : 'false');
}

export async function getPublicBaseUrl(): Promise<string | null> {
  return getSystemSetting('public_base_url');
}

export async function setPublicBaseUrl(url: string): Promise<void> {
  await setSystemSetting('public_base_url', url);
}

/** 获取生效的公网域名：优先 DB 设置，否则回退到 .env */
export async function getEffectivePublicBaseUrl(): Promise<string> {
  const dbOverride = await getPublicBaseUrl().catch(() => null);
  if (dbOverride && dbOverride.trim()) return dbOverride.trim().replace(/\/$/, '');
  const config = loadConfig();
  return config.publicBaseUrl;
}

export interface PaidSupportInviteSnapshot {
  storeSubdomain: string;
  storeName?: string | null;
  storeDomain?: string | null;
  orderId: string;
  orderNumber?: string | null;
  orderedAt?: string | Date | null;
  customerEmail: string;
  customerName?: string | null;
  paymentMethod?: string | null;
  cardLast4?: string | null;
  orderAmount?: string | null;
  orderCurrency?: string | null;
  jobSource?: string | null;  // 'webhook' | 'backfill'
}

export interface AgentReplyNoticeSnapshot extends PaidSupportInviteSnapshot {
  publicTicketNo: string;
}

export function buildEmailJobNo(now = new Date(), originalNo?: string, seq?: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = String(now.getFullYear()).slice(-2);
  const stamp = `${y}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const base = `EJ${stamp}${crypto.randomBytes(2).toString('hex')}`;
  if (originalNo && seq !== undefined) {
    return `${originalNo}-${seq}`;
  }
  return base;
}

export function buildPaidSupportInviteEventKey(params: {
  storeSubdomain: string;
  orderId: string;
  customerEmail: string;
}): string {
  return `paid_support_invite:${params.storeSubdomain}:${params.orderId}:${params.customerEmail.trim().toLowerCase()}`;
}

export function maskClientLink(link: string): string {
  return link.replace(/([?&]t=)([^&]+)/, (_m, prefix: string, token: string) => {
    if (token.length <= 12) return `${prefix}${token.slice(0, 4)}...`;
    return `${prefix}${token.slice(0, 7)}...${token.slice(-4)}`;
  });
}

export function renderPaidSupportInviteEmail(params: {
  storeName?: string | null;
  orderNumber?: string | null;
  clientLink: string;
}) {
  const storeName = params.storeName || 'Support';
  const orderNumber = params.orderNumber || 'your order';
  const maskedLink = maskClientLink(params.clientLink);
  const subject = `${storeName} support link for order ${orderNumber}`;
  const text = [
    `Your order ${orderNumber} is ready for support.`,
    'Open this secure link if you need help with the order:',
    params.clientLink,
  ].join('\n\n');
  const html = [
    `<p>Your order <strong>${escapeHtml(orderNumber)}</strong> is ready for support.</p>`,
    '<p>Open this secure link if you need help with the order:</p>',
    `<p><a href="${escapeHtml(params.clientLink)}">${escapeHtml(params.clientLink)}</a></p>`,
  ].join('');
  const snapshotBody = text.replace(params.clientLink, maskedLink);
  return { subject, text, html, snapshotBody, maskedLink };
}

export function renderAgentReplyNoticeEmail(params: {
  storeName?: string | null;
  orderNumber?: string | null;
  publicTicketNo: string;
  clientLink: string;
}) {
  const storeName = params.storeName || 'Support';
  const orderNumber = params.orderNumber || 'your order';
  const maskedLink = maskClientLink(params.clientLink);
  const subject = `${storeName} replied to dispute ${params.publicTicketNo}`;
  const text = [
    `Support has replied to dispute ${params.publicTicketNo} for order ${orderNumber}.`,
    'Open this secure link to view the reply:',
    params.clientLink,
  ].join('\n\n');
  const html = [
    `<p>Support has replied to dispute <strong>${escapeHtml(params.publicTicketNo)}</strong> for order <strong>${escapeHtml(orderNumber)}</strong>.</p>`,
    '<p>Open this secure link to view the reply:</p>',
    `<p><a href="${escapeHtml(params.clientLink)}">${escapeHtml(params.clientLink)}</a></p>`,
  ].join('');
  const snapshotBody = text.replace(params.clientLink, maskedLink);
  return { subject, text, html, snapshotBody, maskedLink };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getMailDomain(): string {
  const from = process.env.SUPPORT_MAIL_FROM || '';
  const match = from.match(/@([^>\s]+)/);
  return match ? match[1].trim() : '';
}

export async function createPaidSupportInviteEmailJob(params: PaidSupportInviteSnapshot): Promise<{ job: any; inserted: boolean }> {
  const eventKey = buildPaidSupportInviteEventKey({
    storeSubdomain: params.storeSubdomain,
    orderId: params.orderId,
    customerEmail: params.customerEmail,
  });

  // 先生成 token 和快照
  const publicBaseUrl = await getEffectivePublicBaseUrl();
  const token = await createBootstrapToken({
    storeSubdomain: params.storeSubdomain,
    orderId: params.orderId,
    customerEmail: params.customerEmail,
  });
  const clientLink = `${publicBaseUrl}/ticket?t=${token}`;
  const rendered = await renderEmailFromTemplate('paid_support_invite', {
    store_name: params.storeName || '',
    store_domain: params.storeDomain || buildStoreDomain(params.storeSubdomain),
    order_id: params.orderId,
    order_number: params.orderNumber || params.orderId,
    customer_name: params.customerName || '',
    customer_email: params.customerEmail.trim().toLowerCase(),
    public_ticket_no: '',
    client_link: clientLink,
    paid_at: formatEasternTime(params.orderedAt),
    payment_method: params.paymentMethod || '',
    card_last4: params.cardLast4 || '',
    order_amount: params.orderAmount || '',
    order_currency: params.orderCurrency || '',
  });
  const maskedLink = maskClientLink(clientLink);
  // body_snapshot 存完整 HTML（含真实链接），发送时直接使用
  // client_link_snapshot 存脱敏链接，仅用于后台展示
  const snapshotBody = rendered.html;
  const tokenR = await query(`SELECT id FROM support_access_tokens WHERE token_hash = $1`, [hashToken(token)]);
  const tokenId = tokenR.rows[0] ? Number(tokenR.rows[0].id) : null;

  const result = await query(
    `INSERT INTO support_email_jobs
      (email_job_no, event_key, store_subdomain, store_name, store_domain, mail_domain,
       order_id, order_number, ordered_at, email_type, customer_email, status, scheduled_at,
       token_id, subject_snapshot, body_snapshot, client_link_snapshot, raw_client_link, job_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'paid_support_invite',$10,'pending',now(),$11,$12,$13,$14,$15,$16)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING *`,
    [
      buildEmailJobNo(),
      eventKey,
      params.storeSubdomain,
      params.storeName || null,
      params.storeDomain || buildStoreDomain(params.storeSubdomain),
      getMailDomain() || null,
      params.orderId,
      params.orderNumber || null,
      params.orderedAt || null,
      params.customerEmail.trim().toLowerCase(),
      tokenId,
      rendered.subject,
      snapshotBody,
      maskedLink,
      clientLink,  // raw_client_link
      params.jobSource || null,  // job_source
    ],
  );
  if ((result.rowCount || 0) > 0) return { job: result.rows[0], inserted: true };

  const existing = await query(`SELECT * FROM support_email_jobs WHERE event_key = $1`, [eventKey]);
  return { job: existing.rows[0], inserted: false };
}

export async function createAgentReplyNoticeEmailJob(params: AgentReplyNoticeSnapshot) {
  const config = loadConfig();

  // ── 令牌复用：查找该工单上一次回复通知的有效链接 ──
  let clientLink = '';
  let tokenId: number | null = null;

  const lastJob = await query(
    `SELECT ej.raw_client_link, ej.token_id, at.revoked_at, at.expires_at
     FROM support_email_jobs ej
     LEFT JOIN support_access_tokens at ON at.id = ej.token_id
     WHERE ej.public_ticket_no = $1
       AND ej.email_type = 'agent_reply_notice'
       AND ej.status = 'sent'
       AND ej.raw_client_link IS NOT NULL
     ORDER BY ej.sent_at DESC
     LIMIT 1`,
    [params.publicTicketNo],
  );

  if (lastJob.rows[0]) {
    const prev = lastJob.rows[0];
    const revoked = prev.revoked_at;
    const expired = prev.expires_at ? new Date(prev.expires_at) < new Date() : false;
    if (!revoked && !expired && prev.raw_client_link) {
      // 复用上次的有效链接
      clientLink = prev.raw_client_link;
      tokenId = prev.token_id ? Number(prev.token_id) : null;
    }
  }

  // 没有可复用的链接，生成新令牌
  if (!clientLink) {
    const publicBaseUrl = await getEffectivePublicBaseUrl();
    const token = await createTicketAccessToken({
      publicTicketNo: params.publicTicketNo,
      customerEmail: params.customerEmail,
    });
    clientLink = `${publicBaseUrl}/ticket?t=${token}`;
    const tokenR = await query(`SELECT id FROM support_access_tokens WHERE token_hash = $1`, [hashToken(token)]);
    tokenId = tokenR.rows[0] ? Number(tokenR.rows[0].id) : null;
  }

  const rendered = await renderEmailFromTemplate('agent_reply_notice', {
    store_name: params.storeName || '',
    store_domain: params.storeDomain || buildStoreDomain(params.storeSubdomain),
    order_id: params.orderId,
    order_number: params.orderNumber || params.orderId,
    customer_name: '',
    customer_email: params.customerEmail.trim().toLowerCase(),
    public_ticket_no: params.publicTicketNo,
    client_link: clientLink,
    paid_at: formatEasternTime(params.orderedAt),
    payment_method: '',
    card_last4: '',
    order_amount: params.orderAmount || '',
    order_currency: params.orderCurrency || '',
  });
  const maskedLink = maskClientLink(clientLink);
  const snapshotBody = rendered.html;

  const result = await query(
    `INSERT INTO support_email_jobs
      (email_job_no, event_key, store_subdomain, store_name, store_domain, mail_domain,
       order_id, order_number, ordered_at, public_ticket_no, email_type, customer_email,
       status, scheduled_at, token_id, subject_snapshot, body_snapshot, client_link_snapshot, raw_client_link)
     VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,'agent_reply_notice',$10,'pending',now(),$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      buildEmailJobNo(),
      params.storeSubdomain,
      params.storeName || null,
      params.storeDomain || buildStoreDomain(params.storeSubdomain),
      getMailDomain() || null,
      params.orderId,
      params.orderNumber || null,
      params.orderedAt || null,
      params.publicTicketNo,
      params.customerEmail.trim().toLowerCase(),
      tokenId,
      rendered.subject,
      snapshotBody,
      maskedLink,
      clientLink,  // raw_client_link — 原始链接（用于后续复用）
    ],
  );
  return result.rows[0];
}

export async function ensureAgentReplyNoticeJob(params: AgentReplyNoticeSnapshot): Promise<{ job: any; created: boolean }> {
  const existing = await query(
    `SELECT id FROM support_email_jobs
     WHERE public_ticket_no = $1 AND email_type = 'agent_reply_notice' AND status = 'pending'
     LIMIT 1`,
    [params.publicTicketNo],
  );
  if (existing.rows.length > 0) {
    return { job: existing.rows[0], created: false };
  }
  const job = await createAgentReplyNoticeEmailJob(params);
  return { job, created: true };
}

// ── 手动发起新工单邀请 ──

/**
 * 从订单 items_json 中提取第一件商品的图片 URL。
 * Shoplazza line_items 的 image 字段可能为：
 *   - 完整 URL: https://img.shoplazza.com/xxx.jpg
 *   - 协议相对 URL: //img.shoplazza.com/xxx.jpg
 * 统一补全为 https:// 前缀。
 */
export function extractFirstProductImage(itemsJson: unknown[]): string {
  if (!Array.isArray(itemsJson) || itemsJson.length === 0) return '';
  const first = itemsJson[0] as Record<string, unknown> | undefined;
  if (!first) return '';
  const src = String(first.image || first.product_image || first.image_src || '');
  if (!src) return '';
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('http')) return src;
  return '';
}

export interface CustomerComplaintInviteSnapshot {
  storeSubdomain: string;
  storeName?: string | null;
  storeDomain?: string | null;
  orderId: string;
  orderNumber?: string | null;
  orderedAt?: string | Date | null;
  customerEmail: string;
  customerName?: string | null;
  paymentMethod?: string | null;
  cardLast4?: string | null;
  orderAmount?: string | null;
  orderCurrency?: string | null;
  itemsJson?: unknown[];        // 用于提取商品图片
}

export async function createCustomerComplaintInviteJob(
  params: CustomerComplaintInviteSnapshot,
): Promise<{ job: any }> {
  const publicBaseUrl = await getEffectivePublicBaseUrl();
  const token = await createBootstrapToken({
    storeSubdomain: params.storeSubdomain,
    orderId: params.orderId,
    customerEmail: params.customerEmail,
    forceNewTicket: true,  // ★ 关键：标记为强制新建工单
  });
  const clientLink = `${publicBaseUrl}/ticket?t=${token}`;

  const productImage = extractFirstProductImage(params.itemsJson || []);

  const rendered = await renderEmailFromTemplate('customer_complaint_invite', {
    store_name: params.storeName || '',
    store_domain: params.storeDomain || buildStoreDomain(params.storeSubdomain),
    order_id: params.orderId,
    order_number: params.orderNumber || params.orderId,
    customer_name: params.customerName || '',
    customer_email: params.customerEmail.trim().toLowerCase(),
    public_ticket_no: '',     // 新工单尚无 ticket_no
    client_link: clientLink,
    paid_at: formatEasternTime(params.orderedAt),
    payment_method: params.paymentMethod || '',
    card_last4: params.cardLast4 || '',
    order_amount: params.orderAmount || '',
    order_currency: params.orderCurrency || '',
    product_image: productImage,  // ★ 新增变量
  });

  const maskedLink = maskClientLink(clientLink);
  const snapshotBody = rendered.html;
  const tokenR = await query(
    `SELECT id FROM support_access_tokens WHERE token_hash = $1`, [hashToken(token)],
  );
  const tokenId = tokenR.rows[0] ? Number(tokenR.rows[0].id) : null;

  const result = await query(
    `INSERT INTO support_email_jobs
      (email_job_no, store_subdomain, store_name, store_domain, mail_domain,
       order_id, order_number, ordered_at, email_type, customer_email, status, scheduled_at,
       token_id, subject_snapshot, body_snapshot, client_link_snapshot, raw_client_link, job_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'customer_complaint_invite',$9,'pending',now(),$10,$11,$12,$13,$14,'manual_invite')
     RETURNING *`,
    [
      buildEmailJobNo(),
      params.storeSubdomain,
      params.storeName || null,
      params.storeDomain || buildStoreDomain(params.storeSubdomain),
      getMailDomain() || null,
      params.orderId,
      params.orderNumber || null,
      params.orderedAt || null,
      params.customerEmail.trim().toLowerCase(),
      tokenId,
      rendered.subject,
      snapshotBody,
      maskedLink,
      clientLink,
    ],
  );
  return { job: result.rows[0] };
}

export async function listEmailJobs(params: {
  status?: string;
  emailType?: string;
  storeSubdomain?: string;
  q?: string;
  page: number;
  pageSize: number;
}) {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.status && params.status !== 'all') {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.emailType && params.emailType !== 'all') {
    conditions.push(`email_type = $${idx++}`);
    values.push(params.emailType);
  }
  if (params.storeSubdomain) {
    conditions.push(`store_subdomain = $${idx++}`);
    values.push(params.storeSubdomain);
  }
  if (params.q) {
    const q = `%${params.q}%`;
    conditions.push(`(email_job_no ILIKE $${idx} OR order_id ILIKE $${idx + 1} OR order_number ILIKE $${idx + 2} OR customer_email ILIKE $${idx + 3})`);
    values.push(q, q, q, q);
    idx += 4;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const countR = await query(`SELECT COUNT(*) FROM support_email_jobs ${where}`, values);
  const total = Number(countR.rows[0].count);
  const offset = (params.page - 1) * params.pageSize;
  const rows = await query(
    `SELECT id, email_job_no, store_subdomain, store_name, store_domain, mail_domain,
            order_id, order_number, ordered_at, public_ticket_no, email_type, customer_email,
            status, scheduled_at, sent_at, failed_at, retry_count, last_error,
            client_link_snapshot, job_source, created_at, updated_at
     FROM support_email_jobs ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, params.pageSize, offset],
  );
  return { total, jobs: rows.rows };
}

export async function getEmailJobDetail(id: number) {
  const jobR = await query(`SELECT * FROM support_email_jobs WHERE id = $1`, [id]);
  const job = jobR.rows[0] || null;
  if (!job) return null;

  // 关联查询订单快照，补充顾客名/支付方式/卡号信息
  let orderSnapshot: any = null;
  if (job.store_subdomain && job.order_id) {
    const snapR = await query(
      `SELECT customer_name, payment_method, card_last4, paid_at, order_amount, order_currency
       FROM support_order_snapshots
       WHERE store_subdomain = $1 AND order_id = $2 AND customer_email = $3
       ORDER BY updated_at DESC LIMIT 1`,
      [job.store_subdomain, job.order_id, job.customer_email],
    );
    orderSnapshot = snapR.rows[0] || null;
  }

  // 补发历史已废弃（补发改为 UPDATE 原任务，不再创建子任务）
  return { job, orderSnapshot, resends: [] };
}

export async function cancelEmailJob(id: number): Promise<boolean> {
  const r = await query(
    `UPDATE support_email_jobs
     SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'failed')`,
    [id],
  );
  return (r.rowCount || 0) > 0;
}

export async function resendEmailJob(id: number) {
  const originalR = await query(`SELECT * FROM support_email_jobs WHERE id = $1`, [id]);
  const original = originalR.rows[0];
  if (!original) return null;

  // sent/sending 状态不应重发（已成功或正在发送中）
  if (original.status === 'sent' || original.status === 'sending') return null;

  if (original.status === 'pending') {
    // 待发送 → 立即发送（不重置状态，直接触发）
    await processDueEmailJobs({ limit: 1, onlyJobId: id });
    const detail = await getEmailJobDetail(id);
    return detail?.job || original;
  }

  // failed / cancelled / skipped → 重置为 pending 后立即发送
  const updated = await query(
    `UPDATE support_email_jobs
     SET status = 'pending',
         scheduled_at = now(),
         retry_count = retry_count + 1,
         last_error = NULL,
         failed_at = NULL,
         sent_at = NULL,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id],
  );
  if (!updated.rows[0]) return null;

  await processDueEmailJobs({ limit: 1, onlyJobId: id });
  const detail = await getEmailJobDetail(id);
  return detail?.job || updated.rows[0];
}

/** 重新生成客户链接（使旧 token 失效，生成新的） */

export async function processDueEmailJobs(params: { limit?: number; onlyJobId?: number } = {}) {
  const values: (number | string)[] = [];
  let where = `status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= now())`;
  if (params.onlyJobId) {
    values.push(params.onlyJobId);
    where += ` AND id = $1`;
  } else {
    if (!await getAutoSendEnabled()) {
      return { picked: 0, sent: 0, failed: 0 };
    }
    const typeList = AUTO_SEND_TYPES.map((_, i) => `$${i + 1}`).join(',');
    where += ` AND email_type IN (${typeList})`;
    values.push(...AUTO_SEND_TYPES);
  }
  const limit = Math.max(1, Math.min(100, params.limit || 10));
  values.push(limit);
  const limitParam = `$${values.length}`;
  const jobs = await query(
    `SELECT id FROM support_email_jobs
     WHERE ${where}
     ORDER BY scheduled_at ASC NULLS FIRST, id ASC
     LIMIT ${limitParam}`,
    values,
  );

  let sent = 0;
  let failed = 0;
  for (const row of jobs.rows) {
    const ok = await sendEmailJob(Number(row.id));
    if (ok) sent += 1;
    else failed += 1;
  }
  return { picked: jobs.rows.length, sent, failed };
}

async function sendEmailJob(id: number): Promise<boolean> {
  const claim = await query(
    `UPDATE support_email_jobs
     SET status = 'sending', updated_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id],
  );
  const job = claim.rows[0];
  if (!job) return false;

  let subject = job.subject_snapshot || '';
  let snapshotBody = job.body_snapshot || '';
  let maskedLink = job.client_link_snapshot || '';
  let tokenId: number | null = job.token_id || null;
  let token = '';

  try {
    const config = loadConfig();
    let html = '';
    let text = '';

    // 如果已有快照 → 直接复用发送（不重新生成 token）
    if (subject && snapshotBody) {
      // body_snapshot 已是完整 HTML，直接作为邮件正文
      html = snapshotBody;
      text = snapshotBody.replace(/<[^>]+>/g, '');
    } else {
      // 无快照 → 生成新 token 并渲染（使用数据库模板）
      if (job.email_type === 'agent_reply_notice') {
        token = await createTicketAccessToken({
          publicTicketNo: job.public_ticket_no,
          customerEmail: job.customer_email,
        });
      } else {
        token = await createBootstrapToken({
          storeSubdomain: job.store_subdomain,
          orderId: job.order_id,
          customerEmail: job.customer_email,
          forceNewTicket: job.email_type === 'customer_complaint_invite',
        });
      }
      const tokenR = await query(`SELECT id FROM support_access_tokens WHERE token_hash = $1`, [hashToken(token)]);
      tokenId = tokenR.rows[0] ? Number(tokenR.rows[0].id) : null;

      const publicBaseUrl = await getEffectivePublicBaseUrl();
      const clientLink = `${publicBaseUrl}/ticket?t=${token}`;
      const rendered = await renderEmailFromTemplate(job.email_type, {
        store_name: job.store_name || '',
        store_domain: job.store_domain || '',
        order_id: job.order_id || '',
        order_number: job.order_number || job.order_id || '',
        customer_name: '',
        customer_email: job.customer_email,
        public_ticket_no: job.public_ticket_no || '',
        client_link: clientLink,
        paid_at: formatEasternTime(job.ordered_at),
        payment_method: '',
        card_last4: '',
        order_amount: '',
        order_currency: '',
      });
      subject = rendered.subject;
      html = rendered.html;
      text = html.replace(/<[^>]+>/g, '');
      maskedLink = maskClientLink(clientLink);
      snapshotBody = rendered.html;

      // 保存 raw_client_link 以便后续复用
      await query(
        `UPDATE support_email_jobs
         SET raw_client_link = $2 WHERE id = $1`,
        [id, clientLink],
      );
    }

    await query(
      `UPDATE support_email_jobs
       SET token_id = $2, subject_snapshot = $3, body_snapshot = $4,
           client_link_snapshot = $5, updated_at = now()
       WHERE id = $1`,
      [id, tokenId, subject, snapshotBody, maskedLink],
    );

    const mailResult = await sendSupportEmail({
      to: job.customer_email,
      subject,
      html,
      text,
    });

    await query(
      `UPDATE support_email_jobs
       SET status = 'sent', sent_at = now(), failed_at = NULL, last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [id],
    );

    await query(
      `INSERT INTO support_email_events
        (event_key, public_ticket_no, store_subdomain, store_name, order_id, order_number,
         customer_email, event_type, subject, sent_at, provider_message_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,'sent')
       ON CONFLICT (event_key) DO UPDATE SET
         sent_at = EXCLUDED.sent_at,
         provider_message_id = EXCLUDED.provider_message_id,
         status = 'sent',
         updated_at = now()`,
      [
        job.event_key || `email_job:${job.id}`,
        job.public_ticket_no,
        job.store_subdomain,
        job.store_name,
        job.order_id,
        job.order_number,
        job.customer_email,
        job.email_type,
        subject,
        mailResult.messageId,
      ],
    );
    await logOperation({
      category: 'email',
      action: 'job_sent',
      actor: 'system',
      storeSubdomain: job.store_subdomain,
      target: job.email_job_no,
      summary: `邮件发送成功: ${job.email_type} → ${job.customer_email}`,
      status: 'success',
      detailJson: {
        email_type: job.email_type,
        order_number: job.order_number,
        message_id: mailResult.messageId,
      },
    });
    return true;
  } catch (e: any) {
    await query(
      `UPDATE support_email_jobs
       SET status = 'failed', failed_at = now(), retry_count = retry_count + 1,
           last_error = $2,
           subject_snapshot = COALESCE($3, subject_snapshot),
           body_snapshot = COALESCE($4, body_snapshot),
           client_link_snapshot = COALESCE($5, client_link_snapshot),
           token_id = COALESCE($6, token_id),
           updated_at = now()
       WHERE id = $1`,
      [id, e.message || String(e), subject || null, snapshotBody || null, maskedLink || null, tokenId],
    );
    await logOperation({
      category: 'email',
      action: 'job_failed',
      actor: 'system',
      storeSubdomain: job.store_subdomain,
      target: job.email_job_no,
      summary: `邮件发送失败(重试${(job.retry_count || 0) + 1}): ${job.email_type} → ${job.customer_email}`,
      status: 'failed',
      failedAtStep: 'smtp_send',
      detailJson: {
        email_type: job.email_type,
        order_number: job.order_number,
        error: e.message || String(e),
        retry_count: (job.retry_count || 0) + 1,
      },
    });
    return false;
  }
}

// ── 邮件模板 ──

export interface EmailTemplate {
  email_type: string;
  subject_template: string;
  body_template: string;
  active_preset_name?: string | null;
  updated_at: string;
}

const DEFAULT_TEMPLATES: Record<string, { subject: string; body: string }> = {
  paid_support_invite: {
    subject: 'Order Notification',
    body: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;line-height:1.6">
        <p>Dear customer,</p>
        <p>You made a {{order_currency}} {{order_amount}} purchase on {{paid_at}}.</p>
        <p>Order number: <strong>{{order_number}}</strong></p>
        <p>Payment method: {{payment_method}}{{#card_last4}} (card ending in {{card_last4}}){{/card_last4}}</p>
        <p>If you have any questions about this order, please visit:</p>
        <p><a href="{{client_link}}" style="color:#1890ff">{{client_link}}</a></p>
        <p style="color:#8c8c8c;font-size:14px;margin-top:24px">Please do not reply directly to this email, it will be ignored.</p>
      </div>`,
  },
  agent_reply_notice: {
    subject: '{{store_name}} replied to your inquiry {{public_ticket_no}}',
    body: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;line-height:1.6">
  <p>Dear {{customer_name}},</p>
  <p>Our support team has replied to your inquiry <strong>{{public_ticket_no}}</strong> regarding order <strong>{{order_number}}</strong>.</p>
  <p>Please use the secure link below to view the reply:</p>
  <p><a href="{{client_link}}" style="color:#1890ff">{{client_link}}</a></p>
  <p style="color:#8c8c8c;font-size:14px;margin-top:24px">Please do not reply directly to this email, it will be ignored.</p>
</div>`,
  },
  ticket_closed_notice: {
    subject: '{{store_name}} - Your inquiry {{public_ticket_no}} has been closed',
    body: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
         <div style="background:#f7f9fc;padding:20px;border-radius:8px;text-align:center">
           <h2 style="color:#52c41a;margin:0">{{store_name}} Support</h2>
         </div>
         <div style="padding:20px 0">
           <p>Dear {{customer_name}},</p>
           <p>Your inquiry <strong>{{public_ticket_no}}</strong> regarding order <strong>{{order_number}}</strong> has been resolved and closed.</p>
           <p>If you need further assistance, please contact us again.</p>
           <p>Thank you for your patience!</p>
         </div>
         <div style="border-top:1px solid #e8e8e8;padding-top:16px;color:#8c8c8c;font-size:12px">
           <p>This is an automated message from {{store_name}} support system.</p>
         </div>
       </div>`,
  },
  customer_complaint_invite: {
    subject: '{{store_name}} - New complaint for order {{order_number}}',
    body: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;line-height:1.6">
    <p>Dear {{customer_name}},</p>
    <p>Regarding your order <strong>{{order_number}}</strong>, if you have any new issues, please click the link below to submit a complaint:</p>
    <p><a href="{{client_link}}" style="color:#1890ff">{{client_link}}</a></p>
    {{#product_image}}<p><img src="{{product_image}}" style="max-width:200px;border-radius:4px" /></p>{{/product_image}}
    <p style="color:#8c8c8c;font-size:14px;margin-top:24px">Please do not reply directly to this email, it will be ignored.</p>
  </div>`,
  },
};

export async function getEmailTemplate(emailType: string): Promise<EmailTemplate | null> {
  const r = await query(
    `SELECT email_type, subject_template, body_template, active_preset_name, updated_at FROM support_email_templates WHERE email_type = $1`,
    [emailType],
  );
  return r.rows[0] || null;
}

export async function listEmailTemplates(): Promise<EmailTemplate[]> {
  const r = await query(
    `SELECT email_type, subject_template, body_template, active_preset_name, updated_at FROM support_email_templates ORDER BY email_type`,
  );
  return r.rows;
}

export async function updateEmailTemplate(
  emailType: string,
  subjectTemplate: string,
  bodyTemplate: string,
  activePresetName?: string | null,
): Promise<EmailTemplate | null> {
  const r = await query(
    `INSERT INTO support_email_templates (email_type, subject_template, body_template, active_preset_name, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (email_type) DO UPDATE SET
       subject_template = $2,
       body_template = $3,
       active_preset_name = COALESCE($4, support_email_templates.active_preset_name),
       updated_at = now()
     RETURNING email_type, subject_template, body_template, active_preset_name, updated_at`,
    [emailType, subjectTemplate, bodyTemplate, activePresetName ?? null],
  );
  return r.rows[0] || null;
}

/**
 * 简单模板渲染：替换 {{variable}}，支持 {{#var}}...{{/var}} 条件块。
 */
export function renderTemplateString(
  template: string,
  variables: Record<string, string>,
): string {
  let result = template;

  // 处理条件块 {{#var}}...{{/var}}
  result = result.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, content: string) => {
    if (variables[key] && variables[key].trim()) {
      return content;
    }
    return '';
  });

  // 替换 {{variable}}
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => escapeHtml(value));
  }

  return result;
}

/**
 * 从数据库模板渲染邮件（如无自定义则用硬编码默认值）
 */
export async function renderEmailFromTemplate(
  emailType: string,
  variables: Record<string, string>,
): Promise<{ subject: string; html: string }> {
  const tpl = await getEmailTemplate(emailType);
  const subjectTpl = tpl?.subject_template || DEFAULT_TEMPLATES[emailType]?.subject || '';
  const bodyTpl = tpl?.body_template || DEFAULT_TEMPLATES[emailType]?.body || '';

  const subject = renderTemplateString(subjectTpl, variables);
  const html = renderTemplateString(bodyTpl, variables);

  return { subject, html };
}

// ── 模板预设（多套模板切换）──

export interface TemplatePreset {
  id: number;
  email_type: string;
  preset_name: string;
  subject_template: string;
  body_template: string;
  created_at: string;
}

export async function listTemplatePresets(emailType: string): Promise<TemplatePreset[]> {
  const r = await query(
    `SELECT id, email_type, preset_name, subject_template, body_template, created_at
     FROM support_email_template_presets
     WHERE email_type = $1
     ORDER BY created_at`,
    [emailType],
  );
  return r.rows;
}

export async function createTemplatePreset(
  emailType: string,
  presetName: string,
  subjectTemplate: string,
  bodyTemplate: string,
): Promise<TemplatePreset> {
  const r = await query(
    `INSERT INTO support_email_template_presets (email_type, preset_name, subject_template, body_template)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email_type, preset_name) DO UPDATE SET
       subject_template = EXCLUDED.subject_template,
       body_template = EXCLUDED.body_template
     RETURNING id, email_type, preset_name, subject_template, body_template, created_at`,
    [emailType, presetName, subjectTemplate, bodyTemplate],
  );
  return r.rows[0];
}

export async function deleteTemplatePreset(emailType: string, presetName: string): Promise<boolean> {
  const r = await query(
    `DELETE FROM support_email_template_presets WHERE email_type = $1 AND preset_name = $2`,
    [emailType, presetName],
  );
  return (r.rowCount ?? 0) > 0;
}

/** 将预设设为当前活跃模板（复制到 support_email_templates，并记录 active_preset_name） */
export async function activateTemplatePreset(emailType: string, presetName: string): Promise<boolean> {
  const p = await query(
    `SELECT subject_template, body_template FROM support_email_template_presets
     WHERE email_type = $1 AND preset_name = $2`,
    [emailType, presetName],
  );
  if (!p.rows[0]) return false;

  await query(
    `INSERT INTO support_email_templates (email_type, subject_template, body_template, active_preset_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email_type) DO UPDATE SET
       subject_template = EXCLUDED.subject_template,
       body_template = EXCLUDED.body_template,
       active_preset_name = EXCLUDED.active_preset_name,
       updated_at = now()`,
    [emailType, p.rows[0].subject_template, p.rows[0].body_template, presetName],
  );
  return true;
}
