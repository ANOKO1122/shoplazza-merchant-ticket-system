import { useRef, useState } from 'react';
import type { ClaimCandidate, MailboxAgent, MailboxConversation, MailboxMessage, MailboxNote } from './api';

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

const deliveryLabels: Record<string, string> = {
  queued: '等待发送', sending: '发送中', sent: '已发送', failed: '发送失败', unknown: '发送结果待核实', received: '已收到',
};

function Icon({ name }: { name: 'paperclip' | 'envelope' | 'check' | 'chevron' | 'refresh' | 'close' }) {
  const paths = {
    paperclip: <path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l9.2-9.2a3.5 3.5 0 0 1 5 5l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.1-8.1" />,
    envelope: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
    check: <path d="m4 12 5 5L20 6" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2" /></>,
    close: <path d="M6 6 18 18M18 6 6 18" />,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

type ConversationProps = {
  conversation: MailboxConversation;
  agents: MailboxAgent[];
  busy: boolean;
  mailboxReady: boolean;
  loadingOlder: boolean;
  error: string;
  onRefresh: () => void;
  onLoadOlder: () => void;
  onUpdate: (change: { assignee_id?: number | null; status?: 'open' | 'resolved'; mark_read?: boolean; mark_unread?: boolean }) => Promise<void>;
  onNote: (body: string) => Promise<void>;
  onReply: (to: string, body: string, files: File[], idempotencyKey: string) => Promise<void>;
  onLink: (claimId: number | null) => Promise<void>;
  onLinkOrder: (orderId: number | null) => Promise<void>;
  onSearchClaims: (term: string) => Promise<ClaimCandidate[]>;
};

export function ConversationPane({ conversation, agents, busy, mailboxReady, loadingOlder, error, onRefresh, onLoadOlder, onUpdate, onNote, onReply, onLink, onLinkOrder, onSearchClaims }: ConversationProps) {
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [claimQuery, setClaimQuery] = useState('');
  const [claimResults, setClaimResults] = useState<ClaimCandidate[]>([]);
  const [claimSearched, setClaimSearched] = useState(false);
  const [claimSearching, setClaimSearching] = useState(false);
  const pendingKey = useRef<string | null>(null);
  function addFiles(incomingFiles: File[]) {
    if (incomingFiles.some(file => !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type))) {
      setFileError('只支持 JPG、PNG、WebP 和 PDF 文件。'); return;
    }
    if (files.length + incomingFiles.length > 6) { setFileError('最多添加 6 个附件。'); return; }
    pendingKey.current = null;
    setFiles(current => [...current, ...incomingFiles]);
    setFileError('');
  }
  function pasteImages(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (mode !== 'reply') return;
    const pasted = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile()).filter((file): file is File => !!file);
    if (pasted.length) addFiles(pasted.map((file, index) => new File([file], file.name || `pasted-image-${index + 1}.png`, { type: file.type })));
  }
  const incoming = [...conversation.messages].filter(message => message.direction === 'incoming')
    .sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime())[0];
  const recipient = incoming?.sender_email || '';
  const canReply = !!recipient && !recipient.endsWith('@invalid.local');
  const timeline = [
    ...conversation.messages.map(message => ({ type: 'message' as const, at: message.sent_at, id: message.id, value: message })),
    ...conversation.notes.map(note => ({ type: 'note' as const, at: note.created_at, id: note.id, value: note })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.id - b.id);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    try {
      if (mode === 'note') {
        await onNote(draft.trim());
      } else {
        if (!canReply || !mailboxReady) return;
        pendingKey.current ||= crypto.randomUUID();
        await onReply(recipient, draft.trim(), files, pendingKey.current);
        pendingKey.current = null;
        setFiles([]); setFileError('');
      }
      setDraft('');
    } catch {
      // Keep the draft and the same idempotency key for a safe retry.
    }
  }

  async function searchClaim(event: React.FormEvent) {
    event.preventDefault();
    const term = claimQuery.trim();
    if (term.length < 3 || claimSearching) return;
    setClaimSearching(true);
    try { setClaimResults(await onSearchClaims(term)); setClaimSearched(true); }
    catch { setClaimResults([]); setClaimSearched(true); }
    finally { setClaimSearching(false); }
  }

  return <div className="mb-conversation-grid">
    <section className="mb-thread" aria-label="邮件会话">
      <header className="mb-thread-header"><div className="mb-thread-title"><h2>{conversation.subject || '无主题邮件'}</h2><p>{conversation.customer_email}</p></div>
        <div className="mb-thread-actions">
          <button type="button" className="mb-button mb-action-button" disabled={busy} onClick={() => onUpdate(conversation.unread_count ? { mark_read: true } : { mark_unread: true })}>
            <Icon name="envelope" />{conversation.unread_count ? '标记已读' : '标记未读'}</button>
          <button type="button" className={conversation.status === 'open' ? 'mb-button mb-button-primary mb-action-button' : 'mb-button mb-action-button'} disabled={busy}
            onClick={() => onUpdate({ status: conversation.status === 'open' ? 'resolved' : 'open' })}>
            <Icon name="check" />{conversation.status === 'open' ? '标记已处理' : '重新打开'}</button>
          <details className="mb-more-menu"><summary className="mb-button">更多 <Icon name="chevron" /></summary><div className="mb-more-options">
            <button type="button" onClick={onRefresh}><Icon name="refresh" />刷新会话</button>
            <button type="button" onClick={() => navigator.clipboard?.writeText(conversation.customer_email).catch(() => undefined)}>复制顾客邮箱</button>
          </div></details>
        </div></header>
      <div className="mb-timeline">
        {conversation.has_older_messages && <button type="button" className="mb-button mb-load-older" disabled={loadingOlder} onClick={onLoadOlder}>{loadingOlder ? '正在加载…' : '加载更早邮件'}</button>}
        {conversation.notification && <article className="mb-notice"><div className="mb-message-meta"><strong>已发送的保障通知</strong><time>{dateTime(conversation.notification.sent_at)}</time></div>
          <p className="mb-message-title">{conversation.notification.subject}</p><div className="mb-body">{conversation.notification.body_text}</div></article>}
        {timeline.map(item => item.type === 'message'
          ? <MessageCard key={`m-${item.id}`} message={item.value as MailboxMessage} />
          : <NoteCard key={`n-${item.id}`} note={item.value as MailboxNote} />)}
      </div>
      <form className="mb-composer" onSubmit={submit}><div className="mb-composer-tabs" role="tablist" aria-label="编辑内容类型">
        <button type="button" role="tab" aria-selected={mode === 'reply'} className={mode === 'reply' ? 'active' : ''} onClick={() => setMode('reply')}>邮件回复</button>
        <button type="button" role="tab" aria-selected={mode === 'note'} className={mode === 'note' ? 'active' : ''} onClick={() => setMode('note')}>内部备注</button></div>
        {mode === 'reply' ? <div className="mb-recipient"><span>收件人</span><strong>{recipient || '暂无可回复地址'}</strong><small>发件人：customersupport@reply.us-seel.com</small></div>
          : <p className="mb-private-hint">内部备注只对客服可见，不会发送到顾客邮箱。</p>}
        {mode === 'reply' && !mailboxReady && <p className="mb-private-hint">邮箱尚未连接，暂时无法发送回复。</p>}
        <label className="mb-visually-hidden" htmlFor="mailbox-draft">{mode === 'reply' ? '邮件回复内容' : '内部备注内容'}</label>
        <textarea id="mailbox-draft" rows={4} value={draft} onPaste={pasteImages} onChange={event => { pendingKey.current = null; setDraft(event.target.value); }} placeholder={mode === 'reply' ? '输入给顾客的回复，或直接粘贴图片…' : '记录处理情况…'} maxLength={100000} />
        {mode === 'reply' && <input ref={fileInput} className="mb-visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.pdf"
          onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />}
        <div className="mb-composer-footer"><div className="mb-composer-tools">
          {mode === 'reply' && <button type="button" className="mb-button mb-action-button" disabled={busy || files.length >= 6} onClick={() => fileInput.current?.click()}>
            <Icon name="paperclip" />附件{files.length ? ` ${files.length}/6` : ''}</button>}
          {mode === 'reply' && files.length > 0 && <div className="mb-selected-files" aria-label="已选附件">{files.map((file, index) =>
            <span key={`${file.name}-${index}`}>{file.name}<button type="button" aria-label={`移除 ${file.name}`} disabled={busy} onClick={() => { pendingKey.current = null; setFiles(current => current.filter((_, i) => i !== index)); }}><Icon name="close" /></button></span>)}</div>}
          <span role="status" className="mb-error">{fileError || error}</span></div>
          <button type="submit" className="mb-button mb-button-primary" disabled={busy || !draft.trim() || (mode === 'reply' && (!canReply || !mailboxReady))}>{busy ? '处理中…' : mode === 'reply' ? '发送回复' : '保存内部备注'}</button></div>
      </form>
    </section>
    <aside className="mb-context" aria-label="会话资料"><div className="mb-context-heading"><h3>处理资料</h3><span className={conversation.status === 'resolved' ? 'mb-status mb-status-resolved' : 'mb-status'}>{conversation.status === 'open' ? '待处理' : '已处理'}</span></div>
      <label className="mb-field">负责人<select value={conversation.assignee_id ?? ''} disabled={busy} onChange={event => onUpdate({ assignee_id: event.target.value ? Number(event.target.value) : null })}>
        <option value="">未分配</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      <div className="mb-context-section"><h4>保障订单</h4>{conversation.protection_order_id
        ? <p><a href={`/thinkpro-admin/protection?tab=orders&order=${encodeURIComponent(String(conversation.protection_order_id))}`}>{conversation.protection_no || `订单 ${conversation.protection_order_id}`}</a></p>
        : <p className="mb-muted">尚未关联订单</p>}
        <label className="mb-field">关联订单<select value={conversation.protection_order_id ?? ''} disabled={busy} onChange={event => onLinkOrder(event.target.value ? Number(event.target.value) : null)}>
          <option value="">无关联</option>
          {conversation.protection_order_id && !(conversation.order_candidates || []).some(order => order.id === conversation.protection_order_id)
            && <option value={conversation.protection_order_id}>{conversation.protection_no || `订单 ${conversation.protection_order_id}`}</option>}
          {(conversation.order_candidates || []).map(order => <option key={order.id} value={order.id}>{order.order_number || order.public_no}</option>)}</select></label>
      </div>
      <div className="mb-context-section"><h4>保障申请</h4>{conversation.claim_id && conversation.claim_no
        ? <p><a href={`/thinkpro-admin/protection?tab=claims&claim=${encodeURIComponent(String(conversation.claim_id))}`}>{conversation.claim_no}</a></p>
        : <p className="mb-muted">尚未关联申请</p>}
        {conversation.candidate_notification && <div className="mb-candidate"><strong>待人工核对</strong><p>可能回复了「{conversation.candidate_notification.subject}」；原收件人是 {conversation.candidate_notification.recipient_email}。</p>
          {conversation.candidate_notification.claim_id
            ? <button type="button" className="mb-button" disabled={busy} onClick={() => onLink(conversation.candidate_notification!.claim_id)}>关联 {conversation.candidate_notification.claim_no || '该申请'}</button>
            : <button type="button" className="mb-button" disabled={busy} onClick={() => onLinkOrder(conversation.candidate_notification!.protection_order_id)}>关联 {conversation.candidate_notification.order_number || '该保障订单'}</button>}</div>}
        <details className="mb-link-details"><summary>更改申请关联 <Icon name="chevron" /></summary><label className="mb-field">选择申请<select value={conversation.claim_id ?? ''} disabled={busy} onChange={event => onLink(event.target.value ? Number(event.target.value) : null)}>
          <option value="">无关联</option>{conversation.claim_id && <option value={conversation.claim_id}>{conversation.claim_no || `申请 ${conversation.claim_id}`}</option>}
          {conversation.candidates.filter(candidate => candidate.id !== conversation.claim_id).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.public_no} · {candidate.order_number}</option>)}</select></label>
        <form className="mb-claim-search" onSubmit={searchClaim}><label className="mb-field">按申请号或订单号查找
          <input value={claimQuery} onChange={event => { setClaimQuery(event.target.value); setClaimSearched(false); }} placeholder="输入申请号或订单号" maxLength={100} /></label>
          <button type="submit" className="mb-button" disabled={claimSearching || claimQuery.trim().length < 3}>{claimSearching ? '查询中…' : '查询'}</button></form>
        {claimSearched && (claimResults.length ? <ul className="mb-claim-results">{claimResults.map(candidate => <li key={candidate.id}><span>{candidate.public_no}<small>{candidate.order_number}</small></span>
          <button type="button" className="mb-button" disabled={busy} onClick={() => onLink(candidate.id)}>关联</button></li>)}</ul> : <p className="mb-muted">未找到匹配申请；请核对编号。</p>)}</details>
      </div><p className="mb-context-help">普通来信按邮箱关联最新保障订单；通知回复按原邮件关联。申请仍可人工核对与调整。</p>
    </aside>
  </div>;
}

