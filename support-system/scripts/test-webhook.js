const http = require('http');

function postWebhook(subdomain, topic, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 4001,
      path: `/api/shoplazza/webhook/${subdomain}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shoplazza-topic': topic,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  // 测试1: 首次 webhook
  console.log('--- 测试1: 首次 webhook ---');
  const r1 = await postWebhook('test-store', 'orders/paid', {
    order: {
      id: '123456-abc',
      number: '#897542',
      customer: { email: 'test@example.com', first_name: 'John' },
      financial_status: 'paid',
      payment_method: 'Credit Card',
      total_price: '99.00',
      currency: 'USD',
    },
  });
  console.log('response:', r1.status, r1.body);

  // 等待入库
  await new Promise((r) => setTimeout(r, 500));

  // 测试2: 重复 webhook (应幂等跳过)
  console.log('\n--- 测试2: 重复 webhook ---');
  const r2 = await postWebhook('test-store', 'orders/paid', {
    order: {
      id: '123456-abc',
      number: '#897542',
      customer: { email: 'test@example.com', first_name: 'John' },
      financial_status: 'paid',
      payment_method: 'Credit Card',
      total_price: '99.00',
      currency: 'USD',
    },
  });
  console.log('response:', r2.status, r2.body);

  await new Promise((r) => setTimeout(r, 500));

  // 测试3: 未知店铺
  console.log('\n--- 测试3: 未知店铺 ---');
  const r3 = await postWebhook('unknown-store', 'orders/paid', {
    order: { id: 'xxx', customer: { email: 'x@x.com' } },
  });
  console.log('response:', r3.status, r3.body);
}

main().catch((e) => console.error(e));
