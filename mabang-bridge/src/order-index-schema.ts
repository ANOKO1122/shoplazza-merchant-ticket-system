/**
 * order_index 字段映射：
 * - 核心索引列保留（用于查询性能与兼容现有逻辑）
 * - API 字段列严格按 Get Order List 返回字段名落库（含 logistics_code）
 */

/** order_index 表初始即有的核心列（与 CREATE TABLE 一致） */
export const ORDER_INDEX_CORE_COLUMNS = [
  'store_subdomain',
  'order_id',
  'order_number_full',
  'order_number_short',
  'customer_email',
  'created_at',
  'updated_at',
  'processed_at',
  'raw_summary_json',
] as const;

/** Get Order List 响应字段（按返回名建列，不做自定义重命名） */
export const ORDER_INDEX_EXTRA_COLUMNS = [
  'id',
  'number',
  'additional_prices',
  'additional_total',
  'billing_address',
  'buyer_accepts_marketing',
  'checkout_url',
  'code_discount_total',
  'config',
  'currency',
  'customer',
  'customer_note',
  'discount_applications',
  'duty_total',
  'email_status',
  'financial_status',
  'fulfillment_status',
  'gift_card_total',
  'line_items',
  'location_line',
  'payment_line',
  'payment_lines',
  'payment_method',
  'placed_at',
  'primary_market_price',
  'recovery_status',
  'refer_info',
  'sales_platform',
  'shipping_address',
  'shipping_line',
  'shipping_tax_total',
  'status',
  'sub_total',
  'tags',
  'total_discount',
  'total_paid',
  'total_price',
  'total_refund_price',
  'total_shipping',
  'total_tax',
  'total_tip_received',
  'logistics_code',
] as const;

export type OrderIndexExtraColumn = (typeof ORDER_INDEX_EXTRA_COLUMNS)[number];
export type OrderIndexPayload = Record<OrderIndexExtraColumn, string>;

export function orderIndexSelectListSql(): string {
  return [...ORDER_INDEX_CORE_COLUMNS, ...ORDER_INDEX_EXTRA_COLUMNS].join(', ');
}

function toColumnText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/** 订单对象 -> API 字段列（字段名 1:1） */
export function fillOrderIndexPayload(order: Record<string, unknown>): OrderIndexPayload {
  const payload: Record<string, string> = Object.fromEntries(
    ORDER_INDEX_EXTRA_COLUMNS.map((k) => [k, '']),
  );
  for (const key of ORDER_INDEX_EXTRA_COLUMNS) {
    payload[key] = toColumnText(order[key]);
  }
  return payload as OrderIndexPayload;
}

function parseMaybeJson(s: string): unknown {
  const t = s.trim();
  if (!t) return '';
  if (!(t.startsWith('{') || t.startsWith('['))) return t;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** 索引行 -> 订单对象（供 normalizedOrderFromApi / extractSortTimestamp 使用） */
export function orderRecordFromIndexRow(row: Record<string, unknown>): Record<string, unknown> | null {
  const id = String(row.id ?? row.order_id ?? '').trim();
  if (!id) return null;
  // 兼容历史整单 JSON
  const legacyRaw = row.raw_summary_json;
  if (typeof legacyRaw === 'string' && legacyRaw.trim()) {
    try {
      const parsed = JSON.parse(legacyRaw);
      if (parsed && typeof parsed === 'object') {
        const pid = String((parsed as Record<string, unknown>).id ?? '').trim();
        if (!pid && id) (parsed as Record<string, unknown>).id = id;
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fallback 到分列还原 */
    }
  }
  const obj: Record<string, unknown> = {
    id,
    number: String(row.number ?? row.order_number_full ?? row.order_number_short ?? '').trim(),
    created_at: String(row.created_at ?? '').trim(),
    updated_at: String(row.updated_at ?? '').trim(),
    processed_at: String(row.processed_at ?? '').trim(),
  };
  for (const key of ORDER_INDEX_EXTRA_COLUMNS) {
    const raw = row[key];
    if (typeof raw !== 'string') continue;
    if (!raw.trim()) continue;
    obj[key] = parseMaybeJson(raw);
  }
  // 兜底：供 extractOrderEmail 使用
  if (!obj.email && typeof row.customer_email === 'string' && row.customer_email.trim()) {
    obj.email = row.customer_email.trim();
  }
  // 兼容旧逻辑读取 order_number
  if (!obj.order_number) {
    obj.order_number = String(obj.number ?? row.order_number_full ?? '').trim();
  }
  return obj;
}
