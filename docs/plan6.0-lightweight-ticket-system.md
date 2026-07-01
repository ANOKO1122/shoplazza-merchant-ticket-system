# Plan 6.0：极简自研工单系统（移除 Chatwoot 依赖，PG + 自有邮件 + 本地先跑通）

> 目标：在现有 `support-bridge` 阶段 1-4 已完成的基础上，彻底移除 Chatwoot 依赖，改成自研极简工单系统。  
> 系统只保留必要能力：订单售后入口、顾客提交/查看/回复、客服登录、客服查看订单信息、客服回复、工单状态管理、邮件通知。  
> 不做群组、不做聊天室、不做多渠道、不做复杂权限、不做附件、不做 SLA、不做统计报表。  
> 先本地单机跑通全链路，再部署公网服务器。

---

## 0. 当前背景

当前已经完成：

```text
阶段 1：Express 骨架 + 配置
阶段 2：PostgreSQL 建表
阶段 3：Shoplazza Webhook
阶段 4：订单补全 + normalize
```

当前已有能力：

```text
support-bridge 可以启动
/health 可用
PostgreSQL 可用
Shoplazza orders/paid webhook 可接收
webhook 事件可写入 shoplazza_webhook_events
orders/paid 后可补查订单详情 / 交易详情
support_order_snapshots 可写入订单号、支付时间、支付方式、payment_channel、card_last4
```

现在调整方向：

```text
移除 Chatwoot
不再配置 Chatwoot Inbox
不再调用 Chatwoot API
不再使用 Chatwoot 发送邮件
不再通过 Chatwoot webhook 接收客服回复事件
```

改成：

```text
support-bridge 自己做轻量工单后端
PostgreSQL 继续作为唯一业务数据库
邮件由 support-bridge 自己通过工单域名 SMTP 发送
客服后台由 support-bridge 自己提供
顾客前端由 support-bridge 自己提供
```

---

## 1. 设计原则

### 1.1 极简原则

只做必要功能：

```text
顾客端：
- 查看订单信息
- 查看支付信息
- 提交售后问题
- 查看客服回复
- 继续文字回复
- 关闭工单

客服端：
- 登录
- 查看工单列表
- 查看工单详情
- 查看对应订单信息
- 回复工单
- 修改工单状态
```

明确不做：

```text
群组
团队
聊天室
在线状态
客服分配规则
复杂权限
SLA
报表
标签系统
附件上传
图片上传
邮件正文回复
多邮箱路由
客户联系人库
内部知识库
机器人
多渠道 inbox
```

### 1.2 流量假设

```text
客服数量：少量
工单量：最多约 100 单 / 天
消息类型：纯文字
附件：不支持
前端：必须适配手机端
数据库：PostgreSQL
邮件：一个工单域名发信
```

该规模下，不需要复杂客服系统。  
一个单体 Express + PostgreSQL + 简单前端即可。

---

## 2. 总体数据流

### 2.1 用户付款后通知

```text
用户付款
  ↓
Shoplazza orders/paid webhook
  ↓
support-bridge 接收 webhook
  ↓
补查订单详情 / 交易详情
  ↓
写 support_order_snapshots
  ↓
检查 support_email_events 是否已发送付款后通知
  ↓
生成 support_bootstrap token
  ↓
用工单域名邮箱发送通知邮件
  ↓
顾客点击链接进入前端页面
```

注意：

```text
付款后只发通知
付款后不创建工单
付款后不写 support_tickets
付款后不生成 public_ticket_no
```

### 2.2 顾客提交工单

```text
顾客打开 /ticket?t=BOOTSTRAP_TOKEN
  ↓
前端展示订单信息 / 支付信息
  ↓
顾客填写问题类型 + 文字描述
  ↓
POST /api/support/tickets
  ↓
创建 support_tickets
  ↓
创建第一条 support_ticket_messages
  ↓
生成 public_ticket_no
  ↓
发送客服内部通知邮件，或客服后台直接显示新工单
```

### 2.3 客服回复

```text
客服登录 /admin
  ↓
打开工单详情
  ↓
查看订单信息和消息记录
  ↓
回复文字
  ↓
写 support_ticket_messages
  ↓
更新 support_tickets.last_agent_message_at
  ↓
发送顾客提醒邮件
  ↓
顾客点击链接回前端查看
```

### 2.4 顾客继续回复 / 关闭工单

