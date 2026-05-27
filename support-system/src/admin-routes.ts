import express from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { loginAgent, createSession, destroySession, verifySession, changeAgentPassword } from './auth';
import { listTickets, getTicketByPublicNo, getTicketMessages, getOrderSnapshot, addAgentMessage, updateTicketStatus, reopenTicket } from './ticket-service';
import { listStores, createStore, updateStore, deleteStore, getStoreBySubdomain, decryptToken } from './store-service';
import { query } from './pg';
import { cancelEmailJob, ensureAgentReplyNoticeJob, getEmailJobDetail, listEmailJobs, processDueEmailJobs, resendEmailJob, getAutoSendEnabled, setAutoSendEnabled, listEmailTemplates, getEmailTemplate, updateEmailTemplate, renderTemplateString, renderEmailFromTemplate, listTemplatePresets, createTemplatePreset, deleteTemplatePreset, activateTemplatePreset, formatEasternTime, getMailTestMode, setMailTestMode, getPublicBaseUrl, setPublicBaseUrl, getEffectivePublicBaseUrl } from './email-service';
import { runBackfillForStore, getAllBackfillStates, getAutoBackfillEnabled, setAutoBackfillEnabled } from './backfill-jobs';
import { logOperation, listSyncLogs, listOperationLogs } from './log-service';
import { buildCustomerPreviewResponse, extractTrackingNo } from './admin-preview';
import { buildStoreDomain } from './config';
import { registerWebhook, deleteWebhook, findWebhookByTopic, listWebhooks } from './shoplazza-client';
import { mapPaymentMethodDisplay } from './normalize-order';

