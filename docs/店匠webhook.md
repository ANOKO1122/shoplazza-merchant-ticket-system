可以用 店匠 orders/paid Webhook 做“用户付款后立刻发邮件”的触发源。官方 orders/paid 说明是：订单成功下单时触发；对于 COD，它代表成功付款。这个事件需要 order 权限。

你们应该给每个店铺注册 webhook，注册时传 address 和 topic，例如 topic 用 orders/paid。店匠创建 Webhook API 的参数里明确有 address 和 topic。

店匠订单 Webhook 支持哪些订单事件

官方 Webhook 事件目录里，订单相关事件包括：

orders/create
orders/update
orders/paid
orders/partially_fulfilled
orders/fulfilled
orders/finished
orders/partially_refunded
orders/refunded
orders/cancelled
orders/delete

这些都在官方 Webhook Events 的 Orders 分类下。

你们这个需求主用：

orders/paid

其他事件作为后续更新：

orders/update
orders/refunded
orders/cancelled
orders/fulfilled
orders/paid Webhook 能拿到什么信息

官方 orders/paid 示例返回体最外层是：

{
  "order": {}
}

也就是 webhook 会把订单对象推给你们。官方示例里 order 对象能看到这些字段。

1. 订单基础字段
order.id
order.note
order.number
order.financial_status
order.status
order.cancel_reason
order.payment_method
order.fulfillment_status
order.discount_code
order.discount_applications
order.customer_note
order.buyer_accepts_marketing
order.currency
order.tags

官方示例里能看到 id、number、financial_status、status、payment_method、fulfillment_status、currency、tags 等字段。

2. 金额字段
order.sub_total
order.total_discount
order.total_tax
order.total_shipping
order.total_price
order.code_discount_total
order.line_item_discount_total
order.total_tip_received
order.total_paid
order.real_total_paid
order.main_currency_prices

官方示例里包含小计、折扣、税费、运费、订单总价、代码折扣、行项目折扣、小费、已付金额、实际已付金额，以及 main_currency_prices。

3. 时间字段
order.created_at
order.updated_at
order.canceled_at
order.customer_deleted_at
order.deleted_at
order.placed_at
order.closed_at

官方示例里能看到创建时间、更新时间、取消时间、删除时间、下单时间、关闭时间等字段。

4. 配送方式字段
order.shipping_line.name
order.shipping_line.desc
order.shipping_line.delivery_method
order.shipping_line.extra_info

官方示例里的 shipping_line 包含配送名称、描述、配送方式编号和 extra_info。

5. 顾客字段
order.customer.id
order.customer.first_name
order.customer.last_name
order.customer.email
order.customer.phone
order.customer.created_at
order.customer.updated_at
order.customer.order_count
order.customer.total_spent

官方示例里的 customer 包含顾客 ID、姓名、邮箱、电话、创建/更新时间、历史订单数、累计消费金额。

6. 收货地址字段
order.shipping_address.first_name
order.shipping_address.last_name
order.shipping_address.address1
order.shipping_address.address2
order.shipping_address.phone
order.shipping_address.city
order.shipping_address.zip
order.shipping_address.province
order.shipping_address.country
order.shipping_address.company
order.shipping_address.latitude
order.shipping_address.longitude
order.shipping_address.name
order.shipping_address.country_code
order.shipping_address.province_code
order.shipping_address.email
order.shipping_address.phone_area_code
order.shipping_address.area
order.shipping_address.extra_info

官方示例中的 shipping_address 包含姓名、地址、电话、城市、邮编、省份、国家、经纬度、邮箱、国家码、省份码、电话区号和额外信息。

7. 账单地址字段
order.billing_address.first_name
order.billing_address.last_name
order.billing_address.address1
order.billing_address.address2
order.billing_address.phone
order.billing_address.city
order.billing_address.zip
order.billing_address.province
order.billing_address.country
order.billing_address.company
order.billing_address.latitude
order.billing_address.longitude
order.billing_address.name
order.billing_address.country_code
order.billing_address.province_code
order.billing_address.email
order.billing_address.area

