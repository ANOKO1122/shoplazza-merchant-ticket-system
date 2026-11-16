# Shoplazza Merchant Simple Ticket Support System

基于 Shoplazza 开放平台的售后工单客服系统。支持多店铺管理、Webhook 实时触发 + API 定时兜底、邮件通知、顾客自助工单。

## 功能

- **工单管理**：顾客发起 dispute → 客服回复 → 关闭/仲裁
- **多店铺管理**：支持多个 Shoplazza 店铺，独立 API Token 加密存储
- **Webhook 实时触发**：接收 `orders/paid` 推送，秒级创建售后邮件
- **API 兜底同步**：定时轮询已支付订单，确保不漏单
- **邮件通知**：下单引导邮件、客服回复提醒、工单关闭通知
- **邮件模板**：可视化编辑 + 预设切换（平台风 / 品牌风）
- **Mailpit 测试模式**：一键切换测试邮件接收，不真实发送
- **系统日志**：同步日志 + 操作日志，支持按店铺/状态筛选

## 技术栈

- **后端**：Node.js 20.19+ / TypeScript / Express（Docker 使用 Node.js 24）
- **数据库**：PostgreSQL 16
- **邮件**：Nodemailer（支持 Mailpit 测试）
- **部署**：Docker / Docker Compose

## 快速开始

### 1. 克隆项目

```bash
git clone <repo-url>
cd shoplazza-ticket-system
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填写必填配置项
```

### 3. 启动（Docker Compose 一键启动）

```bash
docker compose -f docker-compose.support.yml up -d
```

包含 PostgreSQL、Mailpit、应用服务。

### 4. 创建管理员

```bash
docker compose -f docker-compose.support.yml exec support-bridge node dist/seed-admin.js
```

或本地开发：

```bash
npm install
npm run build
npm run seed-admin
npm start
```

### 5. 访问

| 页面 | 地址 |
|---|---|
| 管理后台 | `http://localhost:4001/admin` |
| 系统设置 | `http://localhost:4001/admin-settings` |
| 顾客工单页 | `http://localhost:4001/ticket?t=<token>` |
| Mailpit 邮件 | `http://localhost:8025` |

## 上线流程

1. 登录后台 → **系统设置** → 填写公网域名
2. **店铺管理** → 添加店铺（域名 + Access Token）
3. 在 Shoplazza 注册 Webhook 或开启 API 兜底
4. **订单邮件管理** → 开启自动发送
5. 测试完整流程：下单 → 收邮件 → 创建工单 → 客服回复

## 邮件格式与称呼

- 邮件同时包含 HTML 和纯文本版本。纯文本从本次发送的 HTML 生成，保留段落、换行和按钮的完整链接，并解码 HTML 实体；HTML 模板样式保持不变。
- 客服回复通知优先使用对应订单的顾客姓名，缺失时使用工单姓名；姓名为空时显示 `Dear Customer,`。已有邮件正文快照保持不变，不因此重发历史邮件。

## 共享客服收件箱

顶部搜索支持订单号、保障编号、申请编号、客户邮箱及邮件内容。会话按「全部 / 未处理 / 已处理」分类：最新一封顾客来信尚无后续成功发送的客服回复时为未处理；回复成功后为已处理，顾客再次来信后重新成为未处理。已读/未读独立筛选，阅读邮件和写内部备注不会改变处理分类，排队中、失败或发送结果待核实的回复也不算已处理。

会话右上角可创建、添加或移除顾客标签，并按标签筛选邮件。标签按客户邮箱共享到该顾客的所有会话；保存使用独立版本校验，其他客服已修改时需重新加载核对，避免覆盖。

后台的 **客服收件箱** 页面使用 `customersupport@reply.us-seel.com` 接收顾客来信，并从同一邮箱发送客服手动回复。客服可搜索会话、查看未读、分配负责人、写内部备注和关联保障申请。内部备注只保存在后台，不作为邮件发出。历史已发保障通知会在匹配到原收件地址的邮件线程中展示；转发等地址不一致的情况只提示人工核对。

在**运行应用的服务器**编辑 `support-system/.env`（Docker Compose 的 `env_file` 也读取这个文件）。填入该邮箱在阿里邮箱网页端生成的**三方客户端安全密码**：

```dotenv
SUPPORT_MAILBOX_USER=customersupport@reply.us-seel.com
SUPPORT_MAILBOX_CLIENT_PASSWORD=在此填写三方客户端安全密码
SUPPORT_MAILBOX_ENABLED=true
```

