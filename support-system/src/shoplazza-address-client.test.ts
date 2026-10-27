import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { PassThrough } from 'node:stream';
import { Response, RequestInit } from 'node-fetch';

const STORE = { subdomain: 'fixture', storeName: 'Fixture', accessToken: 'fixture-token' };
function client(fetch: (url: string, init: RequestInit) => Promise<any>, shortDeadline = false) {
  let time = Date.parse('2026-10-26T12:00:00Z');
  class Clock extends Date { static now() { time += 1000; return time; } }
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/shoplazza-client.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, Date: Clock, AbortController, URLSearchParams,
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, shortDeadline && ms === 18000 ? 5 : ms), clearTimeout,
    require(name: string) {
      if (name === 'node-fetch') return fetch;
      if (name === './config') return { buildApiHost: () => 'fixture.invalid' };
      throw new Error(`Forbidden dependency: ${name}`);
    },
  });
  return module.exports as typeof import('./shoplazza-client');
}
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

test('address API uses 2025-06 GET scopes/detail and sends only order.shipping_address on PUT', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const api = client(async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('access_scopes')) return response({ code: 'Success', data: { access_scopes: [{ handle: 'write_order' }] } });
    return response({ code: 'Success', data: { order: { id: 'order/1', shipping_address: { address: 'Street' } } } });
  });
  assert.deepEqual(Array.from(await api.getOrderAddressAccessScopes(STORE)), ['write_order']);
  assert.equal((await api.getOrderForAddressUpdate(STORE, 'order/1')).id, 'order/1');
  const address = { first_name: 'Name', address: 'Street', address1: 'Unit', email: 'unchanged@example.invalid' };
  await api.putOrderShippingAddress(STORE, 'order/1', address);
  assert.equal(requests[0].url, 'https://fixture.invalid/openapi/2025-06/oauth/access_scopes');
  assert.equal(requests[1].url, 'https://fixture.invalid/openapi/2025-06/orders/order%2F1');
  assert.deepEqual(requests.map(request => request.init.method), ['GET', 'GET', 'PUT']);
  assert.deepEqual(JSON.parse(String(requests[2].init.body)), { order: { shipping_address: address } });
  for (const request of requests) {
    assert.equal(request.init.timeout, 18000);
    assert.equal((request.init.headers as Record<string, string>)['Access-Token'], STORE.accessToken);
  }
});

test('malformed/business-error responses and mismatched order IDs fail closed', async t => {
  for (const item of [
    { name: 'business failure', body: { code: 'Error', message: 'fixture secret', data: { order: { id: 'order-1', shipping_address: {} } } } },
    { name: 'wrong order', body: { order: { id: 'different', shipping_address: {} } } },
    { name: 'missing address', body: { order: { id: 'order-1' } } },
    { name: 'array address', body: { order: { id: 'order-1', shipping_address: [] } } },
  ]) await t.test(item.name, async () => {
    const api = client(async () => response(item.body));
    await assert.rejects(api.getOrderForAddressUpdate(STORE, 'order-1'), (error: any) =>
      error instanceof api.ShoplazzaAddressApiError && !error.message.includes('secret'));
  });
  const api = client(async () => response({ data: { access_scopes: [{}] } }));
  await assert.rejects(api.getOrderAddressAccessScopes(STORE), { code: 'invalid_scopes' });
});

test('provider HTTP errors preserve status but never include response bodies or tokens', async () => {
  const api = client(async () => response({ error: `${STORE.accessToken} secret personal address` }, 403));
  await assert.rejects(api.putOrderShippingAddress(STORE, 'order-1', { address: 'Street' }), (error: any) =>
    error.httpStatus === 403 && !error.message.includes('secret') && !error.message.includes(STORE.accessToken));
});

test('the write client rejects unsupported shipping fields before any request', async () => {
  let requests = 0;
  const api = client(async () => { requests++; return response({ code: 'Success' }); });
  await assert.rejects(api.putOrderShippingAddress(STORE, 'order-1', { address2: 'wrong field' }), { code: 'invalid_address' });
  assert.equal(requests, 0);
});

test('hanging GET and PUT bodies time out with no hidden request retry', async t => {
  for (const operation of ['get', 'put'] as const) await t.test(operation, async () => {
    const stream = new PassThrough();
    let requests = 0;
    const api = client(async (url, init) => {
      requests++;
      assert.equal(init.timeout, 18000);
      return new Response(stream, { status: 200, url, timeout: 5 });
    });
    try {
      await assert.rejects(operation === 'get' ? api.getOrderForAddressUpdate(STORE, 'order-1')
        : api.putOrderShippingAddress(STORE, 'order-1', { address: 'Street' }), { code: 'request_failed' });
      assert.equal(requests, 1);
    } finally { stream.destroy(); }
  });
});

test('the absolute deadline remains active after response headers arrive', async () => {
  let aborted = false;
  const api = client(async (_url, init) => ({ ok: true, text: () => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('fixture deadline')); });
  }) }), true);
  await assert.rejects(api.putOrderShippingAddress(STORE, 'order-1', { address: 'Street' }), { code: 'request_failed' });
  assert.equal(aborted, true);
});
