import { useEffect, useId, useRef, useState } from 'react';
import type { CustomerCaptureCategory, CustomerCaptureSession } from '../../src/protection-customer-types';
import { request } from './api';
import { cameraCategories, cameraCategoryLabel, cameraError, CameraStreamGuard } from './camera';
import { EvidenceQueueList, useEvidenceQueue, type EvidenceQueueProps } from './EvidenceQueue';
import { ErrorNotice, Icon } from './shared';
import { CameraPermissions } from './CameraPermissions';
export function CameraEvidence(props: EvidenceQueueProps & { active: boolean; requireDamaged?: boolean }) {
  const [queueBlocked, setQueueBlocked] = useState(false);
  const queue = useEvidenceQueue({ ...props, onBlocked: setQueueBlocked });
  const [category, setCategory] = useState<CustomerCaptureCategory>('damaged_item');
  const [opened, setOpened] = useState(false); const [starting, setStarting] = useState(false); const [ready, setReady] = useState(false); const [shooting, setShooting] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null); const [capture, setCapture] = useState<CustomerCaptureSession | null>(null);
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null); const [error, setError] = useState<Error | string | null>(null); const [notice, setNotice] = useState('');
  const video = useRef<HTMLVideoElement>(null); const viewer = useRef<HTMLDivElement>(null); const nativeInput = useRef<HTMLInputElement>(null);
  const nativePending = useRef<{ sequence: number; ticket: Promise<{ capture: CustomerCaptureSession | null; error: unknown }> } | null>(null);
  const guard = useRef(new CameraStreamGuard()); const sequence = useRef(0); const mounted = useRef(true);
  const phoneCamera = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  function close() { sequence.current++; nativePending.current = null; guard.current.stop(); if (video.current) video.current.srcObject = null; setStream(null); setOpened(false); setStarting(false); setShooting(false); setReady(false); setCapture(null); setPhoto(null); }
  useEffect(() => { props.onBlocked(queueBlocked || opened); }, [queueBlocked, opened, props.onBlocked]);
  useEffect(() => { if (!props.active || props.disabled) close(); }, [props.active, props.disabled]);
  useEffect(() => { const input = nativeInput.current; const onCancel = () => { if (nativePending.current) { close(); setNotice('No photo was taken.'); } }; input?.addEventListener('cancel', onCancel); return () => input?.removeEventListener('cancel', onCancel); }, []);
  useEffect(() => { const onHidden = () => { if (document.visibilityState === 'hidden' && !nativePending.current) { close(); setNotice('The camera was closed while this page was in the background. Open it again when you are ready.'); } }; document.addEventListener('visibilitychange', onHidden); return () => { mounted.current = false; sequence.current++; nativePending.current = null; guard.current.stop(); document.removeEventListener('visibilitychange', onHidden); }; }, []);
  useEffect(() => { if (!photo) return; return () => URL.revokeObjectURL(photo.url); }, [photo]);
  useEffect(() => { const element = video.current; if (!element || !stream) return; element.srcObject = stream; void element.play().catch(() => { if (mounted.current) setError('The camera preview could not play. Close the camera and open it again.'); }); return () => { element.srcObject = null; }; }, [stream]);
  async function open(nextCategory: CustomerCaptureCategory) {
    if (props.disabled || !props.active || queue.rows.length >= props.limits.max_files) return;
    close(); setError(null); setNotice(''); setCategory(nextCategory);
    if (!window.isSecureContext) { setError('Camera access needs a secure connection. Open the HTTPS link from your protection email.'); return; }
    if (phoneCamera && nativeInput.current) {
      const current = ++sequence.current; setOpened(true); setStarting(true);
      const ticket = request<{ capture: CustomerCaptureSession }>('/capture-sessions', { method: 'POST', body: JSON.stringify({ category: nextCategory }) })
        .then(value => ({ capture: value.capture, error: null }), error => ({ capture: null, error }));
      nativePending.current = { sequence: current, ticket };
      nativeInput.current.value = ''; nativeInput.current.click();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) { setError('This browser cannot open a camera. Try Safari or Chrome on a device with a camera, or tell us that you cannot use one.'); return; }
    const current = ++sequence.current; setOpened(true); setStarting(true);
    const mediaPromise = guard.current.open(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, height: { ideal: 1200 } }, audio: false })).then(media => { if (media && mounted.current && current === sequence.current) setStream(media); return media; });
    const ticketPromise = request<{ capture: CustomerCaptureSession }>('/capture-sessions', { method: 'POST', body: JSON.stringify({ category: nextCategory }) });
    const [media, ticket] = await Promise.allSettled([mediaPromise, ticketPromise]);
    if (!mounted.current || current !== sequence.current) return;
    if (media.status === 'rejected' || ticket.status === 'rejected' || !media.value) { const failure = media.status === 'rejected' ? media.reason : ticket.status === 'rejected' ? ticket.reason : new Error('Camera opening was cancelled.'); close(); setError(cameraError(failure)); return; }
    setCapture(ticket.value.capture); setStarting(false); viewer.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  async function useNativePhoto(file: File | undefined) {
    const pending = nativePending.current;
    if (!pending) return;
    if (!file) { close(); setNotice('No photo was taken.'); return; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { close(); setError('This camera format is not supported. Please take a JPEG, PNG or WebP photo.'); return; }
    const result = await pending.ticket;
    if (!mounted.current || pending.sequence !== sequence.current) return;
    nativePending.current = null;
    if (!result.capture) { close(); setError(cameraError(result.error)); return; }
    if (Date.parse(result.capture.expires_at) <= Date.now()) { close(); setError('The camera session expired. Open the camera again to take a new photo.'); return; }
    setCapture(result.capture); setPhoto({ file, url: URL.createObjectURL(file) }); setStarting(false);
    viewer.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  async function takePhoto() {
    const element = video.current;
    if (!element || !ready || !capture || shooting || props.disabled) return;
    if (Date.parse(capture.expires_at) <= Date.now()) { close(); setError('The camera session expired. Open the camera again to take a new photo.'); return; }
    const current = sequence.current; setShooting(true); setError(null);
    try {
      const canvas = document.createElement('canvas'); const scale = Math.min(1, 1920 / Math.max(element.videoWidth, element.videoHeight)); canvas.width = Math.max(1, Math.round(element.videoWidth * scale)); canvas.height = Math.max(1, Math.round(element.videoHeight * scale));
      const context = canvas.getContext('2d'); if (!context || !element.videoWidth) throw new Error('The camera is not ready yet. Wait for the preview and try again.');
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('This photo could not be captured. Please try again.')), 'image/jpeg', 0.9));
      if (!mounted.current || current !== sequence.current) return;
      const file = new File([blob], `${category}-${Date.now()}.jpg`, { type: 'image/jpeg' }); setPhoto({ file, url: URL.createObjectURL(file) }); guard.current.stop(); setStream(null); setReady(false);
    } catch (error) { if (mounted.current && current === sequence.current) setError(cameraError(error)); }
    finally { if (mounted.current && current === sequence.current) setShooting(false); }
  }
  function usePhoto() {
    if (!photo || !capture || props.disabled) return;
    if (Date.parse(capture.expires_at) <= Date.now()) { setError('This photo session expired. Choose Retake to capture a new photo.'); return; }
    if (queue.add([{ file: photo.file, captureId: capture.id, category: capture.category }])) close();
  }
  return <section className="cp-camera-evidence"><div className="cp-upload-heading"><div><h3>Take photos of the damage</h3><p>{props.requireDamaged ? 'Take at least one clear photo of the damaged item with your camera. Packaging and label photos help us review what happened.' : 'If you need to add photos, take them with your camera. You can also send additional details without a photo.'}</p></div></div><p className="cp-muted">Up to {props.limits.max_files} photos. Keep payment cards and identity documents out of the frame.</p>
    {phoneCamera ? <p className="cp-muted">Your phone should offer its camera. If it also offers photos from your library, choose the camera to take a new photo.</p> : <CameraPermissions expanded={!!error} />}
    <input ref={nativeInput} type="file" accept="image/*" capture="environment" hidden disabled={props.disabled || !props.active} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void useNativePhoto(file); }} />
    <ul className="cp-capture-slots">{cameraCategories.map(item => <li key={item.value}><div><h4>{item.label}{item.value === 'damaged_item' && props.requireDamaged && <span>Required</span>}</h4><p>{item.description}</p>{queue.rows.some(row => row.category === item.value && row.evidence) && <small>Photo attached</small>}</div><button className="cp-button" type="button" disabled={props.disabled || !props.active || queue.rows.length >= props.limits.max_files || opened} onClick={() => void open(item.value)} aria-label={`Open camera for ${item.label.toLowerCase()}`}><Icon name="camera" />Open camera</button></li>)}</ul>
    {opened && <div className="cp-camera-viewer" ref={viewer}><div className="cp-camera-viewer-heading"><h4>{cameraCategoryLabel(category)}</h4><button className="cp-text-button" type="button" onClick={close}>{photo ? 'Discard photo' : 'Close camera'}</button></div><div className="cp-camera-preview">{photo ? <img src={photo.url} alt={`Preview of ${cameraCategoryLabel(category).toLowerCase()}`} /> : !phoneCamera && <video ref={video} autoPlay playsInline muted onLoadedData={() => setReady(true)} aria-label="Live camera preview" />}{starting && <span role="status">{phoneCamera ? 'Take a photo with your phone camera…' : 'Allow camera access to start the preview…'}</span>}</div><p className="cp-muted">{photo ? 'Check that the photo is clear and shows the relevant details.' : 'Position the item in the frame. The microphone is not used.'}</p><div className="cp-camera-actions">{photo ? <><button className="cp-button" type="button" onClick={() => void open(category)}>Retake</button><button className="cp-button cp-primary" type="button" onClick={usePhoto}>Use photo</button></> : !phoneCamera && <button className="cp-button cp-primary" type="button" disabled={starting || !ready || !capture || shooting} onClick={() => void takePhoto()}>{shooting ? 'Taking photo…' : 'Take photo'}</button>}</div></div>}
    <ErrorNotice error={error || queue.error} />{notice && <p className="cp-muted" role="status">{notice}</p>}<EvidenceQueueList queue={queue} disabled={props.disabled} />
  </section>;
}
export function CameraException({ value, onChange, disabled }: { value: string | null; onChange: (value: string | null) => void; disabled?: boolean }) {
  const id = useId(); const labelId = `${id}-label`;
  return <div className="cp-camera-exception">{value == null ? <button className="cp-text-button" type="button" disabled={disabled} onClick={() => onChange('')}>I cannot use a camera</button> : <><h3>Tell us why you cannot take photos</h3><p className="cp-muted">Your request can still be sent for manual review. Explain the camera or access problem so the store can help.</p><label className="cp-field" htmlFor={id}><span id={labelId}>Why you cannot use a camera</span><textarea id={id} aria-labelledby={labelId} value={value} minLength={10} maxLength={2000} rows={3} disabled={disabled} onChange={event => onChange(event.target.value)} placeholder="For example, my phone camera is broken or this device has no camera." /></label><button className="cp-text-button" type="button" disabled={disabled} onClick={() => onChange(null)}>Use the camera instead</button></>}</div>;
}
