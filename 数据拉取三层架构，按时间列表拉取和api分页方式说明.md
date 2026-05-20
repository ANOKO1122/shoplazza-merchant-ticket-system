系统预想，用户下单-webhook投递-触发api单独拉取补全，额外还有每小时更新的大数据表兜底
实时触发 + 数据补全 + 最终一致

层级	职责	为什么不可替代
Webhook 实时推送。	秒级感知"有订单了"。	没有它，你得靠轮询，40 req/min 的配额很快会被拖垮
API 单独拉取补全。	获取订单完整详情、明细、客户信息。	Webhook payload 通常只给订单 ID 和基础状态，字段不全；且店匠不保证 Webhook 顺序，必须通过 API 拿最新快照
每小时兜底同步。	修补 Webhook 丢失、宕机期间、Webhook 被删后的数据缺口。	Webhook 重试 2 天失败后会被删除，期间的事件永久丢失；兜底是最后的防线。

1. Webhook 只当"闹钟"，不当"数据源"，可以存多点，但可能不全，
收到 orders/create 后，只提取订单 ID，立刻返回 200。
把订单 ID 丢进本地队列（Redis/RabbitMQ），由异步 worker 去调 API 拉详情。
这样即使 API 拉取慢或触发 429，也不会让店匠重试 Webhook。

2. API 补全可以"按需 + 批量"（暂时先一个webhook单独查一次，业务量不大）
不要收到一个 Webhook 就发一个 API 请求。
worker 可以攒 5~10 个订单 ID 后批量查询，或者利用 GraphQL（如有）一次拉多个订单。
如果店匠订单 API 只能单条查，那至少做好本地缓存，避免对同一个订单反复拉取。

3. 兜底任务用"增量"而非"全量"
每小时把全量订单扫一遍，对大数据表和 API 都是浪费。
正确做法：记录上次同步时间 last_synced_at，每小时只拉 updated_at > last_synced_at 的订单。
店匠 API 支持按时间过滤，这样即使店铺有 10 万单，每小时可能只更新几十条。

4. 错峰 + 限流
兜底任务避开业务高峰（比如放在整点过 5 分钟执行）。
worker 里做令牌桶/漏桶控制，确保调店匠 API 平均不超过 2 req/s，突发不超过 40。

5. 幂等性是一切的前提
同一订单可能通过 Webhook、API 补全、兜底同步三条路径写入你的数据库。
数据库表必须以店匠订单 ID 为主键或唯一索引，确保重复写入只更新不插入。



Shoplazza Developer Docs 的多数列表接口都支持按时间范围过滤，常见字段包括：

created_at_min
created_at_max
updated_at_min
updated_at_max
部分资源还支持：
published_at_min
published_at_max
placed_at_min
placed_at_max

时间格式要求是 ISO 8601。

例如商品列表接口：

GET /openapi/2022-01/products

支持：

created_at_min=2024-01-01T00:00:00Z
created_at_max=2024-01-31T23:59:59Z
updated_at_min=2024-01-01T00:00:00Z
updated_at_max=2024-01-31T23:59:59Z

文档明确列出了这些参数。

订单列表接口同样支持：

updated_at_min
updated_at_max
placed_at_min
placed_at_max

并支持按 created_at / updated_at / placed_at 排序。

示例：

curl --request GET \
  'https://{shop}.myshoplaza.com/openapi/2022-01/products?updated_at_min=2024-01-01T00:00:00Z&updated_at_max=2024-01-31T23:59:59Z' \
  --header 'access-token: YOUR_TOKEN'

Shoplazza 的订单列表接口本身已经返回相当完整的订单对象，不是只有摘要。

根据官方 GET /orders 文档，列表响应里直接包含：

financial_status
fulfillment_status
customer
shipping_address
billing_address
payment_line
line_items
fulfillments
discount_applications
total_price
payment_method
checkout_url
等完整订单字段

因此：

如果你只是做订单同步、ERP、BI、风控、售后
并且只需要订单商品、客户、支付状态、金额

通常不需要再对每个订单调用 detail API。


## 2025-06 API 实测结论（2026-05-18 真机验证）

