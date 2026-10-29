import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { PassThrough } from 'node:stream';
import { Response, RequestInit } from 'node-fetch';

const STORE = { subdomain: 'fixture', storeName: 'Fixture', accessToken: 'fixture-secret-token' };

// Isolate the HTTP boundary and clock; no application import can open a pool or start a worker.
function client(fetch: (url: string, init: RequestInit) => Promise<unknown>, shortDeadline = false) {
  let now = Date.parse('2026-10-29T12:00:00Z');
  class Clock extends Date { static now() { now += 1000; return now; } }
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, 'shoplazza-client.ts'), 'utf8'), {
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
  const api = module.exports as typeof import('./shoplazza-client');
  assert.equal(typeof api.listOrderFulfillmentsBatch, 'function', 'batch lookup must be exported');
  return api;
}

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function page(orders: unknown[], extra = {}) { return { code: 'Success', data: { orders, ...extra } }; }

test('batch GET deduplicates IDs and retains every package field across all pages', async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const packages = [
    { id: 'f1', order_id: 'order/1', status: 'shipped', tracking_number: 'NEW-1', tracking_company: 'Carrier',
      tracking_company_code: 'carrier', created_at: '2026-10-25T12:00:00Z', updated_at: '2026-10-29T12:00:00Z',
      line_items: [{ id: 'line-1', quantity: 2 }], tracking_numbers: ['OLD-1', 'NEW-1'] },
    { id: 'f2', order_id: 'order/1', tracking_number: 'SECOND-1', line_items: [{ id: 'line-2', quantity: 1 }] },
  ];
  const api = client(async (raw, init) => {
    requests.push({ url: new URL(raw), init });
    if (requests.length === 1) return response(page([{ id: 'order/1', fulfillments: packages }], { has_more: true, cursor: 'page &2' }));
    if (requests.length === 2) return response(page([{ id: 'order-2', fulfillments: [] }], { has_more: true, cursor: 'page-3' }));
    // Live provider observation: a full final page may lead to this terminal sentinel.
    return response({ code: 'Success', data: {} });
  });
  const result = await api.listOrderFulfillmentsBatch(STORE, [' order/1 ', 'order-2', 'missing', 'order/1']);
  assert.deepEqual(Array.from(result.keys()), ['order/1', 'order-2']);
  assert.deepEqual(JSON.parse(JSON.stringify(result.get('order/1'))), packages);
  assert.equal(result.get('order-2')?.length, 0);
  assert.equal(result.has('missing'), false);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(r => r.url.searchParams.get('cursor')), [null, 'page &2', 'page-3']);
  for (const { url, init } of requests) {
    assert.equal(url.origin, 'https://fixture.invalid');
    assert.equal(url.pathname, '/openapi/2025-06/orders');
    assert.deepEqual(url.searchParams.getAll('ids'), ['order/1', 'order-2', 'missing']);
    assert.equal(url.searchParams.get('page_size'), '250');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.timeout, 18000);
    assert.equal((init.headers as Record<string, string>)['Access-Token'], STORE.accessToken);
  }
});

test('empty input makes no request and missing upstream IDs never become empty fulfillments', async () => {
  let requests = 0;
  const api = client(async () => { requests++; return response(page([])); });
  assert.equal((await api.listOrderFulfillmentsBatch(STORE, [])).size, 0);
  assert.equal(requests, 0);
  const result = await api.listOrderFulfillmentsBatch(STORE, ['missing']);
  assert.equal(result.size, 0);
  assert.equal(result.has('missing'), false);
  assert.equal(requests, 1);
});

test('confirmed waiting orders may omit fulfillments without failing shipped orders in the batch', async () => {
  const packages = [{ id: 'package-1', order_id: 'shipped', tracking_number: 'TRACK-1' }];
  const api = client(async () => response(page([
    { id: 'waiting', status: 'placed', financial_status: 'paid', fulfillment_status: 'waiting' },
    { id: 'shipped', fulfillment_status: 'shipped', fulfillments: packages },
  ])));
  const result = await api.listOrderFulfillmentsBatch(STORE, ['waiting', 'shipped', 'missing']);
  assert.equal(result.has('waiting'), true);
  assert.equal(result.get('waiting')?.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.get('shipped'))), packages);
  assert.equal(result.has('missing'), false);
});

