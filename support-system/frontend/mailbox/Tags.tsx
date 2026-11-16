import { useEffect, useRef, useState } from 'react';
import { jsonRequest, mailboxApi, MailboxApiError } from './api';
import type { MailboxTag } from './api';

type CustomerTags = { email: string; version: number; tag_ids: number[] };
const colors = { blue: '蓝色', green: '绿色', amber: '黄色', red: '红色', purple: '紫色', slate: '灰色' };
export function TagBadges({ tags = [] }: { tags?: MailboxTag[] }) {
  return <span className="mb-tags">{tags.map(tag => <span key={tag.id} className={`mb-tag mb-tag-${tag.color}`}>{tag.name}</span>)}</span>;
}
export function CustomerTagsDialog({ conversationId, onClose, onSaved }: { conversationId: number; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tags, setTags] = useState<MailboxTag[]>([]);
  const [customer, setCustomer] = useState<CustomerTags | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState('blue');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [revision, setRevision] = useState(0);
  const saving = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    Promise.all([mailboxApi<{ tags: MailboxTag[] }>('/tags', { signal: controller.signal }),
      mailboxApi<{ customer: CustomerTags }>(`/conversations/${conversationId}/tags`, { signal: controller.signal })])
      .then(([catalog, result]) => { if (!controller.signal.aborted) { setTags(catalog.tags); setCustomer(result.customer); setSelected(result.customer.tag_ids); setConflict(false); } })
      .catch(() => { if (!controller.signal.aborted) setError('标签加载失败，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [conversationId, revision]);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (saving.current || !name.trim()) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await mailboxApi<{ tag: MailboxTag }>('/tags', jsonRequest('POST', { name, color }));
      setTags(current => [...current.filter(tag => tag.id !== result.tag.id), result.tag]);
      setSelected(current => current.includes(result.tag.id) ? current : [...current, result.tag.id]);
      setName(''); setCreating(false);
    } catch { setError('创建失败，请使用不超过 30 字的标签名称后重试。'); }
    finally { saving.current = false; setBusy(false); }
  }
  async function save() {
    if (!customer || saving.current || conflict) return;
    saving.current = true; setBusy(true); setError('');
    try {
      await mailboxApi(`/conversations/${conversationId}/tags`, jsonRequest('PUT', { version: customer.version, tag_ids: selected }));
      onSaved(); onClose();
    } catch (caught) {
      if (caught instanceof MailboxApiError && caught.status === 409) { setConflict(true); setError('该顾客的标签已被其他客服修改，请重新加载后核对。'); }
      else setError('保存失败，请重试。');
    } finally { saving.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="mb-tags-dialog" aria-label="顾客标签" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2>顾客标签</h2><button type="button" className="mb-button" disabled={busy} onClick={onClose} aria-label="关闭顾客标签">关闭</button></header>
    <div className="mb-tags-dialog-body">{loading ? <p role="status">正在加载标签…</p> : <>
      <p className="mb-muted">{customer?.email} · 同一邮箱的会话共享标签。</p>
      <div className="mb-tag-options">{tags.map(tag => <label key={tag.id}><input type="checkbox" checked={selected.includes(tag.id)} disabled={busy || conflict || (!selected.includes(tag.id) && selected.length >= 50)}
        onChange={event => setSelected(current => event.target.checked ? [...current, tag.id] : current.filter(id => id !== tag.id))} /><TagBadges tags={[tag]} /></label>)}</div>
      {!tags.length && <p className="mb-muted">暂无标签，创建后即可为顾客添加。</p>}
      {creating ? <form className="mb-tag-create" onSubmit={create}><label>标签名称<input value={name} maxLength={30} disabled={busy} onChange={event => setName(event.target.value)} placeholder="例如：VIP、已退款" autoFocus /></label>
        <label>标签颜色<select value={color} disabled={busy} onChange={event => setColor(event.target.value)}>{Object.entries(colors).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button className="mb-button" disabled={busy || !name.trim() || selected.length >= 50}>创建</button></form>
        : <button type="button" className="mb-button" disabled={busy || !customer || conflict || selected.length >= 50} onClick={() => setCreating(true)}>创建标签</button>}
      <p className="mb-muted">勾选添加，取消勾选移除；点击保存后生效。</p>
    </>}
    {error && <p className="mb-error" role="alert">{error}</p>}
    {(conflict || (!customer && !loading)) && <button type="button" className="mb-button" onClick={() => setRevision(value => value + 1)}>重新加载标签</button>}</div>
    <footer><button type="button" className="mb-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="mb-button mb-button-primary" disabled={busy || loading || !customer || conflict} onClick={() => void save()}>{busy ? '正在保存…' : '保存'}</button></footer>
  </dialog>;
}
