const path = require('path');
const fs = require('fs');
const http = require('http');

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split('\n').forEach((line) => {
  const t = line.trim();
  if (!t || t.startsWith('#')) return;
  const i = t.indexOf('=');
  if (i === -1) return;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
});

const { Client } = require('pg');

function postWebhook(subdomain, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: 4001,
      path: `/api/shoplazza/webhook/${subdomain}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shoplazza-topic': 'orders/paid',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const storesJson = JSON.parse(process.env.SUPPORT_SHOPLAZZA_STORES_JSON);
  const normalizedSubdomain = storesJson[0].subdomain.replace('https://', '').replace('.myshoplaza.com', '').split('/')[0];
  console.log('storeSubdomain:', normalizedSubdomain);

  // 清掉旧测试数据
  const pg = new Client({ connectionString: process.env.SUPPORT_DATABASE_URL });
  await pg.connect();
  // ⚠️ 替换为你的实际测试订单ID
  await pg.query("DELETE FROM support_order_snapshots WHERE order_id = 'your-test-order-id'");
  await pg.query("DELETE FROM shoplazza_webhook_events WHERE order_id = 'your-test-order-id'");
  console.log('旧数据已清理');

  // 模拟 webhook (跟真店匠推过来的格式一样)
  console.log('\n=== POST webhook ===');
  const r = await postWebhook(normalizedSubdomain, {
    order: {
      id: 'your-test-order-id',
      number: 'your-test-order-number',
      customer: { email: 'test-customer@example.com' },
    },
  });
  console.log('response:', r.status, r.body);

  // 等 API 调用完成（2 次 API 调用需要点时间）
  await new Promise((r) => setTimeout(r, 5000));

  // 查快照
  console.log('\n=== support_order_snapshots ===');
  const snap = await pg.query("SELECT order_id, order_number, customer_email, customer_name, payment_method, paid_at, card_last4, order_amount, order_currency FROM support_order_snapshots WHERE order_id = '289001-JSTGBB84800'");
  if (snap.rows.length > 0) {
    console.log(JSON.stringify(snap.rows[0], null, 2));
  } else {
    console.log('无数据（可能 API 调用失败）');
  }

  // 查 webhook 事件
  console.log('\n=== shoplazza_webhook_events ===');
  const ev = await pg.query("SELECT event_key, status FROM shoplazza_webhook_events WHERE order_id = '289001-JSTGBB84800'");
  ev.rows.forEach((r) => console.log(r.event_key, r.status));

  await pg.end();
}

main().catch((e) => console.error(e));
