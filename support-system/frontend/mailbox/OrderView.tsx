import { useRef, useState } from 'react';
import type { ProtectionOrder } from '../../src/protection-types';
import { trackingWidgetUrl } from '../customer-protection/tracking-widget';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function shipments(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : Array.isArray(record(value).shipments) ? record(value).shipments as unknown[] : [value];
  return rows.map(record).filter(row => Object.keys(row).length > 0 && !['cancelled', 'canceled'].includes(String(row.status || '').toLowerCase()));
}

export function trackingNumbers(value: unknown): string[] {
  const found: string[] = [];
  for (const shipment of shipments(value)) {
    const nested = Array.isArray(shipment.tracking_items) ? shipment.tracking_items.map(row => record(row).tracking_number) : [];
    const values = [shipment.tracking_number, ...(Array.isArray(shipment.tracking_numbers) ? shipment.tracking_numbers : []), ...nested];
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const number = value.trim();
      if (number && number.length <= 50 && !found.includes(number)) found.push(number);
    }
  }
  return found;
}

function money(cents: number | null, currency: string): string {
  return cents == null ? '暂无记录' : `${currency} ${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function date(value: string | null | undefined): string {
  if (!value) return '暂无记录';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '暂无记录' : parsed.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const statuses: Record<string, string> = {
  paid: '已付款', unpaid: '未付款', partially_refunded: '部分退款', refunded: '已退款',
  open: '进行中', closed: '已关闭', completed: '已完成', cancelled: '已取消',
  fulfilled: '已发货', unfulfilled: '未发货', partially_fulfilled: '部分发货', partial: '部分发货',
  submitted: '待审核', reviewing: '审核中', needs_info: '待补充资料', approved: '审核通过', rejected: '已拒绝',
};
const status = (value: string) => statuses[value] || value || '待确认';

function Row({ label, children, emphasis }: { label: string; children: React.ReactNode; emphasis?: boolean }) {
  return <div className={`mb-order-row${emphasis ? ' mb-order-emphasis' : ''}`}><dt>{label}</dt><dd>{children}</dd></div>;
}

export function OrderSummary({ order }: { order: ProtectionOrder }) {
  const numbers = trackingNumbers(order.logistics);
  return <><div className="mb-order-card"><dl>
    <Row label="订单号">{order.order_number}</Row>
    <Row label="订单 ID">{order.order_id}</Row>
    <Row label="订单状态">{status(order.order_status)} · {status(order.fulfillment_status)}</Row>
    <Row label="付款时间">{date(order.paid_at)}</Row>
    <Row label="发货时间">{date(order.timeline?.shipped_at)}</Row>
    <Row label="付款状态">{status(order.payment_status)}</Row>
    <Row label="订单总额" emphasis>{money(order.order_amount_cents, order.currency)}</Row>
    <Row label="保障费">{money(order.protection_fee_cents, order.currency)}</Row>
    <Row label="已退款">{money(order.refund_amount_cents, order.currency)}</Row>
  </dl></div>{numbers.length > 0 && <TrackingPanel key={order.id} numbers={numbers} />}</>;
}

export function TrackingPanel({ numbers }: { numbers: string[] }) {
  const [selected, setSelected] = useState(numbers[0]);
  const openedAt = useRef(Date.now());
  const current = numbers.includes(selected) ? selected : numbers[0];
  if (!current) return null;
  const url = trackingWidgetUrl(current, openedAt.current);
  return <section className="mb-tracking-panel" aria-label="物流信息"><h4>物流信息</h4>
    <label className="mb-tracking-select">运单号{numbers.length > 1
      ? <select value={current} onChange={event => setSelected(event.target.value)}>{numbers.map(number => <option key={number} value={number}>{number}</option>)}</select>
      : <strong>{current}</strong>}</label>
    <iframe key={current} title={`17TRACK ${current}`} src={url} sandbox="allow-scripts allow-forms allow-popups allow-same-origin" referrerPolicy="no-referrer" />
    <p className="mb-muted">如查询组件未能加载，可<a href={url} target="_blank" rel="noopener noreferrer">在新标签页查看物流</a>。</p>
  </section>;
}
