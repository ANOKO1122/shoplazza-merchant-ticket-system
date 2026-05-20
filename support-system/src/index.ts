import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Debug: verify env loaded
console.log('[support-bridge] DB URL:', (process.env.SUPPORT_DATABASE_URL || '').replace(/\/\/.*@/, '//***@'));

import express from 'express';
import rateLimit from 'express-rate-limit';
import { loadConfig, loadStoresConfig } from './config';
import { ensureTables, getPool } from './pg';
import { createShoplazzaWebhookRouter } from './shoplazza-webhook-routes';
import { createSupportRouter } from './support-routes';
import { createAdminRouter } from './admin-routes';
import { processDueEmailJobs } from './email-service';
import { getAutoBackfillEnabled, runBackfillForAllStores } from './backfill-jobs';
import { cleanupSyncLogs } from './log-service';

let config: ReturnType<typeof loadConfig>;
let storesConfig: Awaited<ReturnType<typeof loadStoresConfig>> | null = null;

try {
  config = loadConfig();
} catch (e: any) {
  console.error('[support-bridge] 配置加载失败:', e.message);
  process.exit(1);
}

const app = express();

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

// 速率限制：全局 API 100次/分钟，登录接口更严格
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '请求过于频繁，请稍后重试' },
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '登录尝试过于频繁，请 1 分钟后再试' },
});

app.use('/api/', apiLimiter);

app.use(express.json({ limit: '512kb' }));

// Shoplazza Webhook
app.use('/api/shoplazza', createShoplazzaWebhookRouter());

// Support API (顾客端)
app.use('/api/support', createSupportRouter());

// Admin API (客服端)
app.use('/api/admin', createAdminRouter());

// Static files (前端页面)
app.use(express.static(path.resolve(__dirname, '..', 'public')));

// 路由映射
app.get('/login', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'login.html'));
});
app.get('/ticket', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'ticket.html'));
});
app.get('/admin', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'admin.html'));
});
app.get('/admin-stores', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'admin-stores.html'));
});
app.get('/admin-emails', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'admin-emails.html'));
});
app.get('/admin-logs', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'admin-logs.html'));
});
app.get('/admin/ticket-preview', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'admin-ticket-preview.html'));
});
app.get('/admin/ticket-preview.html', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'admin-ticket-preview.html'));
});
app.get('/admin/email-templates', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'email-templates.html'));
});
app.get('/admin-settings', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'admin-settings.html'));
});
app.get('/admin/email-preview', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'email-preview.html'));
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'support-bridge',
    stores: storesConfig ? storesConfig.length : 0,
  });
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

  // 优雅退出：关闭定时器、释放数据库连接池
  const shutdown = async () => {
    console.log('\n[support-bridge] 正在关闭...');
    if (emailTimer) clearInterval(emailTimer);
    if (backfillTimer) clearInterval(backfillTimer);
    try {
      const pool = getPool();
      await pool.end();
      console.log('[support-bridge] 数据库连接池已关闭');
    } catch (e: any) {
      console.error('[support-bridge] 关闭连接池失败:', e.message);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const emailWorkerIntervalMs = Number(process.env.SUPPORT_EMAIL_WORKER_INTERVAL_MS) || 30000;
  emailTimer = setInterval(() => {
    processDueEmailJobs({ limit: 10 }).catch((e: any) => {
      console.error('[email-worker] failed:', e.message);
    });
  }, emailWorkerIntervalMs);
  emailTimer.unref();

  // 每小时自动兜底同步（整点过 5 分钟首次触发）
  const backfillIntervalMs = 60 * 60 * 1000;
  const firstBackfillDelay = (() => {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(5, 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);
    return next.getTime() - now.getTime();
  })();

  const scheduleBackfill = () => {
    backfillTimer = setInterval(async () => {
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
    }, backfillIntervalMs);
    if (backfillTimer) backfillTimer.unref();
  };

  setTimeout(scheduleBackfill, firstBackfillDelay);

  // 检查自动兜底开关状态
  const backfillEnabled = await getAutoBackfillEnabled();
  if (backfillEnabled) {
    console.log(`[support-bridge] 自动兜底: 已开启，将在 ${Math.round(firstBackfillDelay / 60000)} 分钟后首次运行`);
  } else {
    console.log('[support-bridge] 自动兜底: 已关闭，可在邮件管理页手动开启');
  }

  // 启动时清理过期同步日志 + 每 24h 重复
  const retentionDays = Number(process.env.SUPPORT_SYNC_LOG_RETENTION_DAYS) || 30;
  cleanupSyncLogs(retentionDays).catch((e: any) => console.error('[log-cleanup] failed:', e.message));
  const cleanupTimer = setInterval(() => {
    cleanupSyncLogs(retentionDays).catch((e: any) => console.error('[log-cleanup] failed:', e.message));
  }, 24 * 60 * 60 * 1000);
  cleanupTimer.unref();
}

startup();
