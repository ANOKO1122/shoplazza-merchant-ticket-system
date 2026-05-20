const { Pool } = require('pg');

async function main() {
  const p = new Pool({ connectionString: 'postgres://postgres:root@localhost:5432/support_portal' });
  const tables = await p.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
  console.log('=== 表列表 ===');
  tables.rows.forEach(r => console.log(' ', r.table_name));

  for (const t of tables.rows) {
    console.log(`\n=== ${t.table_name} 列 ===`);
    const cols = await p.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position", [t.table_name]);
    cols.rows.forEach(c => console.log(`  ${c.column_name.padEnd(30)} ${c.data_type.padEnd(20)} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`));
  }
  await p.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
