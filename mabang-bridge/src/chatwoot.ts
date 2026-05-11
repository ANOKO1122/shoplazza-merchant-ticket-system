/**
 * Chatwoot API：获取联系人详情、更新联系人自定义属性（店匠订单信息）
 * 以及列出/创建联系人自定义属性定义（定义存在后，侧边栏才会显示已写入的值）
 */
import fetch from 'node-fetch';

export interface ChatwootContactPayload {
  id: number;
  name?: string;
  email?: string;
  phone_number?: string;
  identifier?: string;
  custom_attributes?: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

export interface ChatwootContactResponse {
  payload: ChatwootContactPayload;
}

/** 自定义属性定义（联系人侧边栏要显示某 key，必须先存在对应定义） */
export interface CustomAttributeDefinition {
  id: number;
  attribute_key: string;
  attribute_display_name?: string;
  attribute_display_type?: number;
  attribute_model?: number;
  [key: string]: unknown;
}

const CONTACT_ATTRIBUTE_MODEL = 1; // 0=会话 1=联系人

/** 构建 Chatwoot API 请求头（同时带 api_access_token 与 Authorization，避免反向代理丢弃下划线头） */
function chatwootHeaders(apiToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    api_access_token: apiToken,
    Authorization: `Bearer ${apiToken}`,
  };
}

/**
 * 列出账户下联系人的自定义属性定义（无定义则侧边栏不显示该 key 的值）
 */
export async function listContactAttributeDefinitions(
  baseUrl: string,
  accountId: number,
  apiToken: string,
): Promise<CustomAttributeDefinition[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/custom_attribute_definitions?attribute_model=${CONTACT_ATTRIBUTE_MODEL}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: chatwootHeaders(apiToken),
  });
  if (!res.ok) return [];
  const raw = await res.json();
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.payload)
      ? raw.payload
      : Array.isArray(raw.data)
        ? raw.data
        : [];
  return list;
}

/**
 * 创建一条联系人自定义属性定义（用于在侧边栏显示该 key）
 * attribute_display_type: 0=text 1=number 2=currency 4=link 5=date 7=checkbox
 */
