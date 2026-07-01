import express from 'express';
import rateLimit from 'express-rate-limit';
import { verifyAccessToken, hashToken, createTicketAccessToken } from './token';
import { createTicket, getTicketByPublicNo, getTicketMessages, addCustomerMessage, closeTicket, getOrderSnapshot, findExistingTicket, listExistingTickets, requestArbitration, countConsecutiveCustomerMessages } from './ticket-service';
import { extractTrackingNo } from './admin-preview';
import { mapPaymentMethodDisplay } from './normalize-order';
import { uploadSingleAttachment, processAttachments } from './storage-service';

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

      // 手动邀请场景：跳过已有工单检测，始终返回新建模式
      if (payload.force_new_ticket) {
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
  router.post('/tickets', async (req, res) => {
    try {
      const { token, issue_type, description } = req.body || {};

      if (!token || !description) {
        res.status(400).json({ ok: false, error: 'Please describe your dispute' });
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

      // 仅当 token 非 force_new_ticket 时才检测已有工单冲突
      if (!payload.force_new_ticket) {
        const existingTicket = await findExistingTicket({
          storeSubdomain: store_subdomain,
          orderId: order_id,
          customerEmail: customer_email,
        });

        if (existingTicket) {
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

      const result = await createTicket({
        storeSubdomain: store_subdomain,
        storeName,
        orderId: order_id,
        orderNumber,
        customerEmail: customer_email,
        customerName,
        issueType: issue_type || null,
        description,
        bootstrapTokenHash: hashToken(token),
      });

      res.json({ ok: true, ...result });
    } catch (e: any) {
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
  router.post('/tickets/:publicTicketNo/messages', uploadSingleAttachment, async (req, res) => {
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

  return router;
}