```text
顾客点击邮件链接
  ↓
进入 /ticket?t=ACCESS_TOKEN
  ↓
查看客服回复
  ↓
继续文字回复
  或点击关闭工单
```

---

## 3. PostgreSQL 表设计

当前已存在：

```text
support_order_snapshots
shoplazza_webhook_events
support_email_events
```

需要新增：

```text
support_tickets
support_ticket_messages
support_agents
support_agent_sessions
```

---

### 3.1 `support_tickets`

用途：保存真正的售后工单。

```sql
CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGSERIAL PRIMARY KEY,

  public_ticket_no TEXT UNIQUE NOT NULL,

  store_subdomain TEXT NOT NULL,
  store_name TEXT,

  order_id TEXT NOT NULL,
  order_number TEXT,
  customer_email TEXT NOT NULL,
  customer_name TEXT,

  issue_type TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',

  customer_access_token_hash TEXT NOT NULL,
  bootstrap_token_hash TEXT,

  last_customer_message_at TIMESTAMPTZ,
  last_agent_message_at TIMESTAMPTZ,
  last_customer_viewed_at TIMESTAMPTZ,

  closed_at TIMESTAMPTZ,
  closed_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(store_subdomain, order_id, customer_email)
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_order
  ON support_tickets(store_subdomain, order_id);

CREATE INDEX IF NOT EXISTS idx_support_tickets_email
  ON support_tickets(customer_email);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status_updated
  ON support_tickets(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_public_no
  ON support_tickets(public_ticket_no);
```

状态建议只保留：

```text
open        新工单 / 待客服处理
waiting     已回复，等待顾客
closed      已关闭
```

---

### 3.2 `support_ticket_messages`

用途：保存工单消息，只支持纯文字。

```sql
CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id BIGSERIAL PRIMARY KEY,

  public_ticket_no TEXT NOT NULL,

  sender_type TEXT NOT NULL,
  sender_email TEXT,
  sender_name TEXT,

  content TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket
  ON support_ticket_messages(public_ticket_no, created_at ASC);
```

`sender_type` 只允许：

```text
customer
agent
system
```

明确不做：

```text
内部备注
附件
图片
富文本
HTML 消息
```

MVP 只做纯文本 `content`。

---

### 3.3 `support_agents`

用途：保存客服账号。

```sql
CREATE TABLE IF NOT EXISTS support_agents (
  id BIGSERIAL PRIMARY KEY,

  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,

  role TEXT NOT NULL DEFAULT 'agent',
  enabled BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_agents_email
  ON support_agents(email);
```

角色只保留：

```text
admin
agent
```

MVP 权限：

```text
admin:
  可以创建/禁用客服账号
  可以处理工单

agent:
  可以查看和回复工单
  可以修改工单状态
```

如果想更轻量，第一版可以只建一个管理员账号，不做客服账号管理页面，用脚本创建客服。

---

### 3.4 `support_agent_sessions`

用途：客服后台登录 session。

```sql
CREATE TABLE IF NOT EXISTS support_agent_sessions (
  id BIGSERIAL PRIMARY KEY,

  session_token_hash TEXT UNIQUE NOT NULL,
  agent_id BIGINT NOT NULL REFERENCES support_agents(id) ON DELETE CASCADE,

  expires_at TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_agent_sessions_token
  ON support_agent_sessions(session_token_hash);

CREATE INDEX IF NOT EXISTS idx_support_agent_sessions_agent
  ON support_agent_sessions(agent_id);
```

MVP：

```text
HTTP-only cookie + session token
session 有效期 7 天
退出登录时删除 session
```

不要做 OAuth / SSO / MFA。

---

### 3.5 `support_email_events`

继续沿用现有表，但改为自有 SMTP 发信记录。

建议字段：

```sql
CREATE TABLE IF NOT EXISTS support_email_events (
  id BIGSERIAL PRIMARY KEY,

  event_key TEXT UNIQUE NOT NULL,

  public_ticket_no TEXT,
  store_subdomain TEXT NOT NULL,
  store_name TEXT,
  order_id TEXT,
  order_number TEXT,
  customer_email TEXT NOT NULL,

  event_type TEXT NOT NULL,
  subject TEXT,

  delivery_provider TEXT NOT NULL DEFAULT 'smtp',
  provider_message_id TEXT,

  sent_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_email_events_ticket
  ON support_email_events(public_ticket_no);

CREATE INDEX IF NOT EXISTS idx_support_email_events_order
  ON support_email_events(store_subdomain, order_id, event_type);

CREATE INDEX IF NOT EXISTS idx_support_email_events_email
  ON support_email_events(customer_email);
```

