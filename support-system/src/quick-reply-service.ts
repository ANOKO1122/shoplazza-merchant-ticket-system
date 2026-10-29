import { query } from './pg';

export const MAX_QUICK_REPLY_TITLE_LENGTH = 80;
export const MAX_QUICK_REPLY_CONTENT_LENGTH = 20000;

export interface QuickReplyInput {
  title: string;
  content: string;
}

export function validateQuickReplyInput(input: unknown): string | null {
  const { title, content } = (input || {}) as Partial<QuickReplyInput>;
  if (typeof title !== 'string' || !title.trim()) return '请填写快捷回复标题';
  if (title.trim().length > MAX_QUICK_REPLY_TITLE_LENGTH) return '快捷回复标题不能超过 80 个字符';
  if (typeof content !== 'string' || !content.trim()) return '请填写快捷回复正文';
  if (content.trim().length > MAX_QUICK_REPLY_CONTENT_LENGTH) return '快捷回复正文不能超过 20000 个字符';
  return null;
}

export async function listQuickReplies() {
  const result = await query(
    `SELECT id, title, content, created_at, updated_at
     FROM support_quick_replies ORDER BY updated_at DESC, id DESC`,
  );
  return result.rows;
}

export async function createQuickReply(input: QuickReplyInput) {
  const result = await query(
    `INSERT INTO support_quick_replies (title, content)
     VALUES ($1, $2) RETURNING id, title, content, created_at, updated_at`,
    [input.title.trim(), input.content.trim()],
  );
  return result.rows[0];
}

export async function updateQuickReply(id: number, input: QuickReplyInput) {
  const result = await query(
    `UPDATE support_quick_replies SET title = $2, content = $3, updated_at = now()
     WHERE id = $1 RETURNING id, title, content, created_at, updated_at`,
    [id, input.title.trim(), input.content.trim()],
  );
  return result.rows[0] || null;
}

export async function deleteQuickReply(id: number) {
  const result = await query(
    `DELETE FROM support_quick_replies WHERE id = $1 RETURNING id, title`,
    [id],
  );
  return result.rows[0] || null;
}