test('the fifty-ID limit applies after deduplication and invalid IDs fail before HTTP', async () => {
  let requests = 0;
  const api = client(async raw => {
    requests++;
    assert.equal(new URL(raw).searchParams.getAll('ids').length, 50);
    return response(page([]));
  });
  const fifty = Array.from({ length: 50 }, (_, index) => `order-${index}`);
  await api.listOrderFulfillmentsBatch(STORE, [...fifty, 'order-0']);
  for (const ids of [[''], ['order-1', ' '], [null], [123], [...fifty, 'too-many']]) {
    await assert.rejects(api.listOrderFulfillmentsBatch(STORE, ids as string[]), /requires|IDs|limit/);
  }
  assert.equal(requests, 1);
});

test('identical duplicate orders are idempotent but conflicting duplicate orders fail closed', async () => {
  for (const conflict of [false, true]) {
    let requests = 0;
    const api = client(async () => {
      requests++;
      return response(page([{ id: 'order-1', fulfillments: requests === 1
        ? [{ id: 'f1', tracking_number: 'A', order_id: 'order-1' }]
        : [{ order_id: 'order-1', tracking_number: conflict ? 'B' : 'A', id: 'f1' }] }],
      requests === 1 ? { has_more: true, cursor: 'next' } : {}));
    });
    if (conflict) await assert.rejects(api.listOrderFulfillmentsBatch(STORE, ['order-1']), /conflicting duplicate/);
    else {
      const result = await api.listOrderFulfillmentsBatch(STORE, ['order-1']);
      assert.equal(result.size, 1);
      assert.equal(result.get('order-1')?.length, 1);
      assert.equal(result.get('order-1')?.[0].tracking_number, 'A');
    }
  }
});

test('malformed or unrelated results reject the batch instead of yielding successful empties', async t => {
  const cases: Array<{ name: string; body: unknown }> = [
    { name: 'null envelope', body: null },
    { name: 'array envelope', body: [] },
    { name: 'business error', body: { code: 'Error', message: 'private', data: { orders: [] } } },
    { name: 'missing orders', body: { code: 'Success' } },
    { name: 'empty data without success', body: { data: {} } },
    { name: 'null data', body: { code: 'Success', data: null } },
    { name: 'array data', body: { code: 'Success', data: [] } },
    { name: 'unexpected empty data fields', body: { code: 'Success', data: { error: 'private' } } },
    { name: 'non-array orders', body: { data: { orders: {} } } },
    { name: 'null order', body: page([null]) },
    { name: 'array order', body: page([[]]) },
    { name: 'order without ID', body: page([{ fulfillments: [] }]) },
    { name: 'non-string ID', body: page([{ id: 1, fulfillments: [] }]) },
    { name: 'ignored ID filter', body: page([{ id: 'unrequested-order', fulfillments: [] }]) },
    { name: 'missing fulfillments', body: page([{ id: 'order-1' }]) },
    { name: 'shipped order without fulfillments', body: page([{ id: 'order-1', fulfillment_status: 'shipped' }]) },
    { name: 'unknown status without fulfillments', body: page([{ id: 'order-1', fulfillment_status: 'unknown' }]) },
    { name: 'waiting order with explicit null fulfillments', body: page([{ id: 'order-1', fulfillment_status: 'waiting', fulfillments: null }]) },
    { name: 'null fulfillments', body: page([{ id: 'order-1', fulfillments: null }]) },
    { name: 'non-array fulfillments', body: page([{ id: 'order-1', fulfillments: {} }]) },
    { name: 'null fulfillment', body: page([{ id: 'order-1', fulfillments: [null] }]) },
    { name: 'array fulfillment', body: page([{ id: 'order-1', fulfillments: [[]] }]) },
    { name: 'wrong fulfillment order', body: page([{ id: 'order-1', fulfillments: [{ order_id: 'other' }] }]) },
    { name: 'null fulfillment order', body: page([{ id: 'order-1', fulfillments: [{ order_id: null }] }]) },
    { name: 'conflicting fulfillment ID', body: page([{ id: 'order-1', fulfillments: [{ id: 'f1', tracking_number: 'A' }, { id: 'f1', tracking_number: 'B' }] }]) },
    { name: 'string pagination flag', body: page([], { has_more: 'false' }) },
    { name: 'null pagination flag', body: page([], { has_more: null }) },
    { name: 'empty page with continuation', body: page([], { has_more: true, cursor: 'next' }) },
    { name: 'missing cursor', body: page([{ id: 'order-1', fulfillments: [] }], { has_more: true }) },
    { name: 'blank cursor', body: page([{ id: 'order-1', fulfillments: [] }], { has_more: true, cursor: ' ' }) },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const api = client(async () => response(scenario.body));
    await assert.rejects(api.listOrderFulfillmentsBatch(STORE, ['order-1']), /Fulfillment batch/);
  });
});

