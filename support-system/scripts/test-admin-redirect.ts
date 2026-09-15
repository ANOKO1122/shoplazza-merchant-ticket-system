/**
 * 管理员登录回跳地址净化自检脚本（纯函数，不连数据库）
 *
 * 运行：npx tsx scripts/test-admin-redirect.ts
 */
import { ADMIN_HOME, ADMIN_PAGE_FILES, normalizeAdminPath, safeAdminRedirect } from '../src/admin-pages';

let failed = 0;

function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

console.log('--- normalizeAdminPath ---');
check('正常路径', normalizeAdminPath('/thinkpro-admin/emails'), '/thinkpro-admin/emails');
check('尾部竖线（从聊天工具复制常见）', normalizeAdminPath('/thinkpro-admin/emails|'), '/thinkpro-admin/emails');
check('尾部百分号编码竖线', normalizeAdminPath('/thinkpro-admin/emails%7C'), '/thinkpro-admin/emails');
check('尾部空格', normalizeAdminPath('/thinkpro-admin/emails '), '/thinkpro-admin/emails');
check('带 query', normalizeAdminPath('/thinkpro-admin/email-preview?job_id=12'), '/thinkpro-admin/email-preview');
check('重复斜杠', normalizeAdminPath('//thinkpro-admin//emails'), '/thinkpro-admin/emails');
check('尾部斜杠', normalizeAdminPath('/thinkpro-admin/emails/'), '/thinkpro-admin/emails');
check('尾部引号', normalizeAdminPath('/thinkpro-admin/emails"'), '/thinkpro-admin/emails');

console.log('--- safeAdminRedirect ---');
check('正常回跳', safeAdminRedirect('/thinkpro-admin/emails'), '/thinkpro-admin/emails');
check('带杂字符回跳（本次故障场景）', safeAdminRedirect('/thinkpro-admin/emails|'), '/thinkpro-admin/emails');
check('嵌套页面回跳', safeAdminRedirect('/thinkpro-admin/ticket-preview.html'), '/thinkpro-admin/ticket-preview.html');
check('空值', safeAdminRedirect(undefined), ADMIN_HOME);
check('外站地址', safeAdminRedirect('https://evil.example.com/x'), ADMIN_HOME);
check('协议相对地址', safeAdminRedirect('//evil.example.com'), ADMIN_HOME);
check('javascript 注入', safeAdminRedirect('javascript:alert(1)'), ADMIN_HOME);
check('大小写绕过协议', safeAdminRedirect('JaVaScRiPt:alert(1)'), ADMIN_HOME);
check('换行头注入', safeAdminRedirect('/thinkpro-admin/emails\r\nSet-Cookie: a=b'), ADMIN_HOME);
check('站内其它路径', safeAdminRedirect('/ticket?t=abc'), ADMIN_HOME);
check('数组参数', safeAdminRedirect(['/thinkpro-admin/emails'] as unknown), ADMIN_HOME);
check('相对路径', safeAdminRedirect('thinkpro-admin/emails'), ADMIN_HOME);

console.log('--- 白名单完整性 ---');
for (const [route, file] of ADMIN_PAGE_FILES) {
  if (safeAdminRedirect(route) !== route) {
    failed++;
    console.log(`FAIL | 白名单路由无法通过净化 | ${route} -> ${file}`);
  }
}
console.log(`白名单页面数：${ADMIN_PAGE_FILES.size}`);

console.log(failed === 0 ? '\n全部通过 ✅' : `\n失败 ${failed} 项 ❌`);
process.exit(failed === 0 ? 0 : 1);
