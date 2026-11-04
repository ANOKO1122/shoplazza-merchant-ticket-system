/**
 * 管理员页面路由白名单 + 跳转地址净化。
 *
 * 这里只放纯函数和常量（不依赖 express / 数据库），
 * 供 src/index.ts（路由与鉴权）以及 scripts 下的校验脚本复用。
 *
 * 背景：从聊天工具、Markdown 表格、文档里复制链接时经常带进尾部杂字符
 * （例如 `|`、引号、空白），这类地址在页面里做 location.replace() 后会
 * 落到 Express 的兜底 404（裸 "Not Found"），登录后表现为“跳转即 404”。
 */

/** 管理员页面路由 → public 目录下的静态文件（唯一事实来源） */
export const ADMIN_PAGES: ReadonlyArray<readonly [string, string]> = [
  ['/thinkpro-admin', 'admin.html'],
  ['/thinkpro-admin/stores', 'admin-stores.html'],
  ['/thinkpro-admin/protection', 'admin-protection.html'],
  ['/thinkpro-admin/emails', 'admin-emails.html'],
  ['/thinkpro-admin/logs', 'admin-logs.html'],
  ['/thinkpro-admin/ticket-preview', 'admin-ticket-preview.html'],
  ['/thinkpro-admin/ticket-preview.html', 'admin-ticket-preview.html'],
  ['/thinkpro-admin/email-templates', 'email-templates.html'],
  ['/thinkpro-admin/email-preferences', 'admin-email-preferences.html'],
  ['/thinkpro-admin/settings', 'admin-settings.html'],
  ['/thinkpro-admin/email-preview', 'email-preview.html'],
];

/** 管理员后台首页（所有非法/未知跳转目标的兜底地址） */
export const ADMIN_HOME = '/thinkpro-admin';

export const ADMIN_PAGE_FILES: ReadonlyMap<string, string> = new Map(ADMIN_PAGES);

/** 尾部杂字符：空白、竖线、各种引号等 */
const TRAILING_JUNK = /[\s|"'`<>“”‘’]+$/;
/** 路径中出现即判定为非法的字符（防 javascript:、防换行头注入、防残留杂字符） */
const ILLEGAL_CHARS = /[\s\\|"'`<>]/;
/** 合法的管理员页面路径形态 */
const ADMIN_PATH_SHAPE = /^\/thinkpro-admin(\/[A-Za-z0-9._-]+)*$/;

/**
 * 规范化路径：
 * - 去掉 query / hash
 * - 百分号解码（/thinkpro-admin/emails%7C → /thinkpro-admin/emails|）
 * - 反斜杠转正斜杠、折叠重复斜杠
 * - 去掉尾部杂字符与尾部斜杠
 */
export function normalizeAdminPath(raw: unknown): string {
  let p = String(raw ?? '');
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  p = p.trim();
  try {
    p = decodeURIComponent(p);
  } catch {
    /* 解码失败按原样处理 */
  }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  p = p.replace(TRAILING_JUNK, '').replace(/\/+$/, '');
  return p;
}

/**
 * 把任意来源的 redirect 参数净化成安全的站内管理员页面地址。
 * 非站内地址、协议相对地址（//evil.com）、javascript: 等一律回后台首页，
 * 避免开放重定向 / 脚本注入，同时避免跳到不存在的路径产生 404。
 */
export function safeAdminRedirect(raw: unknown): string {
  // 只接受字符串（?redirect=a&redirect=b 时 express 会给出数组，直接视为非法）
  if (typeof raw !== 'string') return ADMIN_HOME;
  const p = normalizeAdminPath(raw);
  if (!p.startsWith('/') || p.startsWith('//')) return ADMIN_HOME;
  if (ILLEGAL_CHARS.test(p)) return ADMIN_HOME;
  return ADMIN_PATH_SHAPE.test(p) ? p : ADMIN_HOME;
}
