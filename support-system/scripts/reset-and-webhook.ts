/**
 * 清空测试数据 + 模拟 webhook 传入（一键脚本）
 *
 * 保留表: support_agents, support_agent_sessions, support_stores
 * 其余全部清空，然后自动发送 3 个 orders/paid webhook
 *
 * 用法: npx tsx scripts/reset-and-webhook.ts
 */

import { Pool } from 'pg';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new Pool({ connectionString: process.env.SUPPORT_DATABASE_URL });

const KEEP_TABLES = ['support_agents', 'support_agent_sessions', 'support_stores', 'support_email_templates'];

const DOMAIN = 'jaymiartstore.myshoplaza.com';
const ORDERS = [
  { id: '289001-JSTFYZ60180', number: 'JSTFYZ60180' },
  { id: '289001-JSTFLC24184', number: 'JSTFLC24184' },
  { id: '289001-JSTRER64758', number: 'JSTRER64758' },
];

function postWebhook(subdomain: string, body: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: 4001,
      path: `/api/shoplazza/webhook/${encodeURIComponent(subdomain)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-shoplazza-topic': 'orders/paid' },
    }, (res) => {
      let b = '';
      res.on('data', (c: string) => (b += c));
      res.on('end', () => { console.log(`    ←  HTTP ${res.statusCode}`); resolve(); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  // Step 1: 查所有表
  const r = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND (tablename LIKE 'support_%' OR tablename = 'shoplazza_webhook_events') ORDER BY tablename`,
  );
  const tables: string[] = r.rows.map(row => row.tablename);

  console.log('═══ Step 1: 清空测试数据 ═══');
  for (const t of tables) {
    const keep = KEEP_TABLES.includes(t);
    console.log(`  ${keep ? '🔒 保留' : '🗑️  清空'}: ${t}`);
  }

  for (const t of tables) {
    if (KEEP_TABLES.includes(t)) continue;
    try {
      await pool.query(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
      console.log(`  ✅ ${t}`);
    } catch (e: any) {
      console.log(`  ⚠️  ${t}: ${e.message}`);
    }
  }

  // 验证
  for (const t of tables) {
    const cnt = await pool.query(`SELECT COUNT(*) AS n FROM ${t}`);
    console.log(`  ${t}: ${cnt.rows[0].n} 行`);
  }

  // Step 2: 确保店铺启用
  const store = await pool.query(`SELECT enabled FROM support_stores WHERE subdomain = $1`, [DOMAIN]);
  if (store.rows.length === 0) {
    console.log('\n⚠️  店铺未配置！请先在管理页录入后再运行。');
    await pool.end();
    return;
  }
  if (!store.rows[0].enabled) {
    await pool.query(`UPDATE support_stores SET enabled = true WHERE subdomain = $1`, [DOMAIN]);
  }

  // Step 3: 模拟 webhook
  console.log('\n═══ Step 2: 模拟 Webhook 传入 ═══');
  for (const o of ORDERS) {
    console.log(`  POST  ${o.id}`);
    await postWebhook(DOMAIN, { order: { id: o.id, number: o.number } });
  }

  console.log('\n✅ 全部完成。');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
