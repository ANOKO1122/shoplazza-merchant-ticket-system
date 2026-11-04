import express from 'express';
import type { PoolClient } from 'pg';
import { query } from './pg';

export interface EmailPreferenceFilters {
  q: string;
  category: 'all' | 'ticket' | 'protection';
  page: number;
  page_size: number;
}
export interface EmailPreferenceList {
  items: Array<{ email: string; ticket_unsubscribed_at: string | null; protection_unsubscribed_at: string | null; last_unsubscribed_at: string }>;
  total: number;
  page: number;
  page_size: number;
  summary: { email_count: number; ticket_count: number; protection_count: number };
}
type Database = Pick<PoolClient, 'query'>;
const database = { query } as Database;

export function parseEmailPreferenceFilters(input: Record<string, unknown>): EmailPreferenceFilters {
  const text = (name: string, fallback: string): string => {
    if (input[name] === undefined) return fallback;
    if (typeof input[name] !== 'string') throw new Error('查询参数格式不正确');
    return (input[name] as string).trim();
  };
  const q = text('q', '');
  if (q.length > 254 || /[\u0000-\u001f\u007f]/.test(q)) throw new Error('邮箱搜索内容不正确');
  const category = text('category', 'all');
  if (!['all', 'ticket', 'protection'].includes(category)) throw new Error('请选择有效的邮件系统');
  const integer = (name: string, fallback: string, max: number): number => {
    const raw = text(name, fallback), value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('分页参数不正确');
    return value;
  };
  return { q, category: category as EmailPreferenceFilters['category'], page: integer('page', '1', 1_000_000), page_size: integer('page_size', '25', 100) };
}

export async function listEmailPreferences(filters: EmailPreferenceFilters, db: Database = database): Promise<EmailPreferenceList> {
  // A single statement gives rows, filtered totals and global counts from the same snapshot.
  // Use ! as the LIKE escape so user-entered %, _ and backslashes remain literal.
  const pattern = filters.q ? `%${filters.q.replace(/[!%_]/g, '!$&')}%` : null;
  const result = await db.query(`WITH grouped AS (
      SELECT email,
        max(unsubscribed_at) FILTER (WHERE category='ticket') AS ticket_unsubscribed_at,
        max(unsubscribed_at) FILTER (WHERE category='protection') AS protection_unsubscribed_at,
        max(unsubscribed_at) AS last_unsubscribed_at
      FROM support_email_preferences GROUP BY email
    ), filtered AS (
      SELECT * FROM grouped WHERE ($1::text IS NULL OR email ILIKE $1 ESCAPE '!')
        AND ($2='all' OR ($2='ticket' AND ticket_unsubscribed_at IS NOT NULL)
          OR ($2='protection' AND protection_unsubscribed_at IS NOT NULL))
    ), page_rows AS (
      SELECT * FROM filtered ORDER BY last_unsubscribed_at DESC,email ASC LIMIT $3 OFFSET $4
    ) SELECT
      coalesce((SELECT jsonb_agg(to_jsonb(page_rows) ORDER BY last_unsubscribed_at DESC,email ASC) FROM page_rows),'[]'::jsonb) AS items,
      (SELECT count(*)::int FROM filtered) AS total,
      count(*)::int AS email_count,
      count(ticket_unsubscribed_at)::int AS ticket_count,
      count(protection_unsubscribed_at)::int AS protection_count
    FROM grouped`, [pattern, filters.category, filters.page_size, (filters.page - 1) * filters.page_size]);
  const row = result.rows[0];
  return { items: row.items, total: row.total, page: filters.page, page_size: filters.page_size,
    summary: { email_count: row.email_count, ticket_count: row.ticket_count, protection_count: row.protection_count } };
}

/** Mount only after the parent admin router's agent authentication middleware. */
export function createEmailPreferencesAdminRouter(options: { list?: typeof listEmailPreferences } = {}): express.Router {
  const router = express.Router();
  const list = options.list || listEmailPreferences;
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', async (req, res) => {
    let filters: EmailPreferenceFilters;
    try { filters = parseEmailPreferenceFilters(req.query); }
    catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); return; }
    try { res.json({ ok: true, ...await list(filters) }); }
    catch { res.status(500).json({ ok: false, error: '暂时无法读取退订记录，请稍后重试。' }); }
  });
  router.all('/', (_req, res) => { res.setHeader('Allow', 'GET, HEAD'); res.status(405).json({ ok: false, error: '此页面仅用于查看退订记录。' }); });
  return router;
}
