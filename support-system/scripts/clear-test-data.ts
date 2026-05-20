// 清空测试数据（保留 support_agents 和 support_agent_sessions）
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new Pool({ connectionString: process.env.SUPPORT_DATABASE_URL });

const KEEP_TABLES = ['support_agents', 'support_agent_sessions'];

async function main() {
  // 获取所有 support_ 前缀的表
  const r = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'support_%' ORDER BY tablename`,
  );
  const tables = r.rows.map(row => row.tablename);

  console.log(`找到 ${tables.length} 张表:`);
  for (const t of tables) {
    const keep = KEEP_TABLES.includes(t);
    console.log(`  ${keep ? '🔒 保留' : '🗑️  清空'}: ${t}`);
  }

  // 先禁用外键约束（CASCADE 处理依赖）
  for (const t of tables) {
    if (KEEP_TABLES.includes(t)) continue;
    try {
      // TRUNCATE with CASCADE handles foreign key dependencies
      await pool.query(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
      console.log(`  ✅ TRUNCATE ${t}`);
    } catch (e: any) {
      console.log(`  ⚠️  ${t}: ${e.message}`);
    }
  }

  // 验证
  console.log('\n--- 验证 ---');
  for (const t of tables) {
    const cnt = await pool.query(`SELECT COUNT(*) AS n FROM ${t}`);
    const n = Number(cnt.rows[0].n);
    console.log(`  ${t}: ${n} 行`);
  }

  await pool.end();
  console.log('\n✅ 清空完成');
}
main().catch(e => { console.error(e); process.exit(1); });