官方示例中的 billing_address 结构和收货地址类似。

8. 支付相关字段

Webhook 示例里能看到这些支付相关字段：

order.payment_method
order.financial_status
order.payment_line
order.payment_lines
order.total_paid
order.real_total_paid

但要注意：官方示例里的 payment_line 是 null，payment_lines 是空数组，所以 Webhook 本身不一定能稳定拿到你们想要的“卡号后四位”。

你们邮件里要显示：

店铺名称
订单号
支付时间
支付方式
卡号后四位

其中 订单号、支付方式、部分时间/金额信息可以从 orders/paid 的 order 对象拿到；但 卡号后四位建议收到 webhook 后，再调支付订单详情或订单交易接口补全。店匠有 Payment Order Details API，用于获取具体 payment order 详情；也有订单交易列表 API，说明可以获取交易状态、支付渠道等交易相关信息。

9. 商品明细字段

官方示例里的 line_items 是数组，每个商品项包含：

line_items[].id
line_items[].product_id
line_items[].variant_id
line_items[].variant_title
line_items[].product_title
line_items[].product_handle
line_items[].quantity
line_items[].note
line_items[].fulfillment_status
line_items[].sku
line_items[].weight_unit
line_items[].vendor
line_items[].product_url
line_items[].price
line_items[].compare_at_price
line_items[].total
line_items[].weight
line_items[].image
line_items[].properties
line_items[].custom_properties
line_items[].main_currency_prices
line_items[].discount_applications

官方示例里这些字段都能看到。

10. 履约字段
order.fulfillment_status
order.fulfillments
line_items[].fulfillment_status

官方示例里 fulfillment_status 在订单和商品行里都有，fulfillments 是数组。

11. 访问/营销字段
order.browser_ip
order.landing_site
order.last_landing_url
order.buyer_accepts_marketing

官方示例里有浏览器 IP、落地页、最后落地 URL、是否接受营销。

对你们发邮件来说，字段来源应该这样定
邮件字段	推荐来源	说明
店铺名称	你们本地 stores 表 / token / 店铺配置	不建议依赖 webhook，按 store_subdomain 查本地店铺名
订单号	order.number	webhook 示例里有
支付时间	优先交易/支付详情 API；其次 order.updated_at 或 placed_at	orders/paid 触发时间不一定等于支付完成时间字段
支付方式	order.payment_method，必要时补查交易/支付详情	webhook 示例里有
卡号后四位	支付详情 / 交易详情 API	webhook 示例没看到稳定字段
顾客邮箱	order.customer.email 或 order.shipping_address.email	webhook 示例里都有
订单金额	order.total_price / order.total_paid / real_total_paid	视你们展示口径决定
推荐实现流程
店匠 orders/paid webhook
  ↓
bridge 接收 webhook
  ↓
根据 webhook URL 或 header / 注册信息识别 store_subdomain
  ↓
读取 order.id / order.number / customer.email
  ↓
立刻调用：
    GET /orders/{order_id}
    GET /orders/{order_id}/transactions
    必要时 GET /shoplazza-payment/payment-orders/{id}
  ↓
normalize 出：
    store_name
    order_number
    customer_email
    paid_at
    payment_method
    card_last4
    total_price
  ↓
写入 support_order_snapshots
  ↓
查 support_email_events，防重复
  ↓
生成售后入口 token
  ↓
发邮件

店匠有订单详情接口 GET /orders/{order_id}，有订单交易列表接口 GET /orders/{order_id}/transactions，也有支付订单详情接口 GET /shoplazza-payment/payment-orders/{id}。

关键判断

可以用 webhook 代替“定时拉订单来发现付款”。
但不要只靠 webhook payload 发邮件，尤其你们要显示卡号后四位。正确做法是：

Webhook 只负责触发
订单详情 API / 交易 API 负责补全数据
本地 support_portal.sqlite 负责存快照和防重复发信

最终邮件规则：

有 card_last4：
支付方式：Credit Card（尾号 1234）

无 card_last4：
支付方式：PayPal

店匠 v2025.06 有创建 webhook 接口：

