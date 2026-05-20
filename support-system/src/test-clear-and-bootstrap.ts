import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { loadConfig, loadStoresConfig } from './config';
import { createBootstrapToken } from './token';
import { getOrderDetail, getOrderTransactions } from './shoplazza-client';
import { normalizeOrder } from './normalize-order';
import { query } from './pg';

const config = loadConfig();
const ORDER_IDS = ['289001-JSTFYZ60180', '289001-JSTFLC24184'];

async function clearTables() {
  const tables = [
    'support_access_tokens',
    'support_ticket_messages',
    'support_tickets',
    'support_email_jobs',
    'support_email_events',
    'support_order_snapshots',
    'shoplazza_webhook_events',
  ];
  for (const t of tables) {
    await query(`DELETE FROM ${t}`);
    console.log(`  清空: ${t}`);
  }
}

async function processOrder(orderId: string, store: any) {
  console.log(`\n--- ${orderId} ---`);

  const order = await getOrderDetail(store, orderId);
  if (!order) {
    console.error(`  订单查询失败`);
    return null;
  }

  const transactions = await getOrderTransactions(store, orderId);
  const normalized = normalizeOrder(store.subdomain, store.storeName, order, transactions);

  console.log(`  订单号: ${normalized.orderNumber}`);
  console.log(`  顾客: ${normalized.customerEmail}`);
  console.log(`  金额: ${normalized.orderCurrency} ${normalized.orderAmount}`);
  console.log(`  支付方式: ${normalized.paymentMethod}`);
  console.log(`  卡号后四位: ${normalized.cardLast4 || '无'}`);

  await query(
    `INSERT INTO support_order_snapshots
      (store_subdomain, store_name, order_id, order_number, customer_email, customer_name,
       order_status, fulfillment_status, order_amount, order_currency,
       payment_status, payment_method, paid_at,
       transaction_id_masked, card_last4,
       items_json, shipping_address_json, billing_address_json, logistics_json,
       payment_detail_json, raw_order_json,
       snapshot_source, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (store_subdomain, order_id, customer_email)
     DO UPDATE SET
       order_number = EXCLUDED.order_number,
       order_status = EXCLUDED.order_status,
       fulfillment_status = EXCLUDED.fulfillment_status,
       order_amount = EXCLUDED.order_amount,
       order_currency = EXCLUDED.order_currency,
       payment_status = EXCLUDED.payment_status,
       payment_method = EXCLUDED.payment_method,
       paid_at = EXCLUDED.paid_at,
       transaction_id_masked = EXCLUDED.transaction_id_masked,
       card_last4 = EXCLUDED.card_last4,
       items_json = EXCLUDED.items_json,
       shipping_address_json = EXCLUDED.shipping_address_json,
       billing_address_json = EXCLUDED.billing_address_json,
       logistics_json = EXCLUDED.logistics_json,
       payment_detail_json = EXCLUDED.payment_detail_json,
       raw_order_json = EXCLUDED.raw_order_json,
       updated_at = now()`,
    [
      normalized.storeSubdomain,
      normalized.storeName,
      normalized.orderId,
      normalized.orderNumber,
      normalized.customerEmail,
      normalized.customerName,
      normalized.orderStatus,
      normalized.fulfillmentStatus,
      normalized.orderAmount,
      normalized.orderCurrency,
      normalized.paymentStatus,
      normalized.paymentMethod,
      normalized.paidAt,
      normalized.transactionIdMasked,
      normalized.cardLast4,
      JSON.stringify(normalized.itemsJson),
      JSON.stringify(normalized.shippingAddressJson),
      JSON.stringify(normalized.billingAddressJson),
      JSON.stringify(normalized.logisticsJson),
      JSON.stringify(normalized.paymentDetailJson),
      JSON.stringify(normalized.rawOrderJson),
      'simulated',
      new Date().toISOString(),
    ],
  );
  console.log(`  快照已写入`);

  const token = await createBootstrapToken({
    storeSubdomain: normalized.storeSubdomain,
    orderId: normalized.orderId,
    customerEmail: normalized.customerEmail,
  });

  const url = `${config.publicBaseUrl}/ticket?t=${encodeURIComponent(token)}`;
  console.log(`  链接: ${url}`);

  return { orderId, url, token };
}

async function main() {
  console.log('=== 清空表 ===');
  await clearTables();

  const stores = await loadStoresConfig();
  if (stores.length === 0) { console.error('无店铺配置'); process.exit(1); }
  const store = stores[0];

  console.log('\n=== 测试店铺: ' + store.subdomain + ' ===\n');

  const results = [];
  for (const oid of ORDER_IDS) {
    const r = await processOrder(oid, store);
    if (r) results.push(r);
  }

  console.log('\n========================================');
  console.log('  顾客端链接:');
  for (const r of results) {
    console.log(`  ${r.orderId}`);
    console.log(`  ${r.url}`);
    console.log('');
  }
  console.log('========================================');
}

main().catch(console.error);