事件类型：

```text
paid_support_invite
agent_reply_notice
ticket_created_agent_notice
ticket_closed_notice
```

幂等 key：

```text
paid_support_invite:{store_subdomain}:{order_id}:{customer_email}
agent_reply_notice:{public_ticket_no}:{message_id}
ticket_created_agent_notice:{public_ticket_no}
ticket_closed_notice:{public_ticket_no}
```

---

## 4. 邮件设计

### 4.1 发件域名

只使用一个工单域名发信：

```text
support.yourdomain.com
```

建议邮箱：

```text
no-reply@support.yourdomain.com
```

或者：

```text
support@support.yourdomain.com
```

邮件正文必须明确：

```text
请点击链接进入工单页面查看和回复
不要直接回复此邮件
```

### 4.2 SMTP 环境变量

生产：

```env
SUPPORT_MAIL_FROM="ThinkPro Support <no-reply@support.yourdomain.com>"
SUPPORT_MAIL_REPLY_TO=no-reply@support.yourdomain.com

SUPPORT_SMTP_HOST=smtp.yourprovider.com
SUPPORT_SMTP_PORT=587
SUPPORT_SMTP_SECURE=false
SUPPORT_SMTP_USER=no-reply@support.yourdomain.com
SUPPORT_SMTP_PASS=replace-me
```

本地 Mailpit：

```env
SUPPORT_MAIL_FROM="Local Support <no-reply@local.test>"
SUPPORT_MAIL_REPLY_TO=no-reply@local.test

SUPPORT_SMTP_HOST=mailpit
SUPPORT_SMTP_PORT=1025
SUPPORT_SMTP_SECURE=false
SUPPORT_SMTP_USER=
SUPPORT_SMTP_PASS=
```

### 4.3 付款后通知邮件

触发：

```text
orders/paid webhook
或 1 小时兜底任务发现 paid 订单未发送通知
```

邮件内容：

```text
主题：您的订单已付款，可在需要时申请售后

您好，

我们已收到您的付款。

店铺：ThinkPro
订单号：#897542
支付时间：2026-05-11 10:30
支付方式：Shoplazza Payments-Card（尾号 4690）

如需售后，请点击以下链接提交申请：
https://support.yourdomain.com/ticket?t=BOOTSTRAP_TOKEN

为了保护您的隐私，请不要转发此链接。
```

无 `card_last4`：

```text
支付方式：PayPal
```

### 4.4 客服回复提醒邮件

触发：

```text
客服在后台回复工单
```

邮件内容：

```text
主题：您的售后工单有新的回复

您好，

您的售后工单有新的回复。

店铺：ThinkPro
订单号：#897542
工单号：T202605120001

请点击下面链接查看并回复：
https://support.yourdomain.com/ticket?t=ACCESS_TOKEN

请不要直接回复此邮件。请通过页面继续沟通。
```

禁止：

```text
不要把客服回复正文放入邮件
不要支持邮件正文回复
不要解析 inbound email
```

---

## 5. Token 设计

### 5.1 Bootstrap Token

付款后邮件使用。

用途：

```text
顾客打开售后入口
查看订单信息
提交首个工单
```

payload：

```json
{
  "purpose": "support_bootstrap",
  "store_subdomain": "store-a",
  "store_name": "Store A",
  "order_id": "897542",
  "order_number": "#897542",
  "customer_email": "xxx@example.com",
  "exp": "2026-06-11T00:00:00Z",
  "nonce": "random"
}
```

### 5.2 Ticket Access Token

工单创建后使用。

用途：

```text
顾客查看工单消息
顾客继续回复
顾客关闭工单
```

payload：

```json
{
  "purpose": "support_ticket_access",
  "public_ticket_no": "T202605120001",
  "store_subdomain": "store-a",
  "customer_email": "xxx@example.com",
  "exp": "2026-08-11T00:00:00Z",
  "nonce": "random"
}
```

### 5.3 规则

```text
HMAC-SHA256 签名
base64url 编码
URL 里只放 token
不把 email/order_id/ticket_no 明文放 query
数据库只保存 token hash
bootstrap token 默认 30 天
ticket access token 默认 90 天
```

---

## 6. 后端 API 设计

### 6.1 顾客端 API

#### 初始化售后页面