POST https://{subdomain}.myshoplaza.com/openapi/2025-06/webhooks

官方说明该接口用于创建包含通知 URL、事件名和格式的 webhook。
老版本文档里更明确写了 address 是通知地址，topic 是事件名，例如 orders/cancelled。

1. 先准备我们自己的接收地址

比如你们 bridge 暴露这个接口：

https://support.yourdomain.com/api/shoplazza/webhook/store-a

或者：

https://chat.thinkpro.top/bridge-api/api/shoplazza/webhook/store-a

建议把 store-a 放进路径里，这样店匠推过来时，我们能直接知道是哪一个店铺。

2. 用 curl 注册 orders/paid

假设：

店铺域名：store-a
店匠后台域名：store-a.myshoplaza.com
token：SHOPLAZZA_ACCESS_TOKEN
我们的接收地址：https://support.yourdomain.com/api/shoplazza/webhook/store-a

调用：

curl --request POST \
  --url "https://store-a.myshoplaza.com/openapi/2025-06/webhooks" \
  --header "accept: application/json" \
  --header "content-type: application/json" \
  --header "access-token: SHOPLAZZA_ACCESS_TOKEN" \
  --data '{
    "webhook": {
      "address": "https://support.yourdomain.com/api/shoplazza/webhook/store-a",
      "topic": "orders/paid",
      "format": "json"
    }
  }'

如果你们当前 shoplazza.ts 用的是老版本 2022-01，也可以按老接口写：

curl --request POST \
  --url "https://store-a.myshoplaza.com/openapi/2022-01/webhooks" \
  --header "accept: application/json" \
  --header "content-type: application/json" \
  --header "access-token: SHOPLAZZA_ACCESS_TOKEN" \
  --data '{
    "address": "https://support.yourdomain.com/api/shoplazza/webhook/store-a",
    "topic": "orders/paid"
  }'

老版本创建接口明确要求 address 和 topic 两个字段。
如果你们的项目现在已经统一用 2025-06，优先用第一种。

3. 注册 3 个店铺

每个店铺都要单独注册，因为每个店铺有自己的域名和 token。

# Store A
curl --request POST \
  --url "https://store-a.myshoplaza.com/openapi/2025-06/webhooks" \
  --header "accept: application/json" \
  --header "content-type: application/json" \
  --header "access-token: STORE_A_TOKEN" \
  --data '{
    "webhook": {
      "address": "https://support.yourdomain.com/api/shoplazza/webhook/store-a",
      "topic": "orders/paid",
      "format": "json"
    }
  }'

# Store B
curl --request POST \
  --url "https://store-b.myshoplaza.com/openapi/2025-06/webhooks" \
  --header "accept: application/json" \
  --header "content-type: application/json" \
  --header "access-token: STORE_B_TOKEN" \
  --data '{
    "webhook": {
      "address": "https://support.yourdomain.com/api/shoplazza/webhook/store-b",
      "topic": "orders/paid",
      "format": "json"
    }
  }'

# Store C
curl --request POST \
  --url "https://store-c.myshoplaza.com/openapi/2025-06/webhooks" \
  --header "accept: application/json" \
  --header "content-type: application/json" \
  --header "access-token: STORE_C_TOKEN" \
  --data '{
    "webhook": {
      "address": "https://support.yourdomain.com/api/shoplazza/webhook/store-c",
      "topic": "orders/paid",
      "format": "json"
    }
  }'
4. 查看是否注册成功

店匠也有 Webhook List 接口：

GET https://{shopdomain}.myshoplaza.com/openapi/2022-01/webhooks

支持按 address、topic 查询，limit 默认 50，最大 250。

示例：

curl --request GET \
  --url "https://store-a.myshoplaza.com/openapi/2025-06/webhooks?limit=50" \
  --header "accept: application/json" \
  --header "access-token: STORE_A_TOKEN"

如果 2025-06 list 接口在你们账号里不可用，就用老版本：

curl --request GET \
  --url "https://store-a.myshoplaza.com/openapi/2022-01/webhooks?limit=50" \
  --header "accept: application/json" \
  --header "access-token: STORE_A_TOKEN"
