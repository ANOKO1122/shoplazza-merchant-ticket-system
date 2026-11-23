import { useRef, useState } from 'react';
import { protectionOrderStageLabels, type ClaimReason, type ProtectionClaim, type ProtectionList, type ProtectionOrder, type ProtectionOrderListItem, type ProtectionStore } from '../../src/protection-types';
import { API, ApiError, centsFromInput, dateTime, money, query, request, useResource } from './api';
import { Badge, DetailDialog, Empty, ErrorNotice, Field, FilterBar, Info, initialFilters, ItemList, Loading, OrderContext, Pagination, reasonLabels, Section } from './shared';
import { CustomerAccessLink } from './CustomerSubmission';
export function Orders({ stores, selectedOrder, onClaim }: { stores: ProtectionStore[]; selectedOrder?: string | null; onClaim: (id: string) => void }) {
  const [draft, setDraft] = useState(initialFilters);
  const [filters, setFilters] = useState(initialFilters);
  const [stage, setStage] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(selectedOrder || null);
  const [refresh, setRefresh] = useState(0);
  const params = query({ q: filters.q, store: filters.store, from: filters.from, to: filters.to, status: stage });
  const resource = useResource<ProtectionList<ProtectionOrderListItem>>(`/orders?${params}&page=${page}&page_size=20`, refresh, true);
  return <><FilterBar value={draft} onChange={setDraft} mode="orders" stores={stores} onApply={() => { setFilters(draft); setPage(1); setSelected(null); }} />
    <div className="p-workspace"><section className="p-list-pane"><div className="p-section-title"><h2>保障订单</h2><a className="p-button" href={`${API}/orders/export?${params}`}>导出 CSV</a></div>
      <div className="p-tabs" role="group" aria-label="订单状态">
        {Object.entries({ '': '全部', ...protectionOrderStageLabels }).map(([key, label]) =>
          <button key={key} type="button" className={stage === key ? 'p-tab p-tab-active' : 'p-tab'} aria-pressed={stage === key}
            onClick={() => { setStage(key); setPage(1); setSelected(null); }}>{label}</button>)}
      </div>
      <ErrorNotice error={resource.error} onRetry={resource.reload} />
      {resource.loading && !resource.data ? <Loading /> : resource.data?.items.length ? <div className="p-table-wrap"><table className="p-table">
        <thead><tr><th>保障 / 订单</th><th>订单状态</th><th>订单来源 / 客户</th><th>保障费</th><th>保障商品金额</th><th>申诉</th><th>付款时间</th></tr></thead>
        <tbody>{resource.data.items.map(order => <tr key={order.id} className={selected === order.id ? 'p-selected' : ''}>
          <td><button className="p-link p-strong" onClick={() => setSelected(order.id)}>{order.public_no}</button><small>{order.order_number}</small></td>
          <td><Badge status={order.order_stage}>{protectionOrderStageLabels[order.order_stage]}</Badge></td>
          <td>{order.store_subdomain}<small>{order.customer_email || order.customer_name || '未提供客户信息'}</small></td>
          <td>{money(order.protection_fee_cents, order.currency)}</td><td>{money(order.protected_value_cents, order.currency)}</td>
          <td>{order.claim_count}</td><td>{dateTime(order.paid_at)}</td>
        </tr>)}</tbody></table></div> : !resource.error && <Empty title="暂无保障订单" />}
      <Pagination total={resource.data?.total || 0} page={page} loading={resource.loading} onChange={setPage} />
    </section></div>{selected && <OrderDetail key={selected} id={selected} onClose={() => setSelected(null)} onClaim={onClaim} onChanged={() => setRefresh(value => value + 1)} />}
  </>;
}
export function OrderDetail({ id, onClose, onClaim, onChanged }: { id: string; onClose: () => void; onClaim: (id: string) => void; onChanged: () => void }) {
  const resource = useResource<{ order: ProtectionOrder; claims: ProtectionClaim[] }>(`/orders/${encodeURIComponent(id)}`);
  const [creating, setCreating] = useState(false);
  const data = resource.data;
  return <DetailDialog label="保障订单详情" onClose={onClose}><div className="p-detail-heading"><div><h2>{data?.order.public_no || '保障订单详情'}</h2><p className="p-muted">固定保障编号 · 可包含多次申诉</p></div><button className="p-button" onClick={onClose}>关闭详情</button></div><ErrorNotice error={resource.error} onRetry={resource.reload} />{resource.loading ? <Loading /> : data && <>
    <div className="p-detail-body"><CustomerAccessLink orderId={data.order.id} /><OrderContext order={data.order} /><Section title="订单商品"><ItemList items={data.order.items} currency={data.order.currency} /></Section>
    <Section title="历次申诉" action={!creating && <button className="p-button p-primary" onClick={() => setCreating(true)}>登记新申诉</button>}>
      <p className="p-muted p-space-after">每次申诉独立编号；拒绝后，在申请时限和剩余额度允许时可重新提交，保障编号保持不变。</p>{data.claims.length ? <ul className="p-related">{data.claims.map(claim => <li key={claim.id}><div><button className="p-link p-strong" onClick={() => onClaim(claim.id)}>{claim.public_no}</button><small>{reasonLabels[claim.reason]} · {dateTime(claim.created_at)}</small></div><Badge status={claim.status} /></li>)}</ul> : <p className="p-muted">这笔保障尚无申诉记录。</p>}
    </Section>{creating && <CreateClaim order={data.order} claims={data.claims} onCancel={() => setCreating(false)} onCreated={claim => { onChanged(); onClaim(claim.id); }} />}</div>
  </>}</DetailDialog>;
}
function CreateClaim({ order, claims, onCancel, onCreated }: { order: ProtectionOrder; claims: ProtectionClaim[]; onCancel: () => void; onCreated: (claim: ProtectionClaim) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState<ClaimReason>('lost');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<Error | string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const blocked = new Set(claims.filter(claim => !['rejected', 'closed'].includes(claim.status)).flatMap(claim => claim.item_ids));
  const items = order.items.filter(item => !item.is_protection);
  const selectedItems = items.filter(item => selected.includes(item.id));
  const knownValue = selectedItems.every(item => item.amount_cents != null);
  const limit = knownValue ? selectedItems.reduce((sum, item) => sum + (item.amount_cents || 0), 0) : null;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    const cents = centsFromInput(amount);
    if (!selected.length) { setError('请至少选择一件普通商品。'); return; }
    if (cents == null || (limit != null && cents > limit)) { setError('申请金额须大于 0，最多两位小数，且不能超过所选商品金额。'); return; }
    if (!description.trim()) { setError('请填写问题说明，便于审核人员了解情况。'); return; }
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const data = await request<{ claim: ProtectionClaim }>('/claims', { method: 'POST', body: JSON.stringify({ protection_order_id: order.id, item_ids: selected, reason, description: description.trim(), requested_amount_cents: cents }) });
      onCreated(data.claim);
    } catch (error) { setError(error instanceof ApiError && error.status === 409 ? '所选商品已有进行中的申诉。当前填写内容已保留，请关闭详情并重新打开以确认最新记录。' : error as Error); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <Section title="客服代客户登记申诉"><form className="p-form" onSubmit={submit}><p className="p-muted">保障编号：{order.public_no}。此操作只创建审核申请。</p>
    <fieldset disabled={busy}><legend>选择申诉商品</legend><div className="p-item-options">{items.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={blocked.has(item.id)} onChange={event => setSelected(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} /><span>{item.title}<small>数量 {item.quantity} · {money(item.amount_cents, order.currency)}{blocked.has(item.id) ? ' · 已有进行中申诉' : ''}</small></span></label>)}</div></fieldset>
    {!items.length && <p className="p-notice">订单尚无可申诉的普通商品，请先确认订单同步结果。</p>}
    <Field label="申诉原因"><select value={reason} disabled={busy} onChange={event => setReason(event.target.value as ClaimReason)}>{Object.entries(reasonLabels).filter(([key]) => key !== 'other').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
    <Field label={`申请金额（${order.currency}）`}><input value={amount} disabled={busy} inputMode="decimal" placeholder="0.00" onChange={event => setAmount(event.target.value)} required /></Field><p className="p-muted">所选商品金额：{money(limit, order.currency)}。最终可申请金额由已有审批及退款情况校验。</p>
    <Field label="问题说明"><textarea value={description} disabled={busy} rows={4} maxLength={10000} onChange={event => setDescription(event.target.value)} placeholder="记录客户反馈、发生时间及已核实的信息" required /></Field>
    <ErrorNotice error={error} /><div className="p-actions"><button type="submit" className="p-button p-primary" disabled={busy || !selected.length}>{busy ? '正在提交…' : '提交审核申请'}</button><button type="button" className="p-button" disabled={busy} onClick={onCancel}>取消登记</button></div>
  </form></Section>;
}
