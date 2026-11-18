import { useState } from 'react';
import type { ProtectionStats, ProtectionStore } from '../../src/protection-types';
import { dateTime, money, query, useResource } from './api';
import { Empty, ErrorNotice, FilterBar, initialFilters, Loading, Section } from './shared';
const purchaseRate = new Intl.NumberFormat('zh-CN', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Overview({ stores, onClaims }: { stores: ProtectionStore[]; onClaims: () => void }) {
  const [draft, setDraft] = useState(initialFilters);
  const [filters, setFilters] = useState(initialFilters);
  const resource = useResource<ProtectionStats>('/stats?' + query({ store: filters.store, from: filters.from, to: filters.to }));
  const stats = resource.data;
  return <><FilterBar minDate={draft.store === filters.store ? stats?.first_protection_day || undefined : undefined} value={draft} onChange={setDraft} stores={stores} mode="stats" onApply={() => setFilters(draft)} /><ErrorNotice error={resource.error} onRetry={resource.reload} />{resource.loading ? <Loading /> : stats && <>
    <div className="p-overview-heading"><div><h2>保障业务概况</h2><p className="p-muted">各店从组件首次上线当天起统计。已支付订单按付款日期、申诉按创建日期统计（UTC），金额按币种独立汇总。</p></div><span className="p-muted">最近同步：{dateTime(stats.synced_at)}</span></div>
    <dl className="p-metrics"><div><dt>保障订单</dt><dd>{stats.protected_orders.toLocaleString()}</dd></div><div><dt>申诉总数</dt><dd>{stats.claims.toLocaleString()}</dd></div><div className="p-metric-action"><dt>待处理申诉</dt><dd><button onClick={onClaims}>{stats.pending_claims.toLocaleString()}<span>进入审核 →</span></button></dd></div><div><dt>审核通过</dt><dd>{stats.approved_claims.toLocaleString()}</dd></div><div><dt>已拒绝 / 外部已处理</dt><dd>{stats.rejected_claims.toLocaleString()} <span>/ {stats.closed_claims.toLocaleString()}</span></dd></div></dl>
    <Section title="金额汇总" action={<span className="p-muted">审核通过金额不代表实际打款</span>}>
      {stats.currencies.length ? <div className="p-table-wrap"><table className="p-table"><thead><tr><th>币种</th><th>保障费</th><th>保障商品金额</th><th>申请金额</th><th>审核通过金额</th></tr></thead><tbody>{stats.currencies.map(row => <tr key={row.currency}><td><strong>{row.currency}</strong>{row.unknown_orders > 0 && <small>{row.unknown_orders} 笔订单金额待核对</small>}</td><td>{money(row.protection_fee_cents, row.currency)}</td><td>{money(row.protected_value_cents, row.currency)}</td><td>{money(row.requested_amount_cents, row.currency)}</td><td>{money(row.approved_amount_cents, row.currency)}</td></tr>)}</tbody></table></div> : <Empty title="暂无金额数据">真实保障订单同步后将在这里按币种汇总。</Empty>}
    </Section>
    <div className="p-overview-grid"><Section title="店铺分布">{stats.by_store.length ? <div className="p-table-wrap"><table className="p-table"><thead><tr><th>店铺</th><th>已支付订单</th><th>其中保障订单</th><th>购买率</th><th>申诉</th><th>待处理</th></tr></thead><tbody>{stats.by_store.map(row => <tr key={row.store_subdomain}><td>{row.store_subdomain}</td><td>{row.paid_orders}</td><td>{row.orders}</td><td>{row.paid_orders ? purchaseRate.format(row.orders / row.paid_orders) : '—'}</td><td>{row.claims}</td><td>{row.pending}</td></tr>)}</tbody></table></div> : <Empty />}</Section>
    <Section title="每日记录">{stats.daily.length ? <div className="p-table-wrap p-daily"><table className="p-table"><thead><tr><th>日期</th><th>已支付订单</th><th>其中保障订单</th><th>购买率</th><th>申诉</th></tr></thead><tbody>{stats.daily.map(row => <tr key={row.date}><td>{row.date ? row.date.slice(0, 10) : '日期待确认'}</td><td>{row.paid_orders}</td><td>{row.orders}</td><td>{row.paid_orders ? purchaseRate.format(row.orders / row.paid_orders) : '—'}</td><td>{row.claims}</td></tr>)}</tbody></table></div> : <Empty />}</Section></div>
  </>}</>;
}
