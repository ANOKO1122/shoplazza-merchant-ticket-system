import express from 'express';
import rateLimit from 'express-rate-limit';
import { verifyAccessToken, hashToken, createTicketAccessToken, AccessTokenPurpose } from './token';
import { createTicket, getTicketByPublicNo, getTicketMessages, addCustomerMessage, closeTicket, getOrderSnapshot, findExistingTicket, listExistingTickets, requestArbitration, countConsecutiveCustomerMessages, reopenTicket, findTicketByBootstrapTokenHash } from './ticket-service';
import { buildTrackingDetails } from './admin-preview';
import { mapPaymentMethodDisplay } from './normalize-order';
import { extractStoreCustomDomain } from './email-service';
import { buildStoreDomain } from './config';
import { resolveThumbnailUrl } from './thumbnail-service';

/** 为 items_json 每项补上 thumbnail_url（仅计算 URL，不触发下载） */
function enrichItemsWithThumbnails(items: any[]): any[] {
  if (!Array.isArray(items)) return [];
  return items.map((it: any) => {
    const raw = it.image;
    let src = '';
    if (raw && typeof raw === 'object' && raw.src) src = String(raw.src);
    else src = String(raw || it.product_image || it.image_src || '');
    if (src && src.startsWith('//')) src = 'https:' + src;
    return { ...it, thumbnail_url: src ? resolveThumbnailUrl(src) : '' };
  });
}
import { uploadSingleAttachment, processAttachments, uploadTicketAttachments } from './storage-service';

/** 新客户端在上传前提供 Bearer token；旧客户端仍支持 multipart 中的 token。 */
function authorizeUpload(purpose: AccessTokenPurpose): express.RequestHandler {
  return async (req, res, next) => {
    const authorization = req.get('Authorization');
    if (!authorization) return next();
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    const token = match?.[1];
    const payload = token ? await verifyAccessToken(token) : null;
    if (!payload || payload.purpose !== purpose ||
        (purpose === 'ticket_access' && payload.public_ticket_no !== req.params.publicTicketNo)) {
      res.status(401).json({ ok: false, error: 'Invalid or expired token' });
      return;
    }
    next();
  };
}

