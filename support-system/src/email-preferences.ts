import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { getEmailPreferenceClient, query } from './pg';
import type { SupportMail } from './mailer';
import { emailHtmlToText } from './email-text';

export type EmailPreferenceCategory = 'ticket' | 'protection';
export interface EmailPreferenceView { category: EmailPreferenceCategory; email_masked: string; unsubscribed: boolean; }
type Database = Pick<PoolClient, 'query'>;
const database = { query } as Database;
const TOKEN = /^eu_[A-Za-z0-9_-]{43}$/;
const FOOTER = /<!-- email-unsubscribe:start -->[\s\S]*?<!-- email-unsubscribe:end -->/g;
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
function assertCategory(category: EmailPreferenceCategory) { if (!['ticket', 'protection'].includes(category)) throw new Error('Invalid email preference category'); }
export function normalizePreferenceEmail(email: string): string {
  if (typeof email !== 'string') throw new Error('Invalid email preference recipient');
  const value = email.trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@<>,;\u0000-\u001f\u007f]+@[^\s@<>,;\u0000-\u001f\u007f]+$/.test(value)) throw new Error('Invalid email preference recipient');
  return value;
}
function maskedEmail(email: string): string { const [local, domain] = email.split('@'); return `${local.slice(0, 1)}***@${domain}`; }
function validToken(value: unknown): value is string { return typeof value === 'string' && TOKEN.test(value); }

export async function isEmailUnsubscribed(email: string, category: EmailPreferenceCategory, db: Database = database): Promise<boolean> {
  assertCategory(category);
  const result = await db.query('SELECT 1 FROM support_email_preferences WHERE category=$1 AND email=$2', [category, normalizePreferenceEmail(email)]);
  return result.rows.length > 0;
}

/** A confirmed unsubscribe and a send must not pass each other between the check and SMTP. */
async function withPreferenceLock<T>(email: string, category: EmailPreferenceCategory, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  assertCategory(category);
  const key = `support-email-preference:${category}:${normalizePreferenceEmail(email)}`;
  const client = await getEmailPreferenceClient();
  let locked = false, destroy = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]); locked = true;
    return await callback(client);
  } catch (error) { if (!locked) destroy = true; throw error; }
  finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
      catch { destroy = true; } // Destroying the session releases the lock; do not retry a successful SMTP call.
    }
    client.release(destroy);
  }
}

export async function withEmailPreferenceGuard<T>(email: string, category: EmailPreferenceCategory, send: () => Promise<T>): Promise<{ suppressed: true } | { suppressed: false; value: T }> {
  return withPreferenceLock(email, category, async client => {
    if (await isEmailUnsubscribed(email, category, client)) return { suppressed: true };
    return { suppressed: false, value: await send() };
  });
}

export async function getEmailUnsubscribePreference(rawToken: unknown): Promise<EmailPreferenceView | null> {
  if (!validToken(rawToken)) return null;
  const result = await query(`SELECT t.category,t.email,p.unsubscribed_at FROM support_email_unsubscribe_tokens t
    LEFT JOIN support_email_preferences p ON p.category=t.category AND p.email=t.email WHERE t.token_hash=$1`, [hash(rawToken)]);
  const row = result.rows[0];
  return row ? { category: row.category, email_masked: maskedEmail(row.email), unsubscribed: !!row.unsubscribed_at } : null;
}

export async function unsubscribeEmailByToken(rawToken: unknown): Promise<EmailPreferenceView | null> {
  if (!validToken(rawToken)) return null;
  const result = await query('SELECT category,email FROM support_email_unsubscribe_tokens WHERE token_hash=$1', [hash(rawToken)]);
  const row = result.rows[0];
  if (!row) return null;
  return withPreferenceLock(row.email, row.category, async client => {
    // Recheck the capability after waiting for a send; removed tokens must not mutate preferences.
    const live = await client.query('SELECT 1 FROM support_email_unsubscribe_tokens WHERE token_hash=$1 AND category=$2 AND email=$3', [hash(rawToken), row.category, row.email]);
    if (!live.rows.length) return null;
    await client.query('INSERT INTO support_email_preferences(category,email) VALUES($1,$2) ON CONFLICT(category,email) DO NOTHING', [row.category, row.email]);
    return { category: row.category, email_masked: maskedEmail(row.email), unsubscribed: true };
  });
}

function publicOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  const local = process.env.SUPPORT_EMAIL_PREFERENCES_ALLOW_LOCAL_HTTP === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Invalid email preference public URL');
  return url.origin;
}
const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function withUnsubscribeFooter(html: string, link: string, preview = false): string {
  const inactive = preview ? ' aria-disabled="true" tabindex="-1"' : '';
  const footer = `<!-- email-unsubscribe:start --><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif"><tr><td align="center" style="padding:24px 16px;font-size:12px;line-height:1.6;color:#526477"><a href="${escapeHtml(link)}"${inactive} style="color:#255c98;text-decoration:underline${preview ? ';pointer-events:none' : ''}">Unsubscribe</a></td></tr></table><!-- email-unsubscribe:end -->`;
  const original = html.replace(FOOTER, '');
  return /<\/body\s*>/i.test(original) ? original.replace(/<\/body\s*>/i, () => `${footer}</body>`) : original + footer;
}

/** Pure template preview: the placeholder can never resolve to a recipient preference. */
export function decorateEmailPreviewWithUnsubscribe(html: string, baseUrl: string): string {
  return withUnsubscribeFooter(html, `${publicOrigin(baseUrl)}/email-preferences?preview=1`, true);
}

/** Updates the system footer on queued snapshots while preserving valid tokens across retries. */
export async function decorateEmailWithUnsubscribe(mail: SupportMail, category: EmailPreferenceCategory, baseUrl: string, db: Database = database): Promise<SupportMail> {
  assertCategory(category);
  const email = normalizePreferenceEmail(mail.to), origin = publicOrigin(baseUrl);
  const blocks = mail.html.match(FOOTER) || [];
  if (blocks.length === 1) {
    const candidate = blocks[0].match(/href="([^"]+)"/);
    if (candidate) {
      let url: URL | null = null;
      try { url = new URL(candidate[1]); } catch { /* Replace malformed footer URLs. */ }
      if (url) {
        const token = url.searchParams.get('token');
        if (url.origin === origin && url.pathname === '/email-preferences' && url.searchParams.size === 1 && !url.hash && validToken(token)) {
          const binding = await db.query('SELECT 1 FROM support_email_unsubscribe_tokens WHERE token_hash=$1 AND category=$2 AND email=$3', [hash(token), category, email]);
          if (binding.rows.length) {
            const html = withUnsubscribeFooter(mail.html, url.href);
            return { ...mail, to: email, html, text: emailHtmlToText(html) };
          }
        }
      }
    }
  }
  const token = `eu_${crypto.randomBytes(32).toString('base64url')}`;
  await db.query('INSERT INTO support_email_unsubscribe_tokens(token_hash,category,email) VALUES($1,$2,$3)', [hash(token), category, email]);
  const link = `${origin}/email-preferences?token=${token}`;
  const html = withUnsubscribeFooter(mail.html, link);
  return { ...mail, to: email, html, text: emailHtmlToText(html) };
}
