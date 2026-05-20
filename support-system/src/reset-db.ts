import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new Pool({ connectionString: process.env.SUPPORT_DATABASE_URL });

async function main() {
  const tables = [
    'support_ticket_messages',
    'support_tickets',
    'support_email_jobs',
    'support_email_events',
    'support_order_snapshots',
    'shoplazza_webhook_events',
    'support_agents',
    'support_agent_sessions',
  ];
  for (const t of tables) {
    try { await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`); console.log(`  DROP ${t}`); } catch (e: any) { console.log(`  skip ${t}: ${e.message}`); }
  }
  console.log('表已清空');
  await pool.end();
}
main().catch(console.error);
