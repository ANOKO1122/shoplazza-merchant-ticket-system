"""
兜底任务 API 拉取测试 — 最终正确方案
======================================
经过多轮测试，确定的正确按时间分页拉取方式：

1. 使用 updated_at_min / updated_at_max 做增量过滤（而非 placed_at）
2. 使用 Cursor 分页（而非 page 参数）— 响应中包含 cursor + has_more
3. limit 参数无效，每页固定返回 10 条
4. 列表接口已返回完整订单数据，通常无需逐单查详情
5. 限流约 2 req/s（本脚本用 0.6s 间隔）

Cursor 格式（base64 解码后）：
  created_at#<timestamp>#desc#<order_id>

用法：
  GET /orders?updated_at_min=...&updated_at_max=...&cursor=<上一页返回的cursor>

停止条件：
  has_more == false 或 返回空列表
"""
import requests
import json
import time
import os

# ── 配置 ──
SHOP_DOMAIN = "jaymiartstore.myshoplaza.com"
ACCESS_TOKEN = os.environ.get(
    "SHOPLAZZA_ACCESS_TOKEN",
    ",
)
API_VERSION = "2025-06"
BASE_URL = f"https://{SHOP_DOMAIN}/openapi/{API_VERSION}"
HEADERS = {
    "accept": "application/json",
    "Access-Token": ACCESS_TOKEN,
}

# 限流：至少 0.55s 间隔（~2 req/s，安全余量）
last_request_at = 0.0


def rate_limit():
    """确保请求间隔 >= 550ms"""
    global last_request_at
    now = time.time()
    wait = last_request_at + 0.55 - now
    if wait > 0:
        time.sleep(wait)
    last_request_at = time.time()


def api_get(url: str) -> requests.Response:
    """带限流的 GET 请求"""
    rate_limit()
    resp = requests.get(url, headers=HEADERS, timeout=30)
    return resp


def extract_orders(data: dict) -> list[dict]:
    """从响应中提取订单列表"""
    if isinstance(data.get("data"), dict):
        return data["data"].get("orders", [])
    if isinstance(data.get("orders"), list):
        return data["orders"]
    return []


def get_cursor(data: dict) -> str | None:
    """从响应中提取 cursor"""
    if isinstance(data.get("data"), dict):
        return data["data"].get("cursor") or None
    return data.get("cursor") or None


def get_has_more(data: dict) -> bool:
    """从响应中提取 has_more"""
    if isinstance(data.get("data"), dict):
        return bool(data["data"].get("has_more", False))
    return bool(data.get("has_more", False))


# ── 模拟兜底同步：按 updated_at 增量拉取全部订单 ──
def fallback_sync(
    updated_at_min: str,
    updated_at_max: str,
    max_pages: int = 50,
) -> dict:
    """
    按时间增量拉取全部订单（兜底同步核心逻辑）

    返回:
      {
        "total_orders": int,       # 去重后总数
        "pages": int,               # 请求页数
        "errors": int,              # 请求失败次数
        "sample_order_numbers": [], # 前几个订单号
        "status_counts": {},        # 各状态统计
      }
    """
    all_orders: dict[str, dict] = {}  # order_id -> order
    pages = 0
    errors = 0
    cursor: str | None = None

    while pages < max_pages:
        # 构建 URL
        params = [
            f"updated_at_min={updated_at_min}",
            f"updated_at_max={updated_at_max}",
        ]
        if cursor:
            params.append(f"cursor={cursor}")

        url = f"{BASE_URL}/orders?{'&'.join(params)}"
        pages += 1

        try:
            resp = api_get(url)
        except Exception as e:
            errors += 1
            print(f"  [ERR] Page {pages} 请求失败: {e}")
            break

        if resp.status_code != 200:
            errors += 1
            print(f"  [ERR] Page {pages} HTTP {resp.status_code}: {resp.text[:200]}")
            if resp.status_code == 429:
                print("  ⚠️ 触发限流，等待 30 秒...")
                time.sleep(30)
                continue
            break

        data = resp.json()
        orders = extract_orders(data)
        has_more = get_has_more(data)
        next_cursor = get_cursor(data)

        # 记录订单（以 id 去重）
        new_count = 0
        for o in orders:
            oid = o.get("id", "")
            if oid and oid not in all_orders:
                all_orders[oid] = o
                new_count += 1

        print(
            f"  Page {pages:>3}: {len(orders)} 条 "
            f"(新增 {new_count}, 累计 {len(all_orders)}) "
            f"has_more={has_more}"
        )

        if not has_more or len(orders) == 0:
            print("  ✅ 全部拉取完成")
            break

        if not next_cursor:
            print("  ⚠️ has_more=true 但没有 cursor，停止")
            break

        cursor = next_cursor

    # 统计
    status_counts: dict[str, int] = {}
    for o in all_orders.values():
        fs = o.get("financial_status", "unknown")
        status_counts[fs] = status_counts.get(fs, 0) + 1

    sample_nums = [o.get("number", "?") for o in list(all_orders.values())[:5]]

    return {
        "total_orders": len(all_orders),
        "pages": pages,
        "errors": errors,
        "sample_order_numbers": sample_nums,
        "status_counts": status_counts,
    }


# ── 主程序 ──
if __name__ == "__main__":
    import datetime

    # 模拟场景：上次同步时间是 2025-12-01，现在同步到 2026-05-18
    # 实际兜底任务中 last_synced_at 存数据库，这里硬编码模拟
    last_synced_at = "2025-12-01T00:00:00Z"
    now = "2026-05-18T23:59:59Z"

    print("=" * 60)
    print("兜底同步测试 — Shoplazza 订单增量拉取")
    print("=" * 60)
    print(f"时间范围: {last_synced_at} → {now}")
    print(f"店铺: {SHOP_DOMAIN}")
    print(f"限流策略: >=550ms/请求 (~2 req/s)")
    print()

    t0 = time.time()
    result = fallback_sync(
        updated_at_min=last_synced_at,
        updated_at_max=now,
        max_pages=100,
    )
    elapsed = time.time() - t0

    print()
    print("=" * 60)
    print("同步结果")
    print("=" * 60)
    print(f"  总订单数 (去重): {result['total_orders']}")
    print(f"  请求页数: {result['pages']}")
    print(f"  失败次数: {result['errors']}")
    print(f"  耗时: {elapsed:.1f}s")
    if result["pages"]:
        print(f"  平均每页: {elapsed/result['pages']:.2f}s")
    print(f"  状态分布: {json.dumps(result['status_counts'], ensure_ascii=False)}")
    print(f"  示例订单号: {result['sample_order_numbers']}")

    # 估算全量同步耗时
    if result["pages"] > 0 and elapsed > 0:
        rate = result["total_orders"] / elapsed
        print(f"  吞吐量: {rate:.1f} 订单/秒")
        est_100k = 100000 / rate / 3600
        print(f"  估算 10 万订单全量同步: {est_100k:.1f} 小时")

    print()
    print("=" * 60)
    print("兜底任务实现建议")
    print("=" * 60)
    print("""
1. 数据库记录 last_synced_at 字段
2. 每小时 Cron 触发：
   - 读取 last_synced_at
   - 调用 fallback_sync(last_synced_at, now())
   - 对每个订单做 UPSERT（以 order_id + store_subdomain 为唯一键）
   - 更新 last_synced_at = now()
3. 错峰执行（如每小时过 5 分钟），避免与 Webhook 高峰重叠
4. 监控 has_more 循环是否正常退出
5. 对连续 3 次失败的同步发告警
""")
