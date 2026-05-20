// 删除遗留死表
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new Pool({ connectionString: process.env.SUPPORT_DATABASE_URL });

async function main() {
  await pool.query('DROP TABLE IF EXISTS support_ticket_links CASCADE');
  console.log('✅ Dropped support_ticket_links');
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
