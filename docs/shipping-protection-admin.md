# 运输保障管理后台：运行与维护

本模块接入现有工单系统，页面入口为 `/thinkpro-admin/protection`，复用客服登录。React + TypeScript 提供统计、保障订单、赔付审核、店铺组件四个工作区；Express/PostgreSQL 保存业务状态。它目前仍是内部部署与管理能力，不会在店匠应用列表中新增独立的 OAuth 应用入口。

## 已实现的业务范围

- **统计与订单**：按店铺、日期查询；金额按币种分别汇总。以配置中的自有保障商品 ID 识别订单，同一店铺／订单的多邮箱快照只计一次。金额使用整数分，扣除可核验的商品折扣；金额未知时显示待核对，相关合计也保持未知，不按零或已知部分冒充完整金额。
- **稳定保障编号**：每个已识别订单对应固定 `SP-…` 编号。一份保障记录可以关联多个 `CL-…` 申请；拒绝后重新申请会生成新申请编号，保障编号不变。
- **内部登记和审核**：客服从保障订单选择普通商品，录入问题类型、说明、申请金额；支持负责人、处理备注、审核决定和完整操作记录。问题类型为丢失、损坏、盗窃、延误、其他。未定义保障时限，所以登记某种问题不代表系统已承诺赔付。
- **防重复与超额**：同商品已有待处理或已通过但未结案的申请时，不能重复登记。已通过及已结案申请的批准金额继续占用商品余额；拒绝申请不占用。审核使用版本号、订单行锁及事务审计，竞争提交返回 `409`，需要刷新后重新确认。
- **外部处理记录**：`approved` 只表示审核通过。只有已通过申请可以转为 `closed`，必须填写处理备注和 `external_reference`。这是操作员记录的外部完成信息，不代表系统核验了到账，也不会调用打款接口。

`submitted`、`reviewing`、`needs_info` 均可通过或拒绝；待审核可转入审核或要求补充资料，补充资料后可回到审核。仅 `approved → closed` 可结案。拒绝和要求补充资料须填写说明；终态不支持改回审核，但仍可补充备注或调整负责人。

**退款限制**：当前订单状态 Webhook 可能只更新退款总额，商品行仍是旧数据。只要订单已有退款金额、退款状态或商品退款数量，而逐商品退款金额尚未核验，就暂停新申请及批准操作并给出明确提示，避免已退款商品借用其他商品余额。既有申请仍可查看、拒绝或记录外部结案。这不是自动判定赔付失效，后续需要补齐可核验的退款明细流程。

本轮没有客户申请入口、附件上传、保障邮件、赔付时限规则、付款执行或保障商品自动履约写回。顾客域名及邮件配置也没有改动现有工单配置。

## API