```http
GET /api/support/bootstrap?t=BOOTSTRAP_TOKEN
```

返回：

```json
{
  "ok": true,
  "mode": "new_ticket",
  "order": {
    "store_name": "ThinkPro",
    "order_number": "#897542",
    "paid_at": "2026-05-11T10:30:00Z",
    "payment_method": "Shoplazza Payments-Card",
    "payment_channel": "shoplazzapayment",
    "card_last4": "4690",
    "order_amount": "85.88",
    "order_currency": "USD",
    "items": []
  },
  "ticket": null
}
```

如果已有工单：

```json
{
  "ok": true,
  "mode": "existing_ticket",
  "order": {},
  "ticket": {
    "public_ticket_no": "T202605120001",
    "status": "open"
  }
}
```

#### 创建工单

```http
POST /api/support/tickets
Content-Type: application/json
```

请求：

```json
{
  "token": "BOOTSTRAP_TOKEN",
  "issue_type": "商品破损",
  "description": "收到后发现商品破损"
}
```

行为：

```text
创建 support_tickets
创建第一条 support_ticket_messages
生成 public_ticket_no
生成 ticket access token
返回工单号和 access token
```

#### 获取工单详情

```http
GET /api/support/tickets/:publicTicketNo?t=ACCESS_TOKEN
```

返回：

```json
{
  "ok": true,
  "ticket": {
    "public_ticket_no": "T202605120001",
    "status": "open",
    "issue_type": "商品破损"
  },
  "order": {},
  "messages": []
}
```

#### 顾客继续回复

```http
POST /api/support/tickets/:publicTicketNo/messages
Content-Type: application/json
```

请求：

```json
{
  "token": "ACCESS_TOKEN",
  "content": "这里是补充说明"
}
```

行为：

```text
写 support_ticket_messages sender_type = customer
更新 support_tickets.last_customer_message_at
状态改为 open
```

#### 顾客关闭工单

```http
POST /api/support/tickets/:publicTicketNo/close
Content-Type: application/json
```

请求：

```json
{
  "token": "ACCESS_TOKEN"
}
```

行为：

```text
status = closed
closed_by = customer
closed_at = now()
```

---

### 6.2 客服后台 API

#### 登录

```http
POST /api/admin/login
Content-Type: application/json
```

请求：

```json
{
  "email": "agent@example.com",
  "password": "password"
}
```

返回：

```json
{
  "ok": true
}
```

使用：

```text
HTTP-only cookie 保存 session token
```

#### 退出登录

```http
POST /api/admin/logout
```

#### 获取当前客服

```http
GET /api/admin/me
```

#### 工单列表

```http
GET /api/admin/tickets?status=open&q=&page=1&page_size=30
```

返回字段：

```text
public_ticket_no
store_name
order_number
customer_email
issue_type
status
last_customer_message_at
last_agent_message_at
updated_at
```

#### 工单详情

```http
GET /api/admin/tickets/:publicTicketNo
```

返回：

```text
工单信息
订单快照
支付信息
消息列表
```

#### 客服回复

```http
POST /api/admin/tickets/:publicTicketNo/messages
Content-Type: application/json
```

请求：

```json
{
  "content": "您好，我们已收到您的反馈。"
}
```

行为：

```text
写 support_ticket_messages sender_type = agent
更新 last_agent_message_at
status = waiting
发送 agent_reply_notice 邮件给顾客
```

#### 修改状态

```http
PATCH /api/admin/tickets/:publicTicketNo/status
Content-Type: application/json
```

请求：

```json
{
  "status": "closed"
}
```

---

## 7. 前端设计

### 7.1 顾客端页面

路由：

```text
/ticket?t=TOKEN
```

页面状态：

```text
新工单模式：
- 店铺名称
- 订单号
- 支付时间
- 支付方式
- 订单金额
- 商品列表
- 问题类型
- 文字描述
- 提交按钮

已有工单模式：
- 店铺名称
- 订单号
- 工单号
- 工单状态
- 消息列表
- 回复框
- 关闭工单按钮
```

移动端要求：

```text
必须适配手机
单列布局
按钮高度至少 44px
输入框字体不小于 16px，避免 iOS 自动放大
长订单号 / 邮箱要自动换行
消息气泡宽度自适应
底部回复框在手机上易操作
错误提示明显
加载状态明确
```

不做：

```text
附件上传
图片预览
复杂聊天 UI
实时 WebSocket
桌面端复杂布局
```