请勿把密码发到聊天、写进 `.env.example` 或提交 Git。邮箱账户还需启用 IMAP 和 SMTP 三方客户端访问。修改后重建并重启应用容器：

```bash
cd support-system
docker compose -f docker-compose.support.yml up -d --build support-bridge
```

首次连接只导入 INBOX 最近 30 天的邮件；之后约每分钟同步新邮件。收件箱顶部显示连接或同步状态。通过后台发送的回复会显示发送状态；若显示“发送结果待核实”，请先在阿里邮箱中核对，避免重复发送。直接从阿里邮箱网页端发出的邮件不会自动出现在这里。入站图片和 PDF 存在忽略 Git 的 `support-system/private/mailbox` 中，Compose 将其挂载为私有持久目录；备份数据库时也应备份该目录。应用不会在启用或迁移时自动发送顾客回复。

## 物流同步

- 同一个发货记录 ID 更新当前运单，并在该包裹内累计保留旧、新号码；不同 ID 追加包裹。适用于 ERP 在同一记录上依次写入国内、国外两段运单的情况，后台与顾客页展示全部已记录号码并标出当前号码。
- 每个包裹的 `tracking_number_history` 保存去重后的累计号码。晚到的旧消息不会覆盖当前物流信息，但其中尚未保存的号码仍会补入历史；号码所属运输段由发货系统决定，本系统不自动判断国内或国外。
- 订阅 `orders/fulfilled`、`orders/partially_fulfilled`、`fulfillments/create` 和 `fulfillments/update`。物流事件先入库再确认接收，重复投递不重复入队，失败自动重试；未入库订单的事件会等待快照建立。
- 物流更新以 Webhook 为主。自动查漏开启时，每小时最多核对 200 个已启用店铺的已支付订单，不依赖下单时间或订单更新时间游标；成功后至少间隔 24 小时再进入待查队列，失败 1 小时后进入重试队列。首次待查与到期复查交错轮转，历史订单分批覆盖，并非每小时或每天全库检查。
- 物流处理不创建邮件任务。同步日志中的“物流更新”记录新增包裹、当前号变化、补充历史号、累计保留号码和无变化跳过；“物流兜底汇总”展示批次与逐单结果。
- 物流兜底汇总的新增/更新列按订单计数，更新也包含同号物流信息变化及历史字段补齐；本次新增号码以明细为准。汇总耗时只计该店实际处理时间，整批耗时另存于明细；未检查订单的店铺不生成空汇总。
- `SUPPORT_DISABLE_BACKGROUND_JOBS=true` 同时禁用后台物流重试与兜底定时器。

升级时先部署支持新事件的应用，再为已有店铺补齐订阅（保留其他应用的订阅）：

```bash
docker compose -f docker-compose.support.yml run --rm --no-deps -T support-bridge node scripts/secure-webhooks.js --apply
docker compose -f docker-compose.support.yml run --rm --no-deps -T support-bridge node scripts/secure-webhooks.js --check
```

## 环境变量

见 `.env.example`，关键配置：

| 变量 | 说明 |
|---|---|
| `SUPPORT_PUBLIC_BASE_URL` | 公网访问地址 |
| `SUPPORT_DATABASE_URL` | PostgreSQL 连接 |
| `SUPPORT_TOKEN_SECRET` | 签名密钥（随机 64 位） |
| `SUPPORT_SMTP_*` | 邮件 SMTP 配置 |
| `SUPPORT_SHOPLAZZA_STORES_JSON` | 店铺配置（JSON 数组） |

## 项目结构

```
src/
  index.ts          Express 入口、定时器
  config.ts         配置加载
  pg.ts             PostgreSQL 连接池 + 表初始化
  auth.ts           管理员认证
  token.ts          顾客访问令牌（bt_ / ta_）
  ticket-service.ts 工单 CRUD
  support-routes.ts 顾客端 API
  admin-routes.ts   管理端 API
  email-service.ts  邮件模板、任务、发送
  mailer.ts         Nodemailer 封装
  store-service.ts  店铺管理（Token 加密存储）
  shoplazza-client.ts      Shoplazza API 客户端
  shoplazza-webhook-routes.ts  Webhook 接收处理
  normalize-order.ts        订单数据标准化
  backfill-jobs.ts          兜底同步任务
  log-service.ts            日志服务
public/
  *.html            前端页面
scripts/
  测试与工具脚本
```

## License

MIT
