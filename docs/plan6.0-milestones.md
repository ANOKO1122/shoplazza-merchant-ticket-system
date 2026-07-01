# Plan 6.0 执行阶段清单

> 基于 plan6.0-lightweight-ticket-system.md  
> 已完成：Phase 1-4（Express 骨架 + PG + Webhook + 订单补全）、token.ts

---

## Phase 6: 自有工单后端（先做）

### 文件操作

| 动作 | 文件 |
|------|------|
| 新建 | `src/ticket-service.ts` — 工单 CRUD + 消息 + 状态管理 |
| 新建 | `src/support-routes.ts` — 顾客端 5 个 API |
| 修改 | `src/pg.ts` — 新增 support_tickets + support_ticket_messages 建表 |
| 修改 | `src/index.ts` — 挂载 support routes |

### API 清单

```
GET  /api/support/bootstrap?t=TOKEN   初始化售后页面
POST /api/support/tickets             创建工单
GET  /api/support/tickets/:no?t=TOKEN 获取工单详情
POST /api/support/tickets/:no/messages 顾客回复
POST /api/support/tickets/:no/close   关闭工单
```

### 建表

```sql
support_tickets          — 工单主表
support_ticket_messages  — 消息表
```

### 验证

```
1. 手动构造 bootstrap token，curl GET /api/support/bootstrap?t=TOKEN
2. curl POST /api/support/tickets 创建工单，返回 public_ticket_no
3. curl GET /api/support/tickets/:no?t=ACCESS_TOKEN 查看详情
4. curl POST /api/support/tickets/:no/messages 顾客回复
5. curl POST /api/support/tickets/:no/close 关闭工单
```

---

## Phase 7: 客服后台

### 文件操作

| 动作 | 文件 |
|------|------|
| 新建 | `src/auth.ts` — 登录/登出/session 校验中间件 |
| 新建 | `src/admin-routes.ts` — 客服端 8 个 API |
| 新建 | `public/admin.html` — 客服后台 SPA |
| 新建 | `public/ticket.html` — 顾客端 SPA |  样式和页面设计完全参考，甚至可沿用D:\chatwoot-ThinkPro\dispute_ticket.html，但不需要切换显示按钮和那两个悬浮按钮。
| 修改 | `src/pg.ts` — 新增 support_agents + support_agent_sessions |
| 修改 | `src/index.ts` — 挂载 admin routes + 静态文件 |

### API 清单

```
POST   /api/admin/login                 登录
POST   /api/admin/logout                退出
GET    /api/admin/me                    当前用户
GET    /api/admin/tickets               工单列表
GET    /api/admin/tickets/:no           工单详情
POST   /api/admin/tickets/:no/messages  客服回复
PATCH  /api/admin/tickets/:no/status    修改状态
```

### 验证

```
1. 访问 /admin/login，输入账号密码登录
2. 看到工单列表
3. 点开工单，看到订单信息 + 消息
4. 回复工单，消息创建成功
5. 修改工单状态
```

---

## Phase 5: 自有邮件 + 移除 Chatwoot

### 文件操作

| 动作 | 文件 |
|------|------|
| 新建 | `src/mailer.ts` — 通过 nodemailer 直连 SMTP 发信 |
| 新建 | `src/email-service.ts` — 邮件幂等 + 模板渲染 |
| 修改 | `src/shoplazza-webhook-routes.ts` — 移除 chatwoot-mailer，改用自有 mailer |
| 修改 | `src/config.ts` — 移除 Chatwoot 必填项，新增 SMTP 配置项 |
| 修改 | `src/index.ts` — 移除 Chatwoot 相关日志 |
| 删除 | `src/chatwoot-mailer.ts` |
| 不删 | `src/chatwoot-client.ts` — 保留，后续统一清理 |

### 配置变更

```env
# 新增
SUPPORT_SMTP_HOST=mailpit
SUPPORT_SMTP_PORT=1025
SUPPORT_SMTP_SECURE=false
SUPPORT_SMTP_USER=
SUPPORT_SMTP_PASS=
SUPPORT_MAIL_REPLY_TO=no-reply@local.test

# 移除
CHATWOOT_BASE_URL
CHATWOOT_ACCOUNT_ID
CHATWOOT_API_ACCESS_TOKEN
CHATWOOT_INBOX_ID
CHATWOOT_PORTAL_MAIL_NOTICES_INBOX_ID
```

### 验证

```
1. docker-compose 启动 mailpit
2. curl 模拟 orders/paid webhook
3. Mailpit UI (8025) 看到 paid_support_invite 邮件
4. 重复 webhook 不重复发邮件
5. 邮件含订单号、支付时间、支付方式、卡号后四位
6. 邮件中有 /ticket?t=BOOTSTRAP_TOKEN 链接
7. 客服回复工单，顾客收到 agent_reply_notice 邮件
```

---

## Phase 8: 定时兜底任务

### 文件操作

| 动作 | 文件 |
|------|------|
| 新建 | `src/backfill-jobs.ts` — setInterval 定时扫描 |

### 逻辑

```
每 60 分钟扫最近 3 小时 paid 订单
检查 support_email_events 是否已发 paid_support_invite
未发则补发邮件
```

### 验证

```
1. 手动删掉一条 paid_support_invite 记录
2. 等待/触发 backfill 运行
3. 邮件补发成功
4. 不重复发送已有通知
```

---

## Phase 9: 手机端适配

### 文件操作

| 动作 | 文件 |
|------|------|
| 修改 | `public/ticket.html` — 响应式 + 输入框 16px + 按钮 44px |

### 验证

```
1. Chrome DevTools 切 iPhone 宽度
2. 按钮易点、输入框不放大、长文本不撑破
```
