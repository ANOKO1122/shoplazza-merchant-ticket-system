import { createBootstrapToken } from './token';
import { query } from './pg';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const BASE = process.env.SUPPORT_PUBLIC_BASE_URL || 'http://localhost:4001';

async function main() {
  // 插入测试订单快照
  await query(
    `INSERT INTO support_order_snapshots
      (store_subdomain, store_name, order_id, order_number, customer_email,
       order_amount, order_currency, payment_method, paid_at, card_last4, payment_detail_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (store_subdomain, order_id, customer_email) DO UPDATE SET
       order_number = EXCLUDED.order_number`,
    [
      'jaymiartstore',
      '测试店铺',
      'test-order-001',
      '#TEST001',
      'test@example.com',
      '99.00',
      'USD',
      'Credit Card (尾号 4690)',
      new Date().toISOString(),
      '4690',
      JSON.stringify({ card_last4: '4690' }),
    ],
  );

  const token = await createBootstrapToken({
    storeSubdomain: 'jaymiartstore',
    orderId: 'test-order-001',
    customerEmail: 'test@example.com',
  });

  console.log('\n=== Phase 6 测试命令 ===\n');
  console.log(`# Bootstrap: ${BASE}/api/support/bootstrap?t=${token}\n`);
  console.log(`# 创建工单: curl -s -X POST ${BASE}/api/support/tickets -H "Content-Type: application/json" -d '{"token":"${token}","issue_type":"商品破损","description":"test"}' | npx json\n`);
}

main().catch(console.error);
