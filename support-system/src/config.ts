import { getEnabledStores } from './store-service';

export interface ShoplazzaStoreConfig {
  subdomain: string;
  storeName: string;
  accessToken: string;
}

export interface Config {
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  pgPoolMax: number;
  tokenSecret: string;
  bootstrapTokenDays: number;
  ticketAccessTokenDays: number;
  mailFrom: string;
  mailReplyTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
}

const REQUIRED_VARS = [
  'SUPPORT_PUBLIC_BASE_URL',
  'SUPPORT_DATABASE_URL',
  'SUPPORT_TOKEN_SECRET',
  'SUPPORT_MAIL_FROM',
  'SUPPORT_SMTP_HOST',
  'SUPPORT_SMTP_PORT',
] as const;

function normalizeSubdomain(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '');
  const host = s.split('/')[0]?.trim() ?? s;
  const lower = host.toLowerCase();
  const suffix = '.myshoplaza.com';
  if (lower.endsWith(suffix)) {
    return host.slice(0, host.length - suffix.length).trim();
  }
  return host.trim();
}

/** 从 subdomain/domain 字段构建完整店铺域名。
 *  如果已经是完整域名（含 .），直接返回；否则拼接 .myshoplaza.com */
export function buildStoreDomain(subdomainOrDomain: string): string {
  const s = (subdomainOrDomain || '').trim();
  if (!s) return '';
  if (s.includes('.')) return s; // 已是完整域名如 store-a.myshoplaza.com
  return `${s}.myshoplaza.com`;  // 旧格式：仅 subdomain 前缀
}

/** 从 subdomain/domain 字段提取 API 主机名（用于构造 Shoplazza API URL）。
 *  如果已是完整域名，直接返回；否则拼接 .myshoplaza.com */
export function buildApiHost(subdomainOrDomain: string): string {
  return buildStoreDomain(subdomainOrDomain);
}

export function parseShoplazzaStoresFromEnv(): ShoplazzaStoreConfig[] {
  const raw = (process.env.SUPPORT_SHOPLAZZA_STORES_JSON || '').trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SUPPORT_SHOPLAZZA_STORES_JSON 不是合法 JSON');
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as Array<Record<string, unknown>>).map((item, i) => {
    const subdomain = normalizeSubdomain(String(item.subdomain ?? '').trim());
    const storeName = String(item.store_name ?? item.storeName ?? '').trim() || subdomain;
    const accessToken = String(item.access_token ?? item.accessToken ?? '').trim();
    if (!subdomain || !accessToken) {
      throw new Error(`SUPPORT_SHOPLAZZA_STORES_JSON[${i}] 缺少 subdomain 或 access_token`);
    }
    return { subdomain, storeName, accessToken };
  });
}

export function loadConfig(): Config {
  for (const key of REQUIRED_VARS) {
    if (!process.env[key]?.trim()) {
      throw new Error(`缺少环境变量: ${key}`);
    }
  }

  return {
    port: Number(process.env.PORT) || 4001,
    publicBaseUrl: process.env.SUPPORT_PUBLIC_BASE_URL!.trim().replace(/\/$/, ''),
    databaseUrl: process.env.SUPPORT_DATABASE_URL!.trim(),
    pgPoolMax: Number(process.env.SUPPORT_PG_POOL_MAX) || 10,
    tokenSecret: process.env.SUPPORT_TOKEN_SECRET!.trim(),
    bootstrapTokenDays: Number(process.env.SUPPORT_BOOTSTRAP_TOKEN_DAYS) || 30,
    ticketAccessTokenDays: Number(process.env.SUPPORT_TICKET_ACCESS_TOKEN_DAYS) || 90,
    mailFrom: process.env.SUPPORT_MAIL_FROM!.trim(),
    mailReplyTo: (process.env.SUPPORT_MAIL_REPLY_TO || process.env.SUPPORT_MAIL_FROM!).trim(),
    smtpHost: process.env.SUPPORT_SMTP_HOST!.trim(),
    smtpPort: Number(process.env.SUPPORT_SMTP_PORT) || 587,
    smtpSecure: process.env.SUPPORT_SMTP_SECURE === 'true',
    smtpUser: (process.env.SUPPORT_SMTP_USER || '').trim(),
    smtpPass: (process.env.SUPPORT_SMTP_PASS || '').trim(),
  };
}

export async function loadStoresConfig(): Promise<ShoplazzaStoreConfig[]> {
  const dbStores = await getEnabledStores();
  if (dbStores.length > 0) {
    return dbStores.map(s => ({
      subdomain: s.subdomain,
      storeName: s.store_name || s.subdomain,
      accessToken: s.access_token,
    }));
  }
  return parseShoplazzaStoresFromEnv();
}
