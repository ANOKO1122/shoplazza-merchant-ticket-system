import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, exchangeSession, initializeProtectionReference, request, setProtectionReference, upload } from './api';
test('a page keeps its order reference after another tab replaces the session, including uploads and deletes', async () => {
  const savedFetch = globalThis.fetch;
  const savedXhr = globalThis.XMLHttpRequest;
  const savedWindow = globalThis.window;
  const stored = new Map<string, string>();
  globalThis.window = { sessionStorage: { getItem: (key: string) => stored.get(key) || null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } } } as unknown as Window & typeof globalThis;
  const sent: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (async (url, options) => {
    sent.push({ url: String(url), headers: new Headers(options?.headers) });
    if (sent.length === 1) return new Response(JSON.stringify({ ok: true, protection_no: 'SP-tab-A' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: false, error_code: 'protection_reference_mismatch' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  let xhrHeaders: Record<string, string> = {};
  let uploadForm: FormData | null = null;
  class FakeXhr {
    upload = {}; withCredentials = false; status = 409; responseText = JSON.stringify({ error_code: 'protection_reference_mismatch' });
    onload?: () => void; onloadend?: () => void;
    open() {} setRequestHeader(name: string, value: string) { xhrHeaders[name] = value; }
    send(form: FormData) { uploadForm = form; this.onload?.(); this.onloadend?.(); }
  }
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  try {
    initializeProtectionReference(true);
    await exchangeSession('private-access-token');
    assert.deepEqual([...stored.values()], ['SP-tab-A'], 'store only the public reference, never the access credential');
    await assert.rejects(request('/order'), (error: unknown) => error instanceof ApiError && error.status === 409 && /reopen.*secure email link/i.test(error.message));
    await assert.rejects(request('/claims', { method: 'POST', body: '{}' }));
    await assert.rejects(request('/evidence/file', { method: 'DELETE', body: '{}' }));
    await assert.rejects(request('/session', { method: 'POST', body: '{}' }));
    assert.deepEqual(sent.map(item => item.headers.get('X-Protection-Reference')), [null, 'SP-tab-A', 'SP-tab-A', 'SP-tab-A', null]);
    assert.throws(() => setProtectionReference('SP-tab-B'), /reopen.*secure email link/i);
    await assert.rejects(upload(new File(['file'], 'image.png', { type: 'image/png' }), () => {}, new AbortController().signal, 'fixture-upload', 'capture-ticket'), /reopen.*secure email link/i);
    assert.equal(xhrHeaders['X-Protection-Reference'], 'SP-tab-A');
    assert.equal((uploadForm as unknown as FormData).get('capture_id'), 'capture-ticket');
    assert.equal((uploadForm as unknown as FormData).get('upload_id'), 'fixture-upload');
    initializeProtectionReference(false);
    await assert.rejects(request('/order'));
    assert.equal(sent.at(-1)?.headers.get('X-Protection-Reference'), 'SP-tab-A', 'a reload retains this tab’s original order');
    initializeProtectionReference(true);
    assert.equal(stored.size, 0, 'a new explicit email link can replace the previous binding');
    setProtectionReference('SP-tab-B');
    await assert.rejects(request('/order'));
    assert.equal(sent.at(-1)?.headers.get('X-Protection-Reference'), 'SP-tab-B');
  } finally { globalThis.fetch = savedFetch; globalThis.XMLHttpRequest = savedXhr; globalThis.window = savedWindow; }
});