export function createAdminRouter(): express.Router {
  const router = express.Router();

  const COOKIE_NAME = 'support_session';

  function parseCookies(req: express.Request): Record<string, string> {
    const header = req.headers.cookie;
    if (!header) return {};
    const map: Record<string, string> = {};
    header.split(';').forEach(pair => {
      const [k, ...rest] = pair.trim().split('=');
      if (k && rest.length) map[k] = rest.join('=');
    });
    return map;
  }

  async function getAgent(req: express.Request) {
    const raw = parseCookies(req)[COOKIE_NAME];
    if (!raw) return null;
    return verifySession(raw);
  }

  // POST /api/admin/login
  const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: '登录尝试过于频繁，请 1 分钟后再试' },
  });

  router.post('/login', loginLimiter, async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        res.status(400).json({ ok: false, error: '缺少用户名或密码' });
        return;
      }
      const agent = await loginAgent(username, password);
      if (!agent) {
        res.status(401).json({ ok: false, error: '用户名或密码错误' });
        return;
      }
      const token = await createSession(agent.id);
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure: req.protocol === 'https' || req.get('X-Forwarded-Proto') === 'https',
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 86400 * 1000,
      });
      res.json({ ok: true, agent: { id: agent.id, name: agent.name, role: agent.role } });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/logout
  router.post('/logout', async (req, res) => {
    const raw = parseCookies(req)[COOKIE_NAME];
    if (raw) {
      const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
      await destroySession(tokenHash);
    }
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  // GET /api/admin/me
  router.get('/me', async (req, res) => {
    const agent = await getAgent(req);
    if (!agent) {
      res.status(401).json({ ok: false, error: '未登录' });
      return;
    }
    res.json({ ok: true, agent: { id: agent.agentId, name: agent.name, role: agent.role } });
  });

  // PUT /api/admin/me/password — 修改当前登录密码
  router.put('/me/password', async (req, res) => {
    try {
      const agent = await getAgent(req);
      if (!agent) {
        res.status(401).json({ ok: false, error: '未登录' });
        return;
      }
      const { old_password, new_password } = req.body || {};
      if (!old_password || !new_password) {
        res.status(400).json({ ok: false, error: '缺少旧密码或新密码' });
        return;
      }
      if (String(new_password).length < 6) {
        res.status(400).json({ ok: false, error: '新密码至少 6 位' });
        return;
      }
      const ok = await changeAgentPassword(agent.agentId, String(old_password), String(new_password));
      if (!ok) {
        res.status(401).json({ ok: false, error: '旧密码错误' });
        return;
      }
      res.json({ ok: true, message: '密码已修改' });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Middleware: require agent
  router.use(async (req, res, next) => {
    const agent = await getAgent(req);
    if (!agent) {
      res.status(401).json({ ok: false, error: '未登录' });
      return;
    }
    (req as any).agent = agent;
    next();
  });

  // GET /api/admin/email-jobs
  router.get('/email-jobs', async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 30));
      const result = await listEmailJobs({
        status: (req.query.status as string) || 'all',
        emailType: (req.query.email_type as string) || 'all',
        storeSubdomain: (req.query.store as string) || '',
        q: (req.query.q as string) || '',
        page,
        pageSize,
      });
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/email-jobs/:id
  router.get('/email-jobs/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, error: 'Invalid email job id' });
        return;
      }
      const detail = await getEmailJobDetail(id);
      if (!detail) {
        res.status(404).json({ ok: false, error: 'Email job not found' });
        return;
      }
      res.json({ ok: true, ...detail });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/email-jobs/:id/resend
  router.post('/email-jobs/:id/resend', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, error: 'Invalid email job id' });
        return;
      }
      const job = await resendEmailJob(id);
      if (!job) {
        res.status(400).json({ ok: false, error: 'Email job not found or cannot be resent (already sent/sending)' });
        return;
      }
      const sendOk = job.status === 'sent';
      const actionLabel = job.retry_count > 0 ? '重发' : '发送';
      await logOperation({
        category: 'email',
        action: 'job_resent',
        actor: (req as any).agent?.name || 'unknown',
        storeSubdomain: job.store_subdomain,
        target: job.email_job_no,
        summary: `手动${actionLabel}邮件: ${job.email_job_no}${sendOk ? '' : ' (发送失败，见系统日志)'}`,
        status: sendOk ? 'success' : 'partial',
        failedAtStep: sendOk ? undefined : 'smtp_send',
        detailJson: { job_no: job.email_job_no, retry_count: job.retry_count, send_status: job.status },
      });
      res.json({ ok: true, job });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/email-jobs/:id/cancel
  router.post('/email-jobs/:id/cancel', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, error: 'Invalid email job id' });
        return;
      }
      // 先查任务号用于日志
      const jobR = await query(`SELECT email_job_no FROM support_email_jobs WHERE id = $1`, [id]);
      const jobNo = jobR.rows[0]?.email_job_no || `#${id}`;

      const ok = await cancelEmailJob(id);
      if (!ok) {
        res.status(400).json({ ok: false, error: 'Only pending or failed email jobs can be cancelled' });
        return;
      }
      await logOperation({
        category: 'email',
        action: 'job_cancelled',
        actor: (req as any).agent?.name || 'unknown',
        target: jobNo,
        summary: `取消待发送邮件: ${jobNo}`,
        status: 'success',
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/email-jobs/:id/preview — 返回渲染后的邮件 HTML（模拟顾客视角，token脱敏）
  router.get('/email-jobs/:id/preview', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, error: 'Invalid email job id' });
        return;
      }
      const detail = await getEmailJobDetail(id);
      if (!detail) {
        res.status(404).json({ ok: false, error: 'Email job not found' });
        return;
      }
      const j = detail.job;
      const snap = detail.orderSnapshot || {};

      // 始终用数据库模板重新渲染，保证与顾客实际收到的邮件一致（仅链接脱敏）
      const { getEffectivePublicBaseUrl } = await import('./email-service');
      const baseUrl = await getEffectivePublicBaseUrl();
      const clientLink = j.client_link_snapshot || baseUrl + '/ticket?t=...';
      const rendered = await renderEmailFromTemplate(j.email_type, {
        store_name: j.store_name || '',
        store_domain: j.store_domain || '',
        order_id: j.order_id || '',
        order_number: j.order_number || j.order_id || '',
        customer_name: snap.customer_name || '',
        customer_email: j.customer_email,
        public_ticket_no: j.public_ticket_no || '',
        client_link: clientLink,
        paid_at: formatEasternTime(j.ordered_at || snap.paid_at),
        payment_method: mapPaymentMethodDisplay(snap.payment_method || ''),
        card_last4: snap.card_last4 || '',
        order_amount: snap.order_amount || '',
        order_currency: snap.order_currency || '',
      });
      res.json({ ok: true, subject: rendered.subject, html: rendered.html });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/email-settings
  router.get('/email-settings', async (_req, res) => {
    try {
      const enabled = await getAutoSendEnabled();
      res.json({ ok: true, auto_send_enabled: enabled });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // PATCH /api/admin/email-settings
  router.patch('/email-settings', async (req, res) => {
    try {
      const { auto_send_enabled } = req.body || {};
      if (typeof auto_send_enabled !== 'boolean') {
        res.status(400).json({ ok: false, error: '缺少 auto_send_enabled 参数' });
        return;
      }
      await setAutoSendEnabled(auto_send_enabled);
      await logOperation({
        category: 'config',
        action: 'auto_send_toggled',
        actor: (req as any).agent?.name || 'unknown',
        summary: `自动发送已${auto_send_enabled ? '开启' : '关闭'}`,
        status: 'success',
      });
      res.json({ ok: true, auto_send_enabled });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/pending-reply-count
  router.get('/pending-reply-count', async (_req, res) => {
    try {
      const r = await query(
        `SELECT COUNT(*) FROM support_email_jobs WHERE email_type = 'agent_reply_notice' AND status = 'pending'`,
      );
      res.json({ ok: true, count: Number(r.rows[0]?.count || 0) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 兜底任务（订单自动增量查漏）──

  // GET /api/admin/backfill/status
  router.get('/backfill/status', async (_req, res) => {
    try {
      const states = await getAllBackfillStates();
      res.json({ ok: true, states });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/backfill/trigger
  router.post('/backfill/trigger', async (req, res) => {
    try {
      const { store_subdomain } = req.body || {};
      // 异步执行，先返回 202
      res.status(202).json({ ok: true, message: '兜底任务已触发，请稍后查看状态' });

      const onProgress = (msg: string) => {
        console.log(`[backfill-api] ${msg}`);
      };

      if (store_subdomain) {
        await runBackfillForStore(store_subdomain, onProgress);
      } else {
        const { runBackfillForAllStores } = await import('./backfill-jobs');
        await runBackfillForAllStores(onProgress);
      }
    } catch (e: any) {
      console.error('[backfill-api] trigger failed:', e.message);
    }
  });

  // GET /api/admin/backfill-settings
  router.get('/backfill-settings', async (_req, res) => {
    try {
      const enabled = await getAutoBackfillEnabled();
      res.json({ ok: true, auto_backfill_enabled: enabled });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // PATCH /api/admin/backfill-settings
  router.patch('/backfill-settings', async (req, res) => {
    try {
      const { auto_backfill_enabled } = req.body || {};
      if (typeof auto_backfill_enabled !== 'boolean') {
        res.status(400).json({ ok: false, error: '缺少 auto_backfill_enabled 参数' });
        return;
      }
      await setAutoBackfillEnabled(auto_backfill_enabled);
      await logOperation({
        category: 'config',
        action: 'auto_backfill_toggled',
        actor: (req as any).agent?.name || 'unknown',
        summary: `自动查漏已${auto_backfill_enabled ? '开启' : '关闭'}`,
        status: 'success',
      });
      res.json({ ok: true, auto_backfill_enabled });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/sync-logs
  router.get('/sync-logs', async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 30));
      const result = await listSyncLogs({
        source: (req.query.source as string) || 'all',
        status: (req.query.status as string) || 'all',
        storeSubdomain: (req.query.store as string) || '',
        page,
        pageSize,
      });
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/operation-logs
  router.get('/operation-logs', async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 30));
      const result = await listOperationLogs({
        category: (req.query.category as string) || 'all',
        status: (req.query.status as string) || 'all',
        storeSubdomain: (req.query.store as string) || '',
        q: (req.query.q as string) || '',
        page,
        pageSize,
      });
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/tickets
  router.get('/tickets', async (req, res) => {
    try {
      const status = (req.query.status as string) || '';
      const q = (req.query.q as string) || '';
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 30));
      const timeFieldRaw = (req.query.time_field as string) || '';
      const timeField = (timeFieldRaw === 'created_at' || timeFieldRaw === 'updated_at') ? timeFieldRaw : '';
      const timeRangeRaw = (req.query.time_range as string) || '';
      const timeRange = (timeRangeRaw === '24h' || timeRangeRaw === '2d' || timeRangeRaw === '7d') ? timeRangeRaw : '';

      const result = await listTickets({ status, q, page, pageSize, timeField, timeRange });
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/tickets/:publicTicketNo
  router.get('/tickets/:publicTicketNo', async (req, res) => {
    try {
      const ticket = await getTicketByPublicNo(req.params.publicTicketNo);
      if (!ticket) {
        res.status(404).json({ ok: false, error: '工单不存在' });
        return;
      }

      const [snapshot, messages] = await Promise.all([
        getOrderSnapshot({
          storeSubdomain: ticket.store_subdomain,
          orderId: ticket.order_id,
          customerEmail: ticket.customer_email,
        }),
        getTicketMessages(req.params.publicTicketNo),
      ]);

      const order = snapshot ? {
        store_name: snapshot.store_name || '',
        order_number: snapshot.order_number || '',
        order_amount: snapshot.order_amount || '',
        order_currency: snapshot.order_currency || '',
        paid_at: snapshot.paid_at || null,
        payment_method: mapPaymentMethodDisplay(snapshot.payment_method),
        card_last4: snapshot.card_last4 || '',
        tracking_no: extractTrackingNo(snapshot),
        customer_name: snapshot.customer_name || '',
        items: snapshot.items_json || [],
      } : null;

      res.json({
        ok: true,
        ticket: {
          public_ticket_no: ticket.public_ticket_no,
          status: ticket.status,
          issue_type: ticket.issue_type,
          customer_email: ticket.customer_email,
          customer_name: ticket.customer_name,
          store_name: ticket.store_name,
          store_subdomain: ticket.store_subdomain,
          order_id: ticket.order_id,
          order_number: ticket.order_number,
          arbitration_requested: ticket.arbitration_requested || false,
          created_at: ticket.created_at,
          updated_at: ticket.updated_at,
        },
        order,
        messages: messages.map((m: any) => ({
          id: m.id,
          sender_type: m.sender_type,
          sender_name: m.sender_name,
          content: m.content,
          created_at: m.created_at,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/tickets/:publicTicketNo/customer-preview
  router.get('/tickets/:publicTicketNo/customer-preview', async (req, res) => {
    try {
      const ticket = await getTicketByPublicNo(req.params.publicTicketNo);
      if (!ticket) {
        res.status(404).json({ ok: false, error: '工单不存在' });
        return;
      }

      const [snapshot, messages] = await Promise.all([
        getOrderSnapshot({
          storeSubdomain: ticket.store_subdomain,
          orderId: ticket.order_id,
          customerEmail: ticket.customer_email,
        }),
        getTicketMessages(req.params.publicTicketNo),
      ]);
      if (!snapshot) {
        res.status(404).json({ ok: false, error: '订单快照不存在' });
        return;
      }

      res.json(buildCustomerPreviewResponse({ snapshot, ticket, messages }));
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/orders/:storeSubdomain/:orderId/customer-preview
  router.get('/orders/:storeSubdomain/:orderId/customer-preview', async (req, res) => {
    try {
      const email = String(req.query.email || '').trim().toLowerCase();
      const params: unknown[] = [req.params.storeSubdomain, req.params.orderId];
      let where = `store_subdomain = $1 AND order_id = $2`;
      if (email) {
        params.push(email);
        where += ` AND customer_email = $3`;
      }
      const snapshotR = await query(
        `SELECT * FROM support_order_snapshots
         WHERE ${where}
         ORDER BY updated_at DESC
         LIMIT 1`,
        params,
      );
      const snapshot = snapshotR.rows[0] || null;
      if (!snapshot) {
        res.status(404).json({ ok: false, error: '订单快照不存在' });
        return;
      }

      const ticketR = await query(
        `SELECT * FROM support_tickets
         WHERE store_subdomain = $1 AND order_id = $2 AND customer_email = $3
         ORDER BY updated_at DESC
         LIMIT 1`,
        [snapshot.store_subdomain, snapshot.order_id, snapshot.customer_email],
      );
      const ticket = ticketR.rows[0] || null;
      const messages = ticket ? await getTicketMessages(ticket.public_ticket_no) : [];
      res.json(buildCustomerPreviewResponse({ snapshot, ticket, messages }));
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/tickets/:publicTicketNo/messages
  router.post('/tickets/:publicTicketNo/messages', async (req, res) => {
    try {
      const agent = (req as any).agent;
      const { content } = req.body || {};
      if (!content) {
        res.status(400).json({ ok: false, error: '缺少 content' });
        return;
      }

      const ticket = await getTicketByPublicNo(req.params.publicTicketNo);
      if (!ticket) {
        res.status(404).json({ ok: false, error: '工单不存在' });
        return;
      }

      if (ticket.status === 'closed') {
        res.status(400).json({ ok: false, error: '工单已关闭' });
        return;
      }

      await addAgentMessage({
        publicTicketNo: req.params.publicTicketNo,
        agentId: agent.agentId,
        agentName: agent.name,
        content,
      });

      await ensureAgentReplyNoticeJob({
        storeSubdomain: ticket.store_subdomain,
        storeName: ticket.store_name,
        storeDomain: buildStoreDomain(ticket.store_subdomain),
        orderId: ticket.order_id,
        orderNumber: ticket.order_number,
        customerEmail: ticket.customer_email,
        publicTicketNo: ticket.public_ticket_no,
      });

      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/tickets/:publicTicketNo/notify-email
  router.post('/tickets/:publicTicketNo/notify-email', async (req, res) => {
    try {
      const ticket = await getTicketByPublicNo(req.params.publicTicketNo);
      if (!ticket) {
        res.status(404).json({ ok: false, error: 'Ticket not found' });
        return;
      }
      if (ticket.status === 'closed') {
        res.status(400).json({ ok: false, error: 'Closed tickets cannot send reply notices' });
        return;
      }

      const { job } = await ensureAgentReplyNoticeJob({
        storeSubdomain: ticket.store_subdomain,
        storeName: ticket.store_name,
        storeDomain: buildStoreDomain(ticket.store_subdomain),
        orderId: ticket.order_id,
        orderNumber: ticket.order_number,
        customerEmail: ticket.customer_email,
        publicTicketNo: ticket.public_ticket_no,
      });

      await processDueEmailJobs({ limit: 1, onlyJobId: Number(job.id) });
      const detail = await getEmailJobDetail(Number(job.id));
      res.json({ ok: true, job: detail?.job || job });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // PATCH /api/admin/tickets/:publicTicketNo/status
  router.patch('/tickets/:publicTicketNo/status', async (req, res) => {
    try {
      const { status } = req.body || {};
      if (!status || !['open', 'waiting', 'closed'].includes(status)) {
        res.status(400).json({ ok: false, error: '无效的状态值' });
        return;
      }

      const ticket = await getTicketByPublicNo(req.params.publicTicketNo);
      if (!ticket) {
        res.status(404).json({ ok: false, error: '工单不存在' });
        return;
      }

      await updateTicketStatus(req.params.publicTicketNo, status);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/tickets/:publicTicketNo/reopen
  router.post('/tickets/:publicTicketNo/reopen', async (req, res) => {
    try {
      const ticket = await getTicketByPublicNo(req.params.publicTicketNo);
      if (!ticket) {
        res.status(404).json({ ok: false, error: '工单不存在' });
        return;
      }

      if (ticket.status !== 'closed') {
        res.status(400).json({ ok: false, error: 'Only closed tickets can be reopened' });
        return;
      }

      await reopenTicket(req.params.publicTicketNo);

      await logOperation({
        category: 'ticket',
        action: 'ticket_reopened',
        actor: (req as any).agent?.name || 'unknown',
        storeSubdomain: ticket.store_subdomain,
        target: req.params.publicTicketNo,
        summary: `重新打开工单: ${req.params.publicTicketNo}`,
        status: 'success',
      });

      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/stores
  router.get('/stores', async (_req, res) => {
    try {
      const stores = await listStores();
      res.json({ ok: true, stores: stores.map(s => ({ id: s.id, subdomain: s.subdomain, store_name: s.store_name, enabled: s.enabled })) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/stores
  router.post('/stores', async (req, res) => {
    try {
      const { subdomain, store_name, access_token } = req.body || {};
      if (!subdomain || !access_token) {
        res.status(400).json({ ok: false, error: '缺少 subdomain 或 access_token' });
        return;
      }
      const store = await createStore({ subdomain, store_name, access_token });
      await logOperation({
        category: 'store',
        action: 'store_create',
        actor: (req as any).agent?.name || 'unknown',
        storeSubdomain: store.subdomain,
        target: store.store_name || store.subdomain,
        summary: `新增店铺: ${store.store_name || store.subdomain}`,
        status: 'success',
      });
      res.json({ ok: true, store: { id: store.id, subdomain: store.subdomain, store_name: store.store_name, enabled: store.enabled } });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // PUT /api/admin/stores/:id  (only allows updating store_name)
  router.put('/stores/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { store_name } = req.body || {};
      const store = await updateStore(id, { store_name });
      if (!store) {
        res.status(404).json({ ok: false, error: '店铺不存在' });
        return;
      }
      await logOperation({
        category: 'store',
        action: 'store_update',
        actor: (req as any).agent?.name || 'unknown',
        storeSubdomain: store.subdomain,
        target: store.store_name || store.subdomain,
        summary: `修改店铺名称: ${store.subdomain} → ${store.store_name || '(空)'}`,
        status: 'success',
      });
      res.json({ ok: true, store: { id: store.id, subdomain: store.subdomain, store_name: store.store_name, enabled: store.enabled } });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // PATCH /api/admin/stores/:id/toggle  (toggle enabled)
  router.patch('/stores/:id/toggle', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { enabled } = req.body || {};
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ ok: false, error: '缺少 enabled 参数' });
        return;
      }
      const store = await updateStore(id, { enabled });
      if (!store) {
        res.status(404).json({ ok: false, error: '店铺不存在' });
        return;
      }
      await logOperation({
        category: 'store',
        action: 'store_toggle',
        actor: (req as any).agent?.name || 'unknown',
        storeSubdomain: store.subdomain,
        target: store.store_name || store.subdomain,
        summary: `${store.enabled ? '启用' : '停用'}店铺: ${store.store_name || store.subdomain}`,
        status: 'success',
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // DELETE /api/admin/stores/:id
  router.delete('/stores/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      // 先查完整店铺信息
      const storeR = await query(
        `SELECT subdomain, store_name, access_token FROM support_stores WHERE id = $1`,
        [id],
      );
      if (!storeR.rows[0]) {
        res.status(404).json({ ok: false, error: '店铺不存在' });
        return;
      }
      const row = storeR.rows[0];
      const subdomain: string = row.subdomain;
      const storeName: string = row.store_name || subdomain;
      const accessToken: string = decryptToken(row.access_token);
      const store = { subdomain, storeName, accessToken };

      // 必须先注销 webhook 才能删除店铺
      const existing = await findWebhookByTopic(store, 'orders/paid');
      if (existing.registered && existing.webhook?.id) {
        const unregResult = await deleteWebhook(store, existing.webhook.id);
        if (!unregResult.ok) {
          res.status(502).json({
            ok: false,
            error: `请先手动注销 Webhook 后再删除店铺: ${unregResult.error || '注销失败'}`,
          });
          return;
        }
        await logOperation({
          category: 'webhook',
          action: 'webhook_unregistered',
          actor: (req as any).agent?.name || 'unknown',
          storeSubdomain: subdomain,
          target: subdomain,
          summary: `删除店铺前自动注销 Webhook: ${subdomain}`,
          status: 'success',
        });
      }

      const ok = await deleteStore(id);
      if (!ok) {
        res.status(404).json({ ok: false, error: '店铺不存在' });
        return;
      }
      await logOperation({
        category: 'store',
        action: 'store_delete',
        actor: (req as any).agent?.name || 'unknown',
        target: storeName,
        summary: `删除店铺: ${storeName}`,
        status: 'success',
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // DELETE /api/admin/tickets/:publicTicketNo/messages/:msgId
  router.delete('/tickets/:publicTicketNo/messages/:msgId', async (req, res) => {
    try {
      const agent = (req as any).agent;
      const msgId = Number(req.params.msgId);
      if (!msgId) { res.status(400).json({ ok: false, error: '无效的消息ID' }); return; }

      const r = await query(
        `DELETE FROM support_ticket_messages WHERE id = $1 AND public_ticket_no = $2 AND sender_type = 'agent'`,
        [msgId, req.params.publicTicketNo],
      );
      if ((r.rowCount || 0) === 0) {
        res.status(404).json({ ok: false, error: '消息不存在或无权撤回' });
        return;
      }
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── 邮件模板 API ──

  // GET /api/admin/email-templates
  router.get('/email-templates', async (_req, res) => {
    try {
      const templates = await listEmailTemplates();
      res.json({ ok: true, templates });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/admin/email-templates/:type
  router.get('/email-templates/:type', async (req, res) => {
    try {
      const tpl = await getEmailTemplate(req.params.type);
      if (!tpl) {
        res.status(404).json({ ok: false, error: '模板不存在' });
        return;
      }
      res.json({ ok: true, template: tpl });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // PUT /api/admin/email-templates/:type
  router.put('/email-templates/:type', async (req, res) => {
    try {
      const { subject_template, body_template, active_preset_name } = req.body || {};
      if (!subject_template || !body_template) {
        res.status(400).json({ ok: false, error: '缺少 subject_template 或 body_template' });
        return;
      }
      const tpl = await updateEmailTemplate(req.params.type, subject_template, body_template, active_preset_name ?? null);
      if (!tpl) {
        res.status(404).json({ ok: false, error: '模板类型无效' });
        return;
      }
      await logOperation({
        category: 'config',
        action: 'email_template_updated',
        actor: (req as any).agent?.name || 'unknown',
        target: req.params.type,
        summary: `更新邮件模板: ${req.params.type}`,
        status: 'success',
      });
      res.json({ ok: true, template: tpl });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/email-templates/:type/preview
  router.post('/email-templates/:type/preview', async (req, res) => {
    try {
      const { subject_template, body_template, variables } = req.body || {};
      const tpl = subject_template
        ? { subject_template, body_template: body_template || '' }
        : await getEmailTemplate(req.params.type);

      if (!tpl) {
        res.status(404).json({ ok: false, error: '模板不存在' });
        return;
      }

      const vars = variables || {
        store_name: 'Test Store',
        store_domain: 'test.myshoplaza.com',
        order_id: '1001',
        order_number: 'TEST-1001',
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        public_ticket_no: 'TKT-000001',
        client_link: 'https://example.com/ticket?t=test_token_xxx',
        paid_at: formatEasternTime(new Date()),
        payment_method: 'Visa',
        card_last4: '4242',
        order_amount: '29.99',
        order_currency: 'USD',
      };

      const subject = renderTemplateString(tpl.subject_template, vars);
      const html = renderTemplateString(tpl.body_template, vars);

      res.json({ ok: true, preview: { subject, html } });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 模板预设 ──
  // GET /api/admin/email-templates/:type/presets
  router.get('/email-templates/:type/presets', async (req, res) => {
    try {
      const presets = await listTemplatePresets(req.params.type);
      res.json({ ok: true, presets });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/email-templates/:type/presets
  router.post('/email-templates/:type/presets', async (req, res) => {
    try {
      const { preset_name, subject_template, body_template } = req.body || {};
      if (!preset_name || !subject_template || !body_template) {
        res.status(400).json({ ok: false, error: '缺少 preset_name / subject_template / body_template' });
        return;
      }
      const preset = await createTemplatePreset(req.params.type, preset_name, subject_template, body_template);
      await logOperation({
        category: 'email',
        action: 'template_preset_created',
        actor: (req as any).agent?.name || 'unknown',
        target: `${req.params.type}/${preset_name}`,
        summary: `创建邮件模板预设: ${req.params.type} / ${preset_name}`,
        status: 'success',
      });
      res.json({ ok: true, preset });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // DELETE /api/admin/email-templates/:type/presets/:name
  router.delete('/email-templates/:type/presets/:name', async (req, res) => {
    try {
      const ok = await deleteTemplatePreset(req.params.type, req.params.name);
      if (!ok) {
        res.status(404).json({ ok: false, error: '预设不存在' });
        return;
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/email-templates/:type/presets/:name/activate
  router.post('/email-templates/:type/presets/:name/activate', async (req, res) => {
    try {
      const ok = await activateTemplatePreset(req.params.type, req.params.name);
      if (!ok) {
        res.status(404).json({ ok: false, error: '预设不存在' });
        return;
      }
      await logOperation({
        category: 'email',
        action: 'template_preset_activated',
        actor: (req as any).agent?.name || 'unknown',
        target: `${req.params.type}/${req.params.name}`,
        summary: `切换邮件模板: ${req.params.type} → ${req.params.name}`,
        status: 'success',
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 系统设置 API ──

  // GET /api/admin/settings
  router.get('/settings', async (_req, res) => {
    try {
      const [mailTestMode, publicBaseUrl] = await Promise.all([
        getMailTestMode().catch(() => false),
        getPublicBaseUrl().catch(() => null),
      ]);
      res.json({
        ok: true,
        settings: {
          mail_test_mode: mailTestMode,
          public_base_url: publicBaseUrl || '',
        },
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // PUT /api/admin/settings
  router.put('/settings', async (req, res) => {
    try {
      const { public_base_url, mail_test_mode } = req.body || {};
      const results: string[] = [];

      if (public_base_url !== undefined) {
        const url = String(public_base_url).trim().replace(/\/$/, '');
        await setPublicBaseUrl(url);
        results.push('public_base_url');
      }

      if (typeof mail_test_mode === 'boolean') {
        await setMailTestMode(mail_test_mode);
        results.push('mail_test_mode');
      }

      if (results.length === 0) {
        res.status(400).json({ ok: false, error: '没有可更新的设置项' });
        return;
      }

      await logOperation({
        category: 'config',
        action: 'system_settings_updated',
        actor: (req as any).agent?.name || 'unknown',
        summary: `系统设置已更新: ${results.join(', ')}`,
        status: 'success',
      });

      res.json({ ok: true, updated: results });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Webhook 管理 API ──

  // GET /api/admin/stores/:id/webhook/status
  router.get('/stores/:id/webhook/status', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const storeR = await query(`SELECT subdomain, store_name, access_token, enabled FROM support_stores WHERE id = $1`, [id]);
      if (!storeR.rows[0]) {
        res.status(404).json({ ok: false, error: '店铺不存在' });
        return;
      }
      const row = storeR.rows[0];
      const accessToken = decryptToken(row.access_token);
      const store = { subdomain: row.subdomain, storeName: row.store_name, accessToken };

      const result = await findWebhookByTopic(store, 'orders/paid');
      res.json({
        ok: true,
        registered: result.registered,
        webhook: result.webhook || null,
        error: result.error || null,
        expectedAddress: `${await getEffectivePublicBaseUrl()}/api/shoplazza/webhook/${store.subdomain}`,
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/stores/:id/webhook/register
  router.post('/stores/:id/webhook/register', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const storeR = await query(`SELECT subdomain, store_name, access_token FROM support_stores WHERE id = $1`, [id]);
      if (!storeR.rows[0]) {
        res.status(404).json({ ok: false, error: '店铺不存在' });
        return;
      }
      const row = storeR.rows[0];
      const accessToken = decryptToken(row.access_token);
      const store = { subdomain: row.subdomain, storeName: row.store_name, accessToken };

      const baseUrl = await getEffectivePublicBaseUrl();
      if (!baseUrl || baseUrl.includes('localhost')) {
        res.status(400).json({
          ok: false,
          error: '未配置公网域名。请在系统设置中设置公网域名后再注册 Webhook。',
        });
        return;
      }

      const address = `${baseUrl}/api/shoplazza/webhook/${store.subdomain}`;

      // 先检查是否已注册
      const existing = await findWebhookByTopic(store, 'orders/paid');
      if (existing.registered && existing.webhook?.id) {
        res.json({ ok: true, message: 'Webhook 已注册', webhook: existing.webhook, alreadyRegistered: true });
        return;
      }

      const result = await registerWebhook(store, address, 'orders/paid');
      if (result.ok) {
        await logOperation({
          category: 'webhook',
          action: 'webhook_registered',
          actor: (req as any).agent?.name || 'unknown',
          storeSubdomain: store.subdomain,
          target: store.subdomain,
          summary: `注册 Webhook: ${store.subdomain} → orders/paid`,
          status: 'success',
          detailJson: { address, topic: 'orders/paid', webhook_id: result.webhook?.id },
        });
        res.json({ ok: true, message: '注册成功', webhook: result.webhook });
      } else {
        await logOperation({
          category: 'webhook',
          action: 'webhook_register_failed',
          actor: (req as any).agent?.name || 'unknown',
          storeSubdomain: store.subdomain,
          target: store.subdomain,
          summary: `Webhook 注册失败: ${store.subdomain}`,
          status: 'failed',
          detailJson: { address, error: result.error },
        });
        res.status(502).json({ ok: false, error: result.error || '注册失败' });
      }
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/admin/stores/:id/webhook/unregister
  router.post('/stores/:id/webhook/unregister', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const storeR = await query(`SELECT subdomain, store_name, access_token FROM support_stores WHERE id = $1`, [id]);
      if (!storeR.rows[0]) {
        res.status(404).json({ ok: false, error: '店铺不存在' });
        return;
      }
      const row = storeR.rows[0];
      const accessToken = decryptToken(row.access_token);
      const store = { subdomain: row.subdomain, storeName: row.store_name, accessToken };

      const existing = await findWebhookByTopic(store, 'orders/paid');
      if (!existing.registered || !existing.webhook?.id) {
        res.json({ ok: true, message: 'Webhook 未注册，无需操作' });
        return;
      }

      const result = await deleteWebhook(store, existing.webhook.id);
      if (result.ok) {
        await logOperation({
          category: 'webhook',
          action: 'webhook_unregistered',
          actor: (req as any).agent?.name || 'unknown',
          storeSubdomain: store.subdomain,
          target: store.subdomain,
          summary: `注销 Webhook: ${store.subdomain}`,
          status: 'success',
        });
        res.json({ ok: true, message: '已注销' });
      } else {
        res.status(502).json({ ok: false, error: result.error || '注销失败' });
      }
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
