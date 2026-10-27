import { Pool, PoolClient } from 'pg';
import { ORDER_ADDRESS_SCHEMA_SQL } from './order-address-schema';

let pool: Pool;
let webhookPool: Pool;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.SUPPORT_DATABASE_URL,
      max: Number(process.env.SUPPORT_PG_POOL_MAX) || 10,
    });
  }
  return pool;
}

export async function query(text: string, params?: unknown[]) {
  return getPool().query(text, params);
}

// Keep webhook receipt independent of long-running sync queries. Shoplazza needs
// an explicit response within five seconds; a stalled insert must fail promptly.
export async function queryWebhook(text: string, params?: unknown[]) {
  if (!webhookPool) {
    webhookPool = new Pool({
      connectionString: process.env.SUPPORT_DATABASE_URL,
      max: 4,
      connectionTimeoutMillis: 1000,
      statement_timeout: 1500,
      query_timeout: 2000,
      idleTimeoutMillis: 10000,
      allowExitOnIdle: true,
    });
  }
  return webhookPool.query(text, params);
}

export async function closeDatabasePools(): Promise<void> {
  await Promise.all([pool?.end(), webhookPool?.end()]);
}

export async function getClient(): Promise<PoolClient> {
  return getPool().connect();
}

export async function ensureTables(): Promise<void> {
  const p = getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS support_order_snapshots (
      id BIGSERIAL PRIMARY KEY,
      store_subdomain TEXT NOT NULL,
      store_name TEXT,
      order_id TEXT NOT NULL,
      order_number TEXT,
      customer_email TEXT NOT NULL,
      customer_name TEXT,
      order_status TEXT,
      fulfillment_status TEXT,
      order_amount TEXT,
      order_currency TEXT,
      payment_status TEXT,
      payment_method TEXT,
      paid_at TIMESTAMPTZ,
      refund_status TEXT,
      refund_amount TEXT,
      transaction_id_masked TEXT,
      card_last4 TEXT,
      items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      shipping_address_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      billing_address_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      logistics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      payment_detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_order_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      snapshot_source TEXT NOT NULL DEFAULT 'shoplazza_api',
      last_webhook_topic TEXT,
      last_webhook_received_at TIMESTAMPTZ,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(store_subdomain, order_id, customer_email)
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS support_email_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT UNIQUE NOT NULL,
      public_ticket_no TEXT,
      store_subdomain TEXT NOT NULL,
      store_name TEXT,
      order_id TEXT,
      order_number TEXT,
      customer_email TEXT NOT NULL,
      event_type TEXT NOT NULL,
      subject TEXT,
      sent_at TIMESTAMPTZ,
      provider_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS support_email_jobs (
      id BIGSERIAL PRIMARY KEY,
      email_job_no TEXT UNIQUE NOT NULL,
      event_key TEXT UNIQUE,
      store_subdomain TEXT NOT NULL,
      store_name TEXT,
      store_domain TEXT,
      mail_domain TEXT,
      order_id TEXT NOT NULL,
      order_number TEXT,
      ordered_at TIMESTAMPTZ,
      public_ticket_no TEXT,
      email_type TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      subject_snapshot TEXT,
      body_snapshot TEXT,
      client_link_snapshot TEXT,
      raw_client_link TEXT,
      token_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS support_email_templates (
      email_type TEXT PRIMARY KEY,
      subject_template TEXT NOT NULL,
      body_template TEXT NOT NULL,
      active_preset_name TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // 兼容已有表：添加 active_preset_name 列
  await p.query(`ALTER TABLE support_email_templates ADD COLUMN IF NOT EXISTS active_preset_name TEXT`);

  // 默认模板只在首次安装写入，重启不能覆盖管理员保存的正文和预设。
  await p.query(`
    INSERT INTO support_email_templates (email_type, subject_template, body_template)
    VALUES
      ('paid_support_invite',
       'Order Notification',
       '<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Transaction Notification</title></head>
<body style="margin:0;padding:0;background-color:#ffffff;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="border-collapse:collapse;width:100%">
<tr><td align="center" style="padding:32px 24px">
<table border="0" cellpadding="0" cellspacing="0" width="600" role="presentation" style="max-width:600px;width:100%;border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,segoe ui,Roboto,Helvetica,Arial,sans-serif;color:#333;line-height:1.6;text-align:left">
<tr><td style="padding-top:0;padding-bottom:8px;font-size:16px;color:#111">Dear {{customer_name}},</td></tr>
<tr><td style="font-size:14px;color:#555;padding-bottom:24px">This is an automated notification from our customer support center regarding your order at <strong style="color:#111">{{store_name}}</strong>.</td></tr>
<tr><td style="padding-bottom:28px">
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="background-color:#fcfcfc;border:1px solid #eaedf1;border-radius:8px;border-collapse:collapse;width:100%">
<tr><td style="padding:20px">
<div style="font-size:13px;color:#8c8c8c;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;font-weight:600">Transaction Details</div>
<p style="margin:0 0 8px;font-size:15px">You made a <strong style="font-size:18px;color:#111">{{order_currency}} {{order_amount}}</strong> purchase on <strong style="color:#111">{{paid_at}}</strong>.</p>
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="border-collapse:collapse;width:100%"><tr><td style="padding:12px 0;border-top:1px solid #eaedf1;height:0;line-height:0"></td></tr></table>
<p style="margin:0 0 6px;font-size:14px;color:#555">Order number: <strong style="color:#111">{{order_number}}</strong></p>
<p style="margin:0;font-size:14px;color:#555">Payment method: <strong style="color:#111">{{payment_method}}</strong>{{#card_last4}} (ending in <strong style="color:#111">{{card_last4}}</strong>){{/card_last4}}</p>
</td></tr></table></td></tr>
<tr><td style="padding-bottom:36px">
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="background-color:#f4f7f9;border-radius:8px;border-left:4px solid #1890ff;border-collapse:collapse;width:100%">
<tr><td style="padding:24px">
<p style="margin-top:0;margin-bottom:8px;font-size:15px;color:#111"><strong>Need assistance with this order?</strong></p>
<p style="margin-bottom:20px;font-size:13px;color:#666;line-height:1.5">If you have any questions, or need support, please click the button below to visit your dedicated support page:</p>
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="border-collapse:collapse;width:100%"><tr><td align="left"><a href="{{client_link}}" style="display:inline-block;padding:11px 24px;background-color:#1890ff;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;box-shadow:0 2px 4px rgba(24,144,255,0.15)">Contact Support</a></td></tr></table>
</td></tr></table></td></tr>
<tr><td style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:16px;line-height:1.6">This is a transactional notification regarding your recent purchase. Please do not reply directly to this email as this inbox is unmonitored. If you need further assistance or wish to manage your support tickets, please <a href="{{client_link}}" style="color:#1890ff;text-decoration:underline">click here to contact our support center</a>.</td></tr>
</table></td></tr></table>
</body></html>')
    ON CONFLICT (email_type) DO NOTHING
  `);

  await p.query(`
    INSERT INTO support_email_templates (email_type, subject_template, body_template)
    VALUES
      ('agent_reply_notice',
       '{{store_name}} replied to your inquiry {{public_ticket_no}}',
       '<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Support Ticket Update</title></head>
<body style="margin:0;padding:0;background-color:#ffffff;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="border-collapse:collapse;width:100%">
<tr><td align="center" style="padding:32px 24px">
<table border="0" cellpadding="0" cellspacing="0" width="600" role="presentation" style="max-width:600px;width:100%;border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,segoe ui,Roboto,Helvetica,Arial,sans-serif;color:#333;line-height:1.6;text-align:left">
<tr><td style="padding-top:0;padding-bottom:8px;font-size:16px;color:#111">Dear {{customer_name}},</td></tr>
<tr><td style="font-size:14px;color:#555;padding-bottom:24px">This is an update from our customer support center regarding your inquiry at <strong style="color:#111">{{store_name}}</strong>.</td></tr>
<tr><td style="padding-bottom:28px">
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="background-color:#fcfcfc;border:1px solid #eaedf1;border-radius:8px;border-collapse:collapse;width:100%">
<tr><td style="padding:20px">
<div style="font-size:13px;color:#8c8c8c;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;font-weight:600">Inquiry Information</div>
<p style="margin:0 0 8px;font-size:15px">Our support team has replied to your ticket: <strong style="color:#1890ff;font-size:16px">#{{public_ticket_no}}</strong></p>
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="border-collapse:collapse;width:100%"><tr><td style="padding:12px 0;border-top:1px solid #eaedf1;height:0;line-height:0"></td></tr></table>
<p style="margin:0;font-size:14px;color:#555">Related Order: <strong style="color:#111">{{order_number}}</strong></p>
</td></tr></table></td></tr>
<tr><td style="padding-bottom:36px">
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="background-color:#f4f7f9;border-radius:8px;border-left:4px solid #1890ff;border-collapse:collapse;width:100%">
<tr><td style="padding:24px">
<p style="margin-top:0;margin-bottom:8px;font-size:15px;color:#111"><strong>Please use the secure link below to view the reply:</strong></p>
<p style="margin-bottom:20px;font-size:13px;color:#666;line-height:1.5">To protect your privacy and security, click the button below to log in and access your dedicated message thread:</p>
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="border-collapse:collapse;width:100%"><tr><td align="left"><a href="{{client_link}}" style="display:inline-block;padding:11px 24px;background-color:#1890ff;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;box-shadow:0 2px 4px rgba(24,144,255,0.15)">View Reply &amp; Message History</a></td></tr></table>
</td></tr></table></td></tr>
<tr><td style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:16px;line-height:1.6">Please do not reply directly to this email. This inbox is unattended. If you need further assistance, please follow the link above to update your ticket.</td></tr>
</table></td></tr></table>
</body></html>')
    ON CONFLICT (email_type) DO NOTHING
  `);

  await p.query(`
    INSERT INTO support_email_templates (email_type, subject_template, body_template)
    VALUES
      ('ticket_closed_notice',
       '{{store_name}} - Your inquiry {{public_ticket_no}} has been closed',
       '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
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
       </div>')
    ON CONFLICT (email_type) DO NOTHING
  `);

  // 手动发起新工单邀请：顾客投诉工单模板（英文版，完整HTML邮件格式，含店铺蓝链+商品列表）
  await p.query(`
    INSERT INTO support_email_templates (email_type, subject_template, body_template)
    VALUES
      ('customer_complaint_invite',
       'After-Sales Assistance Notice – Order {{order_number}}',
       '<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>After-Sales Assistance Notice</title></head>
<body style="margin:0;padding:0;background-color:#ffffff;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="border-collapse:collapse;width:100%">
<tr><td align="center" style="padding:32px 24px">
<table border="0" cellpadding="0" cellspacing="0" width="600" role="presentation" style="max-width:600px;width:100%;border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,segoe ui,Roboto,Helvetica,Arial,sans-serif;color:#333;line-height:1.6;text-align:left">
<tr><td style="padding-top:0;padding-bottom:8px;font-size:16px;color:#111">Dear {{customer_name}},</td></tr>
<tr><td style="font-size:14px;color:#555;padding-bottom:24px">We noticed that there may be an after-sales issue with your order <strong style="color:#111">{{order_number}}</strong> at <a href="{{store_link}}" target="_blank" style="color:#1890ff;text-decoration:none;font-weight:600">{{store_name}}</a>. Your order details are provided below for reference.</td></tr>
<tr><td style="padding-bottom:28px">
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="background-color:#fcfcfc;border:1px solid #eaedf1;border-radius:8px;border-collapse:collapse;width:100%">
<tr><td style="padding:20px">
<div style="font-size:13px;color:#8c8c8c;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;font-weight:600">Order Details</div>
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
<tr><td style="padding:6px 0;color:#8c8c8c;width:140px;vertical-align:top">Order Number</td><td style="padding:6px 0;font-weight:600;color:#111">{{order_number}}</td></tr>
<tr><td style="padding:6px 0;color:#8c8c8c;vertical-align:top">Amount</td><td style="padding:6px 0;font-weight:600;color:#ff4d4f">{{order_currency}} {{order_amount}}</td></tr>
<tr><td style="padding:6px 0;color:#8c8c8c;vertical-align:top">Payment Date</td><td style="padding:6px 0;color:#111">{{paid_at}}</td></tr>
<tr><td style="padding:6px 0;color:#8c8c8c;vertical-align:top">Payment Method</td><td style="padding:6px 0;color:#111">{{payment_method}}{{#card_last4}} (ending in <strong style="color:#111">{{card_last4}}</strong>){{/card_last4}}</td></tr>
</table>
{{#has_items}}
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="border-collapse:collapse;width:100%"><tr><td style="padding:12px 0 0;border-top:1px solid #eaedf1;height:0;line-height:0"></td></tr></table>
<div style="font-size:13px;color:#8c8c8c;text-transform:uppercase;letter-spacing:0.5px;margin-top:12px;margin-bottom:8px;font-weight:600">Purchased Items</div>
{{#items}}
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="border-collapse:collapse;width:100%;margin-bottom:6px">
<tr>
{{#image_url}}<td width="72" style="width:72px;padding:0 12px 0 0;vertical-align:top"><img src="{{{image_url}}}" width="64" height="64" style="width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid #e8e8e8;display:block" alt=""></td>{{/image_url}}
<td style="vertical-align:middle;font-size:13px;line-height:1.5">
<div style="color:#262626;font-weight:500;margin-bottom:2px">{{product_title}}</div>
<div style="color:#8c8c8c;font-size:12px">Qty: {{quantity}}</div>
</td>
</tr>
</table>
{{/items}}
{{/has_items}}
</td></tr></table></td></tr>
<tr><td style="font-size:14px;color:#555;padding-bottom:16px">If the merchant has not properly resolved your issue, please click the <strong style="color:#1890ff">Contact Support</strong> button below to explain your situation in detail. We will actively assist you in communicating with the merchant and work to resolve the matter promptly, safeguarding your legitimate rights and interests.</td></tr>
<tr><td style="font-size:14px;color:#555;padding-bottom:28px">If you believe a seller has engaged in improper business practices such as fraud, refusal to honor after-sales obligations, or false advertising, you may also click the <strong style="color:#ff4d4f">Complain About Merchant</strong> button below to file a complaint with us. We will immediately launch an investigation and, based on the findings, take appropriate action against the seller in accordance with laws and regulations.</td></tr>
<tr><td style="padding-bottom:36px">
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="background-color:#f4f7f9;border-radius:8px;border-left:4px solid #1890ff;border-collapse:collapse;width:100%">
<tr><td style="padding:24px">
<p style="margin-top:0;margin-bottom:20px;font-size:15px;color:#111"><strong>Please choose an action below based on your current situation:</strong></p>
<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="border-collapse:collapse;width:100%">
<tr>
<td width="170" style="padding-right:12px;padding-bottom:12px;vertical-align:middle;width:170px"><a href="{{client_link}}" style="display:inline-block;background-color:#1890ff;color:#fff;text-decoration:none;padding:11px 24px;border-radius:6px;font-weight:600;font-size:14px;box-shadow:0 2px 4px rgba(24,144,255,0.15);white-space:nowrap">Contact Support</a></td>
<td style="padding-bottom:12px;vertical-align:middle"><a href="{{complaint_link}}" style="display:inline-block;background-color:#ff4d4f;color:#fff;text-decoration:none;padding:11px 24px;border-radius:6px;font-weight:600;font-size:14px;box-shadow:0 2px 4px rgba(255,77,79,0.15);white-space:nowrap">Complain About Merchant</a></td>
</tr></table>
</td></tr></table></td></tr>
<tr><td style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:16px;line-height:1.6">This is an automated message. Please do not reply directly to this email as this inbox is unmonitored. If you need further assistance or wish to manage your support tickets, please <a href="{{client_link}}" style="color:#1890ff;text-decoration:underline">click here to contact our support center</a>.</td></tr>
</table></td></tr></table>
</body></html>')
    ON CONFLICT (email_type) DO NOTHING
  `);

  // 邮件模板预设（可切换的多套模板）
  await p.query(`
    CREATE TABLE IF NOT EXISTS support_email_template_presets (
      id BIGSERIAL PRIMARY KEY,
      email_type TEXT NOT NULL,
      preset_name TEXT NOT NULL,
      subject_template TEXT NOT NULL,
      body_template TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(email_type, preset_name)
    )
  `);

  // 插入预设：平台风（收单行视角，面向美国顾客）
  await p.query(`
    INSERT INTO support_email_template_presets (email_type, preset_name, subject_template, body_template)
    VALUES (
      'paid_support_invite',
      'Platform Style (Acquirer)',
      'Your order {{order_number}} – Support Available',
      '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;line-height:1.6">
        <p>Dear customer,</p>
        <p>You made a {{order_currency}} {{order_amount}} purchase on {{paid_at}}.</p>
        <p>Order number: <strong>{{order_number}}</strong></p>
        <p>Payment method: {{payment_method}}{{#card_last4}} (card ending in {{card_last4}}){{/card_last4}}</p>
        <p>If you have any questions about this order, please visit:</p>
        <p><a href="{{client_link}}" style="color:#1890ff">{{client_link}}</a></p>
        <p style="margin-top:24px;color:#8c8c8c;font-size:12px">This message is from {{store_domain}} on behalf of the payment platform.</p>
      </div>'
    ) ON CONFLICT (email_type, preset_name) DO NOTHING
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS shoplazza_webhook_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT UNIQUE NOT NULL,
      store_subdomain TEXT NOT NULL,
      topic TEXT NOT NULL,
      order_id TEXT,
      order_number TEXT,
      customer_email TEXT,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'received',
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // 创建索引
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_order_snapshots_order ON support_order_snapshots(store_subdomain, order_id)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_paid_logistics ON support_order_snapshots(store_subdomain, order_id) WHERE payment_status = 'paid'`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS support_fulfillment_sync_state (
      store_subdomain TEXT NOT NULL,
      order_id TEXT NOT NULL,
      last_attempt_at TIMESTAMPTZ,
      last_checked_at TIMESTAMPTZ,
      next_check_at TIMESTAMPTZ,
      last_error TEXT,
      PRIMARY KEY (store_subdomain, order_id)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_fulfillment_sync_due ON support_fulfillment_sync_state(next_check_at, store_subdomain, order_id)`);
  await p.query(`ALTER TABLE shoplazza_webhook_events ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);
  await p.query(`ALTER TABLE shoplazza_webhook_events ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ`);
  await p.query(`ALTER TABLE shoplazza_webhook_events ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ`);
  await p.query(`ALTER TABLE shoplazza_webhook_events ADD COLUMN IF NOT EXISTS delivery_count INTEGER NOT NULL DEFAULT 1`);
  await p.query(`ALTER TABLE shoplazza_webhook_events ADD COLUMN IF NOT EXISTS last_received_at TIMESTAMPTZ`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_fulfillment_webhook_pending ON shoplazza_webhook_events(next_attempt_at, received_at) WHERE event_key LIKE 'fulfillment:%' AND status IN ('received', 'failed', 'processing')`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_paid_webhook_pending ON shoplazza_webhook_events(next_attempt_at, received_at) WHERE event_key LIKE 'paid:%' AND status IN ('received', 'failed', 'processing')`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_order_snapshots_email ON support_order_snapshots(customer_email)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_order_snapshots_paid_at ON support_order_snapshots(paid_at)`);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_email_events_ticket ON support_email_events(public_ticket_no)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_email_events_order ON support_email_events(store_subdomain, order_id, event_type)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_email_events_email ON support_email_events(customer_email)`);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_email_jobs_order ON support_email_jobs(store_subdomain, order_id)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_email_jobs_status ON support_email_jobs(status, scheduled_at)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_email_jobs_customer ON support_email_jobs(customer_email)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_email_jobs_type ON support_email_jobs(email_type)`);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_shoplazza_webhook_events_store_topic ON shoplazza_webhook_events(store_subdomain, topic)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_shoplazza_webhook_events_order ON shoplazza_webhook_events(store_subdomain, order_id)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_shoplazza_webhook_events_status ON shoplazza_webhook_events(status)`);

  // 自有工单表
  await p.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id BIGSERIAL PRIMARY KEY,
      public_ticket_no TEXT UNIQUE NOT NULL,
      store_subdomain TEXT NOT NULL,
      store_name TEXT,
      order_id TEXT NOT NULL,
      order_number TEXT,
      customer_email TEXT NOT NULL,
      customer_name TEXT,
      issue_type TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      customer_access_token_hash TEXT NOT NULL,
      bootstrap_token_hash TEXT,
      last_customer_message_at TIMESTAMPTZ,
      last_agent_message_at TIMESTAMPTZ,
      last_customer_viewed_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      closed_by TEXT,
      arbitration_requested BOOLEAN NOT NULL DEFAULT false,
      reopen_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS support_ticket_messages (
      id BIGSERIAL PRIMARY KEY,
      public_ticket_no TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_email TEXT,
      sender_name TEXT,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_order ON support_tickets(store_subdomain, order_id)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_email ON support_tickets(customer_email)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status_updated ON support_tickets(status, updated_at DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_public_no ON support_tickets(public_ticket_no)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_store_order_email ON support_tickets(store_subdomain, order_id, customer_email)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket ON support_ticket_messages(public_ticket_no, created_at ASC)`);

  // 阶段：图片附件支持
  await p.query(`ALTER TABLE support_ticket_messages ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb`);
  // 允许纯图片消息（content 可为空）
  await p.query(`ALTER TABLE support_ticket_messages ALTER COLUMN content DROP NOT NULL`);
  // 存量消息 attachments 列 NULL → '[]' 回填
  await p.query(`UPDATE support_ticket_messages SET attachments = '[]'::jsonb WHERE attachments IS NULL`);

  // 手动发起新工单邀请功能：移除 support_tickets 唯一约束（允许同一订单多个工单）
  // 约束名可能是完整版（email）或截断版（em），两者都要尝试删除
  await p.query(`ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_store_subdomain_order_id_customer_email_key`);
  await p.query(`ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_store_subdomain_order_id_customer_em_key`);

  // 顾客重开工单功能：support_tickets 增加 reopen_count 列
  await p.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reopen_count INTEGER NOT NULL DEFAULT 0`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS support_agents (
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS support_agent_sessions (
      id BIGSERIAL PRIMARY KEY,
      session_token_hash TEXT UNIQUE NOT NULL,
      agent_id BIGINT NOT NULL REFERENCES support_agents(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_agents_username ON support_agents(username)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_agent_sessions_token ON support_agent_sessions(session_token_hash)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_agent_sessions_agent ON support_agent_sessions(agent_id)`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS support_access_tokens (
      id BIGSERIAL PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      purpose TEXT NOT NULL,
      store_subdomain TEXT,
      order_id TEXT,
      public_ticket_no TEXT,
      customer_email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      force_new_ticket BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_access_tokens_hash ON support_access_tokens(token_hash)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_access_tokens_ticket ON support_access_tokens(public_ticket_no)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_access_tokens_order ON support_access_tokens(store_subdomain, order_id)`);

  // 手动发起新工单邀请功能：support_access_tokens 增加 force_new_ticket 标记
  // 注意：必须放在上面的 CREATE TABLE 之后，否则全新数据库初始化时会报 relation does not exist
  await p.query(`ALTER TABLE support_access_tokens ADD COLUMN IF NOT EXISTS force_new_ticket BOOLEAN NOT NULL DEFAULT false`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS support_stores (
      id BIGSERIAL PRIMARY KEY,
      subdomain TEXT UNIQUE NOT NULL,
      store_name TEXT,
      access_token TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS support_email_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      auto_send_enabled BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await p.query(`INSERT INTO support_email_settings (id, auto_send_enabled) VALUES (1, false) ON CONFLICT DO NOTHING`);

  // 兜底同步状态表
  await p.query(`
    CREATE TABLE IF NOT EXISTS support_backfill_state (
      store_subdomain TEXT PRIMARY KEY,
      last_synced_at TIMESTAMPTZ,
      last_status TEXT NOT NULL DEFAULT 'idle',
      last_result_json JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await p.query(`ALTER TABLE support_backfill_state ADD COLUMN IF NOT EXISTS last_unpaid_synced_at TIMESTAMPTZ`);

  // 自动兜底开关（复用 support_email_settings 表）
  await p.query(`ALTER TABLE support_email_settings ADD COLUMN IF NOT EXISTS auto_backfill_enabled BOOLEAN NOT NULL DEFAULT false`);

  // 清理废弃字段：补发已改为 UPDATE 原任务，不再创建子任务
  await p.query(`ALTER TABLE support_email_jobs DROP COLUMN IF EXISTS manual_resend_of`);

  // 新增 raw_client_link 列（用于回复通知令牌复用）
  await p.query(`ALTER TABLE support_email_jobs ADD COLUMN IF NOT EXISTS raw_client_link TEXT`);
  await p.query(`ALTER TABLE support_email_jobs ADD COLUMN IF NOT EXISTS job_source TEXT`);

  // ── 系统设置（运行时覆盖 .env 的配置）──
  await p.query(`
    CREATE TABLE IF NOT EXISTS support_system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // 系统日志 — 同步日志（高频，定期清理）
  await p.query(`
    CREATE TABLE IF NOT EXISTS support_sync_logs (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      action TEXT NOT NULL,
      store_subdomain TEXT NOT NULL,
      target_id TEXT,
      items_total INTEGER DEFAULT 0,
      items_new INTEGER DEFAULT 0,
      items_updated INTEGER DEFAULT 0,
      items_skipped INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      duration_ms INTEGER,
      detail_json JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_sync_logs_source ON support_sync_logs(source, created_at DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_sync_logs_store ON support_sync_logs(store_subdomain, created_at DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_sync_logs_status ON support_sync_logs(status, created_at DESC)`);
  await p.query(`ALTER TABLE support_sync_logs ADD COLUMN IF NOT EXISTS store_name TEXT`);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_sync_logs_created ON support_sync_logs(created_at)`);

  // 系统日志 — 操作日志（默认保留 60 天）
  await p.query(`
    CREATE TABLE IF NOT EXISTS support_operation_logs (
      id BIGSERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_ip TEXT,
      store_subdomain TEXT,
      target TEXT,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      failed_at_step TEXT,
      detail_json JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_category ON support_operation_logs(category, created_at DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_status ON support_operation_logs(status, created_at DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_store ON support_operation_logs(store_subdomain, created_at DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_target ON support_operation_logs(target)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_created ON support_operation_logs(created_at)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_support_email_jobs_created ON support_email_jobs(created_at)`);

  await p.query(ORDER_ADDRESS_SCHEMA_SQL);

  // 统计实际表数和索引数
  const tableR = await p.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'support_%'`,
  );
  const idxR = await p.query(
    `SELECT COUNT(*) AS cnt FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_support_%'`,
  );
  const tableCount = Number(tableR.rows[0].cnt);
  const idxCount = Number(idxR.rows[0].cnt);
  console.log(`[pg] ${tableCount} 张表 + ${idxCount} 个索引已就绪`);
}
