"""
兜底任务 API 拉取测试 — 验证按时间分页拉取的正确方式
测试要点：
1. updated_at_min/max 是否生效（增量同步核心）
2. 分页机制：page 参数 vs Link header
3. 响应结构：total / meta / 下一页标识
4. 不同排序方式
"""
import requests
import json
import time

SHOP_DOMAIN = "jaymiartstore.myshoplaza.com"
ACCESS_TOKEN = ""
API_VERSION = "2025-06"
BASE_URL = f"https://{SHOP_DOMAIN}/openapi/{API_VERSION}"
headers = {
    "accept": "application/json",
    "Access-Token": ACCESS_TOKEN,
}

def api_get(url):
    """带限流的 GET 请求"""
    time.sleep(0.6)  # 约 2 req/s
    resp = requests.get(url, headers=headers, timeout=30)
    return resp

# ── Test 1: updated_at 筛选 ──
print("=" * 60)
print("Test 1: updated_at 增量筛选")
print("=" * 60)
url = f"{BASE_URL}/orders?limit=3&updated_at_min=2025-12-01T00:00:00Z&updated_at_max=2025-12-31T23:59:59Z"
resp = api_get(url)
print(f"Status: {resp.status_code}")
data = resp.json()
orders = data.get("data", {}).get("orders", data.get("orders", []))
print(f"返回条数: {len(orders)}")
print(f"响应顶层 key: {list(data.keys())}")
# 检查是否有 total/meta 等分页信息
for k in ["total", "count", "meta", "page", "pages", "page_info"]:
    if k in data:
        print(f"  data['{k}']: {json.dumps(data[k], ensure_ascii=False)[:200]}")
# 检查 data 内的分页信息
if isinstance(data.get("data"), dict):
    for k in data["data"].keys():
        if k != "orders":
            print(f"  data.data['{k}']: {json.dumps(data['data'][k], ensure_ascii=False)[:200]}")
if orders:
    print(f"首单: {orders[0].get('number')} updated_at={orders[0].get('updated_at')}")
    print(f"末单: {orders[-1].get('number')} updated_at={orders[-1].get('updated_at')}")

# ── Test 2: page 分页 ──
print("\n" + "=" * 60)
print("Test 2: page 参数分页")
print("=" * 60)

page1_orders = []
page2_orders = []

url = f"{BASE_URL}/orders?limit=3&page=1&placed_at_min=2025-12-01T00:00:00Z&placed_at_max=2025-12-31T23:59:59Z"
resp = api_get(url)
print(f"Page 1 Status: {resp.status_code}")
data = resp.json()
page1_orders = data.get("data", {}).get("orders", data.get("orders", []))
print(f"Page 1 条数: {len(page1_orders)}")
if page1_orders:
    print(f"  首: {page1_orders[0].get('number')}  末: {page1_orders[-1].get('number')}")

url = f"{BASE_URL}/orders?limit=3&page=2&placed_at_min=2025-12-01T00:00:00Z&placed_at_max=2025-12-31T23:59:59Z"
resp = api_get(url)
print(f"Page 2 Status: {resp.status_code}")
data = resp.json()
page2_orders = data.get("data", {}).get("orders", data.get("orders", []))
print(f"Page 2 条数: {len(page2_orders)}")
if page2_orders:
    print(f"  首: {page2_orders[0].get('number')}  末: {page2_orders[-1].get('number')}")

# 检查是否重复
p1_ids = {o["id"] for o in page1_orders}
p2_ids = {o["id"] for o in page2_orders}
overlap = p1_ids & p2_ids
print(f"两页重叠: {len(overlap)} 条 {'⚠️ 有重复!' if overlap else '✅ 无重复'}")

# ── Test 3: Link header (REST 标准分页) ──
print("\n" + "=" * 60)
print("Test 3: Link header 检查")
print("=" * 60)
url = f"{BASE_URL}/orders?limit=3&updated_at_min=2025-12-01T00:00:00Z&updated_at_max=2025-12-31T23:59:59Z"
resp = api_get(url)
print(f"Status: {resp.status_code}")
link_keys = [k for k in resp.headers.keys() if "link" in k.lower()]
print(f"Link 相关 header: {link_keys}")
for k in link_keys:
    print(f"  {k}: {resp.headers[k][:300]}")
# 也看看其他可能有用的 header
for k in ["X-Total-Count", "X-Total", "X-Page", "X-Page-Count", "X-Has-Next", "X-Has-More"]:
    if k in resp.headers:
        print(f"  {k}: {resp.headers[k]}")

# ── Test 4: 不带时间筛选，看默认排序 ──
print("\n" + "=" * 60)
print("Test 4: 不带时间筛选 + created_at 排序")
print("=" * 60)
url = f"{BASE_URL}/orders?limit=3&sort_by=created_at&sort_order=desc"
resp = api_get(url)
print(f"Status: {resp.status_code}")
data = resp.json()
orders = data.get("data", {}).get("orders", data.get("orders", []))
print(f"返回条数: {len(orders)}")
if orders:
    for o in orders:
        print(f"  {o.get('number')} created={o.get('created_at')} updated={o.get('updated_at')} status={o.get('financial_status')}")

# ── Test 5: 验证 limit 上限 ──
print("\n" + "=" * 60)
print("Test 5: limit=250 测试上限")
print("=" * 60)
url = f"{BASE_URL}/orders?limit=250&placed_at_min=2025-01-01T00:00:00Z&placed_at_max=2025-12-31T23:59:59Z"
resp = api_get(url)
print(f"Status: {resp.status_code}")
data = resp.json()
orders = data.get("data", {}).get("orders", data.get("orders", []))
print(f"返回条数: {len(orders)} (limit=250)")
# 如果返回 250，说明可能没到上限；如果返回小于 250，可能是实际数据不够，或者有限制
if len(orders) == 250:
    print("⚠️ 刚好 250 条，可能是截断上限，需分页")

print("\n" + "=" * 60)
print("测试完成")
print("=" * 60)
