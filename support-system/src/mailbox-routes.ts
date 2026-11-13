import express from 'express';
import multer from 'multer';
import { getRequestAgent } from './auth';
import { query } from './pg';
import { mailboxSyncStatus } from './mailbox-imap';
import { addNote, getConversation, linkClaim, listConversations, queueReply, updateConversation } from './mailbox-store';
import { deleteMailboxAttachment, readMailboxAttachment, saveMailboxAttachment } from './mailbox-attachments';

const uploads = multer({ storage: multer.memoryStorage(), limits: { files: 6, fileSize: 10 * 1024 * 1024, fields: 10 } });

function sameOrigin(req: express.Request): boolean {
  const origin = req.get('Origin');
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === `${req.protocol}:` && url.host === req.get('host');
  } catch { return false; }
}

function routeError(res: express.Response, error: unknown): void {
  const code = error instanceof Error ? error.message : 'internal_error';
  const status = code === 'stale_version' ? 409 : code.endsWith('_not_found') ? 404
    : /^(invalid_|empty_|recipient_mismatch|unsupported_type|too_many_files|file_too_large|message_too_large)/.test(code) ? 400 : 500;
  res.status(status).json({ ok: false, error: status === 500 ? 'internal_error' : code });
}

function numericId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) throw new Error('invalid_id');
  return Number(value);
}

export function createMailboxRouter(): express.Router {
  const router = express.Router();
  router.use(async (req, res, next) => {
    try {
      const agent = await getRequestAgent(req);
      if (!agent) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
      (req as any).agent = agent;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) {
        res.status(403).json({ ok: false, error: 'invalid_origin' }); return;
      }
      next();
    } catch { res.status(500).json({ ok: false, error: 'internal_error' }); }
  });

  router.get('/status', async (_req, res) => {
    try { res.json({ ok: true, mailbox: await mailboxSyncStatus() }); }
    catch (error) { routeError(res, error); }
  });

  router.get('/agents', async (_req, res) => {
    try { res.json({ ok: true, agents: (await query('SELECT id,name FROM support_agents WHERE enabled=true ORDER BY name,id')).rows }); }
    catch (error) { routeError(res, error); }
  });

  router.get('/conversations', async (req, res) => {
    try {
      const scope = String(req.query.scope || 'open');
      const agent = (req as any).agent;
      const status = scope === 'resolved' ? 'resolved' : 'open';
      const assigneeId = scope === 'mine' ? agent.agentId : scope === 'unassigned' ? null : undefined;
      res.json({ ok: true, ...await listConversations({ q: String(req.query.q || ''), status, assigneeId,
        unread: req.query.unread === 'true', limit: Number(req.query.limit) || 30, offset: Number(req.query.offset) || 0 }) });
    } catch (error) { routeError(res, error); }
  });

  router.get('/conversations/:id', async (req, res) => {
    try {
      const conversation = await getConversation(numericId(req.params.id));
      if (!conversation) { res.status(404).json({ ok: false, error: 'conversation_not_found' }); return; }
      res.json({ ok: true, conversation });
    } catch (error) { routeError(res, error); }
  });

  router.patch('/conversations/:id', async (req, res) => {
    try {
      const version = Number(req.body?.version);
      if (!Number.isSafeInteger(version) || version < 1) throw new Error('invalid_version');
      const change: { assigneeId?: number | null; status?: 'open' | 'resolved'; markRead?: boolean } = {};
      if ('assignee_id' in (req.body || {})) change.assigneeId = req.body.assignee_id == null ? null : numericId(String(req.body.assignee_id));
      if ('status' in (req.body || {})) {
        if (!['open', 'resolved'].includes(req.body.status)) throw new Error('invalid_status');
        change.status = req.body.status;
      }
      if (req.body?.mark_read === true) change.markRead = true;
      res.json({ ok: true, conversation: await updateConversation(numericId(req.params.id), version, change, (req as any).agent.agentId) });
    } catch (error) { routeError(res, error); }
  });

  router.post('/conversations/:id/notes', async (req, res) => {
    try { res.json({ ok: true, conversation: await addNote(numericId(req.params.id), Number(req.body?.version),
      req.body?.body, (req as any).agent.agentId) }); }
    catch (error) { routeError(res, error); }
  });

  router.post('/conversations/:id/link', async (req, res) => {
    try { res.json({ ok: true, conversation: await linkClaim(numericId(req.params.id), Number(req.body?.version),
      req.body?.claim_id == null ? null : numericId(String(req.body.claim_id)), (req as any).agent.agentId) }); }
    catch (error) { routeError(res, error); }
  });

  router.post('/conversations/:id/replies', uploads.array('attachments', 6), async (req, res) => {
    const storedKeys: string[] = [];
    try {
      const idempotencyKey = String(req.body?.idempotency_key || '');
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error('invalid_idempotency_key');
      const previous = (await query('SELECT id,status FROM support_mailbox_messages WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
      if (previous) { res.json({ ok: true, reply: previous, duplicate: true }); return; }
      const files = (req.files || []) as Express.Multer.File[];
      const attachments = [];
      let totalBytes = 0;
      for (const file of files) {
        totalBytes += file.size;
        const saved = await saveMailboxAttachment({ filename: file.originalname, contentType: file.mimetype, bytes: file.buffer,
          count: attachments.length + 1, totalBytes });
        if (saved.omittedReason) throw new Error(saved.omittedReason);
        attachments.push(saved);
        if (saved.storageKey) storedKeys.push(saved.storageKey);
      }
      const reply = await queueReply(numericId(req.params.id), Number(req.body?.version), String(req.body?.to || ''),
        String(req.body?.body || ''), attachments, (req as any).agent.agentId, idempotencyKey);
      res.json({ ok: true, reply: { id: reply.id, status: reply.status, message_id: reply.message_id }, duplicate: false });
    } catch (error) {
      await Promise.all(storedKeys.map(deleteMailboxAttachment));
      routeError(res, error);
    }
  });

  router.get('/attachments/:id', async (req, res) => {
    try {
      const attachment = (await query(`SELECT storage_key,filename,mime_type FROM support_mailbox_attachments WHERE id=$1`,
        [numericId(req.params.id)])).rows[0];
      if (!attachment?.storage_key) { res.status(404).end(); return; }
      const bytes = await readMailboxAttachment(attachment.storage_key);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
      res.send(bytes);
    } catch (error) { routeError(res, error); }
  });
  return router;
}