> 以下结论基于 `jaymiartstore.myshoplaza.com` 店铺的真实 API 请求测试，
> 使用 `test_list_orders.py` / `test_fallback_sync_v2.py` / `test_cursor_pagination.py` 三组脚本交叉验证。

---

### 分页机制：Cursor（非 page）

| 测试项 | 结论 |
|--------|------|
| `?page=1&page=2` | ❌ **无效**，page=1 和 page=2 返回完全相同的 10 条数据 |
| `?cursor=<上页返回>` | ✅ **正确**，唯一有效的翻页方式 |
| `?limit=N` | ❌ **无效**（2025-06），传 `limit=3` / `limit=50` / `limit=250` 均固定返回 **10 条** |
| `?page_size=N` | ⚠️ **待验证**，文档声称最大 250，但 `limit` 实测无效；建议优先相信实测，以 10 条/页为准 |

**每页固定返回 10 条订单。** 不要依赖 `limit` 或 `page_size` 来改变页大小。

### 响应结构（实测）

```json
{
  "code": "Success",
  "data": {
    "orders": [ /* 10 条完整订单 */ ],
    "cursor": "Y3JlYXRlZF9hdCMyMDI1LTEyLTIwVDE2OjQwOjE4LjY3NDYyNFojZGVzYyMyODkwMDEtSlNUS1BRMDczNzE=",
    "has_more": true
  }
}
```

翻页时把 `cursor` 原样作为 query parameter 传入：

```
GET /orders?updated_at_min=...&updated_at_max=...&cursor=<上页返回的cursor>
```

**停止条件**：`has_more == false` 或返回空数组。

### Cursor 格式

Base64 解码后的内容为：

```
created_at#<ISO8601时间戳>#desc#<最后一条订单的ID>
```

示例解码：
```
created_at#2025-12-20T16:40:18.674624Z#desc#289001-JSTKPQ07371
```

> Cursor 包含排序字段 + 最后一条记录的位置，由服务端生成，**不要自行构造**，只做透传。

### 时间筛选（已确认）

| 参数 | 说明 | 实测 |
|------|------|------|
| `updated_at_min` | 更新时间下限 | ✅ 生效 |
| `updated_at_max` | 更新时间上限 | ✅ 生效 |
| `placed_at_min` | 下单时间下限 | ✅ 生效 |
| `placed_at_max` | 下单时间上限 | ✅ 生效 |

时间格式：ISO 8601，如 `2025-12-01T00:00:00Z`。

### 支付状态筛选（已确认）

| 参数 | 说明 | 实测 |
|------|------|------|
| `financial_status=paid` | 只返回已支付订单 | ✅ 生效，6 条全为 paid |

> 兜底同步应加上 `financial_status=paid`，未支付订单对工单系统无意义，可减少无效数据拉取。

### 列表接口已返回完整订单（已确认）

实测列表接口 `/orders` 返回的每条订单已包含：

- `payment_line`（含 `transaction_no`、`payment_channel`、`payment_method`、`trans_method`）
- `payment_lines`（数组，多支付方式时）
- `line_items`（含 SKU、变体、单价、数量）
- `customer`（email、phone、name）
- `shipping_address` / `billing_address`
- `shipping_line`（物流方案）
- `fulfillment_status` / `financial_status`
- `total_price` / `currency` / `discount_applications`

**唯独没有 `card_last4`（卡号后四位）。**

---

### 卡号后四位：需额外调用，但可按渠道智能跳过

| 支付渠道 | `payment_detail` | 卡号后四位 | 需要调 transactions？ |
|----------|:--:|:--:|:--:|
| `shoplazzapayment`（店匠自有） | `{"card_last_four": "4690", "card_first_fix": "555824", ...}` | ✅ 有 | **是** |
| `paypal` / `paypalapple` | `{}` 空对象 | ❌ 无 | **否**，跳过 |
| `shoplazzaapple`（Apple Pay） | `{}` 空对象 | ❌ 无 | **否**，跳过 |

**实测验证：**

```json
// 店匠自有支付 → 有卡号
GET /orders/289001-JSTFLC24184/transactions
{
  "transactions": [{
    "payment_channel": "shoplazzapayment",
    "payment_detail": {
      "card_last_four": "4690",
      "card_first_fix": "555824",
      "card_year": "31"
    }
  }]
}

// 第三方支付 → payment_detail 为空
GET /orders/{apple_pay_order}/transactions
{
  "transactions": [{
    "payment_channel": "shoplazzaapple",
    "payment_detail": {}   // 空
  }]
}
```

