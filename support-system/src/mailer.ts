import nodemailer, { Transporter } from 'nodemailer';
import { loadConfig } from './config';
import { getMailTestMode } from './email-service';

export interface SupportMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

// ── Transporter 复用 ──
let cachedTransporter: Transporter | null = null;
let cachedFingerprint = '';

function buildFingerprint(host: string, port: number, secure: boolean, user: string, testMode: boolean): string {
  return `${host}:${port}:${secure}:${user}:${testMode}`;
}

async function getTransporter(): Promise<Transporter> {
  const config = loadConfig();
  const testMode = await getMailTestMode().catch(() => false);

  let host: string;
  let port: number;
  let secure: boolean;
  let auth: { user: string; pass: string } | undefined;

  if (testMode) {
    // Mailpit 测试模式：Docker 网络内用容器名 mailpit，宿主机用 localhost
    // 可通过 SUPPORT_MAILPIT_HOST 环境变量覆盖
    host = process.env.SUPPORT_MAILPIT_HOST || 'mailpit';
    port = 1025;
    secure = false;
    auth = undefined;
  } else {
    // 生产模式：阿里云邮件推送等
    host = config.smtpHost;
    port = config.smtpPort;
    secure = config.smtpSecure;
    auth = config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined;
  }

  const fp = buildFingerprint(host, port, secure, auth?.user || '', testMode);

  if (cachedTransporter && cachedFingerprint === fp) {
    return cachedTransporter;
  }

  // 配置变了，关闭旧连接，创建新的
  if (cachedTransporter) {
    cachedTransporter.close();
  }

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth,
    connectionTimeout: 10000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  });

  cachedFingerprint = fp;
  return cachedTransporter;
}

export async function sendSupportEmail(mail: SupportMail): Promise<{ messageId: string }> {
  const config = loadConfig();
  const transporter = await getTransporter();

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
