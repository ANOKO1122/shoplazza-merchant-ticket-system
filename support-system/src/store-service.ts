import crypto from 'crypto';
import { query } from './pg';

function getEncryptionKey(): Buffer {
  const secret = process.env.SUPPORT_TOKEN_SECRET;
  if (!secret) throw new Error('缺少环境变量 SUPPORT_TOKEN_SECRET');
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptToken(token: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

export function decryptToken(encrypted: string): string {
  try {
    const parts = encrypted.split(':');
    if (parts.length !== 3) return encrypted; // Not encrypted (legacy plaintext)
    const key = getEncryptionKey();
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encryptedData = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return encrypted; // Fallback: treat as plaintext
  }
}

export interface StoreRecord {
  id: number;
  subdomain: string;
  store_name: string;
  access_token: string;
  enabled: boolean;
}

export async function listStores(): Promise<StoreRecord[]> {
  const r = await query(`SELECT id, subdomain, store_name, access_token, enabled FROM support_stores ORDER BY id`);
  return r.rows.map(row => ({ ...row, access_token: decryptToken(row.access_token) }));
}

export async function getEnabledStores(): Promise<StoreRecord[]> {
  const r = await query(`SELECT id, subdomain, store_name, access_token, enabled FROM support_stores WHERE enabled = true ORDER BY id`);
  return r.rows.map(row => ({ ...row, access_token: decryptToken(row.access_token) }));
}

export async function getStoreBySubdomain(subdomain: string): Promise<StoreRecord | null> {
  const r = await query(`SELECT id, subdomain, store_name, access_token, enabled FROM support_stores WHERE subdomain = $1`, [subdomain]);
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, access_token: decryptToken(row.access_token) };
}

export async function createStore(params: { subdomain: string; store_name?: string; access_token: string }): Promise<StoreRecord> {
  const encrypted = encryptToken(params.access_token);
  const r = await query(
    `INSERT INTO support_stores (subdomain, store_name, access_token)
     VALUES ($1, $2, $3)
     ON CONFLICT (subdomain) DO UPDATE SET access_token = $3, updated_at = now()
     RETURNING id, subdomain, store_name, access_token, enabled`,
    [params.subdomain, params.store_name || params.subdomain, encrypted],
  );
  const row = r.rows[0];
  return { ...row, access_token: params.access_token };
}

export async function updateStore(id: number, params: { subdomain?: string; store_name?: string; access_token?: string; enabled?: boolean }): Promise<StoreRecord | null> {
  const sets: string[] = [];
  const vals: (string | number | boolean)[] = [];
  let idx = 1;
  if (params.subdomain !== undefined) { sets.push(`subdomain = $${idx++}`); vals.push(params.subdomain); }
  if (params.store_name !== undefined) { sets.push(`store_name = $${idx++}`); vals.push(params.store_name); }
  if (params.access_token !== undefined) { sets.push(`access_token = $${idx++}`); vals.push(encryptToken(params.access_token)); }
  if (params.enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(params.enabled); }
  if (sets.length === 0) return null;
  sets.push(`updated_at = now()`);
  vals.push(id);
  const r = await query(
    `UPDATE support_stores SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, subdomain, store_name, access_token, enabled`,
    vals,
  );
  const row = r.rows[0];
  if (!row) return null;

  // Sync store_name to existing tickets when name changes
  if (params.store_name !== undefined) {
    await query(
      `UPDATE support_tickets SET store_name = $1 WHERE store_subdomain = $2`,
      [params.store_name, row.subdomain],
    );
  }

  return { ...row, access_token: params.access_token || row.access_token };
}

export async function deleteStore(id: number): Promise<boolean> {
  const r = await query(`DELETE FROM support_stores WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}