### 7.2 客服后台页面

路由：

```text
/admin/login
/admin/tickets
/admin/tickets/:publicTicketNo
```

登录页：

```text
邮箱
密码
登录按钮
```

工单列表：

```text
状态筛选
搜索框：订单号 / 邮箱 / 工单号
列表字段：
  工单号
  订单号
  店铺
  顾客邮箱
  问题类型
  状态
  更新时间
```

工单详情：

```text
上方：订单信息
  店铺
  订单号
  支付时间
  支付方式
  金额
  商品

中间：消息列表
  顾客消息
  客服消息
  系统消息

底部：客服回复框
  回复按钮
  状态切换按钮
```

移动端：

```text
客服后台也要可用，但可以先优先桌面
顾客端必须优先适配手机
```

---

## 8. 定时兜底任务

Webhook 是主链路，但要保留每小时补偿。

### 8.1 任务频率

```text
每 1 小时执行一次
```

环境变量：

```env
SUPPORT_ORDER_BACKFILL_INTERVAL_MINUTES=60
SUPPORT_ORDER_BACKFILL_LOOKBACK_HOURS=3
```

### 8.2 任务逻辑

```text
遍历 SUPPORT_SHOPLAZZA_STORES_JSON 中启用店铺
  ↓
按 updated_at_min 查询最近 3 小时订单
  ↓
过滤 paid / financial_status = paid 的订单
  ↓
对每个订单补查交易详情
  ↓
upsert support_order_snapshots
  ↓
检查 support_email_events 是否已有 paid_support_invite
  ↓
如果没有，发送付款后通知邮件
```

### 8.3 注意

```text
不是全量扫单
只扫最近小窗口
只作为 webhook 漏发兜底
必须复用 paid_support_invite 幂等 key
```

---

## 9. 代码结构调整

当前 support-bridge 保留：

```text
src/index.ts
src/config.ts
src/pg.ts
src/shoplazza-client.ts
src/shoplazza-webhook-routes.ts
src/normalize-order.ts
```

新增：

```text
src/token.ts
src/mailer.ts
src/support-routes.ts
src/admin-routes.ts
src/auth.ts
src/ticket-service.ts
src/email-service.ts
src/backfill-jobs.ts
public/ticket.html
public/admin.html
```

删除 / 不再开发：

```text
src/chatwoot-client.ts
src/chatwoot-mailer.ts
src/chatwoot-webhook-routes.ts
Chatwoot Inbox 配置
Chatwoot webhook 配置
Chatwoot API 调用
```

---

## 10. 本地单机全链路

### 10.1 本地组件

```text
support-bridge
support-postgres
Mailpit
```

不再需要本地 Chatwoot。

Mailpit：

```yaml
mailpit:
  image: axllent/mailpit:latest
  ports:
    - "8025:8025"
    - "1025:1025"
```

本地邮件配置：

```env
SUPPORT_SMTP_HOST=mailpit
SUPPORT_SMTP_PORT=1025
SUPPORT_SMTP_SECURE=false
SUPPORT_MAIL_FROM="Local Support <no-reply@local.test>"
```

### 10.2 本地模拟流程

```text
1. curl 模拟 orders/paid webhook
2. support_order_snapshots 写入
3. paid_support_invite 邮件发送到 Mailpit
4. 打开邮件里的 /ticket?t=TOKEN
5. 前端展示订单信息
6. 顾客提交工单
7. 后台 /admin 登录
8. 后台看到新工单
9. 客服回复
10. Mailpit 收到客服回复提醒邮件
11. 顾客点击链接查看回复
12. 顾客继续回复
13. 客服看到顾客回复
14. 顾客关闭工单
```

### 10.3 本地真实 webhook

本地模拟通过后，用：

```text
Cloudflare Tunnel
ngrok
```

把本地接口暴露给 Shoplazza：

```text
https://xxxx.ngrok-free.app/api/shoplazza/webhooks/store-a
```

---

## 11. 公网部署

本地全链路通过后再上公网。

### 11.1 服务器组件

```text
support-bridge
support-postgres 或现有 Postgres 中独立 support_portal database
Nginx
SMTP 邮件服务
```

### 11.2 域名

```text
https://support.yourdomain.com
```

邮件：

```text
no-reply@support.yourdomain.com
```

DNS / 邮件要求：

```text
SPF
DKIM
DMARC
```

---

## 12. 开发阶段

### 阶段 5：Token + 自有邮件

