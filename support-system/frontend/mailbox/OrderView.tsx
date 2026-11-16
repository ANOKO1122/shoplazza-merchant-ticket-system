import { useEffect, useRef, useState } from 'react';
import type { ProtectionClaim, ProtectionOrder } from '../../src/protection-types';
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

export function OrderSummary({ order, onOpen, onTrack }: { order: ProtectionOrder; onOpen: () => void; onTrack: () => void }) {
  const numbers = trackingNumbers(order.logistics);
  return <div className="mb-order-card"><dl>
    <Row label="订单号">{order.order_number}</Row>
    <Row label="订单 ID">{order.order_id}</Row>
    <Row label="订单状态">{status(order.order_status)} · {status(order.fulfillment_status)}</Row>
    <Row label="付款时间">{date(order.paid_at)}</Row>
    <Row label="发货时间">{date(order.timeline?.shipped_at)}</Row>
    <Row label="付款状态">{status(order.payment_status)}</Row>
    <Row label="订单总额" emphasis>{money(order.order_amount_cents, order.currency)}</Row>
    <Row label="保障费">{money(order.protection_fee_cents, order.currency)}</Row>
    <Row label="已退款">{money(order.refund_amount_cents, order.currency)}</Row>
  </dl><div className="mb-order-actions"><button type="button" className="mb-button" onClick={onOpen}>查看订单详情</button>
    {numbers.length > 0 && <button type="button" className="mb-button" onClick={onTrack}>物流查询</button>}</div></div>;
}

function useDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return ref;
}

export function OrderDetailsDialog({ order, claims, onClose, onTrack }: {
  order: ProtectionOrder; claims: ProtectionClaim[]; onClose: () => void; onTrack: () => void;
}) {
  const dialog = useDialog();
  const address = record(order.shipping_address);
  const addressText = [address.address1, address.address2, address.city, address.province, address.zip, address.country]
    .filter(value => typeof value === 'string' && value.trim()).join(' ');
  const numbers = trackingNumbers(order.logistics);
  return <dialog ref={dialog} className="mb-dialog mb-order-dialog" aria-label="保障订单详情" onClose={onClose}>
    <header className="mb-dialog-header"><div><h2>{order.public_no}</h2><p>订单 {order.order_number}</p></div><button type="button" className="mb-button" onClick={() => dialog.current?.close()} aria-label="关闭订单详情">关闭</button></header>
    <div className="mb-dialog-content"><section><h3>订单信息</h3><dl className="mb-order-detail-grid">
      <Row label="订单 ID">{order.order_id}</Row><Row label="顾客">{order.customer_name || '暂无记录'}</Row>
      <Row label="顾客邮箱">{order.customer_email}</Row><Row label="订单状态">{status(order.order_status)} · {status(order.fulfillment_status)}</Row>
      <Row label="付款时间">{date(order.paid_at)}</Row><Row label="发货时间">{date(order.timeline?.shipped_at)}</Row>
      <Row label="订单总额">{money(order.order_amount_cents, order.currency)}</Row><Row label="保障费">{money(order.protection_fee_cents, order.currency)}</Row>
      <Row label="已退款">{money(order.refund_amount_cents, order.currency)}</Row><Row label="保障商品金额">{money(order.protected_value_cents, order.currency)}</Row>
    </dl>{addressText && <p className="mb-order-address"><strong>收货地址</strong><span>{addressText}</span></p>}</section>
    <section><h3>商品</h3>{order.items.length ? <ul className="mb-order-items">{order.items.map(item => <li key={item.id}>
      {item.image_url && /^https:\/\//i.test(item.image_url) && <img src={item.image_url} alt="" loading="lazy" />}
      <span><strong>{item.title || '未命名商品'}</strong><small>数量 {item.quantity}{item.is_protection ? ' · 保障服务' : ''}</small></span>
      <b>{money(item.amount_cents, order.currency)}</b></li>)}</ul> : <p className="mb-muted">暂无商品资料。</p>}</section>
    <section><h3>物流信息</h3>{numbers.length ? <><ul className="mb-order-tracking">{numbers.map(number => <li key={number}>{number}</li>)}</ul><button type="button" className="mb-button" onClick={onTrack}>使用 17TRACK 查询</button></> : <p className="mb-muted">暂无运单号。</p>}</section>
    <section><h3>赔付申请</h3>{claims.length ? <ul className="mb-order-claims">{claims.map(claim => <li key={claim.id}><strong>{claim.public_no}</strong><span>{status(claim.status)}</span></li>)}</ul> : <p className="mb-muted">暂无申请。</p>}</section></div>
  </dialog>;
}

export function TrackingDialog({ numbers, onClose }: { numbers: string[]; onClose: () => void }) {
  const dialog = useDialog();
  const [selected, setSelected] = useState(numbers[0]);
  const openedAt = useRef(Date.now());
  const url = trackingWidgetUrl(selected, openedAt.current);
  return <dialog ref={dialog} className="mb-dialog mb-tracking-dialog" aria-label="物流查询" onClose={onClose}>
    <header className="mb-dialog-header"><div><h2>物流查询</h2><p>由 17TRACK 提供物流轨迹</p></div><button type="button" className="mb-button" onClick={() => dialog.current?.close()} aria-label="关闭物流查询">关闭</button></header>
    <div className="mb-dialog-content"><label className="mb-tracking-select">运单号{numbers.length > 1 ? <select value={selected} onChange={event => setSelected(event.target.value)}>{numbers.map(number => <option key={number} value={number}>{number}</option>)}</select> : <strong>{selected}</strong>}</label>
      <iframe key={selected} title={`17TRACK ${selected}`} src={url} sandbox="allow-scripts allow-forms allow-popups allow-same-origin" referrerPolicy="no-referrer" />
      <p className="mb-muted">如查询组件未能加载，可<a href={url} target="_blank" rel="noopener noreferrer">在新标签页查看物流</a>。</p></div>
  </dialog>;
}
