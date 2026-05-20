const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split('\n').forEach((line) => {
  const t = line.trim();
  if (!t || t.startsWith('#')) return;
  const i = t.indexOf('=');
  if (i === -1) return;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
});

const fetch = require('node-fetch');
// ⚠️ 替换为你的实际店铺域名和订单ID
const SHOP_DOMAIN = 'your-store.myshoplaza.com';
const ORDER_ID = 'your-order-id';
const TOKEN = process.env.SUPPORT_SHOPLAZZA_STORES_JSON
  ? JSON.parse(process.env.SUPPORT_SHOPLAZZA_STORES_JSON)[0].access_token
  : '';

async function main() {
  console.log('=== 查订单: /orders/289001-JSTGBB84800 ===');
  const r1 = await fetch(`https://${SHOP_DOMAIN}/openapi/2025-06/orders/${encodeURIComponent(ORDER_ID)}`, {
    headers: { 'Access-Token': TOKEN },
  });
  const j1 = await r1.json();
  console.log('HTTP:', r1.status);
  if (!r1.ok) { console.log(JSON.stringify(j1).slice(0, 500)); return; }

  const o = j1.order || j1.data?.order || j1;
  console.log('id:', o.id);
  console.log('number:', o.number);
  console.log('financial_status:', o.financial_status);
  console.log('payment_method:', o.payment_method);
  console.log('total_price:', o.total_price, o.currency);
  console.log('customer:', JSON.stringify(o.customer));
  console.log('payment_line:', JSON.stringify(o.payment_line));

  console.log('\n=== 查交易: /orders/{id}/transactions ===');
  const r2 = await fetch(`https://${SHOP_DOMAIN}/openapi/2025-06/orders/${encodeURIComponent(o.id)}/transactions`, {
    headers: { 'Access-Token': TOKEN },
  });
  const j2 = await r2.json();
  console.log('HTTP:', r2.status);
  console.log(JSON.stringify(j2, null, 2));
}

main().catch((e) => { console.error(e.message); if (e.cause) console.error('cause:', e.cause.message); });
