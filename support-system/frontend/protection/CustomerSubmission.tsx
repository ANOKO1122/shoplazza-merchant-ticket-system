import { useRef, useState } from 'react';
import type { CustomerClaim, CustomerEvidence } from '../../src/protection-customer-types';
import type { ProtectionOrder } from '../../src/protection-types';
import { dateTime, request } from './api';
import { ErrorNotice, Field, Info, Section } from './shared';
const issues: Record<string, string> = { damaged: '收到商品损坏', missing_items: '包裹缺少商品', wrong_item: '收到错误商品', delivered_not_received: '物流显示已送达但未收到', not_arrived: '包裹尚未到达', delayed: '配送严重延误', other: '其他问题' };
export function adminEvidenceUrl(value: string): string | undefined { return /^\/api\/protection\/evidence\/[A-Za-z0-9_-]+$/.test(value) ? value : undefined; }
function Evidence({ files }: { files: CustomerEvidence[] }) {
  return files.length ? <ul className="p-customer-evidence">{files.map(file => { const url = adminEvidenceUrl(file.url); return <li key={file.id}>{url && (file.kind === 'video' ? <video src={url} controls preload="metadata" aria-label={file.original_name} /> : <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={file.original_name} loading="lazy" /></a>)}<span>{file.original_name}</span>{file.capture && <span>相机流程 · {({ damaged_item: '损坏商品', outer_packaging: '外包装', shipping_label: '物流面单', additional: '补充细节' })[file.capture.category]}<br />请求拍照：{dateTime(file.capture.requested_at)}<br />服务器接收：{dateTime(file.capture.received_at)}</span>}</li>; })}</ul> : <p className="p-muted">未上传附件。</p>;
}
export function CustomerSubmission({ submission, order }: { submission: CustomerClaim; order: ProtectionOrder }) {
  return <Section title="顾客问答与证据"><dl className="p-info-grid"><Info label="是否收到包裹">{submission.received_package == null ? '未记录' : submission.received_package ? '已收到' : '未收到'}</Info><Info label="具体问题">{submission.issue_code ? issues[submission.issue_code] || submission.issue_code : '未记录'}</Info></dl><div className="p-description"><span>本次申请数量</span>{submission.selections.map(selection => <p key={selection.item_id}>{order.items.find(item => item.id === selection.item_id)?.title || selection.item_id} × {selection.quantity}</p>)}</div><div className="p-description"><span>图片与视频证据</span><Evidence files={submission.evidence} />{submission.evidence.some(file => file.capture) && <p className="p-muted">时间为服务器记录的相机流程与接收时间，不等于对拍摄时间或图片真实性的认证。</p>}</div>
    {submission.camera_exception_reason && <div className="p-description"><span>无法使用相机 · 需人工核查</span><p>{submission.camera_exception_reason}</p></div>}
    <div className="p-description"><span>顾客提交的位置</span>{submission.location ? <><dl className="p-info-grid"><Info label="坐标（纬度，经度）">{submission.location.latitude.toFixed(6)}, {submission.location.longitude.toFixed(6)}</Info><Info label="设备报告的估计范围">约 {Math.round(submission.location.accuracy_meters)} 米</Info><Info label="采集时间">{dateTime(submission.location.captured_at)}</Info></dl><p className="p-muted">估计范围由设备报告，不代表实际误差保证，也不能单独证明顾客所在地。坐标按浏览器返回的 WGS84 原样记录，未作地图坐标转换；请使用相同坐标系的地图核对。</p></> : <p className="p-muted">此申请未记录位置，请结合其他证据审核。</p>}</div>
    {!!submission.messages.length && <div className="p-description"><span>顾客补充资料</span><ol className="p-history">{submission.messages.map(message => <li key={message.id}><time>{dateTime(message.created_at)}</time><p>{message.description}</p><Evidence files={message.evidence} /></li>)}</ol></div>}
  </Section>;
}
export function CustomerAccessLink({ orderId }: { orderId: string }) {
  const [url, setUrl] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<Error | string | null>(null); const [notice, setNotice] = useState(''); const input = useRef<HTMLInputElement>(null); const busyRef = useRef(false);
  async function generate() {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(null); setNotice('');
    try { const result = await request<{ url: string }>(`/orders/${encodeURIComponent(orderId)}/access-link`, { method: 'POST', body: '{}' }); const parsed = new URL(result.url); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('服务器返回的访问链接格式无效。'); setUrl(parsed.href); }
    catch (error) { setError(error as Error); } finally { busyRef.current = false; setBusy(false); }
  }
  async function copy() { try { await navigator.clipboard.writeText(url); setNotice('链接已复制，请仅发送给此订单顾客。'); } catch { input.current?.select(); setNotice('已选中链接，请手动复制。'); } }
  return <Section title="顾客访问链接"><div className="p-form"><p className="p-muted">生成只允许访问此保障订单的安全链接。不会发送邮件。</p><button className="p-button" disabled={busy} onClick={() => void generate()}>{busy ? '正在生成…' : url ? '生成新访问链接' : '生成顾客访问链接'}</button>{url && <><Field label="此订单的安全访问链接"><input ref={input} value={url} readOnly onFocus={event => event.target.select()} /></Field><div className="p-actions"><button className="p-button" onClick={() => void copy()}>复制链接</button><a className="p-button" href={url} target="_blank" rel="noopener noreferrer">打开顾客页面</a></div></>}<ErrorNotice error={error} />{notice && <p className="p-muted" role="status">{notice}</p>}</div></Section>;
}
