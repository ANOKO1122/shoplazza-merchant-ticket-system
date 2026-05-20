=阶段10：
注意一点：店铺表变更和 webhook 注册不是同一个事务。数据库写入可以回滚，Shoplazza webhook 注册是外部 API 调用，可能失败。所以要设计成“状态机 + 重试”，不要做成简单同步硬绑死。

推荐流程
添加店铺
管理员添加店铺
  ↓
写 support_stores，状态 webhook_status = pending
  ↓
调用 Shoplazza API 注册 orders/paid webhook
  ↓
注册成功，保存 webhook_id，状态改为 active
  ↓
注册失败，状态改为 webhook_failed，保存错误

不要这样：

先调用 Shoplazza 注册 webhook
  ↓
再写数据库

因为如果数据库写失败，你会留下一个无人管理的 webhook。

删除店铺

不建议物理删除，建议先软删除：

管理员删除店铺
  ↓
enabled = false
  ↓
webhook_status = deleting
  ↓
调用 Shoplazza DELETE webhook
  ↓
成功后 webhook_status = deleted

如果删除 webhook 失败：

enabled = false
webhook_status = delete_failed
保存 error_message
后台显示“需要重试删除 webhook”

这样至少不会继续主动同步或发送邮件。

建议新增表：support_stores
CREATE TABLE IF NOT EXISTS support_stores (
  id BIGSERIAL PRIMARY KEY,

  store_subdomain TEXT UNIQUE NOT NULL,
  store_name TEXT NOT NULL,

  access_token_encrypted TEXT NOT NULL,

  enabled BOOLEAN NOT NULL DEFAULT true,

  webhook_orders_paid_id TEXT,
  webhook_orders_paid_address TEXT,
  webhook_status TEXT NOT NULL DEFAULT 'pending',
  webhook_error TEXT,

  last_webhook_registered_at TIMESTAMPTZ,
  last_webhook_deleted_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_stores_enabled
  ON support_stores(enabled);

CREATE INDEX IF NOT EXISTS idx_support_stores_webhook_status
  ON support_stores(webhook_status);

webhook_status 建议只保留这些：

pending
active
webhook_failed
deleting
deleted
delete_failed
access_token 不要明文存

店铺 token 要加密存，不要直接明文放 PostgreSQL。

至少做：

access_token_encrypted

用环境变量放主密钥：

SUPPORT_STORE_TOKEN_ENCRYPTION_KEY=base64-32-bytes-key

如果你们短期本地测试，可以先明文，但生产前必须改成加密。

Webhook 地址怎么生成

每个店铺固定：

https://support.yourdomain.com/api/shoplazza/webhooks/{store_subdomain}

例如：

https://support.yourdomain.com/api/shoplazza/webhooks/store-a

注册时写入：

topic = orders/paid
address = 上面的地址
format = json

以后如果你们还要订单状态更新，再加：

orders/update
orders/refunded
orders/cancelled
orders/fulfilled

但 MVP 先只自动注册：

orders/paid
后端 API 建议
添加店铺
POST /api/admin/stores
Content-Type: application/json

请求：

{
  "store_subdomain": "store-a",
  "store_name": "Store A",
  "access_token": "xxx"
}

处理：

1. 校验店铺 subdomain 唯一
2. 校验 token 能访问 Shoplazza，例如调用一个轻量接口
3. 写 support_stores，状态 pending
4. 注册 orders/paid webhook
5. 保存 webhook_id
6. 状态 active
店铺列表
GET /api/admin/stores

返回：

{
  "stores": [
    {
      "store_subdomain": "store-a",
      "store_name": "Store A",
      "enabled": true,
      "webhook_status": "active",
      "webhook_orders_paid_id": "123456789",
      "last_webhook_registered_at": "2026-05-13T10:00:00Z"
    }
  ]
}

不要返回 access token。

删除店铺
DELETE /api/admin/stores/:storeSubdomain

处理：

1. enabled = false
2. webhook_status = deleting
3. 调 Shoplazza 删除 webhook
4. 成功后 webhook_status = deleted
5. 失败后 webhook_status = delete_failed
重试注册 webhook
POST /api/admin/stores/:storeSubdomain/webhook/retry

用于处理：

webhook_failed
delete_failed
定时任务也要改

原来你可能从：

SUPPORT_SHOPLAZZA_STORES_JSON

遍历店铺。

改成从数据库查：

SELECT *
FROM support_stores
WHERE enabled = true
  AND webhook_status = 'active';

每小时兜底任务只处理这些店铺。

webhook 接收时也要查数据库

收到：

POST /api/shoplazza/webhooks/store-a

后端逻辑：

1. 根据 storeSubdomain 查 support_stores
2. 如果不存在，返回 404 或 200 + ignored
3. 如果 enabled = false，记录 ignored
4. 如果存在且 enabled = true，继续处理
5. 使用 access_token_encrypted 解密后的 token 调 Shoplazza API 补查订单详情

我建议对未知店铺返回 200 ignored，避免 Shoplazza 反复重试；但要记录日志。对生产系统来说：

未知店铺 webhook = 安全事件 / 配置残留
关键风险
1. 添加店铺时 webhook 注册失败

不能让整个系统崩。状态写成：

webhook_failed

后台显示“注册失败，可重试”。

2. 删除店铺时 webhook 删除失败

不能物理删店铺，否则你以后不知道要删哪个 webhook id。

所以必须保留：

webhook_orders_paid_id
webhook_status = delete_failed
3. webhook 重复注册

添加店铺前建议先查该店已有 webhook 列表，看看相同 address + topic 是否已经存在。

如果存在：

直接复用已有 webhook_id
不要重复注册
4. access token 失效

定时任务或 webhook 处理时如果 Shoplazza API 返回鉴权失败：

店铺状态可以标记为 token_invalid
后台提示重新填写 token

可以后面再加这个状态。