import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Debug: verify env loaded
console.log('[support-bridge] DB URL:', (process.env.SUPPORT_DATABASE_URL || '').replace(/\/\/.*@/, '//***@'));

import express from 'express';
import rateLimit from 'express-rate-limit';
import { loadConfig, loadStoresConfig } from './config';
import { ensureTables, closeDatabasePools } from './pg';
import { createShoplazzaWebhookRouter } from './shoplazza-webhook-routes';
import { createSupportRouter } from './support-routes';
import { createAdminRouter } from './admin-routes';
import { processDueEmailJobs, cleanupEmailJobs } from './email-service';
import { getAutoBackfillEnabled, runBackfillForAllStores } from './backfill-jobs';
import { processPendingFulfillmentWebhooks } from './fulfillment-webhook';
import { processPendingPaidWebhooks } from './paid-webhook';
import { processPendingShippingAddressRequests } from './order-address-service';
import { createApiLimiter, createWebhookIngressRouter, isShoplazzaWebhookRequest } from './api-rate-limits';
import { logWebhookRejection } from './webhook-security';
import { runFulfillmentReconciliation } from './fulfillment-reconcile';
import { cleanupSyncLogs, cleanupOperationLogs } from './log-service';
import { getRequestAgent } from './auth';
import { ADMIN_HOME, ADMIN_PAGES, ADMIN_PAGE_FILES, normalizeAdminPath, safeAdminRedirect } from './admin-pages';

let config: ReturnType<typeof loadConfig>;
let storesConfig: Awaited<ReturnType<typeof loadStoresConfig>> | null = null;

try {
  config = loadConfig();
} catch (e: any) {
  console.error('[support-bridge] 配置加载失败:', e.message);
  process.exit(1);
}

const app = express();

// 信任 nginx 反代传递的 X-Forwarded-For 头
app.set('trust proxy', 1);

// CORS
const corsAllowOrigins = (process.env.SUPPORT_CORS_ORIGINS || '').trim();
const corsAllowList = corsAllowOrigins ? corsAllowOrigins.split(',').map(s => s.trim()).filter(Boolean) : null;

// 安全响应头
app.use((_req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// CORS
app.use((req, res, next) => {
  const origin = req.get('Origin');
  let allow: string | undefined;
  if (corsAllowList && corsAllowList.length > 0) {
    if (corsAllowList.includes('*')) {
      allow = origin;
    } else if (origin && corsAllowList.includes(origin)) {
      allow = origin;
    }
  } else if (origin) {
    allow = origin;
  }
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', allow);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// Interactive APIs share an IP budget; authenticated webhook stores use their own.
const apiLimiter = createApiLimiter();

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '登录尝试过于频繁，请 1 分钟后再试' },
});

app.use('/api/', apiLimiter);
// Authenticate webhook headers before spending work parsing an untrusted body.
app.use('/api/shoplazza', createWebhookIngressRouter());

app.use(express.json({ limit: '512kb' }));

// 挂载上传文件静态目录（图片附件访问）
app.use('/uploads', express.static(path.resolve(__dirname, '..', 'public', 'uploads'), {
  maxAge: '7d',          // 图片缓存 7 天
  immutable: true,       // 文件名含随机 hex，内容永不变
}));

// Shoplazza Webhook
app.use('/api/shoplazza', createShoplazzaWebhookRouter());

// Support API (顾客端)
app.use('/api/support', createSupportRouter());

// Admin API (客服端)
app.use('/api/admin', createAdminRouter());

// Static files (CSS/JS/assets) — 不含 index 自动映射，防止根路径泄露页面
const publicDir = path.resolve(__dirname, '..', 'public');

// 旧静态文件直链 → 正式路由（否则可绕过页面鉴权直接访问 public/*.html）
const PRIVATE_PAGE_ALIASES: Record<string, string> = {
  '/admin.html': ADMIN_HOME,
  '/admin-stores.html': '/thinkpro-admin/stores',
  '/admin-emails.html': '/thinkpro-admin/emails',
  '/admin-logs.html': '/thinkpro-admin/logs',
  '/admin-settings.html': '/thinkpro-admin/settings',
  '/admin-ticket-preview.html': '/thinkpro-admin/ticket-preview',
  '/email-templates.html': '/thinkpro-admin/email-templates',
  '/email-preview.html': '/thinkpro-admin/email-preview',
  '/login.html': '/login',
  '/ticket.html': '/ticket',
};

app.use((req, res, next) => {
  const alias = req.method === 'GET' ? PRIVATE_PAGE_ALIASES[normalizeAdminPath(req.path)] : undefined;
  if (!alias) {
    next();
    return;
  }
  const q = req.originalUrl.indexOf('?');
  res.redirect(302, alias + (q >= 0 ? req.originalUrl.slice(q) : ''));
});

app.use(express.static(publicDir, {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
      return;
    }
    if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return;
    }
    if (/\.(css|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  },
}));