export function createSupportRouter(): express.Router {
  const router = express.Router();

  // 防滥用：bootstrap 端点独立限流（10次/分钟，正常顾客最多2-3次）
  const bootstrapLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: '访问过于频繁，请稍后重试' },
  });

  // GET /api/support/bootstrap?t=BOOTSTRAP_TOKEN  or  ?t=TICKET_ACCESS_TOKEN
  router.get('/bootstrap', bootstrapLimiter, async (req, res) => {
    try {
      const rawToken = (req.query.t as string) || '';
      const payload = await verifyAccessToken(rawToken);

      if (!payload) {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      if (payload.purpose === 'ticket_access') {
        if (!payload.public_ticket_no) {
          res.status(400).json({ ok: false, error: 'Invalid token data' });
          return;
        }
        const ticket = await getTicketByPublicNo(payload.public_ticket_no);
        if (!ticket) {
          res.status(404).json({ ok: false, error: 'Dispute not found' });
          return;
        }
        const snapshot = await getOrderSnapshot({
          storeSubdomain: ticket.store_subdomain,
          orderId: ticket.order_id,
          customerEmail: ticket.customer_email,
        });
        const order = snapshot ? {
          store_subdomain: snapshot.store_subdomain || '',
          store_name: snapshot.store_name || '',
          store_domain: extractStoreCustomDomain(snapshot.raw_order_json) || buildStoreDomain(snapshot.store_subdomain),
          order_number: snapshot.order_number || '',
          order_amount: snapshot.order_amount || '',
          order_currency: snapshot.order_currency || '',
          paid_at: snapshot.paid_at || null,
          payment_method: mapPaymentMethodDisplay(snapshot.payment_method),
          card_last4: snapshot.card_last4 || '',
          ...buildTrackingDetails(snapshot),
          customer_name: snapshot.customer_name || '',
          items: enrichItemsWithThumbnails(snapshot.items_json || []),
        } : null;
        res.json({
          ok: true,
          mode: 'existing_ticket',
          order,
          ticket: {
            public_ticket_no: ticket.public_ticket_no,
            status: ticket.status,
          },
          accessToken: rawToken,
        });
        return;
      }

      if (payload.purpose !== 'support_bootstrap') {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      const { store_subdomain, order_id, customer_email } = payload;
      if (!store_subdomain || !order_id || !customer_email) {
        res.status(400).json({ ok: false, error: 'Invalid token data' });
        return;
      }

      const snapshot = await getOrderSnapshot({
        storeSubdomain: store_subdomain,
        orderId: order_id,
        customerEmail: customer_email,
      });

      const order = snapshot ? {
        store_subdomain: snapshot.store_subdomain || '',
        store_name: snapshot.store_name || '',
        store_domain: extractStoreCustomDomain(snapshot.raw_order_json) || buildStoreDomain(snapshot.store_subdomain),
        order_number: snapshot.order_number || '',
        order_amount: snapshot.order_amount || '',
        order_currency: snapshot.order_currency || '',
        paid_at: snapshot.paid_at || null,
        payment_method: mapPaymentMethodDisplay(snapshot.payment_method),
        card_last4: snapshot.card_last4 || '',
        ...buildTrackingDetails(snapshot),
        customer_name: snapshot.customer_name || '',
        items: enrichItemsWithThumbnails(snapshot.items_json || []),
      } : null;

      // 已激活的邀请优先进入它创建的工单，包含已关闭工单，避免跳到同订单的其他工单。
      const ticketFromToken = await findTicketByBootstrapTokenHash(hashToken(rawToken));

      if (ticketFromToken) {
        const taToken = await createTicketAccessToken({
          publicTicketNo: ticketFromToken.public_ticket_no,
          customerEmail: customer_email,
        });
        res.json({
          ok: true,
          mode: 'existing_ticket',
          order,
          ticket: {
            public_ticket_no: ticketFromToken.public_ticket_no,
            status: ticketFromToken.status,
          },
          accessToken: taToken,
        });
        return;
      }

      if (payload.force_new_ticket) {
        // 手动邀请尚未生成工单，返回新建模式
        res.json({ ok: true, mode: 'new_ticket', order, ticket: null });
        return;
      }

      const existingTicket = await findExistingTicket({
        storeSubdomain: store_subdomain,
        orderId: order_id,
        customerEmail: customer_email,
      });

      if (existingTicket) {
        const taToken = await createTicketAccessToken({
          publicTicketNo: existingTicket.public_ticket_no,
          customerEmail: customer_email,
        });
        res.json({
          ok: true,
          mode: 'existing_ticket',
          order,
          ticket: {
            public_ticket_no: existingTicket.public_ticket_no,
            status: existingTicket.status,
          },
          accessToken: taToken,
        });
        return;
      }

      res.json({ ok: true, mode: 'new_ticket', order, ticket: null });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/support/tickets
  router.post('/tickets', authorizeUpload('support_bootstrap'), uploadTicketAttachments, async (req, res) => {
    try {
      const { token, issue_type, description } = req.body || {};
      const contentStr = (description || '').trim();
      const files = req.files as Express.Multer.File[] | undefined;

      if (!token || !description) {
        res.status(400).json({ ok: false, error: 'Please describe your dispute' });
        return;
      }

      // 校验：文字和图片至少提供一个
      if (!contentStr && (!files || files.length === 0)) {
        res.status(400).json({ ok: false, error: 'Please provide a description or attach images' });
        return;
      }

      const payload = await verifyAccessToken(token);
      if (!payload || payload.purpose !== 'support_bootstrap') {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      const { store_subdomain, order_id, customer_email } = payload;
      if (!store_subdomain || !order_id || !customer_email) {
        res.status(400).json({ ok: false, error: 'Invalid token data' });
        return;
      }

      // 重复提交已激活的邀请只进入原工单，不创建或再次延长邀请期限。
      const ticketFromToken = await findTicketByBootstrapTokenHash(hashToken(token));
      if (ticketFromToken) {
        const taToken = await createTicketAccessToken({
          publicTicketNo: ticketFromToken.public_ticket_no,
          customerEmail: customer_email,
        });
        res.json({ ok: true, publicTicketNo: ticketFromToken.public_ticket_no, accessToken: taToken });
        return;
      }

      // 未激活的普通邀请保留已有工单冲突检查。
      if (!payload.force_new_ticket) {
        const existingTicket = await findExistingTicket({
          storeSubdomain: store_subdomain,
          orderId: order_id,
          customerEmail: customer_email,
        });

        if (existingTicket) {
          // Another submission may have activated this invitation after the first hash lookup.
          const activatedTicket = await findTicketByBootstrapTokenHash(hashToken(token));
          if (activatedTicket) {
            const taToken = await createTicketAccessToken({
              publicTicketNo: activatedTicket.public_ticket_no,
              customerEmail: customer_email,
            });
            res.json({ ok: true, publicTicketNo: activatedTicket.public_ticket_no, accessToken: taToken });
            return;
          }
          res.status(409).json({
            ok: false,
            error: 'A dispute already exists for this order',
            public_ticket_no: existingTicket.public_ticket_no,
          });
          return;
        }
      }

      const snapshot = await getOrderSnapshot({
        storeSubdomain: store_subdomain,
        orderId: order_id,
        customerEmail: customer_email,
      });

      const storeName = snapshot?.store_name || '';
      const orderNumber = snapshot?.order_number || '';
      const customerName = snapshot?.customer_name || '';

      // 处理图片附件
      let attachmentUrls: string[] = [];
      if (files && files.length > 0) {
        attachmentUrls = await processAttachments(files);
      }

      const result = await createTicket({
        storeSubdomain: store_subdomain,
        storeName,
        orderId: order_id,
        orderNumber,
        customerEmail: customer_email,
        customerName,
        issueType: issue_type || null,
        description: contentStr,
        bootstrapTokenHash: hashToken(token),
        attachments: attachmentUrls,
      });

      res.json({ ok: true, ...result });
    } catch (e: any) {
      if (e.message === 'Invalid or expired token') {
        res.status(401).json({ ok: false, error: e.message });
        return;
      }
      if (e.message && (e.message.includes('Invalid dispute type') || e.message.includes('Description must be under'))) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/support/tickets/:publicTicketNo?t=ACCESS_TOKEN
  router.get('/tickets/:publicTicketNo', async (req, res) => {
    try {
      const { publicTicketNo } = req.params;
      const rawToken = (req.query.t as string) || '';

      const payload = await verifyAccessToken(rawToken);
      if (!payload || payload.purpose !== 'ticket_access') {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      if (payload.public_ticket_no !== publicTicketNo) {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      const ticket = await getTicketByPublicNo(publicTicketNo);
      if (!ticket) {
        res.status(404).json({ ok: false, error: 'Dispute not found' });
        return;
      }

      const snapshot = await getOrderSnapshot({
        storeSubdomain: ticket.store_subdomain,
        orderId: ticket.order_id,
        customerEmail: ticket.customer_email,
      });

      const order = snapshot ? {
        store_subdomain: snapshot.store_subdomain || '',
        store_name: snapshot.store_name || '',
        store_domain: extractStoreCustomDomain(snapshot.raw_order_json) || buildStoreDomain(snapshot.store_subdomain),
        order_number: snapshot.order_number || '',
        order_amount: snapshot.order_amount || '',
        order_currency: snapshot.order_currency || '',
        paid_at: snapshot.paid_at || null,
        payment_method: mapPaymentMethodDisplay(snapshot.payment_method),
        card_last4: snapshot.card_last4 || '',
        ...buildTrackingDetails(snapshot),
        customer_name: snapshot.customer_name || '',
        items: enrichItemsWithThumbnails(snapshot.items_json || []),
      } : null;

      const messages = await getTicketMessages(publicTicketNo);
      const consecutiveCount = await countConsecutiveCustomerMessages(publicTicketNo);

      res.json({
        ok: true,
        ticket: {
          public_ticket_no: ticket.public_ticket_no,
          status: ticket.status,
          issue_type: ticket.issue_type,
          created_at: ticket.created_at,
          arbitration_requested: ticket.arbitration_requested || false,
          reopen_count: ticket.reopen_count || 0,
        },
        order,
        messages: messages.map((m: any) => ({
          id: m.id,
          sender_type: m.sender_type,
          sender_email: m.sender_email || null,
          sender_name: m.sender_name,
          content: m.content,
          attachments: m.attachments || [],
          created_at: m.created_at,
        })),
        remainingMessages: Math.max(0, 5 - consecutiveCount),
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/support/tickets/:publicTicketNo/messages
  router.post('/tickets/:publicTicketNo/messages', authorizeUpload('ticket_access'), uploadSingleAttachment, async (req, res) => {
    try {
      const { publicTicketNo } = req.params;
      const { token, content } = req.body || {};
      const contentStr = (content || '').trim();
      const files = req.files as Express.Multer.File[] | undefined;

      // 校验：文字和图片至少提供一个
      if (!contentStr && (!files || files.length === 0)) {
        res.status(400).json({ ok: false, error: 'Please provide message content or an image' });
        return;
      }

      if (!token) {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      const payload = await verifyAccessToken(token);
      if (!payload || payload.purpose !== 'ticket_access') {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      if (payload.public_ticket_no !== publicTicketNo) {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      const ticket = await getTicketByPublicNo(publicTicketNo);
      if (!ticket) {
        res.status(404).json({ ok: false, error: 'Dispute not found' });
        return;
      }

      if (ticket.status === 'closed') {
        res.status(400).json({ ok: false, error: 'This dispute has been closed' });
        return;
      }

      // 处理图片
      let attachmentUrls: string[] = [];
      if (files && files.length > 0) {
        attachmentUrls = await processAttachments(files);
      }

      await addCustomerMessage({
        publicTicketNo,
        customerEmail: payload.customer_email,
        content: contentStr,
        attachments: attachmentUrls,
      });

      const consecutiveCount = await countConsecutiveCustomerMessages(publicTicketNo);
      res.json({ ok: true, remainingMessages: Math.max(0, 5 - consecutiveCount) });
    } catch (e: any) {
      if (e.message && e.message.includes('maximum of 5 consecutive')) {
        res.status(429).json({ ok: false, error: e.message });
        return;
      }
      if (e.message && e.message.includes('Message must be under')) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      if (e.message && e.message.includes('Unsupported file type')) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/support/tickets/:publicTicketNo/arbitration
  router.post('/tickets/:publicTicketNo/arbitration', async (req, res) => {
    try {
      const { publicTicketNo } = req.params;
      const { token } = req.body || {};

      if (!token) {
        res.status(400).json({ ok: false, error: 'Invalid request' });
        return;
      }

      const payload = await verifyAccessToken(token);
      if (!payload || payload.purpose !== 'ticket_access') {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      if (payload.public_ticket_no !== publicTicketNo) {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      const ticket = await getTicketByPublicNo(publicTicketNo);
      if (!ticket) {
        res.status(404).json({ ok: false, error: 'Dispute not found' });
        return;
      }

      if (ticket.status === 'closed') {
        res.status(400).json({ ok: false, error: 'This dispute has been closed' });
        return;
      }

      await requestArbitration(publicTicketNo);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/support/tickets/:publicTicketNo/close
  router.post('/tickets/:publicTicketNo/close', async (req, res) => {
    try {
      const { publicTicketNo } = req.params;
      const { token } = req.body || {};

      if (!token) {
        res.status(400).json({ ok: false, error: 'Invalid request' });
        return;
      }

      const payload = await verifyAccessToken(token);
      if (!payload || payload.purpose !== 'ticket_access') {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      if (payload.public_ticket_no !== publicTicketNo) {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      const ticket = await getTicketByPublicNo(publicTicketNo);
      if (!ticket) {
        res.status(404).json({ ok: false, error: 'Dispute not found' });
        return;
      }

      await closeTicket({ publicTicketNo, closedBy: 'customer' });

      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/support/tickets/:publicTicketNo/reopen — 顾客重开工单（最多一次）
  router.post('/tickets/:publicTicketNo/reopen', async (req, res) => {
    try {
      const { publicTicketNo } = req.params;
      const { token } = req.body || {};

      if (!token) {
        res.status(400).json({ ok: false, error: 'Invalid request' });
        return;
      }

      const payload = await verifyAccessToken(token);
      if (!payload || payload.purpose !== 'ticket_access') {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      if (payload.public_ticket_no !== publicTicketNo) {
        res.status(401).json({ ok: false, error: 'Invalid or expired token' });
        return;
      }

      await reopenTicket(publicTicketNo, 'customer');
      res.json({ ok: true });
    } catch (e: any) {
      if (e.message && e.message.includes('already been reopened')) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      if (e.message && e.message.includes('only closed')) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
