import crypto from 'crypto';
import { query } from './pg';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const computed = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
}

export async function seedAgent(params: {
  username: string;
  name: string;
  password: string;
  role?: string;
}) {
  const h = hashPassword(params.password);
  await query(
    `INSERT INTO support_agents (username, name, password_hash, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO UPDATE SET name = $2, password_hash = $3, role = $4`,
    [params.username, params.name, h, params.role || 'admin'],
  );
}

export async function loginAgent(username: string, password: string): Promise<{ id: number; name: string; role: string } | null> {
  const r = await query(
    `SELECT id, name, role, password_hash, enabled FROM support_agents WHERE username = $1`,
    [username],
  );
  const agent = r.rows[0];
  if (!agent || !agent.enabled) return null;
  if (!verifyPassword(password, agent.password_hash)) return null;
  return { id: agent.id, name: agent.name, role: agent.role };
}

export async function createSession(agentId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await query(
    `INSERT INTO support_agent_sessions (session_token_hash, agent_id, expires_at)
     VALUES ($1, $2, now() + interval '7 days')`,
    [tokenHash, agentId],
  );
  return token;
}

export async function destroySession(tokenHash: string): Promise<void> {
  await query(
    `DELETE FROM support_agent_sessions WHERE session_token_hash = $1`,
    [tokenHash],
  );
}

export async function verifySession(token: string): Promise<{ agentId: number; name: string; role: string } | null> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const r = await query(
    `SELECT a.id, a.name, a.role FROM support_agent_sessions s
     JOIN support_agents a ON a.id = s.agent_id
     WHERE s.session_token_hash = $1 AND s.expires_at > now() AND a.enabled = true`,
    [tokenHash],
  );
  return r.rows[0] || null;
}

/** 修改管理员密码（需验证旧密码） */
export async function changeAgentPassword(
  agentId: number,
  oldPassword: string,
  newPassword: string,
): Promise<boolean> {
  const r = await query(
    `SELECT password_hash FROM support_agents WHERE id = $1 AND enabled = true`,
    [agentId],
  );
  const agent = r.rows[0];
  if (!agent || !verifyPassword(oldPassword, agent.password_hash)) return false;

  const newHash = hashPassword(newPassword);
  await query(
    `UPDATE support_agents SET password_hash = $1 WHERE id = $2`,
    [newHash, agentId],
  );
  return true;
}
