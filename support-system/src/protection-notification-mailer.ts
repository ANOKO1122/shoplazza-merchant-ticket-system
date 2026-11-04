import nodemailer from 'nodemailer';
import { sendSupportEmail, type SupportMail } from './mailer';

type Environment = Record<string, string | undefined>;
type ProtectionMailMode = 'disabled' | 'shared' | 'dedicated';
export interface ProtectionMailReadiness { mode: ProtectionMailMode; ready: boolean; reason?: string; }

/** A new domain does not authorize reuse of the ordinary ticket sender. */
export function protectionMailReadiness(env: Environment = process.env): ProtectionMailReadiness {
  const mode = env.SUPPORT_PROTECTION_MAIL_MODE || 'disabled';
  if (mode === 'disabled') return { mode, ready: false, reason: 'disabled' };
  if (mode === 'shared') return { mode, ready: true };
  if (mode !== 'dedicated') return { mode: 'disabled', ready: false, reason: 'invalid_mode' };
  const required = ['SUPPORT_PROTECTION_SMTP_HOST', 'SUPPORT_PROTECTION_SMTP_PORT', 'SUPPORT_PROTECTION_SMTP_USER', 'SUPPORT_PROTECTION_SMTP_PASS', 'SUPPORT_PROTECTION_MAIL_FROM'];
  if (required.some(key => !env[key]?.trim())) return { mode, ready: false, reason: 'incomplete_dedicated_settings' };
  const port = Number(env.SUPPORT_PROTECTION_SMTP_PORT);
  const from = env.SUPPORT_PROTECTION_MAIL_FROM!.trim();
  const singleSender = /^(?:[^<>\s@,;]+@us-seel\.com|[^<>\r\n,;]*<[^<>\s@,;]+@us-seel\.com>)$/i.test(from);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !singleSender) return { mode, ready: false, reason: 'invalid_dedicated_settings' };
  if (env.SUPPORT_PROTECTION_MAIL_REPLY_TO && /[\r\n]/.test(env.SUPPORT_PROTECTION_MAIL_REPLY_TO)) return { mode, ready: false, reason: 'invalid_dedicated_settings' };
  return { mode, ready: true };
}

export async function sendProtectionNotificationEmail(mail: SupportMail, env: Environment = process.env): Promise<{ messageId: string }> {
  const readiness = protectionMailReadiness(env);
  if (!readiness.ready) throw new Error(`Protection email delivery unavailable: ${readiness.reason}`);
  if (readiness.mode === 'shared') return sendSupportEmail(mail);
  const transport = nodemailer.createTransport({
    host: env.SUPPORT_PROTECTION_SMTP_HOST!.trim(), port: Number(env.SUPPORT_PROTECTION_SMTP_PORT),
    secure: env.SUPPORT_PROTECTION_SMTP_SECURE === 'true', requireTLS: env.SUPPORT_PROTECTION_SMTP_SECURE !== 'true',
    auth: { user: env.SUPPORT_PROTECTION_SMTP_USER!, pass: env.SUPPORT_PROTECTION_SMTP_PASS! },
    connectionTimeout: 10000, greetingTimeout: 5000, socketTimeout: 15000,
  });
  try {
    const result = await transport.sendMail({ ...mail, from: env.SUPPORT_PROTECTION_MAIL_FROM!.trim(), replyTo: env.SUPPORT_PROTECTION_MAIL_REPLY_TO?.trim() || env.SUPPORT_PROTECTION_MAIL_FROM!.trim() });
    if (result.rejected?.length) throw new Error('Protection email recipient rejected');
    return { messageId: result.messageId || mail.messageId || '' };
  } finally { transport.close(); }
}
