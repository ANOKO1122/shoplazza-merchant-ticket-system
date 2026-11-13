import { useRef, useState } from 'react';
import type { MailboxAgent, MailboxConversation, MailboxMessage, MailboxNote } from './api';

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

const deliveryLabels: Record<string, string> = {
  queued: '等待发送', sending: '发送中', sent: '已发送', failed: '发送失败', unknown: '发送结果待核实', received: '已收到',
};

type ConversationProps = {
  conversation: MailboxConversation;
  agents: MailboxAgent[];
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onUpdate: (change: { assignee_id?: number | null; status?: 'open' | 'resolved'; mark_read?: boolean }) => Promise<void>;
  onNote: (body: string) => Promise<void>;
  onReply: (to: string, body: string, files: File[], idempotencyKey: string) => Promise<void>;
  onLink: (claimId: number | null) => Promise<void>;
};

export function ConversationPane({ conversation, agents, busy, error, onRefresh, onUpdate, onNote, onReply, onLink }: ConversationProps) {
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const pendingKey = useRef<string | null>(null);
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
        if (!canReply) return;
        pendingKey.current ||= crypto.randomUUID();
        await onReply(recipient, draft.trim(), files, pendingKey.current);
        pendingKey.current = null;
        setFiles([]);
      }
      setDraft('');
    } catch {
      // Keep the draft and the same idempotency key for a safe retry.
    }
  }

  return <div className="mb-conversation-grid">
    <section className="mb-thread" aria-label="邮件会话">
      <header className="mb-thread-header"><div><h2>{conversation.subject || '无主题邮件'}</h2><p>{conversation.customer_email}</p></div>
        <div className="mb-thread-actions"><button type="button" className="mb-button mb-button-quiet" onClick={onRefresh}>刷新</button>
          <button type="button" className="mb-button" disabled={busy} onClick={() => onUpdate({ status: conversation.status === 'open' ? 'resolved' : 'open' })}>
            {conversation.status === 'open' ? '标记已解决' : '重新打开'}</button></div></header>
      <div className="mb-timeline">
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
        <label className="mb-visually-hidden" htmlFor="mailbox-draft">{mode === 'reply' ? '邮件回复内容' : '内部备注内容'}</label>
        <textarea id="mailbox-draft" rows={5} value={draft} onChange={event => { pendingKey.current = null; setDraft(event.target.value); }} placeholder={mode === 'reply' ? '输入给顾客的回复…' : '记录处理情况…'} maxLength={100000} />
        {mode === 'reply' && <label className="mb-file-control">添加附件（图片或 PDF，最多 6 个）
          <input type="file" multiple accept=".jpg,.jpeg,.png,.webp,.pdf" onChange={event => { pendingKey.current = null; setFiles(Array.from(event.target.files || [])); }} /></label>}
        {files.length > 0 && mode === 'reply' && <p className="mb-selected-files">{files.map(file => file.name).join('、')}</p>}
        <div className="mb-composer-footer"><span role="status" className="mb-error">{error}</span>
          <button type="submit" className="mb-button mb-button-primary" disabled={busy || !draft.trim() || (mode === 'reply' && !canReply)}>{busy ? '处理中…' : mode === 'reply' ? '发送回复' : '保存内部备注'}</button></div>
      </form>
    </section>
    <aside className="mb-context" aria-label="会话资料"><h3>处理资料</h3><dl><dt>状态</dt><dd>{conversation.status === 'open' ? '待处理' : '已解决'}</dd><dt>顾客邮箱</dt><dd>{conversation.customer_email}</dd></dl>
      <label className="mb-field">负责人<select value={conversation.assignee_id ?? ''} disabled={busy} onChange={event => onUpdate({ assignee_id: event.target.value ? Number(event.target.value) : null })}>
        <option value="">未分配</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      <div className="mb-context-section"><h4>保障申请</h4>{conversation.claim_id && conversation.claim_no
        ? <p><a href={`/thinkpro-admin/protection?tab=claims&claim=${encodeURIComponent(String(conversation.claim_id))}`}>{conversation.claim_no}</a></p>
        : <p className="mb-muted">尚未关联申请</p>}
        {conversation.candidate_notification && <div className="mb-candidate"><strong>待人工核对</strong><p>可能回复了「{conversation.candidate_notification.subject}」；原收件人是 {conversation.candidate_notification.recipient_email}。</p>
          {conversation.candidate_notification.claim_id && <button type="button" className="mb-button" disabled={busy} onClick={() => onLink(conversation.candidate_notification!.claim_id)}>关联 {conversation.candidate_notification.claim_no || '该申请'}</button>}</div>}
        <label className="mb-field">手动关联<select value={conversation.claim_id ?? ''} disabled={busy} onChange={event => onLink(event.target.value ? Number(event.target.value) : null)}>
          <option value="">无关联</option>{conversation.claim_id && <option value={conversation.claim_id}>{conversation.claim_no || `申请 ${conversation.claim_id}`}</option>}
          {conversation.candidates.filter(candidate => candidate.id !== conversation.claim_id).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.public_no} · {candidate.order_number}</option>)}</select></label>
      </div><p className="mb-context-help">仅邮件线程与原收件地址一致时自动关联；其他匹配需人工确认。</p>
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