```text
1. token.ts
2. mailer.ts
3. support_email_events pending/sent/failed
4. paid_support_invite 邮件
5. agent_reply_notice 邮件
```

验收：

```text
orders/paid 后能发付款后通知邮件
重复 webhook 不重复发邮件
邮件包含订单号、支付时间、支付方式、可选卡号后四位
邮件链接能进入 /ticket?t=TOKEN
```

### 阶段 6：自有工单后端

```text
1. support_tickets 表
2. support_ticket_messages 表
3. GET /api/support/bootstrap
4. POST /api/support/tickets
5. GET /api/support/tickets/:ticketNo
6. POST /api/support/tickets/:ticketNo/messages
7. POST /api/support/tickets/:ticketNo/close
```

验收：

```text
顾客能看订单
顾客能提交工单
顾客能看消息
顾客能回复
顾客能关闭工单
```

### 阶段 7：客服后台

```text
1. support_agents 表
2. support_agent_sessions 表
3. POST /api/admin/login
4. GET /api/admin/tickets
5. GET /api/admin/tickets/:ticketNo
6. POST /api/admin/tickets/:ticketNo/messages
7. PATCH /api/admin/tickets/:ticketNo/status
8. public/admin.html
```

验收：

```text
客服能登录
客服能看工单列表
客服能看订单信息
客服能回复工单
客服能关闭 / 重开工单
客服回复后顾客收到提醒邮件
```

### 阶段 8：每小时兜底任务

```text
1. backfill-jobs.ts
2. 每小时扫最近 3 小时订单
3. 检测 paid 订单是否已发 paid_support_invite
4. 未发送则补发
```

验收：

```text
手动删除某笔 paid_support_invite 记录
运行 backfill
系统能补发通知
不会重复发送已有通知
```

### 阶段 9：手机端适配

```text
1. 顾客端手机布局
2. 工单消息手机展示
3. 回复框手机适配
4. 关闭工单按钮二次确认
5. 错误态 / 空态 / 加载态
```

验收：

```text
iPhone 宽度可用
Android 宽度可用
输入框不触发 iOS 自动放大
按钮不难点
长文本不撑破页面
```

---

## 13. MVP 范围

MVP 必做：

```text
1. 付款后通知邮件
2. support_order_snapshots
3. support_email_events
4. support_tickets
5. support_ticket_messages
6. support_agents
7. 顾客端 /ticket
8. 客服端 /admin
9. 自有 SMTP 发信
10. 每小时补偿任务
11. 手机端适配
```

MVP 不做：

```text
Chatwoot
群组
团队
聊天室
附件
图片
SLA
统计报表
复杂权限
邮件正文回复
IMAP 收信
机器人
多渠道
WebSocket
实时在线状态
```

---

## 14. 上线门槛

上线前必须通过：

```text
1. 本地 curl 模拟 orders/paid 成功
2. 本地真实 tunnel webhook 成功
3. support_order_snapshots 字段正确
4. 付款后邮件能发出
5. paid_support_invite 不重复
6. 顾客端手机可用
7. 顾客能提交工单
8. 客服能登录后台
9. 客服能看到订单信息
10. 客服能回复
11. 顾客能收到提醒邮件
12. 顾客能查看回复
13. 顾客能继续回复
14. 顾客能关闭工单
15. 每小时兜底能补漏
```

不能上线：

```text
邮件重复发送无法控制
token 可被篡改
客服后台没有登录保护
顾客端手机不可用
webhook 漏发没有兜底
订单邮箱未校验
```

---

## 15. 最终结论

新的方向：

```text
support-bridge 从 Chatwoot 对接服务
改为极简自研工单系统
```

最终链路：

```text
Shoplazza orders/paid webhook
  ↓
support-bridge 补查订单 / 交易详情
  ↓
PostgreSQL 保存订单快照
  ↓
自有 SMTP 发付款后售后入口邮件
  ↓
顾客进入手机端 /ticket
  ↓
顾客提交纯文字工单
  ↓
客服登录 /admin
  ↓
客服查看订单信息并回复
  ↓
自有 SMTP 发提醒邮件
  ↓
顾客回 /ticket 查看和继续回复
```

核心原则：

```text
能轻量就轻量
能少做就少做
前端必须适配手机
后端只保留必要 API
数据库继续用 PostgreSQL
邮件自己发
工单域名统一发信
Webhook 实时触发
每小时兜底补漏
不再接 Chatwoot
```
