import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWebhookCallbackUrl, redactWebhookAddress, requireWebhookAuth } from './webhook-security';

function withSecret(t: import('node:test').TestContext) {
  const previous = process.env.SUPPORT_WEBHOOK_SECRET;
  process.env.SUPPORT_WEBHOOK_SECRET = 'fixture-only-callback-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.SUPPORT_WEBHOOK_SECRET;
    else process.env.SUPPORT_WEBHOOK_SECRET = previous;
  });
}

function checkAuth(key: unknown, store = 'store-a', domain = 'store-a.myshoplaza.com') {
  let status = 200;
  let accepted = false;
  const req = { query: { key }, params: { storeSubdomain: store }, get: () => domain };
  const res = { status(n: number) { status = n; return this; }, json() { return this; } };
  requireWebhookAuth(req as any, res as any, error => {
    if (error) throw error;
    accepted = true;
  });
  return { status, accepted };
}

test('callback credentials are stable per store, distinct across stores and require HTTPS', t => {
  withSecret(t);
  const url = buildWebhookCallbackUrl('https://support.example.invalid/', 'store-a');
  const key = new URL(url).searchParams.get('key');
  assert.match(key!, /^[a-f0-9]{64}$/);
  assert.equal(url, buildWebhookCallbackUrl('https://support.example.invalid', 'store-a'));
  assert.notEqual(key, new URL(buildWebhookCallbackUrl('https://support.example.invalid', 'store-b')).searchParams.get('key'));
  assert.throws(() => buildWebhookCallbackUrl('http://support.example.invalid', 'store-a'), /HTTPS/);
  assert.deepEqual(checkAuth(key), { status: 200, accepted: true });
  assert.deepEqual(checkAuth(key, 'store-b', 'store-b.myshoplaza.com'), { status: 401, accepted: false });
});

test('unauthenticated, malformed and wrong-store callbacks never enter the handler', t => {
  withSecret(t);
  for (const key of [undefined, '', 'bad', '0'.repeat(64), ['0'.repeat(64)], { key: '0'.repeat(64) }]) {
    assert.deepEqual(checkAuth(key), { status: 401, accepted: false });
  }
  const key = new URL(buildWebhookCallbackUrl('https://support.example.invalid', 'store-a')).searchParams.get('key');
  assert.deepEqual(checkAuth(key, 'store-a', ''), { status: 403, accepted: false });
  assert.deepEqual(checkAuth(key, 'store-a', 'store-b.myshoplaza.com'), { status: 403, accepted: false });
});

test('credential rotation invalidates old callback keys and addresses are redacted', t => {
  withSecret(t);
  const url = buildWebhookCallbackUrl('https://support.example.invalid', 'store-a');
  const key = new URL(url).searchParams.get('key');
  process.env.SUPPORT_WEBHOOK_SECRET = 'rotated-fixture-secret';
  assert.deepEqual(checkAuth(key), { status: 401, accepted: false });
  assert.equal(redactWebhookAddress(url), 'https://support.example.invalid/api/shoplazza/webhook/store-a');
  assert.equal(redactWebhookAddress('https://user:secret@example.invalid/hook?key=secret#secret'), 'https://example.invalid/hook');
});