// 根路径：返回 404 页面（不允许直接访问）
app.get('/', (_req, res) => {
  res.status(404).sendFile(path.join(publicDir, 'not-found.html'));
});

// 顾客端路由（保持不变）
app.get('/ticket', (_req, res) => {
  res.sendFile(path.join(publicDir, 'ticket.html'));
});

// 登录页：已登录直接回跳（回跳目标必须先过白名单，防开放重定向 / javascript: 注入）
app.get('/login', async (req, res, next) => {
  try {
    const target = safeAdminRedirect(req.query.redirect);
    const agent = await getRequestAgent(req).catch(() => null);
    if (agent) {
      res.redirect(302, target);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'login.html'));
  } catch (e) {
    next(e);
  }
});

// 页面级鉴权：管理员页面必须携带有效会话，未登录则跳登录页并带上回跳目标
async function requireAgentPage(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const agent = await getRequestAgent(req);
    if (!agent) {
      const back = normalizeAdminPath(req.path) || ADMIN_HOME;
      res.redirect(302, '/login?redirect=' + encodeURIComponent(back));
      return;
    }
    (req as any).agent = agent;
    next();
  } catch (e) {
    next(e);
  }
}

// 管理员路由 → 统一前缀 /thinkpro-admin（全部经过页面级鉴权）
for (const [routePath, file] of ADMIN_PAGES) {
  app.get(routePath, requireAgentPage, (_req, res) => {
    // 后台页面不缓存，避免退出登录后仍能通过缓存/后退看到内容
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, file));
  });
}

// /thinkpro-admin 下未注册的路径（含尾部杂字符、重复斜杠、大小写笔误后的历史链接）
// 不再返回裸 404，统一回到后台首页，避免“登录后跳转即 Not Found”
app.use('/thinkpro-admin', (req, res) => {
  const cleaned = normalizeAdminPath(req.baseUrl + req.path);
  const target = ADMIN_PAGE_FILES.has(cleaned) ? cleaned : ADMIN_HOME;
  console.warn(`[support-bridge] 未知管理路径，已重定向: ${req.originalUrl} → ${target}`);
  res.redirect(302, target);
});

// 旧路径兼容（短期保留，后续可删）
app.get('/admin', (_req, res) => res.redirect(301, '/thinkpro-admin'));
app.get('/admin-stores', (_req, res) => res.redirect(301, '/thinkpro-admin/stores'));
app.get('/admin-emails', (_req, res) => res.redirect(301, '/thinkpro-admin/emails'));
app.get('/admin-logs', (_req, res) => res.redirect(301, '/thinkpro-admin/logs'));
app.get('/admin-settings', (_req, res) => res.redirect(301, '/thinkpro-admin/settings'));
app.get('/admin/ticket-preview', (_req, res) => res.redirect(301, '/thinkpro-admin/ticket-preview'));
app.get('/admin/email-templates', (_req, res) => res.redirect(301, '/thinkpro-admin/email-templates'));
app.get('/admin/email-preview', (_req, res) => res.redirect(301, '/thinkpro-admin/email-preview'));

// Health check (必须在 404 兜底之前)
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'support-bridge',
    stores: storesConfig ? storesConfig.length : 0,
  });
});