统一前缀：`/api/admin/protection`。所有接口要求有效的 `support_session`；修改请求使用同源 JSON 请求。安装、暂停和远程检测任务仅管理员可提交，普通登录客服可查看及处理申请。现有系统为共享客服后台，本模块没有增加客服按店铺分配的权限模型。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /stats` | 返回统计对象，支持 `store/from/to` |
| `GET /orders` | 保障订单分页，支持 `q/store/from/to/page/page_size` |
| `GET /orders/:id` | 返回 `{ok, order, claims}` |
| `GET /orders/export` | 当前筛选下的订单 CSV |
| `GET /claims` | 申请分页，除通用筛选外支持 `status/reason` |
| `GET /claims/:id` | 返回 `{ok, claim, order, events}` |
| `POST /claims` | 内部登记，返回 `201` 和 `{ok, claim}` |
| `PATCH /claims/:id` | 原子审核／备注／指派，返回 `{ok, claim}` |
| `GET /claims/export` | 当前筛选下的申请 CSV |
| `GET /agents` | 可选负责人 `{ok, items:[{id,name}]}` |
| `GET /stores` | 安装配置、期望启停、最近检测状态及最新任务 |
| `POST /stores/:id/actions` | `{action:"check"\|"install"\|"disable"}`，返回 `202` 和任务 |
| `GET /jobs/:id` | 查询安装任务状态及诊断信息 |

`POST /claims` 字段：`protection_order_id, item_ids, reason, description, requested_amount_cents`。

`PATCH /claims/:id` 必填 `revision`，可带 `status, approved_amount_cents, note, assignee_id, external_reference`。批准金额必须大于零，且不超过申请金额和所选商品／订单剩余可审核金额。已通过金额不能直接改写。金额字段单位均为分。

日期参数使用 `YYYY-MM-DD`，结束日期包含当天；统计日按 UTC 归组。分页默认 30 条、最多 100 条。CSV 最多 10,000 条，超限需缩小筛选；导出会转义引号、换行及电子表格公式前缀。

## 同步与数据库迁移

**数据来源是工单系统当前已经同步到 `support_order_snapshots` 的订单。** 本模块没有新增独立的店匠全量已支付订单拉取、支付 Webhook 或轮询器；源快照尚未同步的订单不会出现在保障统计中。这里的保障索引刷新不能被视为已完成后续“新已支付保障订单检测并发送赔付邮件”的独立流程，该接入及保障邮件仍属于下一阶段。

`ensureTables()` 依次执行 `PROTECTION_STORE_SCHEMA_SQL` 和 `PROTECTION_SCHEMA_SQL`，为现有数据库增加独立表、索引及快照触发器；不删除原有工单数据。迁移可重复执行。

新增表：

- `support_protection_stores`、`support_protection_install_jobs`：店铺配置、检测及安装任务。
- `support_protection_orders`、`support_protection_claims`、`support_protection_claim_events`：保障记录、申请和持久审计。
- `support_protection_sync_state`、`support_protection_sync_dirty`：历史游标和实时待同步队列。

配置店铺的 `support_order_snapshots` 在 INSERT/UPDATE 时，同一事务写入唯一 `(store_subdomain, order_id)` 的 dirty 记录。这样，时间戳更早但提交更晚的事务也会被消费，不依赖时间回看窗口。

后台每 10 秒运行保障同步及安装任务检查。`syncProtectionOrders(200)` 每批合计最多处理 200 个 dirty／历史候选：先锁同步状态，再以 `FOR UPDATE SKIP LOCKED` 领取 dirty，读取最新已提交快照，保存保障记录并同事务删除 dirty；剩余名额推进历史游标。游标使用数据库时间戳字符串保存微秒。审核修改另外读取最新源快照，防止周期同步尚未执行时使用旧退款或取消状态。

`resetProtectionOrderSync()` 可重置历史游标，用于新增适配配置后的历史扫描；不会重置申请或审计。启动只导入已有的 amao04／hipkastl 安装清单。同步不会自动发送邮件或触发订单 API 写回。

`SUPPORT_DISABLE_BACKGROUND_JOBS=true` 会同时停用既有后台任务和新保障任务，适合隔离预览；不要把它理解为只停保障同步。

## 店铺安装与故障恢复

当前已有验证清单为 amao04 的 Hero 主题、hipkastl 的 Nova 主题。支持的是具体清单中的店铺、主题 ID、商品和版本，并不意味着任何 Hero／Nova 店铺都可直接安装。未知主题、缺少清单或已更换主题时标记“待适配”，禁止直接写入主题。新店需先完成商品准备、主题适配及清单验证，再通过管理页部署。

构建显式使用独立 `tsconfigRaw`，并固定价格档位对象字段顺序，避免父项目编译设置和 PostgreSQL JSONB 键重排造成校验误报。脚本校验仍核对真实配置与执行内容。

“检测”执行只读远程核对及本地构建；“安装／启用”和“暂停”会调用既有部署脚本。远程检查核对当前主题、购物车资产、结账扩展发布及保障商品。`enabled` 是本地期望状态，`health/checked_at` 是最近一次检测结果；不能把未检测视为正常。

同一店铺只允许一个 queued/running 任务；worker 使用数据库 advisory lock 串行执行。任务超时分三层：

| 时间 | 行为 |
| --- | --- |
| 14 分钟 | 子 CLI 的 `PROTECTION_DEADLINE_AT` 截止时间，限制后续嵌套请求 |
| 15 分钟 | 父进程终止安装进程组，任务报超时 |
| 20 分钟 | 回收中断后遗留的 running 任务，标记失败并要求重新检测 |

远程操作失败可能已经产生新版本，系统会尽量保存更新后的清单 ID。遇到失败、进程中断或超时，先“检测”确认实际状态，再决定重试，不将失败等同于远程完全未变。

运行包目录为 `SUPPORT_PROTECTION_PACKAGE_DIR`，可写目录为 `SUPPORT_PROTECTION_DATA_DIR`。Docker 默认分别是 `/opt/shipping-protection` 和 `/app/protection-data`；后者挂载宿主机 `support-system/protection-data`，保存每店运行清单、构建和备份。Token 只进入服务器／子进程环境，不进入前端响应。

“暂停”停用自有组件，保留保障商品、历史订单及搜索／直购保护。不要直接恢复旧的整份主题备份覆盖商家的其他改动；必要时根据 `.backups` 和最新主题内容，只恢复本模块管理的变更。

## 履约状态与后续工作

当前读取实际保障商品行及对应包裹：已发货与已完成分别显示，取消／待发货包裹不会被计为已完成。它不会将整张订单改成完成。

已确认目标规则是“首次有效实物商品发货后，只完成剩余保障商品行”。官方部分商品履约接口已核对，但创建履约是否触发店匠顾客邮件尚未实测确认，因此 `fulfillment_enabled` 保持关闭，本轮没有创建或完成履约的后台写入 worker。服务履约完成也不等于保障到期；自动履约和保障期限需独立实现及验证。

## 构建与验证

在仓库根目录执行：

```bash
npm --prefix support-system ci
npm --prefix shipping-protection ci
npm --prefix support-system run build
npm --prefix support-system test
npm --prefix shipping-protection test
```

数据库集成测试需要专用 PostgreSQL 测试库。服务测试会重建 fixture 表；店铺测试要求空的本地测试库，二者使用不同数据库，不可指向业务库：

```bash
cd support-system
SUPPORT_PROTECTION_TEST_DATABASE_URL='postgres://USER:PASS@127.0.0.1:PORT/support_protection_test' npx tsx --test src/protection-service.test.ts
SUPPORT_PROTECTION_STORE_TEST_DATABASE_URL='postgres://USER:PASS@127.0.0.1:PORT/support_protection_store_test' npx tsx --test src/protection-store-db.test.ts
```

构建容器使用仓库根目录作为上下文，Compose 已配置这一点：

```bash
cd support-system
docker compose -f docker-compose.support.yml build support-bridge
```

截至本记录的自动化证据：后端完整测试 405 项（396 通过、9 项依赖专用测试库而跳过）；前端 6 项通过；运输保障部署包 36 项通过。独立后端／金额／安装器复核回归 20 项通过，先前 HTTP／店铺任务回归 4 项通过。测试使用合成资料，不使用截图中的顾客数据，不进行真实付款或审核真实申请。

桌面 1440px 与手机 390px 浏览器检查通过，页面无横向溢出、无 JavaScript 错误，旧工单与新后台之间导航正常。完整隔离流程通过：登记申请 → 拒绝 → 同一保障下新申请 → 并发修改返回 409 → 重载保留备注 → 审核通过 → 记录外部处理并结案。切换工作区会回到顶部。两家店铺已进行只读在线核对，没有修改前台启停状态。

## 发布记录

**2026-11-03：管理后台已发布并完成核验。** 公网入口为 `https://server.clientservice-center.com/thinkpro-admin/protection`；登录页面、静态资源、全部管理 API 和同源修改校验均已通过公网验证。当前保障订单／申诉均为 0；未向正式库注入测试申请。

