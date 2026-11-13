import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationPane } from './Conversation';
import { mailboxApi, jsonRequest, MailboxApiError } from './api';
import type { ClaimCandidate, ConversationSummary, MailboxAgent, MailboxConversation, MailboxMessage } from './api';
import './styles.css';

type Scope = 'open' | 'unread' | 'read' | 'resolved' | 'mine' | 'unassigned';
type MailboxStatus = { configured: boolean; last_success_at: string | null; last_error: string | null };

function errorText(error: unknown): string {
  if (error instanceof MailboxApiError) {
    if (error.status === 409) return '会话已被其他客服更新。已重新加载，请再试一次。';
    if (error.status === 401) return '登录已过期，请重新登录。';
    if (error.code === 'recipient_mismatch') return '收件地址与最新来信不一致，请刷新会话。';
    if (error.code === 'file_too_large' || error.code === 'message_too_large') return '附件超过大小限制，请选择更小的文件。';
    if (error.code === 'unsupported_type') return '只支持 JPG、PNG、WebP 和 PDF 附件。';
    if (error.code === 'mailbox_unavailable') return '邮箱尚未连接，暂时无法发送回复。';
  }
  return '操作失败，请刷新后重试。';
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function App() {
  const [scope, setScope] = useState<Scope>('open');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const value = Number(new URLSearchParams(location.search).get('conversation'));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const [detail, setDetail] = useState<MailboxConversation | null>(null);
  const [agents, setAgents] = useState<MailboxAgent[]>([]);
  const [mailbox, setMailbox] = useState<MailboxStatus | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showMobileDetail, setShowMobileDetail] = useState(!!selectedId);
  const detailRequest = useRef(0);
  const selectedIdRef = useRef(selectedId);
  const mutatingRef = useRef(false);
  const historyRef = useRef<{ id: number; messages: MailboxMessage[]; hasOlder: boolean } | null>(null);

  function mergeHistory(next: MailboxConversation): MailboxConversation {
    const previous = historyRef.current?.id === next.id ? historyRef.current : null;
    const messages = previous ? [...new Map([...previous.messages, ...next.messages].map(message => [message.id, message])).values()]
      .sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime() || a.id - b.id) : next.messages;
    const hasOlder = previous?.hasOlder ?? next.has_older_messages;
    historyRef.current = { id: next.id, messages, hasOlder };
    return { ...next, messages, has_older_messages: hasOlder };
  }

  useEffect(() => {
    const id = setTimeout(() => { setSearch(query.trim()); setPage(0); }, 300);
    return () => clearTimeout(id);
  }, [query]);

  const loadList = useCallback(async () => {
    try {
      const params = new URLSearchParams({ scope, limit: '50', offset: String(page * 50) });
      if (search) params.set('q', search);
      const result = await mailboxApi<{ items: ConversationSummary[]; total: number }>(`/conversations?${params}`);
      setItems(result.items); setTotal(result.total);
    } catch (caught) { setError(errorText(caught)); }
    finally { setLoadingList(false); }
  }, [scope, search, page]);

  const loadDetail = useCallback(async (id: number) => {
    if (selectedIdRef.current !== id || mutatingRef.current) return;
    const request = ++detailRequest.current;
    setLoadingDetail(true);
    try {
      const result = await mailboxApi<{ conversation: MailboxConversation }>(`/conversations/${id}`);
      let next = result.conversation;
      if (next.unread_count > 0 && request === detailRequest.current
        && selectedIdRef.current === id && document.visibilityState === 'visible') {
        try {
          const read = await mailboxApi<{ conversation: MailboxConversation }>(`/conversations/${id}`, jsonRequest('PATCH', { version: next.version, mark_read: true }));
          next = read.conversation;
          void loadList();
        } catch { /* Another agent may have read it already; the next refresh reconciles. */ }
      }
      if (request === detailRequest.current && selectedIdRef.current === id && !mutatingRef.current)
        setDetail(current => current?.id === id && current.version > next.version ? current : mergeHistory(next));
    } catch (caught) { if (request === detailRequest.current) { setError(errorText(caught)); setDetail(null); } }
    finally { if (request === detailRequest.current) setLoadingDetail(false); }
  }, [loadList]);

  useEffect(() => { setLoadingList(true); loadList(); }, [loadList]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); else setDetail(null); }, [selectedId, loadDetail]);
  useEffect(() => {
    const refresh = () => {
      mailboxApi<{ mailbox: MailboxStatus }>('/status').then(result => setMailbox(result.mailbox)).catch(caught => setError(errorText(caught)));
      mailboxApi<{ agents: MailboxAgent[] }>('/agents').then(result => setAgents(result.agents)).catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => { loadList(); if (selectedId) loadDetail(selectedId); }, 30_000);
    return () => clearInterval(timer);
  }, [loadList, loadDetail, selectedId]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible' && selectedIdRef.current) loadDetail(selectedIdRef.current); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [loadDetail]);

  function select(id: number) {
    id = Number(id);
    if (id !== selectedIdRef.current) { setDetail(null); detailRequest.current++; historyRef.current = null; }
    selectedIdRef.current = id;
    setSelectedId(id); setShowMobileDetail(true); setError('');
    const url = new URL(location.href); url.searchParams.set('conversation', String(id)); history.replaceState(null, '', url);
  }
  function backToList() {
    selectedIdRef.current = null; detailRequest.current++; historyRef.current = null;
    setSelectedId(null); setDetail(null); setLoadingDetail(false);
    setShowMobileDetail(false);
    const url = new URL(location.href); url.searchParams.delete('conversation'); history.replaceState(null, '', url);
  }
  async function action(fn: () => Promise<MailboxConversation>): Promise<boolean> {
    if (!detail || busy) return false;
    const targetId = detail.id;
    mutatingRef.current = true; detailRequest.current++;
    setBusy(true); setError('');
    try { const next = await fn(); if (selectedIdRef.current === targetId) setDetail(mergeHistory(next)); await loadList(); return true; }
    catch (caught) { mutatingRef.current = false; if (selectedIdRef.current === targetId) {
      setError(errorText(caught));
      if (caught instanceof MailboxApiError && caught.status === 409) await loadDetail(targetId);
    } return false; }
    finally { mutatingRef.current = false; setBusy(false); }
  }
  async function update(change: { assignee_id?: number | null; status?: 'open' | 'resolved'; mark_read?: boolean; mark_unread?: boolean }) {
    if (!detail) return;
    const changed = await action(async () => (await mailboxApi<{ conversation: MailboxConversation }>(`/conversations/${detail.id}`, jsonRequest('PATCH', { version: detail.version, ...change }))).conversation);
    if (changed && change.mark_unread) backToList();
  }
  async function addNote(body: string) {
    if (!detail || !(await action(async () => (await mailboxApi<{ conversation: MailboxConversation }>(`/conversations/${detail.id}/notes`, jsonRequest('POST', { version: detail.version, body }))).conversation))) throw new Error('note_not_saved');
  }
  async function linkClaim(claimId: number | null) {
    if (!detail) return;
    await action(async () => (await mailboxApi<{ conversation: MailboxConversation }>(`/conversations/${detail.id}/link`, jsonRequest('POST', { version: detail.version, claim_id: claimId }))).conversation);
  }
  async function linkOrder(orderId: number | null) {
    if (!detail) return;
    await action(async () => (await mailboxApi<{ conversation: MailboxConversation }>(`/conversations/${detail.id}/link-order`, jsonRequest('POST', { version: detail.version, order_id: orderId }))).conversation);
  }
  async function searchClaims(term: string): Promise<ClaimCandidate[]> {
    const result = await mailboxApi<{ items: ClaimCandidate[] }>(`/claims?q=${encodeURIComponent(term)}`);
    return result.items;
  }
  async function reply(to: string, body: string, files: File[], idempotencyKey: string) {
    if (!detail || busy) throw new Error('busy');
    const targetId = detail.id;
    const targetVersion = detail.version;
    mutatingRef.current = true; detailRequest.current++;
    setBusy(true); setError('');
    try {
      const form = new FormData();
      form.set('version', String(targetVersion)); form.set('to', to); form.set('body', body); form.set('idempotency_key', idempotencyKey);
      files.forEach(file => form.append('attachments', file));
      await mailboxApi(`/conversations/${targetId}/replies`, { method: 'POST', body: form });
      mutatingRef.current = false;
      if (selectedIdRef.current === targetId) await loadDetail(targetId);
      await loadList();
    } catch (caught) { mutatingRef.current = false; if (selectedIdRef.current === targetId) {
      setError(errorText(caught));
      if (caught instanceof MailboxApiError && caught.status === 409) await loadDetail(targetId);
    }
      throw caught; }
    finally { mutatingRef.current = false; setBusy(false); }
  }
  async function loadOlder() {
    if (!detail || loadingOlder || !detail.has_older_messages) return;
    const targetId = detail.id;
    const before = Math.min(...detail.messages.map(message => message.id));
    setLoadingOlder(true);
    try {
      const result = await mailboxApi<{ conversation: MailboxConversation }>(`/conversations/${targetId}?before_message_id=${before}`);
      if (selectedIdRef.current === targetId) {
        const older = result.conversation;
        const retained = historyRef.current?.id === targetId ? historyRef.current.messages : detail.messages;
        const messages = [...new Map([...retained, ...older.messages].map(message => [message.id, message])).values()]
          .sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime() || a.id - b.id);
        historyRef.current = { id: targetId, messages, hasOlder: older.has_older_messages };
        setDetail(current => current?.id === targetId ? { ...current, messages, has_older_messages: older.has_older_messages } : current);
      }
    } catch (caught) { setError(errorText(caught)); }
    finally { setLoadingOlder(false); }
  }
  function refresh() { loadList(); if (selectedId) loadDetail(selectedId); }

  return <div className="mb-app"><header className="mb-topbar"><div><a className="mb-mobile-home" href="/thinkpro-admin">← 后台首页</a><h1>客服收件箱</h1><p>customersupport@reply.us-seel.com</p></div>
    <div className="mb-topbar-actions"><span className={`mb-connection ${mailbox?.configured && !mailbox.last_error ? 'connected' : ''}`}>
      {mailbox?.configured ? mailbox.last_error ? '同步异常' : mailbox.last_success_at ? '邮箱已连接' : '等待首次同步' : '邮箱尚未连接'}</span>
      <button type="button" className="mb-button" onClick={refresh}>刷新</button></div></header>
    {mailbox && !mailbox.configured && <div className="mb-alert" role="status">收件箱尚未连接。请管理员完成邮箱连接后刷新页面。</div>}
    {mailbox?.last_error && <div className="mb-alert" role="alert">邮件同步遇到问题。已保存的会话仍可查看，请检查邮箱连接。</div>}
    <main className={`mb-workspace ${showMobileDetail ? 'mb-mobile-detail' : ''}`}>
      <section className="mb-list-panel" aria-label="会话列表"><div className="mb-list-header"><div className="mb-list-heading"><h2>会话 <span>{total}</span></h2>
        <label className="mb-search"><span className="mb-visually-hidden">搜索邮件</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索邮件" /></label></div>
        <label className="mb-filter"><span className="mb-visually-hidden">会话分类</span><select value={scope} onChange={event => { setScope(event.target.value as Scope); setPage(0); }}>
          <option value="open">待处理</option><option value="unread">未读</option><option value="read">已读</option><option value="resolved">已处理</option>
          <option value="mine">分配给我</option><option value="unassigned">未分配</option></select></label></div>
        <div className="mb-list-scroll">{loadingList ? <p className="mb-empty">正在载入会话…</p> : items.length ? items.map(item => <button type="button" key={item.id} className={`mb-list-item ${selectedId === item.id ? 'active' : ''}`} onClick={() => select(item.id)}>
          <span className="mb-list-subject">{item.unread_count > 0 && <i className="mb-unread-dot" aria-label="未读" />}{item.subject || '无主题邮件'}</span>
          <span className="mb-list-date">{shortDate(item.last_message_at)}</span><span className="mb-list-address">{item.customer_email}</span>
          <span className="mb-list-foot">{item.claim_no || item.protection_no || item.assignee_name || '未分配'}{item.unread_count > 0 && <em>{item.unread_count}</em>}</span>
        </button>) : <p className="mb-empty">这里暂无会话。</p>}</div>
        {total > 50 && <div className="mb-list-pagination"><button type="button" className="mb-button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</button>
          <span>{page + 1} / {Math.ceil(total / 50)}</span><button type="button" className="mb-button" disabled={(page + 1) * 50 >= total} onClick={() => setPage(value => value + 1)}>下一页</button></div>}</section>
      <section className="mb-detail-panel" aria-label="会话详情"><button type="button" className="mb-mobile-back mb-button" onClick={backToList}>返回会话列表</button>
        {error && !detail && <div className="mb-alert" role="alert">{error}</div>}
        {loadingDetail && !detail ? <div className="mb-detail-empty">正在载入邮件…</div> : detail
          ? <ConversationPane key={detail.id} conversation={detail} agents={agents} busy={busy} mailboxReady={!!mailbox?.configured} loadingOlder={loadingOlder} error={error} onRefresh={refresh} onLoadOlder={loadOlder} onUpdate={update} onNote={addNote} onReply={reply} onLink={linkClaim} onLinkOrder={linkOrder} onSearchClaims={searchClaims} />
          : <div className="mb-detail-empty">从左侧选择一封邮件，查看会话并回复。</div>}</section>
    </main>
  </div>;
}

const main = document.getElementById('mainArea');
if (main) createRoot(main).render(<App />);