// ── Multer / 通用错误处理中间件（必须在所有路由之后、404 兜底之前注册） ──
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (isShoplazzaWebhookRequest(_req)) {
    const reason = err.type === 'entity.too.large' ? 'payload_too_large'
      : err.type === 'entity.parse.failed' ? 'invalid_json' : 'persist_failed';
    logWebhookRejection(_req, reason);
    if (!res.headersSent) {
      const status = reason === 'payload_too_large' ? 413 : reason === 'invalid_json' ? 400 : 503;
      res.status(status).json({ ok: false, error: 'Could not accept webhook' });
    }
    return;
  }
  // Multer 文件大小超限
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ ok: false, error: 'File too large. Maximum size is 5MB per file.' });
    return;
  }
  // Multer 文件数量超限
  if (err.code === 'LIMIT_FILE_COUNT') {
    res.status(400).json({ ok: false, error: 'Too many files. Maximum is 3 per message.' });
    return;
  }
  // Multer 字段名不符
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    res.status(400).json({ ok: false, error: 'Unexpected file field. Use "images" as the field name.' });
    return;
  }
  // 自定义文件类型错误
  if (err.message && err.message.includes('Unsupported file type')) {
    res.status(400).json({ ok: false, error: err.message });
    return;
  }
  // 其他未预期错误
  console.error('[support-bridge] 未捕获错误:', err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// 兜底 404：浏览器访问返回友好 HTML 页面，接口等其它请求保持纯文本
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && req.accepts('html')) {
    res.status(404).sendFile(path.join(publicDir, 'not-found.html'));
    return;
  }
  res.status(404).send('Not Found');
});