发布来源保留在 `/root/work/amao04-shipping-protection`，分支 `codex/amao04-shipping-protection`，没有合并主分支。部署项目目录为 `/root/work/shoplazza-merchant-ticket-system/support-system`；固定镜像 `support-bridge:protection-admin-20261103`，覆盖配置为该目录下已忽略的 `docker-compose.override.yml`，持久化该目录的 `protection-data`。后续部署务必保留这一覆盖配置，避免普通 Compose 重建时切回旧镜像或丢掉运行目录挂载。

```bash
cd /root/work/shoplazza-merchant-ticket-system/support-system
docker compose -p support-system --env-file .env -f docker-compose.support.yml -f docker-compose.override.yml up -d --no-deps --no-build support-bridge
```

最终镜像摘要为 `sha256:53d2b7b7dae27d3dedd9ec79663fb2e822aa16c10686572f6ac1871b13a3f33b`。正式后台的只读检测任务 3、4 分别验证 amao04／hipkastl，均成功；两店组件保持启用，自动履约仍关闭。首次任务因跨环境构建差异失败的记录保留，后续成功记录是当前健康状态依据。没有执行店铺重装、暂停或任何真实申诉审核。

发布前镜像已保留为 `support-bridge:pre-protection-admin-20261103`。如需回退，将上述 override 的 image 改为此标签，再执行同一条命令；只重建 support-bridge，不重建数据库或邮件服务。

回退应用版本时保留上述新增表和审计，不执行破坏性逆向迁移；dirty 队列可保留供再次升级消费。回退后台镜像不会自动撤销已经安装在店铺前台的组件，组件暂停需要单独执行并检测。