export async function createContactAttributeDefinition(
  baseUrl: string,
  accountId: number,
  apiToken: string,
  params: {
    attribute_key: string;
    attribute_display_name: string;
    attribute_display_type: number;
    attribute_description?: string;
  },
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/custom_attribute_definitions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: chatwootHeaders(apiToken),
    body: JSON.stringify({
      attribute_model: CONTACT_ATTRIBUTE_MODEL,
      attribute_key: params.attribute_key,
      attribute_display_name: params.attribute_display_name,
      attribute_display_type: params.attribute_display_type,
      attribute_description: params.attribute_description ?? '',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn('[chatwoot] create attribute definition failed', params.attribute_key, res.status, body.slice(0, 300));
  }
  return res.ok;
}

/**
 * 更新已存在的联系人自定义属性定义（修正展示名等）
 */
export async function patchContactAttributeDefinition(
  baseUrl: string,
  accountId: number,
  definitionId: number,
  apiToken: string,
  body: { attribute_display_name?: string; attribute_description?: string },
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/custom_attribute_definitions/${definitionId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: chatwootHeaders(apiToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn('[chatwoot] patch attribute definition failed', definitionId, res.status, text.slice(0, 300));
  }
  return res.ok;
}

/**
 * 联系人自定义属性：键名与店匠 Order 资源 JSON 字段一致（OpenAPI 2025-06），便于对照官方文档。
 * 例外：`shoplazza_order_lookup` 为客户手写查询串；`matching_orders_count` 为命中条数；
 * `myshoplaza_subdomain` / `shoplazza_sync_note` 为桥接元数据。
 * @see https://www.shoplazza.dev/reference/order-list-v2025-06
 */
export const SHOPLAZZA_CONTACT_ATTRIBUTES: Array<{
  attribute_key: string;
  attribute_display_name: string;
  attribute_display_type: number;
}> = [
  {
    attribute_key: 'shoplazza_order_lookup',
    attribute_display_name: '订单邮箱/订单号',
    attribute_display_type: 0,
  },
  { attribute_key: 'matching_orders_count', attribute_display_name: '匹配订单数（多店合并）', attribute_display_type: 1 },
  { attribute_key: 'id', attribute_display_name: '最近一单订单 id', attribute_display_type: 0 },
  { attribute_key: 'name', attribute_display_name: 'name（订单名称）', attribute_display_type: 0 },
  { attribute_key: 'order_number', attribute_display_name: 'order_number', attribute_display_type: 0 },
  { attribute_key: 'email', attribute_display_name: '订单 email', attribute_display_type: 0 },
  { attribute_key: 'created_at', attribute_display_name: 'created_at', attribute_display_type: 0 },
  { attribute_key: 'updated_at', attribute_display_name: 'updated_at', attribute_display_type: 0 },
  { attribute_key: 'processed_at', attribute_display_name: 'processed_at', attribute_display_type: 0 },
  { attribute_key: 'cancelled_at', attribute_display_name: 'cancelled_at', attribute_display_type: 0 },
  { attribute_key: 'total_price', attribute_display_name: 'total_price', attribute_display_type: 0 },
  { attribute_key: 'sub_total', attribute_display_name: 'sub_total', attribute_display_type: 0 },
  { attribute_key: 'total_tax', attribute_display_name: 'total_tax', attribute_display_type: 0 },
  { attribute_key: 'total_shipping', attribute_display_name: 'total_shipping', attribute_display_type: 0 },
  { attribute_key: 'total_discount', attribute_display_name: 'total_discount', attribute_display_type: 0 },
  { attribute_key: 'currency', attribute_display_name: 'currency', attribute_display_type: 0 },
  { attribute_key: 'financial_status', attribute_display_name: 'financial_status', attribute_display_type: 0 },
  { attribute_key: 'payment_method', attribute_display_name: 'Payment method', attribute_display_type: 0 },
  { attribute_key: 'fulfillment_status', attribute_display_name: 'fulfillment_status', attribute_display_type: 0 },
  { attribute_key: 'tracking_numbers', attribute_display_name: '物流单号', attribute_display_type: 0 },
  { attribute_key: 'customer_note', attribute_display_name: 'customer_note', attribute_display_type: 0 },
  { attribute_key: 'shop_last_store', attribute_display_name: '最近订单店铺', attribute_display_type: 0 },
  { attribute_key: 'myshoplaza_subdomain', attribute_display_name: '店铺子域（桥接）', attribute_display_type: 0 },
  { attribute_key: 'shoplazza_recent_orders', attribute_display_name: '近30天订单列表（按邮箱）', attribute_display_type: 0 },
  { attribute_key: 'shoplazza_sync_note', attribute_display_name: '桥接同步备注', attribute_display_type: 0 },
];

/**
 * Chatwoot 不允许这些 key 作为「联系人自定义属性定义」（与内置字段冲突，POST 会 422）
 * 桥接仍可在 sync 时把同名键写入 custom_attributes，但不在此创建/更新定义
 */
const SKIP_CONTACT_ATTRIBUTE_DEFINITION_KEYS = new Set(['name', 'email', 'created_at']);

/**
 * 确保联系人自定义属性定义存在（缺少则创建），这样写入的值才会在侧边栏显示
 */
export async function ensureContactAttributeDefinitions(
  baseUrl: string,
  accountId: number,
  apiToken: string,
): Promise<void> {
  const existing = await listContactAttributeDefinitions(baseUrl, accountId, apiToken);
  const existingByKey = new Map<string, CustomAttributeDefinition>(
    existing.map((a) => {
      const k = (a.attribute_key ?? (a as any).key) ?? '';
      return [k, a];
    }),
  );
  if (existing.length === 0 && SHOPLAZZA_CONTACT_ATTRIBUTES.length > 0) {
    console.log('[chatwoot] no existing contact attribute definitions, will try to create', SHOPLAZZA_CONTACT_ATTRIBUTES.length);
  } else if (existing.length > 0) {
    console.log('[chatwoot] found', existing.length, 'contact attribute definitions');
  }
  for (const def of SHOPLAZZA_CONTACT_ATTRIBUTES) {
    if (SKIP_CONTACT_ATTRIBUTE_DEFINITION_KEYS.has(def.attribute_key)) {
      continue;
    }
    const row = existingByKey.get(def.attribute_key);
    if (row && row.id) {
      const cur = (row.attribute_display_name ?? '').trim();
      if (cur !== def.attribute_display_name) {
        const ok = await patchContactAttributeDefinition(baseUrl, accountId, row.id, apiToken, {
          attribute_display_name: def.attribute_display_name,
          attribute_description: `店匠桥接：${def.attribute_display_name}`,
        });
        if (ok) {
          console.log('[chatwoot] updated contact attribute display name:', def.attribute_key, '->', def.attribute_display_name);
        }
      }
      continue;
    }
    const ok = await createContactAttributeDefinition(baseUrl, accountId, apiToken, {
      ...def,
      attribute_description: `店匠桥接自动创建：${def.attribute_display_name}`,
    });
    if (ok) {
      console.log('[chatwoot] created contact attribute definition:', def.attribute_key);
    } else {
      console.warn('[chatwoot] failed to create contact attribute definition:', def.attribute_key);
    }
  }
}

/**
 * 获取联系人详情（含 email）
 */
export async function getContact(
  baseUrl: string,
  accountId: number,
  contactId: number,
  apiToken: string,
): Promise<ChatwootContactPayload | null> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/contacts/${contactId}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: chatwootHeaders(apiToken),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  return json.payload ?? null;
}

/**
 * 更新联系人自定义属性（店匠订单数量、最近订单号等）
 */
export async function updateContactCustomAttributes(
  baseUrl: string,
  accountId: number,
  contactId: number,
  apiToken: string,
  customAttributes: Record<string, string | number | boolean>,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/contacts/${contactId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: chatwootHeaders(apiToken),
    body: JSON.stringify({ custom_attributes: customAttributes }),
  });
  if (res.status !== 200 && res.status !== 204) {
    const body = await res.text();
    console.warn('[chatwoot] update contact custom_attributes failed', contactId, res.status, body.slice(0, 400));
  }
  return res.status === 200 || res.status === 204;
}