function MessageCard({ message }: { message: MailboxMessage }) {
  const outbound = message.direction === 'outgoing';
  return <article className={outbound ? 'mb-message mb-message-out' : 'mb-message'}><div className="mb-message-meta"><strong>{outbound ? `客服${message.agent_name ? ` · ${message.agent_name}` : ''}` : message.sender_email}</strong>
    <time>{dateTime(message.sent_at)}</time></div><div className="mb-body">{message.body_text}</div>
    {message.attachments?.length > 0 && <ul className="mb-attachments">{message.attachments.map(attachment => <li key={attachment.id}>
      {attachment.available ? <a href={`/api/admin/mailbox/attachments/${attachment.id}`}>{attachment.filename}</a> : <span>{attachment.filename}（未保存：{attachment.omitted_reason || '不支持'}）</span>}
    </li>)}</ul>}
    {outbound && <span className={`mb-delivery mb-delivery-${message.status}`}>{deliveryLabels[message.status] || message.status}</span>}
  </article>;
}

function NoteCard({ note }: { note: MailboxNote }) {
  return <article className="mb-note"><div className="mb-message-meta"><strong>内部备注 · {note.agent_name}</strong><time>{dateTime(note.created_at)}</time></div><div className="mb-body">{note.body_text}</div></article>;
}