test('a later bad page rejects all earlier data and repeated cursors cannot return partial success', async () => {
  for (const second of [page([{ id: 'unrequested', fulfillments: [] }]),
    page([{ id: 'order-1', fulfillments: [] }], { has_more: true, cursor: 'again' })]) {
    let requests = 0;
    const api = client(async () => response(++requests === 1
      ? page([{ id: 'order-1', fulfillments: [] }], { has_more: true, cursor: 'again' }) : second));
    await assert.rejects(api.listOrderFulfillmentsBatch(STORE, ['order-1']), /Fulfillment batch/);
    assert.equal(requests, 2);
  }
});

test('a provider that emits endless unique cursors fails at the page bound', async () => {
  let requests = 0;
  const api = client(async () => response(page([{ id: 'order-1', fulfillments: [] }], { has_more: true, cursor: `page-${++requests}` })));
  await assert.rejects(api.listOrderFulfillmentsBatch(STORE, ['order-1']), /exceeded 200 pages/);
  assert.equal(requests, 200);
});

test('HTTP, network, JSON and body-read errors expose only safe error text with no retry', async t => {
  const sensitive = `${STORE.accessToken} customer@example.invalid private-address https://fixture.invalid?secret=value`;
  const cases = [
    { name: 'HTTP', fetch: async () => ({ ok: false, status: 503, text: async () => { throw Error('must not read body'); } }), expected: /HTTP 503/ },
    { name: 'network', fetch: async () => { throw Error(sensitive); }, expected: /request failed/ },
    { name: 'invalid JSON', fetch: async () => ({ ok: true, text: async () => sensitive }), expected: /request failed/ },
    { name: 'body reader', fetch: async () => ({ ok: true, text: async () => { throw Error(sensitive); } }), expected: /request failed/ },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    let requests = 0;
    const api = client(async () => { requests++; return scenario.fetch(); });
    await assert.rejects(api.listOrderFulfillmentsBatch(STORE, ['order-1']), (error: any) => {
      assert.match(error.message, scenario.expected);
      assert.doesNotMatch(String(error.stack), /fixture-secret|customer@|private-address|secret=value/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(requests, 1);
  });
});

test('body timeouts reject safely and the absolute deadline remains active through the body', async () => {
  const body = new PassThrough();
  const timedBody = client(async (_url, init) => {
    assert.equal(init.timeout, 18000);
    return new Response(body, { status: 200, timeout: 5, url: 'https://fixture.invalid/private' });
  });
  try { await assert.rejects(timedBody.listOrderFulfillmentsBatch(STORE, ['order-1']), /Fulfillment batch request failed/); }
  finally { body.destroy(); }
  let aborted = false;
  const deadline = client(async (_url, init) => ({ ok: true, text: () => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => { aborted = true; reject(Error('private URL')); });
  }) }), true);
  await assert.rejects(deadline.listOrderFulfillmentsBatch(STORE, ['order-1']), /Fulfillment batch request failed/);
  assert.equal(aborted, true);
});
