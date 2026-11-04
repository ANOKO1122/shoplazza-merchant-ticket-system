import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { CustomerEvidence } from '../../src/protection-customer-types';
import { evidenceUrl, safeImage, statusLabels } from './domain';
export function Icon({ name, size = 20 }: { name: 'shield' | 'arrow' | 'close' | 'package' | 'pin' | 'upload' | 'check' | 'camera' | 'info'; size?: number }) {
  const paths = { info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>, camera: <><path d="M4 7h4l2-3h4l2 3h4v14H4V7Z"/><circle cx="12" cy="13" r="4"/></>, shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/></>, arrow: <path d="m10 6 6 6-6 6M16 12H4"/>, close: <path d="m6 6 12 12M6 18 18 6"/>, package: <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/></>, pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/></>, upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/></>, check: <path d="m5 12 4 4L19 6"/> };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
export function ErrorNotice({ error }: { error: Error | string | null }) { return error ? <div className="cp-notice cp-error" role="alert">{typeof error === 'string' ? error : error.message}</div> : null; }
export function Badge({ status }: { status: string }) { return <span className={`cp-badge cp-badge-${status}`}>{statusLabels[status] || status}</span>; }
export function ProductImage({ src }: { src: string | null }) { return safeImage(src) ? <img className="cp-product-image" src={safeImage(src)} alt="" loading="lazy" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} /> : <span className="cp-product-image cp-image-placeholder"><Icon name="package" /></span>; }
export function EvidenceList({ files }: { files: CustomerEvidence[] }) {
  return <ul className="cp-evidence-list">{files.map(file => { const url = evidenceUrl(file.url); return <li key={file.id}>{url && (file.kind === 'video' ? <video src={url} controls preload="metadata" aria-label={file.original_name} /> : <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={file.original_name} loading="lazy" /></a>)}<span>{file.original_name}</span></li>; })}</ul>;
}
export function Dialog({ title, onClose, children, footer, busy = false }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const dialog = ref.current; dialog?.showModal(); const old = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { dialog?.close(); document.body.style.overflow = old; previous?.focus(); }; }, []);
  return <dialog className="cp-dialog" ref={ref} aria-labelledby={id} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><div className="cp-dialog-heading"><h2 id={id}>{title}</h2><button type="button" className="cp-icon-button" aria-label="Close dialog" onClick={onClose} disabled={busy}><Icon name="close" /></button></div><div className="cp-dialog-content">{children}</div>{footer && <div className="cp-dialog-footer">{footer}</div>}</dialog>;
}
