// 清空测试数据（保留账号、店铺、邮件/系统配置）
// 用法: npx tsx clear-test-data.ts [--force]       （在 scripts/ 目录下执行）
//       npx tsx scripts/clear-test-data.ts --force   （在项目根目录执行）
//   --force  跳过确认，直接执行
//
// 如果在宿主机（非 Docker 容器内）运行，需要先设置正确的数据库地址：
//   SUPPORT_DATABASE_URL="postgres://support_user:support_password@localhost:5432/support_portal" npx tsx clear-test-data.ts --force
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import readline from 'readline';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// 宿主机运行时，Docker 内部 hostname "postgres" 不可达，自动替换为 localhost
let dbUrl = process.env.SUPPORT_DATABASE_URL || '';
if (dbUrl.includes('@postgres:') || dbUrl.includes('@postgres/')) {
  dbUrl = dbUrl.replace('@postgres:', '@localhost:').replace('@postgres/', '@localhost/');
  console.log('ℹ️  检测到宿主机环境，数据库地址已自动替换为 localhost');
}

const pool = new Pool({ connectionString: dbUrl });

/** 不删除的配置类表 */
const KEEP_TABLES = [
  'support_agents',              // 管理员账号
  'support_agent_sessions',      // 管理员登录会话
  'support_stores',              // 店铺配置（含 access_token）
  'support_email_settings',      // 邮件开关/测试模式
  'support_email_templates',     // 邮件模板
  'support_email_template_presets', // 模板预设
  'support_system_settings',     // 公网域名等系统设置
];

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function main() {
  const force = process.argv.includes('--force');

  // 获取所有 support_ 前缀的表
  const r = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'support_%' ORDER BY tablename`,
  );
  const tables: string[] = r.rows.map(row => row.tablename);
  const toClear = tables.filter(t => !KEEP_TABLES.includes(t));

  console.log(`\n找到 ${tables.length} 张表:`);
  for (const t of tables) {
    const keep = KEEP_TABLES.includes(t);
    console.log(`  ${keep ? '🔒 保留' : '🗑️  清空'}: ${t}`);
  }

  if (toClear.length === 0) {
    console.log('\n✅ 没有需要清空的表');
    await pool.end();
    return;
  }

  // 确认
  if (!force) {
    console.log(`\n⚠️  将清空以上 ${toClear.length} 张表的所有数据，此操作不可逆！`);
    const ok = await confirm('输入 yes 确认执行，其他任意键取消: ');
    if (!ok) {
      console.log('❌ 已取消');
      await pool.end();
      return;
    }
  }

  // 执行清空
  console.log('\n--- 执行清空 ---');
  for (const t of toClear) {
    try {
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
    const marker = KEEP_TABLES.includes(t) ? (n > 0 ? '🔒' : '⚠️') : (n === 0 ? '✅' : '❌');
    console.log(`  ${marker} ${t}: ${n} 行`);
  }

  await pool.end();
  console.log('\n✅ 清空完成');
}
main().catch(e => { console.error(e); process.exit(1); });