/**
 * 更新联系人主邮箱（店匠订单邮箱与对话邮箱不一致时，同步成功后覆盖）
 */
export async function updateContactPrimaryEmail(
  baseUrl: string,
  accountId: number,
  contactId: number,
  apiToken: string,
  email: string,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/contacts/${contactId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: chatwootHeaders(apiToken),
    body: JSON.stringify({ email: email.trim() }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn('[chatwoot] update contact email failed', contactId, res.status, body.slice(0, 200));
  }
  return res.status === 200 || res.status === 204;
}

/**
 * 拉取联系人关联会话列表（用于"同联系人重复邮件线程"收敛）。
 */
export async function listContactConversations(
  baseUrl: string,
  accountId: number,
  contactId: number,
  apiToken: string,
): Promise<Record<string, unknown>[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/contacts/${contactId}/conversations`;
  const res = await fetch(url, {
    method: 'GET',
    headers: chatwootHeaders(apiToken),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn('[chatwoot] list contact conversations failed', contactId, res.status, body.slice(0, 240));
    return [];
  }
  const raw = await res.json();
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.payload)
      ? raw.payload
      : Array.isArray(raw.data)
        ? raw.data
        : [];
  return list.filter((r: any) => !!r && typeof r === 'object');
}

/**
 * 修改会话状态（open/pending/resolved/snoozed）。
 */
export async function setConversationStatus(
  baseUrl: string,
  accountId: number,
  conversationId: number,
  apiToken: string,
  status: 'open' | 'pending' | 'resolved' | 'snoozed',
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`;
  const res = await fetch(url, {
    method: 'POST',
    headers: chatwootHeaders(apiToken),
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn('[chatwoot] set conversation status failed', conversationId, res.status, body.slice(0, 240));
  }
  return res.ok;
}

/**
 * 在会话中写入 private note（仅客服可见）。
 */
export async function createConversationPrivateNote(
  baseUrl: string,
  accountId: number,
  conversationId: number,
  apiToken: string,
  content: string,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: chatwootHeaders(apiToken),
    body: JSON.stringify({
      content: content.trim(),
      private: true,
      message_type: 'outgoing',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn('[chatwoot] create private note failed', conversationId, res.status, body.slice(0, 240));
  }
  return res.ok;
}

function normalizeConversationLabelTitles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => {
      if (typeof l === 'string') return l.trim();
      if (l && typeof l === 'object' && 'title' in l) {
        return String((l as any).title).trim();
      }
      return '';
    })
    .filter(Boolean);
}

/**
 * 读取会话当前标签标题（用于合并写入，避免 POST /labels 覆盖丢失）
 */
export async function getConversationLabelTitles(
  baseUrl: string,
  accountId: number,
  conversationId: number,
  apiToken: string,
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/conversations/${conversationId}`;
  const res = await fetch(url, { headers: chatwootHeaders(apiToken) });
  if (!res.ok) return [];
  const json = (await res.json()) as any;
  return normalizeConversationLabelTitles(json.labels);
}

/**
 * 合并追加标签（会先 GET 现有标签再 POST 全量列表）
 */
export async function mergeConversationLabels(
  baseUrl: string,
  accountId: number,
  conversationId: number,
  apiToken: string,
  addTitles: string[],
): Promise<boolean> {
  const existing = await getConversationLabelTitles(baseUrl, accountId, conversationId, apiToken);
  const merged = [...new Set([...existing, ...addTitles.map((t) => t.trim()).filter(Boolean)])];
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`;
  const res = await fetch(url, {
    method: 'POST',
    headers: chatwootHeaders(apiToken),
    body: JSON.stringify({ labels: merged }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.warn('[chatwoot] merge conversation labels failed', conversationId, res.status, t.slice(0, 400));
  }
  return res.ok;
}

/**
 * 聚合会话标题/最近消息正文，用于从邮件主题（如 Re: 2317789-XXX）中解析店匠订单号，补全「仅邮箱对不上」的匹配。
 */
export async function getConversationTextForOrderHints(
  baseUrl: string,
  accountId: number,
  conversationId: number,
  apiToken: string,
): Promise<string> {
  const root = baseUrl.replace(/\/$/, '');
  const parts: string[] = [];
  const pushObjStrings = (o: unknown) => {
    if (o === null || o === undefined) return;
    if (typeof o === 'string') {
      parts.push(o);
      return;
    }
    if (typeof o === 'object' && !Array.isArray(o)) {
      for (const v of Object.values(o)) {
        if (typeof v === 'string') parts.push(v);
      }
    }
  };
  try {
    const convUrl = `${root}/api/v1/accounts/${accountId}/conversations/${conversationId}`;
    const res = await fetch(convUrl, { headers: chatwootHeaders(apiToken) });
    if (res.ok) {
      const json = (await res.json()) as any;
      const payload = (json.payload ?? json);
      const meta = (json.meta ?? payload.meta);
      if (meta && typeof meta === 'object') {
        for (const k of ['sender', 'assignee', 'channel']) {
          const x = meta[k];
          if (x && typeof x === 'object') pushObjStrings(x.name);
        }
      }
      if (payload && typeof payload === 'object') {
        const c = payload;
        if (typeof c.additional_attributes === 'object') {
          parts.push(JSON.stringify(c.additional_attributes));
        }
        const msgs = c.messages;
        if (Array.isArray(msgs)) {
          for (const m of msgs.slice(0, 25)) {
            if (m && typeof m === 'object') {
              const mo = m as any;
              if (typeof mo.content === 'string') parts.push(mo.content);
              if (typeof mo.subject === 'string') parts.push(mo.subject);
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }
  try {
    const msgUrl = `${root}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages?limit=20`;
    const res2 = await fetch(msgUrl, { headers: chatwootHeaders(apiToken) });
    if (res2.ok) {
      const json2 = (await res2.json()) as any;
      const arr = Array.isArray(json2)
        ? json2
        : Array.isArray(json2.payload)
          ? json2.payload
          : [];
      for (const m of arr) {
        if (m && typeof m === 'object') {
          const mo = m as any;
          if (typeof mo.content === 'string') parts.push(mo.content);
          if (typeof mo.subject === 'string') parts.push(mo.subject);
        }
      }
    }
  } catch {
    // ignore
  }
  return parts.join('\n');
}

export async function getConversationContactId(
  baseUrl: string,
  accountId: number,
  conversationId: number,
  apiToken: string,
): Promise<number | null> {
  const root = baseUrl.replace(/\/$/, '');
  const urls = [
    `${root}/api/v1/accounts/${accountId}/conversations/${conversationId}`,
    `${root}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages?before=${Date.now()}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: chatwootHeaders(apiToken),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as any;
      const cid =
        Number(json.meta?.contact?.id) ||
        Number(json.meta?.sender?.id) ||
        Number(json.conversation?.contact_id) ||
        Number(json.conversation?.contact?.id) ||
        Number(json.payload?.[0]?.sender?.id) ||
        Number(json.contact_id) ||
        0;
      if (cid > 0) return cid;
    } catch (_) {
      // ignore and try next endpoint
    }
  }
  return null;
}
