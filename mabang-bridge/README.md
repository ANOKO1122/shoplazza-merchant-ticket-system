# Chatwoot ↔ 店匠 Shoplazza 桥接

收到 Chatwoot 的 Webhook 后，在**一个或多个**店匠店铺中查询订单：可在联系人属性 **「订单邮箱/订单号」**（`shoplazza_order_lookup`）中混填客户提供的邮箱或单号（逗号、换行等分隔）；**优先按订单号**调用 [按单号获取订单](https://www.shoplazza.dev/reference/order-get-by-number-v2025-06)，否则再按邮箱拉 [订单列表](https://www.shoplazza.dev/reference/order-list-v2025-06) 并匹配。命中后写回订单字段与 `matching_orders_count`；若订单上的邮箱与联系人主邮箱不一致，会用 **订单邮箱覆盖联系人主邮箱**。失败原因写入 `shoplazza_sync_note`。

## 故障排查：全部会话侧边栏都空白

这通常**不是单个客户问题**，而是下面几类之一：

1. **浏览器打不到桥接**：打开会话时，`public/chatwoot-open-sync.js` 会探测 `/health` 再调 `/sync/conversation-order`。若 Nginx **未**把例如 `/bridge-api` 反代到 `mabang-bridge:4000`，或用户浏览器访问不了宿主机 **4000** 端口，同步**根本不会发起**，所有联系人都会长期 `---`。请在浏览器开发者工具 **Network** 里看是否有对桥接地址的请求失败。
2. **Webhook 兜底**：在 Chatwoot 里配置 `http://mabang-bridge:4000/webhook/chatwoot`（同 compose 内网地址），则**发消息/建会话**时仍可能触发同步，可与前端脚本互为补充。
3. **本地索引是否有邮箱**：请求 `GET /health`（同上认证），看 `orderIndexRowsWithEmail`。联系人侧**只读** `order_index`；若带邮箱的索引行极少，按邮箱匹配会大面积落空。需确认后台索引进程正常，并保持 `SHOPLAZZA_INDEX_ENRICH_EMAIL` 未误关为 `false`。

## 配置步骤

### 1. 店匠 OpenAPI

- 在店匠合作伙伴中心创建应用，取得各店铺的 **Access Token**（或按官方文档完成 OAuth）。
- 请求地址：`GET https://{subdomain}.myshoplaza.com/openapi/{版本}/orders`
- 请求头：`Access-Token: <token>`、`Content-Type: application/json`（见 [Authentication](https://www.shoplazza.dev/reference/overview-30)）。
- 桥接按 `created_at_min` 拉取最近 N 天订单并分页，在内存中按**订单/客户邮箱**与 Chatwoot 联系人邮箱匹配（不区分大小写）。

### 2. Chatwoot API Token 与 Account ID

- 登录 Chatwoot → 右上角头像 → **Profile** → 复制 **Access Token** → `CHATWOOT_API_ACCESS_TOKEN`。
- Account ID：一般为 `1`。
- **若 API 报 401**：与 Chatwoot 同 compose 时建议 `CHATWOOT_BASE_URL=http://chatwoot:3000` 内网直连。

### 3. 环境变量（`.env.mabang-bridge`）

可复制 `mabang-bridge/.env.example`。

**多店铺（推荐）**：`SHOPLAZZA_STORES_JSON` 为 JSON 数组，每项包含：

- `subdomain`：店铺子域名（仅 `xxx` 部分）。若误填 `xxx.myshoplaza.com`，桥接会自动去掉后缀，避免请求打到错误主机名。
- `accessToken`：该店 Token
- `label`（可选）：在桥接备注与调试日志中区分店铺；写入联系人的店铺标识为 **API 侧子域** `myshoplaza_subdomain`

**单店铺**：设置 `SHOPLAZZA_SUBDOMAIN` + `SHOPLAZZA_ACCESS_TOKEN`。

可选：`SHOPLAZZA_API_VERSION`（默认 `2025-06`）、`SHOPLAZZA_DAYS_BACK`、`SHOPLAZZA_PAGE_LIMIT`、`SHOPLAZZA_MAX_PAGES_PER_STORE`、`SHOPLAZZA_ORDER_LOOKUP_ATTRIBUTE_KEY`（默认 `shoplazza_order_lookup`）。

**按邮箱查单（避免侧边栏长期为 `---`）**：店匠列表接口常返回**无 `customer`/`email` 的精简对象**，仅靠内存比对会永远匹配不到。桥接会（1）优先使用订单列表的 `keyword` + `keyword_scope_fields=email`；（2）仍无邮箱时对单条再请求 `GET /orders/number/{number}` 补全后再匹配。若需关闭 keyword 路径可设 `SHOPLAZZA_EMAIL_KEYWORD_SEARCH=false`。索引入库时若列表无邮箱，默认会补全单条详情（可设 `SHOPLAZZA_INDEX_ENRICH_EMAIL=false` 关闭以减轻 API 调用量）。

**列表分页参数**：OpenAPI v2025-06 使用 `page_size`（1–250）；历史上误用 `limit` 会导致每页条数异常。桥接已同时发送 `page_size` 与 `limit`。

**多店性能**：店铺很多时，主动同步接口会**立即返回** `{"accepted":true}`，同步在**后台**完成（避免 Nginx/浏览器等 60s 超时）。打开会话后若侧边栏仍空，请**等约 30～60 秒**再刷新页面或切换会话再切回。多店按邮箱采用**两阶段**：先**全店并行 keyword**（每店只打一次），未命中的店再**列表扫描**（`skipKeyword`，避免 keyword 重复）。可调：`SHOPLAZZA_KEYWORD_ALL_STORES_CONCURRENCY`（阶段 A 并行店铺数，默认 12，上限 16）、`SHOPLAZZA_STORE_QUERY_CONCURRENCY`（阶段 B 列表扫描并行，默认 4）、`SHOPLAZZA_EMAIL_SCAN_MAX_PAGES_WHEN_MULTI`（店铺数 >12 时限制每店翻页，默认 14）、`SHOPLAZZA_LIST_EMAIL_ENRICH_MAX`（列表无邮箱时单号补全次数上限，默认 6）、`SHOPLAZZA_FETCH_TIMEOUT_MS`（单请求超时，默认 18000）、`SHOPLAZZA_EMAIL_LOOKUP_TIMEOUT_MS`（多店按邮箱整段查询上限，默认 120000，最大 300000）、`SHOPLAZZA_EMAIL_LOOKUP_MS_PER_STORE`（与店数相乘后与前者取**较大值**再封顶，默认每店 2000ms，避免仅设 72s 而店多必超时）。

**联系人同步与索引库**：**仅**读本地 `order_index`（时间窗口见 `SHOPLAZZA_INDEX_EMAIL_LOOKUP_WINDOW_DAYS` / `SHOPLAZZA_DAYS_BACK`），**不会在联系人同步时请求店匠**。排障可设 `SHOPLAZZA_SKIP_ORDER_INDEX_LOOKUP=true` 强制视为未命中。索引入库的 `raw_summary_json` 与 `NormalizedShopOrder` 对齐；历史行缺字段待下一轮索引 upsert 补全。

**订单列表分页（v2025-06）**：店匠返回 `data.cursor` + `data.has_more`，**`page` 查询参数无效**（会重复首屏）。桥接已按 **cursor** 翻页；大单量店请适当提高 `SHOPLAZZA_MAX_PAGES_PER_STORE`（默认已加大，仍不足时再调）。

邮箱索引化（推荐开启，默认开启）：

- `SHOPLAZZA_INDEX_SYNC_ENABLED`：是否开启后台索引同步（默认 `true`）
- `SHOPLAZZA_INDEX_SYNC_INTERVAL_MS`：索引增量同步间隔（默认 `180000`，即 3 分钟）
- `SHOPLAZZA_INDEX_SYNC_PAGE_LIMIT`：每页拉单数量（默认 `100`）
- `SHOPLAZZA_INDEX_SYNC_MAX_PAGES`：每店每轮最多分页（默认 `20`）
- `SHOPLAZZA_INDEX_BOOTSTRAP_DAYS`：索引时间窗口（天，默认 `180`）。每次同步用 `updated_at_min = max(游标, 当前时间−N 天)` 拉单，结束后删除该店索引里订单时间早于窗口起点的行，使库内仅保留最近 N 天范围
- `SHOPLAZZA_INDEX_LOOKUP_LIMIT`：邮箱索引查询返回条数（默认 `30`）

**店铺配置来源（优先级）**

1. **SQLite**（`BRIDGE_DATA_DIR`，默认 `/data/stores.sqlite`，Docker Compose 已挂载 `mabang-bridge-data`）：库中**至少有一条**店铺记录时，**仅使用数据库**，不再读取下方 env 中的店列表。
2. **环境变量兜底**：数据库为空或无法打开时，使用 `SHOPLAZZA_STORES_JSON` 或 `SHOPLAZZA_SUBDOMAIN` + `SHOPLAZZA_ACCESS_TOKEN`（与旧行为一致）。便于首次部署后通过管理 API 写入 DB，再逐步清空 env 中的敏感 JSON。

### 3.1 管理 API（仅管理员 Bearer）

用于增删改店匠店铺，**不经过 Chatwoot 前端**。需在 `.env.mabang-bridge` 中设置强随机 **`BRIDGE_ADMIN_TOKEN`**；未设置时所有 `/admin/*` 返回 **503**（避免无鉴权写接口）。

| 环境变量 | 说明 |
|----------|------|
| `BRIDGE_DATA_DIR` | SQLite 目录，默认 `/data` |
| `BRIDGE_ADMIN_TOKEN` | **必填**。`Authorization: Bearer <token>` 与脚本鉴权；未设置时管理功能 **503** |
| `BRIDGE_SYNC_TOKEN` | **可选**。`POST /sync/contact-order` 主动同步接口专用令牌；未设置则复用 `BRIDGE_ADMIN_TOKEN` |
| `BRIDGE_ACTIVE_SYNC_DEDUP_MS` | **可选**。主动同步同一 `accountId+contactId` 的去重窗口（毫秒，默认 8000） |
| `BRIDGE_ADMIN_PASSWORD` | **可选**。网页 `/admin/ui` 专用登录密码。**若设置**：须为 **10–16 位**，且同时包含 **英文字母** 与 **数字**（否则进程启动失败）；不设则网页登录仍使用 `BRIDGE_ADMIN_TOKEN` |
| `BRIDGE_SESSION_SECRET` | **可选**。签名登录会话 Cookie，建议生产设置 ≥16 字符；不设则从 token 派生 |
| `BRIDGE_COOKIE_SECURE` | 设为 `true` 时 Cookie 仅走 HTTPS（反向代理终止 TLS 时需正确配置） |

**网页管理**：浏览器打开 `http://<宿主机>:4000/admin/ui`，使用上述密码登录后可添加 / 删除店铺（调用同一套 `/admin/stores` API，带 Cookie 会话，无需手写 Bearer）。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/admin/ui` | 自建管理页面（HTML） |
| `POST` | `/admin/session/login` | Body：`{ "password" }`，校验通过后写入会话 |
| `POST` | `/admin/session/logout` | 清除会话 |
| `GET` | `/admin/stores` | 列出店铺；`accessToken` 仅返回脱敏 `accessTokenPreview`（末 4 位） |
| `POST` | `/admin/stores` | Body JSON：`{ "subdomain", "accessToken", "label"? }`，存在则 upsert |
| `PUT` | `/admin/stores/:subdomain` | 更新 `label` 或 `accessToken`（可只传其一） |
| `DELETE` | `/admin/stores/:subdomain` | 按子域删除 |
| `POST` | `/sync/contact-order` | 主动同步联系人订单。Header：`Authorization: Bearer <BRIDGE_SYNC_TOKEN>`（或 admin token）；Body：`{ "accountId":1, "contactId":123 }` |

- 管理路由有简易 **按 IP 限流**（每分钟约 60 次）。
- 生产环境请仅内网或 VPN 访问 `:4000`，或对 `/admin` 做反代 + HTTPS；勿在日志中打印完整 token。

示例：

```bash
curl -sS -H "Authorization: Bearer $BRIDGE_ADMIN_TOKEN" http://127.0.0.1:4000/admin/stores
curl -sS -X POST -H "Authorization: Bearer $BRIDGE_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"subdomain":"yourstore","accessToken":"xxx","label":"旗舰店"}' \
  http://127.0.0.1:4000/admin/stores
curl -sS -X POST -H "Authorization: Bearer $BRIDGE_SYNC_TOKEN" -H "Content-Type: application/json" \
  -d '{"accountId":1,"contactId":123}' \
  http://127.0.0.1:4000/sync/contact-order
```

**从 env 批量导入 SQLite**（桥接已启动、`.env.mabang-bridge` 里已配置 `BRIDGE_ADMIN_TOKEN`）：

```bash
node scripts/migrate-shoplazza-stores-to-db.js
# 或指定 env 文件路径
node scripts/migrate-shoplazza-stores-to-db.js /path/to/.env.mabang-bridge
```

本机 Node 低于 18 时可用：

```bash
docker run --rm -v "$PWD:/w" -w /w --network host node:18-alpine node scripts/migrate-shoplazza-stores-to-db.js
```

脚本会读取 `SHOPLAZZA_STORES_JSON` 或 `SHOPLAZZA_SUBDOMAIN` + `SHOPLAZZA_ACCESS_TOKEN`，对每条调用 `POST /admin/stores`（upsert）。导入成功后桥接优先使用数据库，可再按需从 env 中移除明文 Token。

### 4. Chatwoot 自定义属性（联系人）

桥接启动时会尝试自动创建以下**联系人**自定义属性定义（若不存在）。**属性键与店匠 Order 资源 JSON 字段一致**（[订单列表 API v2025-06](https://www.shoplazza.dev/reference/order-list-v2025-06)），便于对照官方文档；下列为例外字段（客户输入或桥接元数据）。

| 属性键 | 说明 |
|--------|------|
| `shoplazza_order_lookup` | **订单邮箱/订单号**：可填多项，英文逗号、分号、顿号、换行、竖线等分隔；含 `@` 视为邮箱，否则视为订单号；**优先尝试订单号**（从左到右依次尝试），均失败再尝试邮箱，最后尝试联系人主邮箱。 |
| `matching_orders_count` | 数字：按邮箱列表匹配时的订单条数；**若仅命中按单号 API，则一般为 1** |
| `myshoplaza_subdomain` | 最近一单所在店铺的 OpenAPI 子域（`xxx` from `xxx.myshoplaza.com`） |
| `shoplazza_sync_note` | 桥接说明：无邮箱、未找到订单、部分店铺请求失败等 |
| `id` | 最近一单订单 `id` |
| `name` | 最近一单 `name` |
| `order_number` | 最近一单 `order_number` |
| `email` | 订单上的 `email`（与联系人邮箱应一致） |
| `created_at` / `updated_at` / `processed_at` / `cancelled_at` | 时间字段（与 API 一致） |
| `total_price` / `sub_total` / `total_tax` / `total_shipping` / `total_discount` | 金额相关（与 API 一致，`total_price` 会兼容 `current_total_price`） |
| `currency` | 币种 |
| `financial_status` / `fulfillment_status` | 支付与履约状态 |
| `customer_note` | 买家备注 |

旧版马帮时代的 `erp_*`、`shop_last_store` 已不再写入；可在 Chatwoot「设置 → 自定义属性」中删除旧定义及旧值以免混淆。

**说明**：若「设置 → 自定义属性」不列出联系人属性，可在浏览器打开 `http://<宿主机>:4000/contact-attributes` 查看 API 返回的定义列表。

### 5. Webhook

- URL：`http://mabang-bridge:4000/webhook/chatwoot`（compose 服务名未改，仍为 `mabang-bridge`）。
- 事件：建议至少勾选 `conversation_created`、`message_created`、`contact_created`、`contact_updated`，并加上 `conversation_updated`、`conversation_status_changed`（提升自动触发覆盖率）。

### 5.1 打开会话即主动同步（推荐）

如果希望“打开会话就立即刷新订单”，可在 Chatwoot 页面注入脚本：

- 脚本地址：`http://<宿主机>:4000/chatwoot/open-sync.js`
- 在 Chatwoot 页面对 `window` 注入两项变量（如通过自定义脚本、浏览器扩展等）：
  - `window.__SHOPLAZZA_BRIDGE_BASE__ = 'http://<宿主机>:4000'`
  - `window.__SHOPLAZZA_SYNC_TOKEN__ = '<BRIDGE_SYNC_TOKEN>'`

脚本行为：

1. 监听 URL 会话切换（`/app/accounts/:accountId/conversations/:conversationId`）。
2. 读取当前会话详情，提取 `contactId`。
3. 调用 `POST /sync/contact-order` 主动同步。
4. 完成后触发前端刷新，右侧联系人属性展示最新订单字段。

### 6. 启动

```bash
docker-compose build mabang-bridge && docker-compose up -d mabang-bridge
```

## 流程说明

1. Chatwoot 触发 Webhook → 桥接解析 `contact_id`。
2. 调 Chatwoot API 获取联系人、`custom_attributes` 中的 `shoplazza_order_lookup` 与主邮箱。
3. 若 `lookup` 中有订单号：**多店并行**请求 `GET .../orders/number/{number}`，命中则取该单（多店假设单号全局唯一）。
4. 否则：将 `lookup` 中邮箱与联系人主邮箱**去重**后，在未设置「跳过索引」时先查本地 `order_index`（邮箱索引）；
   - 索引命中：直接按与店匠 API 相同的排序规则取最近一单；
   - 索引未命中：回退到 [订单列表](https://www.shoplazza.dev/reference/order-list-v2025-06) + keyword / 列表扫描（多店两阶段，见上文）。
   合并结果按时间取**全局最近一单**。
5. 写回自定义属性；若有店铺 HTTP/网络错误，在 `shoplazza_sync_note` 中说明**部分店铺失败**。
6. 若命中订单且订单上 `email` 非空且与当前联系人主邮箱不同：**PUT 更新联系人主邮箱**为订单邮箱。
7. 服务启动后与运行期间会后台执行订单索引增量同步（写入 SQLite 的 `order_index`），提升邮箱命中率与查询速度。

## 与马帮版本的差异

- 已移除马帮 HMAC 签名逻辑；改为店匠 `Access-Token` + REST GET。
- 支持多店配置；单店也可用环境变量简化配置。
