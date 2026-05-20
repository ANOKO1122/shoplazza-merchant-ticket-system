const { Pool } = require('pg');

async function main() {
  const p = new Pool({ connectionString: 'postgres://postgres:root@localhost:5432/support_portal' });

  console.log('=== shoplazza_webhook_events ===');
  const rows = await p.query('SELECT id, event_key, store_subdomain, topic, order_id, customer_email, status FROM shoplazza_webhook_events ORDER BY id');
  console.log(`共 ${rows.rowCount} 条`);
  rows.rows.forEach((r) => {
    console.log(`  #${r.id} ${r.event_key} | ${r.store_subdomain} | ${r.topic} | ${r.order_id} | ${r.customer_email} | ${r.status}`);
  });

  await p.end();
}

main().catch((e) => console.error(e.message));
