"""测试 financial_status 过滤 + 支付渠道分布"""
import requests, json, time

DOMAIN = "jaymiartstore.myshoplaza.com"
TOKEN = ""
BASE = f"https://{DOMAIN}/openapi/2025-06"
HEADERS = {"accept": "application/json", "Access-Token": TOKEN}

# Test 1: financial_status=paid filter
print("=== Test 1: financial_status=paid ===")
url = f"{BASE}/orders?updated_at_min=2026-04-10T00:00:00Z&updated_at_max=2026-04-30T23:59:59Z&financial_status=paid"
r = requests.get(url, headers=HEADERS)
data = r.json()
orders = data.get("data", {}).get("orders", [])
print(f"Status: {r.status_code}, 返回: {len(orders)} 条")
all_paid = all(o.get("financial_status") == "paid" for o in orders)
print(f"全部是 paid: {all_paid}")
for o in orders[:5]:
    print(f"  {o['number']} status={o['financial_status']}")

# Test 2: 不筛选，看支付渠道分布
print("\n=== Test 2: 支付渠道分布 (5月订单) ===")
time.sleep(0.6)
url = f"{BASE}/orders?updated_at_min=2026-05-01T00:00:00Z&updated_at_max=2026-05-18T23:59:59Z"
r = requests.get(url, headers=HEADERS)
data = r.json()
orders = data.get("data", {}).get("orders", [])
print(f"共 {len(orders)} 条")

# 统计支付渠道
from collections import Counter
channels = Counter()
methods = Counter()
for o in orders:
    pl = o.get("payment_line", {})
    ch = pl.get("payment_channel", "unknown")
    mt = pl.get("payment_method", "unknown")
    channels[ch] += 1
    methods[mt] += 1

print(f"支付渠道: {dict(channels)}")
print(f"支付方式: {dict(methods)}")

# 判断哪些是店匠自有（可能有 card_last4）
shoplazza_own = ["shoplazzapayment", "shoplazza_payment"]
third_party = ["shoplazzaapple", "paypal", "stripe"]

own_count = sum(v for k, v in channels.items() if any(x in k.lower() for x in shoplazza_own))
tp_count = sum(v for k, v in channels.items() if any(x in k.lower() for x in third_party))
print(f"\n店匠自有支付: {own_count} 条 (可能有卡号)")
print(f"第三方支付: {tp_count} 条 (payment_detail 为空)")

# Test 3: 验证一个 credit_card 订单的 transactions 有 card_last4
print("\n=== Test 3: 找一个 credit_card 订单验卡号 ===")
time.sleep(0.6)
credit_orders = [o for o in orders if o.get("payment_line", {}).get("payment_method") == "credit_card"]
if credit_orders:
    oid = credit_orders[0]["id"]
    print(f"测试订单: {credit_orders[0]['number']} payment_channel={credit_orders[0].get('payment_line',{}).get('payment_channel')}")
    txn_url = f"{BASE}/orders/{oid}/transactions"
    r = requests.get(txn_url, headers=HEADERS)
    txn_data = r.json()
    txns = txn_data.get("data", {}).get("transactions", [])
    if txns:
        pd = txns[0].get("payment_detail", {})
        print(f"  payment_detail: {json.dumps(pd, ensure_ascii=False)}")
        card = pd.get("card_last_four", pd.get("card_last4", ""))
        print(f"  card_last4: '{card}'")
    else:
        print("  无交易记录")
else:
    print("  本月无 credit_card 订单")
    # 找 shoplazzapayment 渠道的
    shop_orders = [o for o in orders if "shoplazzapayment" in o.get("payment_line",{}).get("payment_channel","").lower()]
    if shop_orders:
        oid = shop_orders[0]["id"]
        print(f"  改用 shoplazzapayment 订单: {shop_orders[0]['number']}")
        txn_url = f"{BASE}/orders/{oid}/transactions"
        r = requests.get(txn_url, headers=HEADERS)
        txn_data = r.json()
        txns = txn_data.get("data", {}).get("transactions", [])
        if txns:
            print(f"  payment_detail: {json.dumps(txns[0].get('payment_detail',{}), ensure_ascii=False)}")
