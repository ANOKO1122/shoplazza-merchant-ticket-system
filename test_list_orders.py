"""
时间筛选 API 列表拉取测试脚本（单页）
=====================================
注意：此脚本为单页测试，生产兜底同步请使用 test_fallback_sync_v2.py
- 分页：Shoplazza 使用 Cursor（非 page 参数）
- 筛选：updated_at_min/max 用于增量同步
- 详情：列表接口已返回完整订单信息，通常无需单独查详情
"""
import requests
import json

SHOP_DOMAIN = "jaymiartstore.myshoplaza.com"
ACCESS_TOKEN = ""
API_VERSION = "2025-06"
BASE_URL = f"https://{SHOP_DOMAIN}/openapi/{API_VERSION}"
headers = {
    "accept": "application/json",
    "Access-Token": ACCESS_TOKEN,
}

url = f"{BASE_URL}/orders?limit=50&placed_at_min=2025-12-15T00:00:00Z&placed_at_max=2025-12-24T00:00:00Z"
print(f"URL: {url}")
resp = requests.get(url, headers=headers)
print(f"状态码: {resp.status_code}")
data = resp.json()
orders = data.get("data", {}).get("orders", [])
print(f"返回条数: {len(orders)}")

# 只关心已支付的
paid_orders = [o for o in orders if o.get("financial_status") == "paid"]
print(f"其中已支付: {len(paid_orders)}")

# 打印第一条已支付订单的完整 JSON，找 payment_line
if paid_orders:
    print("\n=== 第一条已支付订单完整 JSON ===")
    print(json.dumps(paid_orders[0], ensure_ascii=False, indent=2))

    # 测试交易接口
    order_id = paid_orders[0]["id"]
    print(f"\n=== 交易接口: {paid_orders[0].get('number')} ===")
    txn_url = f"{BASE_URL}/orders/{order_id}/transactions"
    txn_resp = requests.get(txn_url, headers=headers)
    if txn_resp.status_code == 200:
        txn_data = txn_resp.json()
        print(json.dumps(txn_data, ensure_ascii=False, indent=2)[:3000])
