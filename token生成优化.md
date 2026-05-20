现在 token 不要继续用自包含 JWT-like 方案了，链接太长，邮件/浏览器可能截断。

请改成 **数据库 opaque token**：

```text
URL 里只放短随机 token
数据库里通过 token_hash 找 payload
```

目标链接：

```text
/ticket?t=bt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
/ticket?t=ta_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

不要再把这些信息塞进 token 本体：

```text
store_subdomain
order_id
customer_email
public_ticket_no
exp
nonce
```

这些改为存 PostgreSQL。

新增表：

```sql
CREATE TABLE IF NOT EXISTS support_access_tokens (
  id BIGSERIAL PRIMARY KEY,

  token_hash TEXT UNIQUE NOT NULL,
  purpose TEXT NOT NULL,

  store_subdomain TEXT,
  order_id TEXT,
  public_ticket_no TEXT,
  customer_email TEXT NOT NULL,

  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_access_tokens_hash
  ON support_access_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_support_access_tokens_ticket
  ON support_access_tokens(public_ticket_no);

CREATE INDEX IF NOT EXISTS idx_support_access_tokens_order
  ON support_access_tokens(store_subdomain, order_id);
```

Token 规则：

```text
support_bootstrap:
  前缀 bt_
  用于付款后邮件入口
  默认 30 天

ticket_access:
  前缀 ta_
  用于已创建工单后的查看 / 回复 / 关闭
  默认 90 天
```

实现方式：

```ts
import crypto from 'crypto';

export type AccessTokenPurpose = 'support_bootstrap' | 'ticket_access';

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function generateOpaqueToken(prefix: 'bt' | 'ta'): string {
  return `${prefix}_${base64urlEncode(crypto.randomBytes(32))}`;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function getExpiryDate(purpose: AccessTokenPurpose): Date {
  const days =
    purpose === 'support_bootstrap'
      ? Number(process.env.SUPPORT_BOOTSTRAP_TOKEN_DAYS || 30)
      : Number(process.env.SUPPORT_TICKET_ACCESS_TOKEN_DAYS || 90);

  return new Date(Date.now() + days * 86400 * 1000);
}
```

新增：

```ts
createBootstrapToken({
  storeSubdomain,
  orderId,
  customerEmail
})
```

逻辑：

```text
1. 生成 bt_ 随机 token
2. hash token
3. 写 support_access_tokens
4. 返回原始 token 给邮件链接使用
```

新增：

```ts
createTicketAccessToken({
  publicTicketNo,
  customerEmail
})
```

逻辑：

```text
1. 生成 ta_ 随机 token
2. hash token
3. 写 support_access_tokens
4. 返回原始 token 给顾客查看工单链接使用
```

验证函数改成异步查库：

```ts
verifyAccessToken(token)
```

逻辑：

```text
1. hash token
2. 查 support_access_tokens
3. 不存在 → null
4. revoked_at 有值 → null
5. expires_at 过期 → null
6. 返回 purpose / store_subdomain / order_id / public_ticket_no / customer_email
```

原来的：

```ts
generateBootstrapToken(...)
verifyToken(...)
generateTicketAccessToken(...)
```

需要替换为：

```ts
await createBootstrapToken(...)
await verifyAccessToken(...)
await createTicketAccessToken(...)
```

注意：

```text
1. 不要再把订单号、邮箱、店铺信息放进 URL token 里
2. 邮件链接只放短 token
3. 数据库只存 token_hash，不存原始 token
4. purpose 统一使用：
   - support_bootstrap
   - ticket_access
5. 旧代码里的 ticket_access 可以保留，但不要和 support_ticket_access 混用
6. bootstrap token 只能用于初始化售后页和创建首个工单
7. ticket_access token 只能用于查看 / 回复 / 关闭已存在工单
```

这样可以解决现在 token 太长、邮件链接被截断的问题，也方便以后撤销 token、重发链接和排查访问记录。
