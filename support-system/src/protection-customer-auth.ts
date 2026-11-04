import crypto from 'crypto';
import type { Request } from 'express';
import { query } from './pg';
import { ProtectionError } from './protection-domain';

export const PROTECTION_COOKIE='protection_customer';
export const PROTECTION_ACCESS_LINK_DAYS=90;
export const digest=(value:string)=>crypto.createHash('sha256').update(value).digest('hex');
export interface ProtectionCustomerIdentity { orderId:string; publicNo:string; email:string; sessionHash:string; }
export function protectionPublicBaseUrl():string {
  const url=new URL(process.env.SUPPORT_PROTECTION_PUBLIC_BASE_URL||'https://us-seel.com');
  const local=process.env.SUPPORT_PROTECTION_ALLOW_LOCAL_HTTP==='true'&&['127.0.0.1','localhost'].includes(url.hostname);
  if((url.protocol!=='https:'&&!local)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Invalid protection public base URL');
  return url.origin;
}
export async function createProtectionAccessLink(protectionOrderId:string):Promise<string>{
  if(!/^[1-9]\d{0,18}$/.test(protectionOrderId))throw new ProtectionError('Invalid protection order',400);
  const result=await query('SELECT customer_email FROM support_protection_orders WHERE id=$1',[protectionOrderId]);
  const email=result.rows[0]?.customer_email;
  if(!email)throw new ProtectionError('Protection order has no customer email',404);
  const token=`pa_${crypto.randomBytes(32).toString('base64url')}`;
  await query(`INSERT INTO support_protection_access_tokens(token_hash,protection_order_id,customer_email,expires_at) VALUES($1,$2,$3,now()+make_interval(days=>$4::int))`,[digest(token),protectionOrderId,email,PROTECTION_ACCESS_LINK_DAYS]);
  return `${protectionPublicBaseUrl()}/protection#access=${token}`;
}
export async function exchangeProtectionAccessToken(value:unknown):Promise<{session:string;protection_no:string}>{
  if(typeof value!=='string'||!/^pa_[A-Za-z0-9_-]{43}$/.test(value))throw new ProtectionError('This access link is invalid or expired.',401);
  const session=`ps_${crypto.randomBytes(32).toString('base64url')}`;
  const result=await query(`WITH valid AS (SELECT t.token_hash,t.expires_at,o.public_no FROM support_protection_access_tokens t
    JOIN support_protection_orders o ON o.id=t.protection_order_id
    WHERE t.token_hash=$2 AND t.revoked_at IS NULL AND t.expires_at>now() AND lower(t.customer_email)=lower(o.customer_email)),
    inserted AS (INSERT INTO support_protection_customer_sessions(session_hash,token_hash,expires_at)
      SELECT $1,token_hash,LEAST(now()+interval '12 hours',expires_at) FROM valid RETURNING session_hash)
    SELECT valid.public_no FROM valid,inserted`,[digest(session),digest(value)]);
  if(!result.rows.length)throw new ProtectionError('This access link is invalid or expired.',401);
  return {session,protection_no:result.rows[0].public_no};
}
export async function getProtectionCustomer(req:Request):Promise<ProtectionCustomerIdentity|null>{
  const token=(req.headers.cookie||'').split(';').map(p=>p.trim()).find(p=>p.startsWith(`${PROTECTION_COOKIE}=`))?.slice(PROTECTION_COOKIE.length+1);
  if(!token||!/^ps_[A-Za-z0-9_-]{43}$/.test(token))return null;
  const hash=digest(token);
  const result=await query(`SELECT t.protection_order_id,t.customer_email,o.public_no FROM support_protection_customer_sessions s
    JOIN support_protection_access_tokens t ON t.token_hash=s.token_hash JOIN support_protection_orders o ON o.id=t.protection_order_id
    WHERE s.session_hash=$1 AND s.expires_at>now() AND t.expires_at>now() AND t.revoked_at IS NULL AND lower(o.customer_email)=lower(t.customer_email)`,[hash]);
  return result.rows[0]?{orderId:String(result.rows[0].protection_order_id),publicNo:result.rows[0].public_no,email:result.rows[0].customer_email,sessionHash:hash}:null;
}