5. bridge 里接收 webhook 的例子

新增一个接口：

// src/support-shoplazza-webhook.ts
import express from "express";

export function createShoplazzaWebhookRouter(deps: {
  handleOrderPaid: (input: {
    storeSubdomain: string;
    payload: any;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<void>;
}) {
  const router = express.Router();

  router.post("/webhook/:storeSubdomain", async (req, res) => {
    const { storeSubdomain } = req.params;

    try {
      await deps.handleOrderPaid({
        storeSubdomain,
        payload: req.body,
        headers: req.headers
      });

      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[shoplazza-webhook] failed", {
        storeSubdomain,
        error: err
      });

      res.status(500).json({ ok: false });
    }
  });

  return router;
}

在 index.ts 里注册：

import { createShoplazzaWebhookRouter } from "./support-shoplazza-webhook";

app.use(
  "/api/shoplazza",
  createShoplazzaWebhookRouter({
    handleOrderPaid: async ({ storeSubdomain, payload, headers }) => {
      const topic =
        String(headers["x-shoplazza-topic"] || "") ||
        String(payload?.topic || "");

      // 不要完全依赖 topic header，先按注册的地址区分店铺
      // 这里主要处理 orders/paid
      const order = payload?.order;

      if (!order) {
        console.warn("[shoplazza-webhook] missing order", {
          storeSubdomain,
          payload
        });
        return;
      }

      const orderId = order.id;
      const orderNumber = order.number;
      const email =
        order.customer?.email ||
        order.shipping_address?.email ||
        order.billing_address?.email;

      if (!orderId || !email) {
        console.warn("[shoplazza-webhook] missing orderId/email", {
          storeSubdomain,
          orderId,
          orderNumber,
          email
        });
        return;
      }

      // 关键：webhook 只当触发器
      // 收到后再用 storeSubdomain 精确选择该店铺 API，拉订单详情/支付详情
      // 1. loadStoreBySubdomain(storeSubdomain)
      // 2. fetchOrderDetail(store, orderId)
      // 3. fetchOrderTransactions(store, orderId)
      // 4. normalize payment_method / paid_at / card_last4
      // 5. upsert support_order_snapshots
      // 6. check support_email_events 防重复
      // 7. send paid email
    }
  })
);
6. Node 脚本注册 webhook

你也可以写一个一次性脚本：

// scripts/register-shoplazza-webhooks.ts

type StoreConfig = {
  subdomain: string;
  token: string;
};

const stores: StoreConfig[] = [
  {
    subdomain: "store-a",
    token: process.env.STORE_A_TOKEN!
  },
  {
    subdomain: "store-b",
    token: process.env.STORE_B_TOKEN!
  },
  {
    subdomain: "store-c",
    token: process.env.STORE_C_TOKEN!
  }
];

const publicBaseUrl = "https://support.yourdomain.com";

async function registerWebhook(store: StoreConfig) {
  const url = `https://${store.subdomain}.myshoplaza.com/openapi/2025-06/webhooks`;

  const body = {
    webhook: {
      address: `${publicBaseUrl}/api/shoplazza/webhook/${store.subdomain}`,
      topic: "orders/paid",
      format: "json"
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "access-token": store.token
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `Failed to register webhook for ${store.subdomain}: ${res.status} ${text}`
    );
  }

  console.log(`[ok] ${store.subdomain}: ${text}`);
}

