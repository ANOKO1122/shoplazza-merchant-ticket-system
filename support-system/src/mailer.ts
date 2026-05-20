import nodemailer from 'nodemailer';
import { loadConfig } from './config';
import { getMailTestMode } from './email-service';

export interface SupportMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendSupportEmail(mail: SupportMail): Promise<{ messageId: string }> {
  const config = loadConfig();
  const testMode = await getMailTestMode().catch(() => false);

  let host = config.smtpHost;
  let port = config.smtpPort;
  let secure = config.smtpSecure;
  let auth: { user: string; pass: string } | undefined = config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined;

  // Mailpit 测试模式：强制发送到 localhost:1025，无认证
  if (testMode) {
    host = 'localhost';
    port = 1025;
    secure = false;
    auth = undefined;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth,
    // 连接超时防止长时间阻塞
    connectionTimeout: 10000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  });

  const result = await transporter.sendMail({
    from: config.mailFrom,
    replyTo: config.mailReplyTo,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });

  return { messageId: result.messageId || '' };
}