**智能策略：** 列表拉取后，只对 `payment_channel == "shoplazzapayment"` 的订单调用 transactions 接口，第三方支付直接跳过 —— 因为它们必然返回空 `payment_detail`。

### API 消耗估算（按 150 单/天/店，每小时 ~6 单）

| 场景 | 列表请求 | 交易请求 | 总 API 调用 |
|------|:--:|:--:|:--:|
| 每小时增量（全部 paid，假设 60% 店匠自有） | 1 | ~4 | **~5 次** |
| 首次全量 500 单 | 50 | ~300 | **~350 次**（约 3 分钟） |

> 店匠自有支付比例因店铺而异，本测试店铺 5 月订单中第三方支付占比 100%（PayPal + Apple Pay），无店匠自有支付。实际按店铺真实比例计算。

---

### 限流实测

| 指标 | 数据 |
|------|------|
| 请求间隔 | ≥550ms（约 2 req/s） |
| 本次测试请求数 | 49 页 |
| 触发 429 | 0 次 |
| 超时（30s） | 1 次（第 49 页） |
| 实际吞吐量 | ~4.6 订单/秒 |

> 建议兜底任务加上 **重试机制**（超时/5xx 时退避重试 3 次）。

---

## ⭐ 推荐同步策略（实测修正版）

```
1. updated_at_min = 上次同步时间（last_synced_at）
2. updated_at_max = 当前时间
3. financial_status = paid        ← 只拉已支付
4. 首请求不加 cursor
5. 从响应 data 中取 cursor + has_more
6. 下一页：原参数 + &cursor=<上页返回的cursor>
7. 重复直到 has_more == false
8. 对每条订单判断 payment_line.payment_channel：
   ├─ "shoplazzapayment" → 调 transactions API 拿 card_last4
   └─ 其他（paypal/paypalapple/shoplazzaapple...）→ 跳过
9. UPSERT 入库（order_id + store_subdomain 唯一键）
10. 更新 last_synced_at = now()
```

**伪代码：**

```python
cursor = None
while True:
    url = f"/orders?financial_status=paid&updated_at_min={last}&updated_at_max={now}"
    if cursor:
        url += f"&cursor={cursor}"
    resp = api_get(url)          # 限流 ≥550ms/req
    data = resp.json()
    orders = data["data"]["orders"]       # 固定 10 条/页
    has_more = data["data"]["has_more"]
    cursor = data["data"]["cursor"]

    for order in orders:
        # 智能卡号查询：只查店匠自有支付
        channel = order.get("payment_line", {}).get("payment_channel", "")
        card_last4 = ""
        if channel == "shoplazzapayment":
            txns = api_get(f"/orders/{order['id']}/transactions")
            pd = txns["data"]["transactions"][0].get("payment_detail", {})
            card_last4 = pd.get("card_last_four", "")

        upsert_order(order, card_last4)   # 幂等写入

    if not has_more:
        break
```

**注意：**
- 不要传 `page` 参数（无效）
- 不要依赖 `limit`/`page_size` 来增大页大小（实测固定 10 条）
- 必须带 `financial_status=paid`，只同步已支付订单
- 卡号查询按 `payment_channel` 过滤，第三方支付不浪费 API 配额
- 翻页过程中 `updated_at_min/max` 必须保持不变，只变 cursor

---

### 首次全量同步耗时估算（含卡号查询，假设 60% 店匠自有支付）

| 订单量 | 列表页数 | 交易查询 | 总 API | 预估耗时（2 req/s） |
|--------|:--:|:--:|:--:|---------------------|
| 500 单（~300 需查卡号） | 50 | 300 | 350 | ~3 分钟 |
| 5,000 单（~3,000 需查卡号） | 500 | 3,000 | 3,500 | ~30 分钟 |
| 50,000 单 | 5,000 | 30,000 | 35,000 | ~5 小时 |

> 首次全量同步后，每小时增量同步通常只有 1-3 页（10-30 条），含卡号查询总计 <20 次 API，耗时 <15 秒。