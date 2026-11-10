import { useState } from 'react';
import type { ProtectionEmailRecord, ProtectionList, ProtectionStore } from '../../src/protection-types';
import { dateTime, query, useResource } from './api';
import { Empty, ErrorNotice, Field, Loading, Pagination, statusLabels } from './shared';

interface Filters { q: string; store: string; from: string; to: string; status: string; event_type: string }
const emptyFilters: Filters = { q: '', store: '', from: '', to: '', status: '', event_type: '' };
const eventLabels: Record<ProtectionEmailRecord['event_type'], string> = {
  shipment: '发货通知', completion: '订单完成通知', claim_update: '申请更新通知',
};
const errorLabels: Record<string, string> = {
  delivery_or_preparation_failed: '发送未成功，等待自动重试',
  manual_delivery_enabled: '已切换为手动发送',
  recipient_changed_or_invalid: '收件人已变更或邮箱无效',
  recipient_or_order_changed: '收件人或订单已变更',
  order_no_longer_eligible_for_event: '订单已不符合发送条件',
  'email_unsubscribed:protection': '收件人已退订运输保障邮件',
  unknown: '处理未完成，请查看服务日志',
};
function statusLabel(record: ProtectionEmailRecord) {
  if (record.status === 'sent') return '已发送';
  if (record.status === 'sending') return '发送中';
  if (record.status === 'cancelled') return '已取消';
  return record.attempts ? '待重试' : '待发送';
}
export function EmailRecords({ stores, onClaim }: { stores: ProtectionStore[]; onClaim: (id: string) => void }) {
  const [draft, setDraft] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const set = (key: keyof Filters, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const params = query({ ...applied, page, page_size: 20 });
  const resource = useResource<ProtectionList<ProtectionEmailRecord>>(`/emails?${params}`);
  return <>
    <form className="p-filters" onSubmit={event => { event.preventDefault(); setPage(1); setApplied({ ...draft }); }}>
      <Field label="订单 / 申请 / 邮箱"><input value={draft.q} maxLength={200} placeholder="编号或收件邮箱" onChange={event => set('q', event.target.value)} /></Field>
      <Field label="店铺"><select value={draft.store} onChange={event => set('store', event.target.value)}><option value="">全部店铺</option>{stores.map(store => <option key={store.id} value={store.subdomain}>{store.store_name || store.subdomain}</option>)}</select></Field>
      <Field label="通知类型"><select value={draft.event_type} onChange={event => set('event_type', event.target.value)}><option value="">全部类型</option>{Object.entries(eventLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
      <Field label="发送状态"><select value={draft.status} onChange={event => set('status', event.target.value)}><option value="">全部状态</option><option value="pending">待发送 / 待重试</option><option value="sending">发送中</option><option value="sent">已发送</option><option value="cancelled">已取消</option></select></Field>
      <Field label="创建开始"><input type="date" value={draft.from} max={draft.to || undefined} onChange={event => set('from', event.target.value)} /></Field>
      <Field label="创建结束"><input type="date" value={draft.to} min={draft.from || undefined} onChange={event => set('to', event.target.value)} /></Field>
      <button className="p-button p-primary" type="submit">查询</button>
      <button className="p-button" type="button" onClick={() => { setDraft(emptyFilters); setApplied(emptyFilters); setPage(1); }}>清空条件</button>
    </form>
    <section className="p-section p-email-records"><div className="p-section-title"><div><h2>运输保障邮件记录</h2><p className="p-muted">发货和订单完成通知自动发送；申请状态更新由客服手动发送。仅显示发送记录，不显示邮件正文或客户访问链接。</p></div><button className="p-button" onClick={resource.reload}>刷新</button></div>
      <ErrorNotice error={resource.error} onRetry={resource.reload} />
      {resource.loading && !resource.data ? <Loading /> : resource.data?.items.length ? <div className="p-table-wrap"><table className="p-table"><thead><tr><th>通知 / 关联申请</th><th>店铺 / 订单</th><th>收件人</th><th>状态</th><th>发送次数</th><th>创建 / 发送时间</th></tr></thead><tbody>{resource.data.items.map(record => <tr key={record.id}>
        <td><strong>{eventLabels[record.event_type]}</strong><small>{record.claim_id && record.claim_public_no ? <button className="p-link" onClick={() => onClaim(record.claim_id!)}>{record.claim_public_no}</button> : record.protection_public_no}{record.target_status && ` · ${statusLabels[record.target_status]}`}</small></td>
        <td>{record.store_name || record.store_subdomain}<small>{record.order_number} · {record.protection_public_no}</small></td>
        <td>{record.recipient_email}</td>
        <td><span className={`p-email-status p-email-status-${record.status}`}>{statusLabel(record)}</span>{record.last_error_code && <small>{errorLabels[record.last_error_code] || errorLabels.unknown}</small>}{record.status === 'pending' && record.attempts > 0 && <small>下次重试：{dateTime(record.next_attempt_at)}</small>}</td>
        <td>{record.attempts}</td><td>{dateTime(record.created_at)}<small>{record.status === 'sent' ? `发送：${dateTime(record.sent_at)}` : record.status === 'cancelled' ? `取消：${dateTime(record.updated_at)}` : '尚未发送'}</small></td>
      </tr>)}</tbody></table></div> : !resource.error && <Empty title="暂无邮件记录">当前筛选条件下没有运输保障邮件。可以调整条件后重试。</Empty>}
      <Pagination total={resource.data?.total || 0} page={page} loading={resource.loading} onChange={setPage} />
    </section>
  </>;
}
