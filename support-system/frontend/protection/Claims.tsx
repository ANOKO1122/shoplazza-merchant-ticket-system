import { useEffect, useRef, useState } from 'react';
import type { ClaimDetail as ClaimDetailData, ClaimStatus, ProtectionClaim, ProtectionList, ProtectionOrder, ProtectionStore } from '../../src/protection-types';
import { API, ApiError, centsFromInput, dateTime, money, query, request, useResource } from './api';
import { Badge, Empty, ErrorNotice, Field, FilterBar, Info, initialFilters, ItemList, Loading, OrderContext, Pagination, reasonLabels, Section, statusLabels, useDetailFocus } from './shared';
import { CustomerSubmission } from './CustomerSubmission';
export interface Agent { id: number; name: string }
export function Claims({ stores, agents, selected, onSelect }: { stores: ProtectionStore[]; agents: Agent[]; selected: string | null; onSelect: (id: string | null) => void }) {
  const [draft, setDraft] = useState(initialFilters);
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const params = query({ ...filters });
  const resource = useResource<ProtectionList<ProtectionClaim>>(`/claims?${params}&page=${page}&page_size=20`, refresh);
  return <><FilterBar value={draft} onChange={setDraft} mode="claims" stores={stores} onApply={() => { setFilters(draft); setPage(1); onSelect(null); }} />
    <div className="p-notice">本页仅处理申诉审核，不执行打款。审核通过后，可记录外部处理结果。</div>
    <div className={`p-workspace ${selected ? 'p-has-detail' : ''}`}><section className="p-list-pane"><div className="p-section-title"><h2>赔付申诉</h2><a className="p-button" href={`${API}/claims/export?${params}`}>导出 CSV</a></div><ErrorNotice error={resource.error} onRetry={resource.reload} />
      {resource.loading ? <Loading /> : resource.data?.items.length ? <div className="p-table-wrap"><table className="p-table"><thead><tr><th>申诉 / 保障</th><th>客户 / 店铺</th><th>原因</th><th>申请金额</th><th>状态</th><th>负责人 / 创建时间</th></tr></thead><tbody>{resource.data.items.map(claim => <tr key={claim.id} className={selected === claim.id ? 'p-selected' : ''}><td><button className="p-link p-strong" onClick={() => onSelect(claim.id)}>{claim.public_no}</button><small>{claim.protection_public_no}</small></td><td>{claim.customer_email || claim.customer_name || '未提供客户信息'}<small>{claim.store_name} · {claim.order_number}</small></td><td>{reasonLabels[claim.reason]}</td><td>{money(claim.requested_amount_cents, claim.currency)}</td><td><Badge status={claim.status} /></td><td>{claim.assignee_name || '未分配'}<small>{dateTime(claim.created_at)}</small></td></tr>)}</tbody></table></div> : !resource.error && <Empty title="暂无赔付申诉">可在「保障订单」中打开订单，代客户登记申诉。</Empty>}
      <Pagination page={page} total={resource.data?.total || 0} loading={resource.loading} onChange={setPage} />
    </section>{selected && <ClaimDetail key={selected} id={selected} agents={agents} onClose={() => onSelect(null)} onChanged={() => setRefresh(value => value + 1)} />}</div>
  </>;
}
function ClaimDetail({ id, agents, onClose, onChanged }: { id: string; agents: Agent[]; onClose: () => void; onChanged: () => void }) {
  const detailRef = useDetailFocus();
  const resource = useResource<ClaimDetailData>(`/claims/${encodeURIComponent(id)}`, 0, true);
  const data = resource.data;
  return <aside className="p-detail" ref={detailRef} tabIndex={-1} aria-label="赔付申诉详情"><div className="p-detail-heading"><div><h2>{data?.claim.public_no || '申诉详情'}</h2><p className="p-muted">保障编号 {data?.claim.protection_public_no || '加载中'}</p></div><button className="p-button" onClick={onClose}>关闭详情</button></div>
    <ErrorNotice error={resource.error} onRetry={resource.reload} />{!data && resource.loading ? <Loading /> : data && <div className="p-detail-body">
      <Section title="申诉信息" action={<Badge status={data.claim.status} />}><dl className="p-info-grid"><Info label="申诉原因">{reasonLabels[data.claim.reason]}</Info><Info label="申请金额">{money(data.claim.requested_amount_cents, data.claim.currency)}</Info><Info label="审核通过金额">{data.claim.approved_amount_cents == null ? '尚未审核通过' : money(data.claim.approved_amount_cents, data.claim.currency)}</Info><Info label="负责人">{data.claim.assignee_name || '未分配'}</Info><Info label="创建时间">{dateTime(data.claim.created_at)}</Info><Info label="最近更新">{dateTime(data.claim.updated_at)}</Info></dl><div className="p-description"><span>问题说明</span><p>{data.claim.description || '未填写说明'}</p></div>{data.claim.resolution_note && <div className="p-description"><span>处理说明</span><p>{data.claim.resolution_note}</p></div>}{data.claim.external_reference && <div className="p-description"><span>外部处理凭据</span><p>{data.claim.external_reference}</p></div>}</Section>
      {data.customer_submission && <CustomerSubmission submission={data.customer_submission} order={data.order} />}
      <ReviewForm claim={data.claim} order={data.order} agents={agents} refreshing={resource.loading} onReload={resource.reload} onSaved={() => { resource.reload(); onChanged(); }} />
      <OrderContext order={data.order} /><Section title="本次申诉商品"><ItemList items={data.order.items.filter(item => data.claim.item_ids.includes(item.id))} currency={data.order.currency} selected={data.claim.item_ids} /></Section>
      <Section title="操作记录">{data.events.length ? <ol className="p-history">{data.events.map(event => <li key={event.id}><div><strong>{event.actor_name || '系统'}</strong><time>{dateTime(event.created_at)}</time></div><p>{event.detail?.from_status && event.detail?.to_status && event.detail.from_status !== event.detail.to_status ? `${statusLabels[event.detail.from_status]} → ${statusLabels[event.detail.to_status]}` : eventLabel(event.action)}</p>{event.detail?.approved_amount_cents != null && <p className="p-history-note">审核通过金额：{money(event.detail.approved_amount_cents, data.claim.currency)}</p>}{event.detail?.external_reference && <p className="p-history-note">外部处理凭据：{event.detail.external_reference}</p>}{event.note && <p className="p-history-note">{event.note}</p>}</li>)}</ol> : <p className="p-muted">暂无操作记录。</p>}</Section>
    </div>}</aside>;
}
function eventLabel(action: string) {
  const labels: Record<string, string> = { created: '创建申诉', claim_created: '创建申诉', submitted: '提交申诉', reviewing: '开始审核', needs_info: '要求补充资料', approved: '审核通过', rejected: '拒绝申诉', closed: '记录外部处理结果', updated: '更新申诉', note: '添加备注', assigned: '调整负责人', assignment: '调整负责人', status_changed: '变更审核状态', update: '更新申诉' };
  return labels[action] || action;
}
function ReviewForm({ claim, order, agents, refreshing, onReload, onSaved }: { claim: ProtectionClaim; order: ProtectionOrder; agents: Agent[]; refreshing: boolean; onReload: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState(claim.approved_amount_cents != null ? (claim.approved_amount_cents / 100).toFixed(2) : (claim.requested_amount_cents / 100).toFixed(2));
  const [assignee, setAssignee] = useState(claim.assignee_id == null ? '' : String(claim.assignee_id));
  const [note, setNote] = useState('');
  const [customerMessage, setCustomerMessage] = useState(claim.customer_message || '');
  const [reference, setReference] = useState(claim.external_reference || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false);
  const dirty = useRef({ amount: false, assignee: false, reference: false, customerMessage: false });
  useEffect(() => {
    if (!dirty.current.amount) setAmount(((claim.approved_amount_cents ?? claim.requested_amount_cents) / 100).toFixed(2));
    if (!dirty.current.assignee) setAssignee(claim.assignee_id == null ? '' : String(claim.assignee_id));
    if (!dirty.current.reference) setReference(claim.external_reference || '');
    if (!dirty.current.customerMessage) setCustomerMessage(claim.customer_message || '');
  }, [claim.revision, claim.approved_amount_cents, claim.requested_amount_cents, claim.assignee_id, claim.external_reference, claim.customer_message]);
  const editable = ['submitted', 'reviewing', 'needs_info'].includes(claim.status);
  const canNotify = ['needs_info', 'approved', 'rejected', 'closed'].includes(claim.status);
  const unsaved = !!note.trim() || dirty.current.amount || dirty.current.assignee || dirty.current.reference || dirty.current.customerMessage;
  const unknownMoney = order.protected_value_cents == null || order.order_amount_cents == null || order.refund_amount_cents == null || order.items.filter(item => claim.item_ids.includes(item.id)).some(item => item.amount_cents == null);
  async function notifyCustomer() {
    if (busyRef.current || refreshing || conflict || unsaved || !canNotify) return;
    if (!window.confirm('确认给顾客发送申请更新通知邮件？')) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice('');
    try {
      const result = await request<{status:string}>(`/claims/${encodeURIComponent(claim.id)}/notify-email`, { method:'POST', body:JSON.stringify({revision:claim.revision}) });
      setNotice(result.status==='sent' ? '申请更新通知已发送；同一次更新不会重复发送。' : '通知已提交；如发送失败，系统会重试。');
    } catch (error) {
      if (error instanceof ApiError && error.status===409 && /更新|刷新/.test(error.message)) setConflict(true);
      setError(error as Error);
    } finally { busyRef.current=false; setBusy(false); }
  }
  async function save(status?: ClaimStatus) {
    if (busyRef.current || refreshing || conflict) return;
    if ((status === 'rejected' || status === 'needs_info' || status === 'closed') && !note.trim()) { setError('请填写处理备注，说明原因或需要补充的资料。'); return; }
    if (status === 'closed' && !reference.trim()) { setError('请填写外部处理凭据，例如退款单号或转账记录编号。'); return; }
    const cents = centsFromInput(amount);
    if (status === 'approved' && (unknownMoney || cents == null || cents > claim.requested_amount_cents)) { setError('审核金额须大于 0，不能超过申请金额，且订单金额必须已确认。'); return; }
    if (!status && !note.trim() && !dirty.current.customerMessage && assignee === (claim.assignee_id == null ? '' : String(claim.assignee_id))) { setError('请填写备注、顾客可见回复或变更负责人后保存。'); return; }
    busyRef.current = true; setBusy(true); setError(null); setNotice('');
    try {
      await request(`/claims/${encodeURIComponent(claim.id)}`, { method: 'PATCH', body: JSON.stringify({ revision: claim.revision, ...(status ? { status } : {}), ...(status === 'approved' ? { approved_amount_cents: cents } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...(dirty.current.customerMessage ? { customer_message: customerMessage.trim() } : {}), assignee_id: assignee === '' ? null : Number(assignee), ...(status === 'closed' ? { external_reference: reference.trim() } : {}) }) });
      dirty.current = { amount: false, assignee: false, reference: false, customerMessage: false };
      setNote(''); setNotice(status ? `${statusLabels[status]}已保存。${status === 'approved' ? '本次操作未执行打款。' : ''}` : '备注、顾客回复与负责人已保存。'); onSaved();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { setConflict(true); setError('此申诉已被其他人更新。请加载最新记录后核对，再提交；当前填写内容会保留。'); }
      else setError(error as Error);
    } finally { busyRef.current = false; setBusy(false); }
  }
  return <Section title={claim.status === 'approved' ? '记录外部处理结果' : '审核与内部备注'}><div className="p-form"><p className="p-muted">审核通过仅表示审核结果。款项由外部系统处理。保存状态或回复不会自动发送邮件。</p>
    <Field label="负责人"><select value={assignee} disabled={busy || refreshing} onChange={event => { dirty.current.assignee = true; setAssignee(event.target.value); }}><option value="">未分配</option>{claim.assignee_id != null && !agents.some(agent => agent.id === claim.assignee_id) && <option value={claim.assignee_id}>{claim.assignee_name || `客服 ${claim.assignee_id}`}</option>}{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
    {editable && <><Field label={`审核通过金额（${claim.currency}）`}><input inputMode="decimal" value={amount} disabled={busy || refreshing} onChange={event => { dirty.current.amount = true; setAmount(event.target.value); }} /></Field><p className="p-muted">申请金额 {money(claim.requested_amount_cents, claim.currency)}；剩余可赔额度会在提交时再次校验。</p>{unknownMoney && <p className="p-notice">订单、退款或商品金额尚未完整同步，目前不可审核通过。</p>}</>}
    {claim.status === 'approved' && <Field label="外部处理凭据"><input value={reference} maxLength={500} disabled={busy || refreshing} placeholder="外部退款单号、转账记录编号等" onChange={event => { dirty.current.reference = true; setReference(event.target.value); }} /></Field>}
    <Field label="顾客可见回复"><textarea value={customerMessage} rows={3} maxLength={5000} disabled={busy || refreshing} placeholder="顾客会在申请详情看到此内容，请使用顾客理解的语言说明审核结果或所需资料" onChange={event => { dirty.current.customerMessage = true; setCustomerMessage(event.target.value); }} /></Field><p className="p-muted">此回复显示在顾客申请页面。下方内部备注和外部处理凭据不会展示给顾客。</p>
    <Field label="处理备注（内部）"><textarea value={note} rows={3} maxLength={10000} disabled={busy || refreshing} placeholder={claim.status === 'approved' ? '记录外部处理时间、方式和结果' : '内部审核依据、拒绝原因或所需补充资料'} onChange={event => setNote(event.target.value)} /></Field>
    <ErrorNotice error={error} />{conflict && <button className="p-button" disabled={refreshing} onClick={() => { onReload(); setConflict(false); setError(null); setNotice('正在读取最新记录。请核对状态与操作记录，填写内容已保留。'); }}>加载最新记录并保留填写内容</button>}
    {notice && <p className="p-notice" role="status">{notice}</p>}
    <div className="p-actions">{editable && <><button className="p-button p-primary" disabled={busy || refreshing || conflict || unknownMoney} onClick={() => save('approved')}>审核通过</button><button className="p-button p-danger" disabled={busy || refreshing || conflict} onClick={() => save('rejected')}>拒绝申诉</button><button className="p-button" disabled={busy || refreshing || conflict} onClick={() => save('needs_info')}>要求补充资料</button>{claim.status !== 'reviewing' && <button className="p-button" disabled={busy || refreshing || conflict} onClick={() => save('reviewing')}>开始审核</button>}</>}
    {claim.status === 'approved' && <button className="p-button p-primary" disabled={busy || refreshing || conflict} onClick={() => save('closed')}>保存外部处理并结案</button>}
    <button className="p-button" disabled={busy || refreshing || conflict} onClick={() => save()}>保存备注 / 回复 / 负责人</button>{canNotify && <button className="p-button" disabled={busy || refreshing || conflict || unsaved} onClick={() => void notifyCustomer()}>发送申请更新通知邮件</button>}{busy && <span role="status">正在处理…</span>}{refreshing && <span role="status">正在更新详情…</span>}</div>
  </div></Section>;
}