async function startup() {
  try {
    await ensureTables();
  } catch (e: any) {
    console.error('[support-bridge] 数据库初始化失败:', e.message);
    process.exit(1);
  }

  storesConfig = await loadStoresConfig();

  app.listen(config.port, () => {
    console.log(`[support-bridge] 已启动，端口 ${config.port}`);
    console.log(`[support-bridge] 店铺数: ${storesConfig!.length}`);
  });

  // 定时器引用（用于优雅关闭）
  let emailTimer: ReturnType<typeof setInterval> | null = null;
  let backfillTimer: ReturnType<typeof setInterval> | null = null;
  let fulfillmentTimer: ReturnType<typeof setInterval> | null = null;
  let paidWebhookTimer: ReturnType<typeof setInterval> | null = null;
  let shippingAddressTimer: ReturnType<typeof setInterval> | null = null;
  let fulfillmentReconcileTimer: ReturnType<typeof setInterval> | null = null;

  // 优雅退出：关闭定时器、释放数据库连接池
  const shutdown = async () => {
    console.log('\n[support-bridge] 正在关闭...');
    if (emailTimer) clearInterval(emailTimer);
    if (backfillTimer) clearInterval(backfillTimer);
    if (fulfillmentTimer) clearInterval(fulfillmentTimer);
    if (paidWebhookTimer) clearInterval(paidWebhookTimer);
    if (shippingAddressTimer) clearInterval(shippingAddressTimer);
    if (fulfillmentReconcileTimer) clearInterval(fulfillmentReconcileTimer);
    try {
      await closeDatabasePools();
      console.log('[support-bridge] 数据库连接池已关闭');
    } catch (e: any) {
      console.error('[support-bridge] 关闭连接池失败:', e.message);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 本地冒烟测试开关：SUPPORT_DISABLE_BACKGROUND_JOBS=true 时不启动后台定时任务，
  // 避免测试实例误发邮件 / 误跑兜底同步
  const backgroundJobsDisabled = process.env.SUPPORT_DISABLE_BACKGROUND_JOBS === 'true';
  if (backgroundJobsDisabled) {
    console.log('[support-bridge] 后台定时任务已禁用（SUPPORT_DISABLE_BACKGROUND_JOBS=true）');
  }

  if (!backgroundJobsDisabled) {
    const processShippingAddresses = () => {
      processPendingShippingAddressRequests().catch(() => console.error('[shipping-address-worker] failed; will recheck'));
    };
    processShippingAddresses();
    shippingAddressTimer = setInterval(processShippingAddresses, 3000);
    shippingAddressTimer.unref();
    const processFulfillments = () => {
      processPendingFulfillmentWebhooks().catch(() => console.error('[fulfillment-worker] failed; will retry'));
    };
    processFulfillments();
    fulfillmentTimer = setInterval(processFulfillments, 15000);
    fulfillmentTimer.unref();
    const processPaid = () => {
      processPendingPaidWebhooks().catch(() => console.error('[paid-webhook-worker] failed; will retry'));
    };
    processPaid();
    paidWebhookTimer = setInterval(processPaid, 15000);
    paidWebhookTimer.unref();
    const reconcileFulfillments = async () => {
      try {
        if (await getAutoBackfillEnabled()) await runFulfillmentReconciliation({ limit: 200 });
      } catch (error: any) {
        console.error('[fulfillment-reconcile] failed:', error.message);
      }
    };
    // Webhooks handle live updates; reconcile one bounded batch each hour.
    fulfillmentReconcileTimer = setInterval(reconcileFulfillments, 60 * 60 * 1000);
    fulfillmentReconcileTimer.unref();
  }

  const emailWorkerIntervalMs = Number(process.env.SUPPORT_EMAIL_WORKER_INTERVAL_MS) || 30000;
  if (!backgroundJobsDisabled) {
    emailTimer = setInterval(() => {
      processDueEmailJobs({ limit: 10 }).catch((e: any) => {
        console.error('[email-worker] failed:', e.message);
      });
    }, emailWorkerIntervalMs);
    emailTimer.unref();
  }

  // 每小时自动兜底同步（整点过 5 分钟首次触发）
  const backfillIntervalMs = 60 * 60 * 1000;
  const firstBackfillDelay = (() => {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(5, 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);
    return next.getTime() - now.getTime();
  })();

  const doBackfill = async () => {
    try {
      const enabled = await getAutoBackfillEnabled();
      if (!enabled) {
        console.log('[backfill-worker] 自动兜底已关闭，跳过');
        return;
      }
      console.log('[backfill-worker] 开始每小时自动兜底同步...');
      const results = await runBackfillForAllStores((msg) => {
        console.log(`[backfill-worker] ${msg}`);
      });
      const totalOrders = results.reduce((s, r) => s + r.ordersFound, 0);
      const totalEmails = results.reduce((s, r) => s + r.emailJobsCreated, 0);
      console.log(`[backfill-worker] 完成: ${results.length} 店铺, ${totalOrders} 订单, ${totalEmails} 新邮件任务`);
    } catch (e: any) {
      console.error('[backfill-worker] failed:', e.message);
    }
  };

  const scheduleBackfill = () => {
    // 首次到达 xx:05 时立即执行一次，然后每小时重复
    doBackfill();
    backfillTimer = setInterval(doBackfill, backfillIntervalMs);
    if (backfillTimer) backfillTimer.unref();
  };

  if (!backgroundJobsDisabled) {
    setTimeout(scheduleBackfill, firstBackfillDelay);
  }

  // 检查自动兜底开关状态
  const backfillEnabled = await getAutoBackfillEnabled();
  if (backfillEnabled) {
    console.log(`[support-bridge] 自动兜底: 已开启，将在 ${Math.round(firstBackfillDelay / 60000)} 分钟后首次运行`);
  } else {
    console.log('[support-bridge] 自动兜底: 已关闭，可在邮件管理页手动开启');
  }

  // 启动时清理过期日志和邮件任务，之后每 24 小时重复
  const logRetentionDays = Number(process.env.SUPPORT_SYNC_LOG_RETENTION_DAYS) || 60;
  const emailRetentionDays = Number(process.env.SUPPORT_EMAIL_JOB_RETENTION_DAYS) || 120;
  const runRetention = () => {
    cleanupSyncLogs(logRetentionDays).catch((e: any) => console.error('[log-cleanup] sync failed:', e.message));
    cleanupOperationLogs(logRetentionDays).catch((e: any) => console.error('[log-cleanup] operation failed:', e.message));
    cleanupEmailJobs(emailRetentionDays).catch((e: any) => console.error('[email-cleanup] failed:', e.message));
  };
  runRetention();
  const cleanupTimer = setInterval(runRetention, 24 * 60 * 60 * 1000);
  cleanupTimer.unref();
}

startup();
