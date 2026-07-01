"""测试 Cursor 分页机制"""
import requests
import json
import time
import base64

SHOP_DOMAIN = "jaymiartstore.myshoplaza.com"
ACCESS_TOKEN = ""
API_VERSION = "2025-06"
BASE_URL = f"https://{SHOP_DOMAIN}/openapi/{API_VERSION}"
HEADERS = {"accept": "application/json", "Access-Token": ACCESS_TOKEN}

def api_get(url):
    time.sleep(0.6)
    return requests.get(url, headers=HEADERS, timeout=30)

# ── Cursor 分页循环测试 ──
print("=" * 60)
print("Cursor 分页遍历测试")
print("=" * 60)

params = {
    "limit": 3,
    "updated_at_min": "2025-12-01T00:00:00Z",
    "updated_at_max": "2025-12-31T23:59:59Z",
}

all_order_ids = set()
page = 0
cursor = None

while True:
    query_parts = [f"{k}={v}" for k, v in params.items()]
    if cursor:
        query_parts.append(f"cursor={cursor}")
    url = f"{BASE_URL}/orders?{'&'.join(query_parts)}"
    
    resp = api_get(url)
    data = resp.json()
    orders = data.get("data", {}).get("orders", [])
    has_more = data.get("data", {}).get("has_more", False)
    next_cursor = data.get("data", {}).get("cursor", "")
    
    page += 1
    new_ids = {o["id"] for o in orders}
    overlap = new_ids & all_order_ids
    all_order_ids.update(new_ids)
    
    print(f"Page {page}: {len(orders)} 条, has_more={has_more}, 重叠={len(overlap)}")
    for o in orders:
        print(f"  {o['number']} updated={o['updated_at']} status={o['financial_status']}")
    
    # 解码 cursor
    if next_cursor:
        try:
            decoded = base64.b64decode(next_cursor).decode()
            print(f"  cursor decoded: {decoded}")
        except:
            print(f"  cursor raw: {next_cursor[:60]}...")
    
    if not has_more or len(orders) == 0 or len(overlap) > 0:
        break
    
    cursor = next_cursor

print(f"\n总计唯一订单: {len(all_order_ids)}")

# ── 测试不同 cursor 传参方式 ──
print("\n" + "=" * 60)
print("测试 cursor 参数名变体")
print("=" * 60)

# 先获取第一页和一个 cursor
url = f"{BASE_URL}/orders?limit=3&updated_at_min=2025-12-01T00:00:00Z&updated_at_max=2025-12-31T23:59:59Z"
resp = api_get(url)
data = resp.json()
cursor_val = data.get("data", {}).get("cursor", "")
print(f"原始 cursor: {cursor_val[:60]}...")

# 尝试 page_info 参数名
for param_name in ["cursor", "page_info", "page_cursor", "next_cursor", "from"]:
    if param_name == "cursor":
        continue  # 上面已测
    url = f"{BASE_URL}/orders?limit=3&{param_name}={cursor_val}&updated_at_min=2025-12-01T00:00:00Z&updated_at_max=2025-12-31T23:59:59Z"
    resp = api_get(url)
    data = resp.json()
    orders = data.get("data", {}).get("orders", [])
    first_num = orders[0].get("number") if orders else "N/A"
    print(f"  {param_name}=...: {len(orders)} 条, 首单={first_num}")

print("\n测试完成")
