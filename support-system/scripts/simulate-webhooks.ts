/**
 * 本地测试：模拟 webhook 传入 3 个订单
 *
 * 用法：
 *   1. 确保 support-bridge 正在运行 (npm run dev 或 npx tsx src/index.ts)
 *   2. 设置环境变量 SHOPLAZZA_ACCESS_TOKEN
 *   3. npx tsx scripts/simulate-webhooks.ts
 *
 * 或直接传 token：
 *   SHOPLAZZA_ACCESS_TOKEN=xxx npx tsx scripts/simulate-webhooks.ts
 */

import http from 'http';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ── 配置 ──
// ⚠️ 替换为你的实际店铺域名和测试订单
const DOMAIN = 'your-store.myshoplaza.com';
const ORDERS = [
  { id: 'your-order-id-1', number: 'your-order-number-1' },
  { id: 'your-order-id-2', number: 'your-order-number-2' },
  { id: 'your-order-id-3', number: 'your-order-number-3' },
];
const SERVER_HOST = 'localhost';
const SERVER_PORT = 4001;

// ── 从 env 或命令行参数获取 token ──
const ACCESS_TOKEN = process.env.SHOPLAZZA_ACCESS_TOKEN || process.argv[2];
if (!ACCESS_TOKEN) {
  console.error('❌ 缺少 Shoplazza Access Token');
  console.error('   用法: SHOPLAZZA_ACCESS_TOKEN=xxx npx tsx scripts/simulate-webhooks.ts');
  console.error('   或:   npx tsx scripts/simulate-webhooks.ts <token>');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.SUPPORT_DATABASE_URL });

// ── 模拟 webhook POST ──
function postWebhook(subdomain: string, body: any): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: SERVER_HOST,
      port: SERVER_PORT,
      path: `/api/shoplazza/webhook/${encodeURIComponent(subdomain)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shoplazza-topic': 'orders/paid',
      },
    }, (res) => {
      let b = '';
      res.on('data', (c: string) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: b }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  本地测试：模拟 Webhook 传入');
  console.log('═══════════════════════════════════════════');
  console.log(`  域名: ${DOMAIN}`);
  console.log(`  订单: ${ORDERS.map(o => o.id).join(', ')}`);
  console.log('');

  // Step 1: 录入店铺到 support_stores（幂等，存在则更新 token）
  console.log('📝 Step 1: 录入店铺...');
  const encrypted = await pool.query(
    `INSERT INTO support_stores (subdomain, store_name, access_token)
     VALUES ($1, $2, $3)
     ON CONFLICT (subdomain) DO UPDATE SET access_token = $3, updated_at = now()
     RETURNING id, subdomain, store_name, enabled`,
    [DOMAIN, DOMAIN, ACCESS_TOKEN],
  );
  const store = encrypted.rows[0];
  console.log(`  ✅ 店铺已录入: id=${store.id} subdomain=${store.subdomain} enabled=${store.enabled}`);
  console.log('');

  // Step 2: 确保店铺启用
  await pool.query(`UPDATE support_stores SET enabled = true WHERE subdomain = $1`, [DOMAIN]);

  // Step 3: 清理旧测试数据
  console.log('🧹 Step 2: 清理旧测试数据...');
  for (const order of ORDERS) {
    await pool.query(`DELETE FROM support_order_snapshots WHERE order_id = $1`, [order.id]);
    await pool.query(`DELETE FROM shoplazza_webhook_events WHERE order_id = $1`, [order.id]);
    await pool.query(`DELETE FROM support_email_jobs WHERE order_id = $1`, [order.id]);
    await pool.query(`DELETE FROM support_tickets WHERE order_id = $1`, [order.id]);
    await pool.query(`DELETE FROM support_access_tokens WHERE order_id = $1`, [order.id]);
  }
  console.log('  ✅ 旧数据已清理');
  console.log('');

  // Step 4: 模拟 webhook（模拟 Shoplazza 推送格式）
  console.log('📨 Step 3: 发送模拟 Webhook...');
  for (const order of ORDERS) {
    const payload = {
      order: {
        id: order.id,
        number: order.number,
      },
    };
    console.log(`  POST /api/shoplazza/webhook/${DOMAIN}  →  ${order.id}`);
    const r = await postWebhook(DOMAIN, payload);
    console.log(`    ←  HTTP ${r.status}  ${r.body}`);
  }
  console.log('');

  // Step 5: 等待服务端处理（需调用 Shoplazza API，每个订单约 1-2 秒）
  console.log('⏳ Step 4: 等待服务端拉取订单详情（约 10 秒）...');
  await new Promise(r => setTimeout(r, 10000));
  console.log('');

  // Step 6: 检查结果
  console.log('📊 Step 5: 检查结果');
  console.log('');

  // 6a. Webhook 事件
  console.log('  ── shoplazza_webhook_events ──');
  const events = await pool.query(
    `SELECT order_id, topic, status, error_message FROM shoplazza_webhook_events WHERE order_id = ANY($1) ORDER BY created_at`,
    [ORDERS.map(o => o.id)],
  );
  events.rows.forEach(r => console.log(`    ${r.order_id}  ${r.topic}  ${r.status}${r.error_message ? '  err:' + r.error_message : ''}`));
  if (events.rows.length === 0) console.log('    (无记录)');
  console.log('');

  // 6b. 订单快照
  console.log('  ── support_order_snapshots ──');
  const snaps = await pool.query(
    `SELECT order_id, order_number, customer_email, customer_name, payment_method, paid_at, card_last4, order_amount, order_currency FROM support_order_snapshots WHERE order_id = ANY($1) ORDER BY order_id`,
    [ORDERS.map(o => o.id)],
  );
  snaps.rows.forEach(r => {
    console.log(`    ${r.order_id}  ${r.order_number}  ${r.customer_email || '(无邮箱)'}  ${r.payment_method || '-'}  ${r.paid_at || '-'}`);
  });
  if (snaps.rows.length === 0) console.log('    ⚠️  无快照（可能 API 调用失败）');
  console.log('');

  // 6c. 邮件任务
  console.log('  ── support_email_jobs ──');
  const jobs = await pool.query(
    `SELECT email_job_no, order_id, email_type, status, customer_email FROM support_email_jobs WHERE order_id = ANY($1) ORDER BY order_id`,
    [ORDERS.map(o => o.id)],
  );
  jobs.rows.forEach(r => console.log(`    ${r.email_job_no}  ${r.order_id}  ${r.email_type}  ${r.status}  → ${r.customer_email}`));
  if (jobs.rows.length === 0) console.log('    (无邮件任务)');
  console.log('');

  // 6d. Bootstrap Token
  console.log('  ── support_access_tokens (bootstrap) ──');
  const tokens = await pool.query(
    `SELECT id, purpose, order_id, customer_email, expires_at FROM support_access_tokens WHERE order_id = ANY($1) AND purpose = 'support_bootstrap' ORDER BY order_id`,
    [ORDERS.map(o => o.id)],
  );
  tokens.rows.forEach(r => console.log(`    #${r.id}  ${r.order_id}  ${r.customer_email}  过期:${r.expires_at}`));
  if (tokens.rows.length === 0) console.log('    (无 bootstrap token)');
  console.log('');

  console.log('═══════════════════════════════════════════');
  console.log('  模拟完成！');
  console.log('  如果快照有数据 → Webhook 流程正常 ✅');
  console.log('  如果没有快照 → 检查服务端日志，可能是 API token 问题');
  console.log('═══════════════════════════════════════════');

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
