import type { CustomerEvidence } from '../../src/protection-customer-types';
export const API = '/api/protection';
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
const referenceMismatch = 'Another order was opened in this browser. To continue with this order, reopen its secure email link. Your current answers have not been submitted to the other order.';
let protectionReference: string | null = null;
const referenceStorageKey = 'protection.order-reference';
export function initializeProtectionReference(hasNewAccessToken: boolean): void {
  protectionReference = null;
  try {
    if (hasNewAccessToken) window.sessionStorage.removeItem(referenceStorageKey);
    else { const stored = window.sessionStorage.getItem(referenceStorageKey); if (stored) protectionReference = stored; }
  } catch { /* The in-memory binding still protects pages when storage is unavailable. */ }
}
export function setProtectionReference(reference: string): void {
  if (typeof reference !== 'string' || !reference) throw new ApiError('We could not verify the order reference. Please reopen your secure email link.', 502);
  if (protectionReference && protectionReference !== reference) throw new ApiError(referenceMismatch, 409);
  protectionReference = reference;
  try { window.sessionStorage.setItem(referenceStorageKey, reference); } catch { /* No credentials are stored here. */ }
}
export async function exchangeSession(accessToken: string): Promise<void> {
  const result = await request<{ protection_no: string }>('/session', { method: 'POST', body: JSON.stringify({ access_token: accessToken }) });
  setProtectionReference(result.protection_no);
}
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (path !== '/session' && protectionReference) headers.set('X-Protection-Reference', protectionReference);
  else headers.delete('X-Protection-Reference');
  let response: Response;
  try { response = await fetch(API + path, { ...init, credentials: 'same-origin', headers }); }
  catch { throw new ApiError('We could not connect. Check your connection and try again. Your answers are still here.', 0); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok === false) throw new ApiError(data?.error_code === 'protection_reference_mismatch' ? referenceMismatch : response.status === 401 ? 'This access link has expired or is no longer available. Please reopen the secure link in your shipping protection email.' : data?.error || data?.message || 'We could not complete that request. Please try again.', response.status);
  return data as T;
}
export function upload(file: File, onProgress: (progress: number) => void, signal: AbortSignal, uploadId: string, captureId?: string): Promise<CustomerEvidence> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/evidence'); xhr.withCredentials = true;
    if (protectionReference) xhr.setRequestHeader('X-Protection-Reference', protectionReference);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => { let data; try { data = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300 && data?.evidence) resolve(data.evidence);
      else reject(new ApiError(data?.error_code === 'protection_reference_mismatch' ? referenceMismatch : xhr.status === 401 ? 'Your session expired. Open your protection email again before uploading.' : data?.error || 'This file could not be uploaded. Please try again.', xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Upload interrupted. Check your connection and retry this file.', 0));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    const onAbort = () => xhr.abort(); signal.addEventListener('abort', onAbort, { once: true });
    xhr.onloadend = () => signal.removeEventListener('abort', onAbort);
    const form = new FormData(); form.append('upload_id', uploadId); if (captureId) form.append('capture_id', captureId); form.append('file', file); xhr.send(form);
  });
}
