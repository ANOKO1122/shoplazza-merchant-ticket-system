import { cloneElement, useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import type { ClaimReason, ClaimStatus, ProtectionItem, ProtectionOrder, ProtectionStore } from '../../src/protection-types';
import { ApiError, dateTime, money, safeUrl } from './api';
export const statusLabels: Record<ClaimStatus, string> = { submitted: '待审核', reviewing: '审核中', needs_info: '待补充资料', approved: '审核通过', rejected: '已拒绝', closed: '外部已处理' };
export const reasonLabels: Record<ClaimReason, string> = { lost: '包裹丢失', damaged: '商品损坏', stolen: '包裹被盗', delayed: '配送延误', other: '其他问题' };
const orderLabels: Record<string, string> = { completed: '已完成', removed: '已移除', paid: '已付款', pending: '待处理', unpaid: '未付款', refunded: '已退款', partially_refunded: '部分退款', fulfilled: '已发货', unfulfilled: '未发货', partially_fulfilled: '部分发货', partial: '部分完成', open: '进行中', closed: '已关闭', cancelled: '已取消', canceled: '已取消', none: '无', unknown: '待确认', disabled: '未启用', not_ready: '待就绪', pending_verification: '待验证', awaiting_shipment: '等待普通商品发货', no_protection_lines: '暂无保障商品', ready: '已就绪', not_enabled: '未启用' };
export function displayStatus(value: string | null | undefined) { return value ? (orderLabels[value] || value) : '待确认'; }
export function Badge({ status, children }: { status?: string; children?: ReactNode }) { return <span className={`p-badge p-badge-${status || 'neutral'}`}>{children ?? statusLabels[status as ClaimStatus] ?? displayStatus(status)}</span>; }
export function ErrorNotice({ error, onRetry }: { error: ApiError | Error | string | null; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="p-notice p-error" role="alert"><span>{typeof error === 'string' ? error : error.message}</span>{error instanceof ApiError && error.status === 401 ? <a href="/thinkpro-admin/login" target="_blank" rel="noopener noreferrer">重新登录</a> : onRetry && <button className="p-link" onClick={onRetry}>重新加载</button>}</div>;
}
export function Empty({ title = '暂无记录', children }: { title?: string; children?: ReactNode }) { return <div className="p-empty"><strong>{title}</strong><p>{children || '当前筛选条件下没有数据，可调整条件后重试。'}</p></div>; }
export function Loading() { return <div className="p-loading" role="status"><span className="p-spinner" />正在加载数据…</div>; }
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) { return <section className="p-section"><div className="p-section-title"><h2>{title}</h2>{action}</div>{children}</section>; }
export function Field({ label, children }: { label: string; children: ReactElement<{ id?: string; 'aria-labelledby'?: string }> }) {
  const controlId = useId();
  const labelId = `${controlId}-label`;
  return <label className="p-field" htmlFor={controlId}><span id={labelId}>{label}</span>{cloneElement(children, { id: controlId, 'aria-labelledby': labelId })}</label>;
}
export function Info({ label, children }: { label: string; children: ReactNode }) { return <div className="p-info"><dt>{label}</dt><dd>{children || '—'}</dd></div>; }
export interface Filters { q: string; store: string; from: string; to: string; status: string; reason: string }
export const initialFilters: Filters = { q: '', store: '', from: '', to: '', status: '', reason: '' };
export function FilterBar({ value, onChange, stores, mode, onApply }: { value: Filters; onChange: (next: Filters) => void; stores: ProtectionStore[]; mode: 'stats' | 'orders' | 'claims'; onApply: () => void }) {
  const set = (key: keyof Filters, next: string) => onChange({ ...value, [key]: next });
  return <form className="p-filters" onSubmit={event => { event.preventDefault(); onApply(); }}>
    {mode !== 'stats' && <Field label={mode === 'claims' ? '申诉 / 订单 / 客户' : '保障 / 订单 / 客户'}><input placeholder="编号、姓名或邮箱" value={value.q} onChange={event => set('q', event.target.value)} /></Field>}
    <Field label="店铺"><select value={value.store} onChange={event => set('store', event.target.value)}><option value="">全部店铺</option>{stores.map(store => <option key={store.id} value={store.subdomain}>{store.subdomain}</option>)}</select></Field>
    <Field label="开始日期"><input type="date" value={value.from} max={value.to || undefined} onChange={event => set('from', event.target.value)} /></Field>
    <Field label="结束日期"><input type="date" value={value.to} min={value.from || undefined} onChange={event => set('to', event.target.value)} /></Field>
    {mode === 'claims' && <><Field label="审核状态"><select value={value.status} onChange={event => set('status', event.target.value)}><option value="">全部状态</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field label="申诉原因"><select value={value.reason} onChange={event => set('reason', event.target.value)}><option value="">全部原因</option>{Object.entries(reasonLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field></>}
    <button className="p-button p-primary" type="submit">查询</button>
    <button className="p-button" type="button" onClick={() => onChange(initialFilters)}>清空条件</button>
  </form>;
}
export function Pagination({ total, page, size = 20, loading, onChange }: { total: number; page: number; size?: number; loading?: boolean; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return <div className="p-pagination"><span>共 {total.toLocaleString()} 条</span><div><button className="p-button" disabled={loading || page <= 1} onClick={() => onChange(page - 1)}>上一页</button><span>第 {page} / {pages} 页</span><button className="p-button" disabled={loading || page >= pages} onClick={() => onChange(page + 1)}>下一页</button></div></div>;
}
export function ItemList({ items, currency, selected }: { items: ProtectionItem[]; currency: string; selected?: string[] }) {
  return <ul className="p-items">{items.map(item => <li key={item.id}>{safeUrl(item.image_url) && <img src={safeUrl(item.image_url)} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none'; }} />}<div><strong>{item.title || '未命名商品'}</strong><small>数量 {item.quantity}{item.is_protection ? ' · 保障服务' : ''}{selected?.includes(item.id) ? ' · 本次申诉商品' : ''}</small></div><span>{money(item.amount_cents, currency)}</span></li>)}</ul>;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function textValue(...values: unknown[]): string { const value = values.find(item => typeof item === 'string' && item); return typeof value === 'string' ? value : ''; }
export function OrderContext({ order }: { order: ProtectionOrder }) {
  const address = record(order.shipping_address);
  const logistics = record(order.logistics);
  const shipments = Array.isArray(order.logistics) ? order.logistics : Array.isArray(logistics.shipments) ? logistics.shipments : Object.keys(logistics).length ? [logistics] : [];
  const addressText = [address.first_name, address.last_name, address.name, address.address1, address.address2, address.address, address.city, address.province, address.country, address.zip, address.phone].filter(value => typeof value === 'string' && value).join(' ');
  return <>
    <Section title="订单与申请人"><dl className="p-info-grid"><Info label="订单编号">{order.order_number}</Info><Info label="店铺">{order.store_subdomain}</Info><Info label="申请人">{order.customer_name || '未提供姓名'}</Info><Info label="邮箱">{order.customer_email}</Info><Info label="订单金额">{money(order.order_amount_cents, order.currency)}</Info><Info label="保障费">{money(order.protection_fee_cents, order.currency)}</Info><Info label="保障商品金额">{money(order.protected_value_cents, order.currency)}</Info><Info label="已退款金额">{money(order.refund_amount_cents, order.currency)}</Info><Info label="付款 / 退款">{displayStatus(order.payment_status)} / {displayStatus(order.refund_status)}</Info><Info label="订单 / 发货">{displayStatus(order.order_status)} / {displayStatus(order.fulfillment_status)}</Info><Info label="保障商品履约">{displayStatus(order.service_fulfillment_status)}</Info><Info label="付款时间">{dateTime(order.paid_at)}</Info><Info label="订单同步时间">{dateTime(order.synced_at)}</Info></dl>{addressText && <p className="p-address"><span>收货地址</span>{addressText}</p>}</Section>
    <Section title="物流信息">{shipments.length ? <ul className="p-logistics">{shipments.map((shipment, index) => {
      const item = record(shipment);
      const tracking = textValue(item.tracking_number, item.tracking_no, item.number) || (Array.isArray(item.tracking_numbers) ? item.tracking_numbers.filter(v => typeof v === 'string').join('、') : '暂无运单号');
      const href = safeUrl(item.tracking_url || item.url);
      return <li key={index}><strong>{textValue(item.tracking_company, item.carrier, item.company) || `包裹 ${index + 1}`}</strong><span>{tracking}</span>{href && <a href={href} target="_blank" rel="noopener noreferrer">查看物流</a>}</li>;
    })}</ul> : <p className="p-muted">尚未同步到物流信息。</p>}</Section>
  </>;
}

export function useDetailFocus() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 1250px)').matches) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);
  return ref;
}