async function main() {
  for (const store of stores) {
    await registerWebhook(store);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

运行：

STORE_A_TOKEN="xxx" \
STORE_B_TOKEN="yyy" \
STORE_C_TOKEN="zzz" \
npx ts-node scripts/register-shoplazza-webhooks.ts

如果你们项目不用 ts-node，就写成 .js。

7. 实际收到 webhook 后要做什么

收到 orders/paid 后，不要马上只用 webhook payload 发邮件。建议这样：

orders/paid webhook
  ↓
识别 storeSubdomain
  ↓
读取该店铺 token
  ↓
调用订单详情 API
  ↓
调用交易/支付详情 API
  ↓
整理：
    store_name
    order_number
    customer_email
    payment_method
    paid_at
    card_last4
  ↓
写 support_order_snapshots
  ↓
查 support_email_events，确认没发过
  ↓
生成售后页面 token
  ↓
发邮件

因为你们邮件里要卡号后四位，而 orders/paid webhook 示例里不一定稳定带这个字段；支付方式可以从订单对象里的 payment_method 拿，卡号后四位最好补查支付/交易详情。

8. 最小落地版本

先注册一个店铺测试：

curl --request POST \
  --url "https://你的店铺前缀.myshoplaza.com/openapi/2025-06/webhooks" \
  --header "accept: application/json" \
  --header "content-type: application/json" \
  --header "access-token: 你的店匠token" \
  --data '{
    "webhook": {
      "address": "https://你的公网域名/api/shoplazza/webhook/你的店铺前缀",
      "topic": "orders/paid",
      "format": "json"
    }
  }'

然后下一笔测试付款后，店匠就会 POST 到：

https://你的公网域名/api/shoplazza/webhook/你的店铺前缀


店匠官方的 webhook 创建接口只是定义事件订阅，orders/paid 是订单事件；而交易详情是你主动调用 API 得到的独立数据。官方文档里也单独提供 Payment Order / payment orders 查询接口，说明支付详情和 webhook payload 并不是同一个稳定数据源。

所以正式逻辑应该是：

orders/paid webhook
  ↓
只读取 order.id / order.number / customer.email
  ↓
用 order.id 再调用交易详情接口
  ↓
从 transactions[0].payment_detail.card_last_four 取卡号后四位
  ↓
写入 support_order_snapshots
  ↓
发邮件


店匠的webhook注册之后怎么注销

可以注销。流程是先查出 webhook 的 id，再调用 DELETE。

官方删除接口是：

DELETE https://{subdomain}.myshoplaza.com/openapi/2025-06/webhooks/{id}

店匠文档说明这个接口用 webhook 的唯一 id 删除，成功返回 200 OK。

1. 先查 webhook 列表拿 id

如果你不知道 webhook id，先 list。2022-01 文档里 list 接口是：

GET https://{shopdomain}.myshoplaza.com/openapi/2022-01/webhooks

支持按 address、topic 过滤，limit 默认 50、最大 250。

示例：

curl --request GET \
  --url "https://store-a.myshoplaza.com/openapi/2022-01/webhooks?topic=orders/paid&limit=50" \
  --header "accept: application/json" \
  --header "access-token: STORE_A_TOKEN"

如果你们创建时用的是 2025-06，也可以先试：

curl --request GET \
  --url "https://store-a.myshoplaza.com/openapi/2025-06/webhooks?topic=orders/paid&limit=50" \
  --header "accept: application/json" \
  --header "access-token: STORE_A_TOKEN"

返回里找到类似：

{
  "id": "123456789",
  "address": "https://support.yourdomain.com/api/shoplazza/webhooks/store-a",
  "topic": "orders/paid"
}

记下 id。

2. 删除 webhook
curl --request DELETE \
  --url "https://store-a.myshoplaza.com/openapi/2025-06/webhooks/123456789" \
  --header "accept: application/json" \
  --header "access-token: STORE_A_TOKEN"

如果你们用老版本接口创建的，也可以试：

curl --request DELETE \
  --url "https://store-a.myshoplaza.com/openapi/2022-01/webhooks/123456789" \
  --header "accept: application/json" \
  --header "access-token: STORE_A_TOKEN"
3. 删除后确认

再查一次：

curl --request GET \
  --url "https://store-a.myshoplaza.com/openapi/2025-06/webhooks?topic=orders/paid&limit=50" \
  --header "accept: application/json" \
  --header "access-token: STORE_A_TOKEN"

确认对应的：

address = 你的 webhook 地址
topic = orders/paid

已经不存在。

4. 三个店铺都要单独删

每个店铺的 webhook 是独立注册的，所以要分别删：

store-a.myshoplaza.com
store-b.myshoplaza.com
store-c.myshoplaza.com

每个店铺都要用自己的 token。