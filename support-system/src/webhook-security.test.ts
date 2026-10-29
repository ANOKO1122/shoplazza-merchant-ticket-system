import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildWebhookCallbackUrl, configureWebhookRejectionLogging, logWebhookRejection, redactWebhookAddress, requireWebhookAuth } from './webhook-security';
import type { OperationLogParams } from './log-service';

function withSecret(t: import('node:test').TestContext) {
  const logs: Array<{ prefix: string; details: Record<string, unknown> }> = [];
  t.mock.method(console, 'warn', (prefix: string, json: string) => { logs.push({ prefix, details: JSON.parse(json) }); });
  const previous = process.env.SUPPORT_WEBHOOK_SECRET;
  process.env.SUPPORT_WEBHOOK_SECRET = 'fixture-only-callback-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.SUPPORT_WEBHOOK_SECRET;
    else process.env.SUPPORT_WEBHOOK_SECRET = previous;
  });
  return logs;
}

function checkAuth(key: unknown, store = 'store-a', domain = 'store-a.myshoplaza.com', extraHeaders: Record<string, string> = {}) {
  let status = 200;
  let accepted = false;
  const headers: Record<string, string> = { 'x-shoplazza-shop-domain': domain, ...extraHeaders };
  const req = { query: { key }, params: { storeSubdomain: store }, get: (name: string) => headers[name.toLowerCase()] };
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

test('authentication rejections distinguish missing, malformed, incorrect and wrong-store credentials without exposing them', t => {
  const logs = withSecret(t);
  const validKey = new URL(buildWebhookCallbackUrl('https://support.example.invalid', 'store-a')).searchParams.get('key');
  const headers = { 'x-shoplazza-topic': 'fulfillments/update', 'x-shoplazza-deduplication-id': 'fixture-delivery-123' };
  checkAuth(undefined, 'store-a', 'store-a.myshoplaza.com', headers);
  checkAuth('bad-key-secret', 'store-a', 'store-a.myshoplaza.com', headers);
  checkAuth([validKey], 'store-a', 'store-a.myshoplaza.com', headers);
  checkAuth('0'.repeat(64), 'store-a', 'store-a.myshoplaza.com', headers);
  checkAuth(validKey, 'store-a', 'store-b.myshoplaza.com', headers);
  assert.deepEqual(logs.map(log => log.details.reason), ['missing_key', 'malformed_key', 'malformed_key', 'key_mismatch', 'store_mismatch']);
  const expectedHash = crypto.createHash('sha256').update(headers['x-shoplazza-deduplication-id']).digest('hex').slice(0, 16);
  assert.ok(logs.every(log => log.prefix === '[webhook-rejected]' && log.details.shop === 'store-a'
    && log.details.topic === 'fulfillments/update' && log.details.deliveryIdHash === expectedHash));
  assert.equal(logs[4].details.headerShop, 'store-b.myshoplaza.com');
  assert.deepEqual(checkAuth(validKey), { status: 200, accepted: true });
  assert.equal(logs.length, 5, 'successful authentication should not create rejection logs');
  const output = JSON.stringify(logs);
  for (const secret of [validKey!, 'bad-key-secret', '0'.repeat(64), headers['x-shoplazza-deduplication-id'], process.env.SUPPORT_WEBHOOK_SECRET!]) {
    assert.ok(!output.includes(secret));
  }
});

test('rejection audit retains only bounded safe metadata, including for hostile path and header values', async t => {
  const logs = withSecret(t);
  const retained: OperationLogParams[] = [];
  configureWebhookRejectionLogging(async entry => { retained.push(entry); });
  t.after(() => configureWebhookRejectionLogging());
  const key = 'a'.repeat(64);
  const email = 'customer-private@example.invalid';
  const headers: Record<string, string> = {
    'x-shoplazza-shop-domain': `${email}?key=${key}`,
    'x-shoplazza-topic': 'fulfillments/update\nforged-log',
    'x-shoplazza-deduplication-id': `delivery:${email}:${key}`,
    'user-agent': `${email} ${key}`,
  };
  const req = {
    params: { storeSubdomain: key },
    get: (name: string) => headers[name.toLowerCase()],
    get query(): never { throw new Error('logger must not read query'); },
    get body(): never { throw new Error('logger must not read body'); },
    get originalUrl(): never { throw new Error('logger must not read URL'); },
  };
  const before = Date.now();
  logWebhookRejection(req as any, 'invalid_payload');
  const after = Date.now();
  assert.equal(retained.length, 0, 'audit persistence must not run on the response path');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(Object.keys(logs[0].details).sort(), ['deliveryIdHash', 'headerShop', 'reason', 'receivedAt', 'shop', 'topic']);
  assert.equal(logs[0].details.shop, '[invalid]');
  assert.equal(logs[0].details.headerShop, '[invalid]');
  assert.equal(logs[0].details.topic, '[invalid]');
  assert.match(String(logs[0].details.deliveryIdHash), /^[a-f0-9]{16}$/);
  const receivedAt = Date.parse(String(logs[0].details.receivedAt));
  assert.ok(receivedAt >= before && receivedAt <= after);
  assert.deepEqual(retained, [{
    category: 'webhook', action: 'rejected', actor: 'system', storeSubdomain: undefined,
    summary: 'Webhook rejected: invalid_payload', status: 'failed', failedAtStep: 'ingress',
    detailJson: logs[0].details,
  }]);
  const output = JSON.stringify({ logs, retained });
  for (const forbidden of [key, email, 'forged-log', 'user-agent']) assert.ok(!output.includes(forbidden));
  assert.ok(JSON.stringify(logs[0]).length < 350);
  logWebhookRejection(req as any, `untrusted:${key}` as any);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(logs[1].details.reason, 'unknown_rejection');
  assert.equal(retained[1].summary, 'Webhook rejected: unknown_rejection');
  assert.ok(!JSON.stringify(retained).includes(key));
});

test('authentication responds before a pending audit write finishes and retains the safe store and reason', async t => {
  const logs = withSecret(t);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const retained: OperationLogParams[] = [];
  configureWebhookRejectionLogging(async entry => { retained.push(entry); await pending; });
  t.after(() => { release(); configureWebhookRejectionLogging(); });
  assert.deepEqual(checkAuth('bad-key-secret'), { status: 401, accepted: false });
  assert.equal(retained.length, 0);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(retained.length, 1);
  assert.equal(retained[0].storeSubdomain, 'store-a');
  assert.equal(retained[0].detailJson?.reason, 'malformed_key');
  assert.equal(logs[0].prefix, '[webhook-rejected]');
  const key = new URL(buildWebhookCallbackUrl('https://support.example.invalid', 'store-a')).searchParams.get('key');
  assert.deepEqual(checkAuth(key), { status: 200, accepted: true });
  assert.equal(retained.length, 1);
});

for (const failure of ['throw', 'reject'] as const) {
  test(`audit sink ${failure} does not change rejection responses or leak errors`, async t => {
    const logs = withSecret(t);
    const secret = 'private-database-error@example.invalid?key=fixture-secret';
    configureWebhookRejectionLogging(() => {
      if (failure === 'throw') throw new Error(secret);
      return Promise.reject(new Error(secret));
    });
    t.after(() => configureWebhookRejectionLogging());
    assert.deepEqual(checkAuth(undefined), { status: 401, accepted: false });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(logs.map(log => log.prefix), ['[webhook-rejected]', '[webhook-rejection-audit-failed]']);
    assert.equal(logs[1].details.reason, 'missing_key');
    assert.ok(!JSON.stringify(logs).includes(secret));
  });
}

test('console failures cannot prevent authentication rejection or create unhandled audit errors', async t => {
  withSecret(t);
  t.mock.method(console, 'warn', () => { throw new Error('fixture console unavailable'); });
  let writes = 0;
  configureWebhookRejectionLogging(async () => { writes++; throw new Error('fixture sink unavailable'); });
  t.after(() => configureWebhookRejectionLogging());
  assert.deepEqual(checkAuth(undefined), { status: 401, accepted: false });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(writes, 1);
});
