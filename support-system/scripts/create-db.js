const { Pool } = require('pg');

async function main() {
  const p = new Pool({ connectionString: 'postgres://postgres:root@localhost:5432/postgres' });
  const r = await p.query("SELECT 1 FROM pg_database WHERE datname='support_portal'");
  if (r.rowCount === 0) {
    await p.query('CREATE DATABASE support_portal');
    console.log('[setup] support_portal 数据库已创建');
  } else {
    console.log('[setup] support_portal 数据库已存在');
  }
  await p.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
