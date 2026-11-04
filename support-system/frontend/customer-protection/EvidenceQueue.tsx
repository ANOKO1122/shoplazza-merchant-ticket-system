import { useEffect, useRef, useState } from 'react';
import type { CustomerCaptureCategory, CustomerEvidence, CustomerOrderResponse } from '../../src/protection-customer-types';
import { request, upload } from './api';
import { cameraCategoryLabel } from './camera';
type Candidate = { file: File; captureId?: string; category?: CustomerCaptureCategory };
export type EvidenceRow = Candidate & { key: string; progress: number; evidence?: CustomerEvidence; error?: string; removing?: boolean; preview?: string };
export interface EvidenceQueueProps { limits: CustomerOrderResponse['limits']; onChange: (files: CustomerEvidence[]) => void; onBlocked: (blocked: boolean) => void; preserve: { current: boolean }; disabled?: boolean; }
export function useEvidenceQueue({ limits, onChange, onBlocked, preserve, disabled = false }: EvidenceQueueProps) {
  const [rows, setRows] = useState<EvidenceRow[]>([]); const [error, setError] = useState<string | null>(null);
  const rowsRef = useRef<EvidenceRow[]>([]); const controllers = useRef(new Map<string, AbortController>()); const mounted = useRef(true);
  useEffect(() => { onChange(rows.flatMap(row => row.evidence ? [row.evidence] : [])); onBlocked(rows.some(row => !row.evidence || row.removing)); }, [rows, onChange, onBlocked]);
  useEffect(() => () => {
    mounted.current = false; controllers.current.forEach(controller => controller.abort());
    rowsRef.current.forEach(row => { if (row.preview) URL.revokeObjectURL(row.preview); if (!preserve.current && row.evidence) void request(`/evidence/${encodeURIComponent(row.evidence.id)}`, { method: 'DELETE', body: '{}' }).catch(() => { /* Pending files also expire server-side. */ }); });
  }, []);
  function update(updater: (rows: EvidenceRow[]) => EvidenceRow[]) { if (!mounted.current) return; rowsRef.current = updater(rowsRef.current); setRows(rowsRef.current); }
  async function start(row: EvidenceRow) {
    if (disabled) return;
    const controller = new AbortController(); controllers.current.set(row.key, controller);
    update(rows => rows.map(item => item.key === row.key ? { ...item, error: undefined, progress: 0 } : item));
    try {
      const evidence = await upload(row.file, progress => update(rows => rows.map(item => item.key === row.key ? { ...item, progress } : item)), controller.signal, row.key, row.captureId);
      if (!mounted.current && !preserve.current) { void request(`/evidence/${encodeURIComponent(evidence.id)}`, { method: 'DELETE', body: '{}' }).catch(() => {}); return; }
      update(rows => rows.map(item => item.key === row.key ? { ...item, evidence, progress: 100 } : item));
    } catch (error) { if (!controller.signal.aborted) update(rows => rows.map(item => item.key === row.key ? { ...item, error: (error as Error).message } : item)); }
    finally { controllers.current.delete(row.key); }
  }
  function add(candidates: Candidate[]): boolean {
    if (disabled || !candidates.length) return false; setError(null);
    if (candidates.length + rowsRef.current.length > limits.max_files) { setError(`You can attach up to ${limits.max_files} files. Remove a file before adding more.`); return false; }
    if (candidates.some(({ file }) => file.size > limits.max_file_bytes || file.size === 0)) { setError(`Choose non-empty files smaller than ${Math.floor(limits.max_file_bytes / 1024 / 1024)} MB each.`); return false; }
    if (candidates.reduce((sum, { file }) => sum + file.size, 0) + rowsRef.current.reduce((sum, row) => sum + row.file.size, 0) > limits.max_total_bytes) { setError(`The combined files must be smaller than ${Math.floor(limits.max_total_bytes / 1024 / 1024)} MB.`); return false; }
    const created = candidates.map(candidate => ({ ...candidate, key: crypto.randomUUID(), progress: 0, ...(candidate.captureId ? { preview: URL.createObjectURL(candidate.file) } : {}) }));
    update(rows => [...rows, ...created]); created.forEach(row => { void start(row); }); return true;
  }
  async function remove(row: EvidenceRow) {
    if (disabled || row.removing) return;
    const discard = () => { if (row.preview) URL.revokeObjectURL(row.preview); update(rows => rows.filter(item => item.key !== row.key)); };
    if (!row.evidence) { controllers.current.get(row.key)?.abort(); discard(); return; }
    update(rows => rows.map(item => item.key === row.key ? { ...item, removing: true } : item)); setError(null);
    try { await request(`/evidence/${encodeURIComponent(row.evidence.id)}`, { method: 'DELETE', body: '{}' }); discard(); }
    catch (error) { update(rows => rows.map(item => item.key === row.key ? { ...item, removing: false } : item)); setError((error as Error).message); }
  }
  return { rows, error, add, remove, retry: start };
}
export function EvidenceQueueList({ queue, disabled }: { queue: ReturnType<typeof useEvidenceQueue>; disabled?: boolean }) {
  return queue.rows.length ? <ul className="cp-upload-list">{queue.rows.map(row => <li key={row.key}>{row.preview && <img className="cp-capture-thumbnail" src={row.preview} alt={row.category ? cameraCategoryLabel(row.category) : 'Captured photo'} />}<div><strong>{row.category ? cameraCategoryLabel(row.category) : row.file.name}</strong><span className="cp-muted">{(row.file.size / 1024 / 1024).toFixed(1)} MB · {row.evidence ? 'Attached' : row.error ? 'Upload failed' : row.progress === 100 ? 'Checking file…' : `Uploading ${row.progress}%`}</span>{row.error && <p className="cp-upload-error" role="alert">{row.error}{row.captureId && /expired/i.test(row.error) && ' Remove this photo, then open the camera to take a new one.'}</p>}{!row.evidence && !row.error && <progress value={row.progress} max={100} aria-label={`Uploading ${row.file.name}`} />}</div><div className="cp-upload-actions">{row.error && !(row.captureId && /expired/i.test(row.error)) && <button type="button" className="cp-text-button" disabled={disabled} onClick={() => { void queue.retry(row); }}>Retry</button>}<button type="button" className="cp-text-button" disabled={disabled || row.removing || (!row.evidence && !row.error)} onClick={() => { void queue.remove(row); }} aria-label={`Remove ${row.category ? cameraCategoryLabel(row.category) : row.file.name}`}>{row.removing ? 'Removing…' : 'Remove'}</button></div></li>)}</ul> : null;
}
