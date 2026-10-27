import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { PassThrough } from 'node:stream';
import { Response, RequestInit } from 'node-fetch';

const NOW = '2026-10-26T12:00:00.000Z';
const STORE = { subdomain: 'store-a', storeName: 'Store A', accessToken: 'fixture-only' };

// Never import real application dependencies: unexpected imports, queries and calls fail closed.
function isolatedModule<T>(filename: string, dependencies: Record<string, unknown>, now?: () => number): T {
  let clock = Date.parse(NOW);
  class FixedDate extends Date {
    constructor(value?: string | number) { super(value ?? NOW); }
    static now() { if (now) return now(); clock += 1000; return clock; }
  }
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src', filename), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name: string) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    Date: FixedDate, URLSearchParams, AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
  }, { filename });
  return module.exports as T;
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function api(fetch: (url: string, init?: RequestInit) => Promise<unknown>) {
  return isolatedModule<typeof import('./shoplazza-client')>('shoplazza-client.ts', {
    './config': { buildApiHost: () => 'fixture.invalid' },
    'node-fetch': fetch,
  });
}

test('fulfillment API reads the order endpoint and retains all pages', async () => {
  const urls: URL[] = [];
  const client = api(async raw => {
    urls.push(new URL(raw));
    return urls.length === 1
      ? response({ code: 'Success', data: { fulfillments: [{ id: 'f1', order_id: 'order/1', tracking_number: 'A' }], has_more: true, cursor: 'page-2' } })
      : response({ code: 'Success', data: { fulfillments: [{ id: 'f2', order_id: 'order/1', tracking_number: 'B' }] } });
  });
  const items = await client.listOrderFulfillments(STORE, 'order/1');
  assert.equal(urls[0].pathname, '/openapi/2025-06/orders/order%2F1/fulfillments');
  assert.equal(urls[1].searchParams.get('cursor'), 'page-2');
  assert.deepEqual(Array.from(items, item => item.id), ['f1', 'f2']);
});

test('fulfillment API accepts explicit empty lists and the observed Success empty data response', async () => {
  for (const body of [{ code: 'Success', data: { fulfillments: [] } }, { code: 'Success', data: {} }]) {
    assert.equal((await api(async () => response(body)).listOrderFulfillments(STORE, 'order-1')).length, 0);
  }
});

test('fulfillment response body timeout fails the check and releases the batch lock for retry', async () => {
  const pendingBody = new PassThrough();
  const client = api(async (_url, init) => {
    assert.equal(init?.timeout, 18000);
    // Exercise node-fetch 2's actual body reader with an unfinished in-memory stream.
    // Only the test response's clock is shortened; no real request or 18-second wait.
    return new Response(pendingBody, { status: 200, timeout: 1, url: 'https://fixture.invalid/fulfillments' });
  });
  const { run, calls } = harness({
    candidates: [candidate('slow-body')],
    list: async id => client.listOrderFulfillments(STORE, id),
  });
  try {
    const summary = await run();
    assert.equal(summary.failed, 1);
    assert.equal(calls.applied.length, 0);
    assert.equal(calls.state.length, 1);
    assert.match(calls.state[0].sql, /interval '1 hour'/);
    assert.doesNotMatch(calls.state[0].sql, /last_checked_at/);
    assert.match(calls.state[0].params[3], /Response timeout/);
    assert.equal(calls.unlocks, 1);
    assert.equal(calls.released.length, 1);
  } finally {
    pendingBody.destroy();
  }
});

test('existing order GET requests also bound response bodies', async () => {
  const timeouts: Array<number | undefined> = [];
  const client = api(async (_url, init) => {
    timeouts.push(init?.timeout);
    return response({ orders: [], has_more: false });
  });
  await client.listPaidOrdersCreatedSince(STORE, NOW, NOW);
  assert.deepEqual(timeouts, [18000]);
});

test('fulfillment API does not turn HTTP, business or malformed responses into an empty result', async t => {
  const cases = [
    { name: 'HTTP error', status: 503, body: {}, error: /HTTP 503/ },
    { name: 'business error with empty data', body: { code: 'Error', data: {} }, error: /unsuccessful code/ },
    { name: 'business error with a list', body: { code: 'Error', data: { fulfillments: [] } }, error: /unsuccessful code/ },
    { name: 'missing data', body: { code: 'Success' }, error: /valid fulfillments array/ },
    { name: 'empty data without Success', body: { data: {} }, error: /valid fulfillments array/ },
    { name: 'null data', body: { code: 'Success', data: null }, error: /valid fulfillments array/ },
    { name: 'array data', body: { code: 'Success', data: [] }, error: /valid fulfillments array/ },
    { name: 'unexpected data fields', body: { code: 'Success', data: { error: 'failed' } }, error: /valid fulfillments array/ },
    { name: 'malformed item', body: { data: { fulfillments: [null] } }, error: /valid fulfillments array/ },
    { name: 'other order', body: { data: { fulfillments: [{ id: 'f1', order_id: 'other-order' }] } }, error: /different order/ },
    { name: 'invalid pagination flag', body: { data: { fulfillments: [], has_more: 'false' } }, error: /pagination flag/ },
    { name: 'empty page with more results', body: { code: 'Success', data: {}, has_more: true, cursor: 'next' }, error: /pagination/ },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await assert.rejects(api(async () => response(scenario.body, scenario.status)).listOrderFulfillments(STORE, 'order-1'), scenario.error);
    });
  }
  await t.test('invalid JSON', async () => {
    await assert.rejects(api(async () => ({ ok: true, text: async () => '{broken' })).listOrderFulfillments(STORE, 'order-1'));
  });
  await t.test('repeated cursor', async () => {
    let requests = 0;
    const client = api(async () => {
      requests++;
      return response({ data: { fulfillments: [{ id: 'f1' }], has_more: true, cursor: 'same' } });
    });
    await assert.rejects(client.listOrderFulfillments(STORE, 'order-1'), /repeated/);
    assert.equal(requests, 2);
  });
});

interface Candidate { store_subdomain: string; order_id: string; order_number: string; }

function harness(options: {
  candidates?: Candidate[];
  locked?: boolean;
  list?: (orderId: string) => Promise<Record<string, unknown>[]>;
  apply?: (params: any) => Promise<any>;
  selectionError?: boolean;
  unlockError?: boolean;
  now?: () => number;
  onQuery?: (sql: string, params: any[]) => void;
  onLog?: () => void;
} = {}) {
  const calls = { connections: 0, unlocks: 0, released: [] as unknown[], selections: [] as Array<{ sql: string; params: any[] }>, state: [] as Array<{ sql: string; params: any[] }>, api: [] as string[], applied: [] as any[], logs: [] as any[] };
  const stores = ['store-a', 'store-b'].map(subdomain => ({ subdomain, store_name: subdomain, access_token: 'fixture-only', enabled: true }));
  const client = {
    async query(sql: string, params: any[] = []) {
      options.onQuery?.(sql, params);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: options.locked !== false }] };
      if (sql.includes('pg_advisory_unlock')) {
        calls.unlocks++;
        if (options.unlockError) throw new Error('simulated unlock error');
        return { rows: [{}] };
      }
      if (sql.includes('WITH paid_orders')) {
        calls.selections.push({ sql, params });
        if (options.selectionError) throw new Error('simulated selection error');
        return { rows: (options.candidates || []).filter(item => params[0].includes(item.store_subdomain) && (!params[1] || item.order_id === params[1])).slice(0, params[2]) };
      }
      if (sql.includes('INSERT INTO support_fulfillment_sync_state')) {
        calls.state.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('AS remaining_due')) return { rows: [{ store_subdomain: 'store-a', remaining_due: 7 }] };
      throw new Error(`Unexpected database operation: ${sql}`);
    },
    release(error?: unknown) { calls.released.push(error); },
  };
  const reconciler = isolatedModule<typeof import('./fulfillment-reconcile')>('fulfillment-reconcile.ts', {
    './pg': { getClient: async () => { calls.connections++; return client; } },
    './store-service': { getEnabledStores: async () => stores },
    './shoplazza-client': { listOrderFulfillments: async (_store: unknown, id: string) => { calls.api.push(id); return options.list ? options.list(id) : [{ id: 'f1', order_id: id }]; } },
    './fulfillment-service': { applyFulfillmentUpdate: async (params: any) => {
      calls.applied.push(params);
      return options.apply ? options.apply(params) : { matched: true, added: 1, updated: 0, unchanged: 0, stale: 0, changes: [{ id: 'f1', kind: 'added' }], trackingNumbers: ['TRACK'] };
    } },
    './log-service': { logSync: async (entry: unknown) => { calls.logs.push(entry); options.onLog?.(); } },
  }, options.now);
  return { run: reconciler.runFulfillmentReconciliation, calls };
}

function candidate(orderId: string, store = 'store-a'): Candidate {
  return { store_subdomain: store, order_id: orderId, order_number: orderId };
}

test('reconciliation includes old paid orders, has one global batch limit and schedules successful checks for 24 hours', async () => {
  const input = Array.from({ length: 230 }, (_, i) => candidate(i === 0 ? 'old-order-from-2024' : `order-${i}`, i % 2 ? 'store-b' : 'store-a'));
  const { run, calls } = harness({ candidates: input });
  const summary = await run({ limit: 1000 });
  assert.equal(summary.checked, 200);
  assert.equal(calls.api.length, 200);
  assert.ok(calls.api.includes('old-order-from-2024'));
  assert.equal(summary.stores[0].checked, 100);
  assert.equal(summary.stores[1].checked, 100);
  assert.equal(summary.remainingDue, 7);
  assert.equal(calls.selections[0].params[2], 200);
  const sql = calls.selections[0].sql;
  assert.match(sql, /snapshot.payment_status IN \('paid', 'partially_refunded'\)/);
  assert.match(sql, /GROUP BY snapshot.store_subdomain, snapshot.order_id/);
  assert.match(sql, /PARTITION BY \(state.last_attempt_at IS NULL\)/);
  assert.match(sql, /state.next_check_at <= now\(\)/);
  assert.doesNotMatch(sql, /(?:created_at|paid_at)\s*[<>]=?/);
  assert.ok(calls.state.every(write => write.sql.includes("interval '24 hours'") && write.sql.includes('last_checked_at = EXCLUDED.last_checked_at')));
  assert.ok(calls.applied.every(params => params.source === 'backfill' && !('fulfillmentStatus' in params)));
  assert.equal(calls.logs.length, 2);
  assert.ok(calls.logs.every(log => log.source === 'backfill' && log.action === 'fulfillment_reconcile_summary' && log.detailJson.checked === 100));
  assert.equal(calls.unlocks, 1);
  assert.equal(calls.released.length, 1);
});

test('API failure and unmatched updates retry in one hour without recording a successful check', async () => {
  const { run, calls } = harness({
    candidates: [candidate('api-error'), candidate('missing-snapshot'), candidate('unchanged')],
    list: async id => { if (id === 'api-error') throw new Error('Fulfillment list HTTP 503'); return []; },
    apply: async params => ({ matched: params.orderId !== 'missing-snapshot', added: 0, updated: 0, unchanged: 1, stale: 0, changes: [], trackingNumbers: [] }),
  });
  const summary = await run();
  assert.equal(summary.checked, 3);
  assert.equal(summary.failed, 2);
  assert.equal(summary.changed, 0);
  const failed = calls.state.filter(write => write.sql.includes("interval '1 hour'"));
  assert.equal(failed.length, 2);
  assert.ok(failed.every(write => !write.sql.includes('last_checked_at')));
  assert.equal(calls.logs[0].status, 'partial');
  assert.equal(calls.logs[0].detailJson.items.filter((item: any) => item.status === 'failed').length, 2);
  assert.equal(calls.applied.length, 2);
});

test('store durations accumulate only their own checks while batch duration includes shared work', async () => {
  let clock = Date.parse(NOW);
  const apiDurations: Record<string, number> = { 'a-first': 100, 'b-first': 300, 'a-second': 200 };
  const { run, calls } = harness({
    candidates: [candidate('a-first'), candidate('b-first', 'store-b'), candidate('a-second')],
    now: () => clock,
    list: async id => { clock += apiDurations[id]; return []; },
    apply: async () => {
      clock += 20;
      return { matched: true, added: 0, updated: 0, unchanged: 1, stale: 0, changes: [], trackingNumbers: [] };
    },
    onQuery: sql => {
      if (sql.includes('WITH paid_orders')) clock += 40;
      if (sql.includes('INSERT INTO support_fulfillment_sync_state')) clock += 7;
      if (sql.includes('AS remaining_due')) clock += 60;
    },
    onLog: () => { clock += 50; },
  });
  const summary = await run();
  assert.equal(summary.stores[0].durationMs, 354);
  assert.equal(summary.stores[1].durationMs, 327);
  assert.deepEqual(calls.logs.map(log => log.durationMs), [354, 327]);
  // Both logs describe the same batch; writing the first log must not inflate the second.
  assert.deepEqual(calls.logs.map(log => log.detailJson.batchDurationMs), [781, 781]);
});

test('failed checks include retry state writes in store duration and unchecked stores retain backlog without logs', async () => {
  let clock = Date.parse(NOW);
  const { run, calls } = harness({
    candidates: [candidate('failed-order', 'store-b')],
    now: () => clock,
    list: async () => { clock += 75; throw new Error('simulated API failure'); },
    onQuery: sql => { if (sql.includes('INSERT INTO support_fulfillment_sync_state')) clock += 25; },
  });
  const summary = await run();
  assert.equal(summary.stores.length, 2);
  assert.equal(summary.stores[0].checked, 0);
  assert.equal(summary.stores[0].durationMs, 0);
  assert.equal(summary.stores[0].remainingDue, 7);
  assert.equal(summary.remainingDue, 7);
  assert.equal(summary.stores[1].durationMs, 100);
  assert.equal(calls.logs.length, 1);
  assert.equal(calls.logs[0].storeSubdomain, 'store-b');
  assert.equal(calls.logs[0].durationMs, 100);
  assert.equal(calls.logs[0].detailJson.batchDurationMs, 100);
  assert.equal(calls.logs[0].status, 'failed');
});

test('a batch with no checked orders returns all stores and backlog without summary logs', async () => {
  const { run, calls } = harness();
  const summary = await run();
  assert.equal(summary.checked, 0);
  assert.equal(summary.stores.length, 2);
  assert.equal(summary.remainingDue, 7);
  assert.equal(calls.logs.length, 0);
});

test('forced reconciliation filters a single order and bypasses its next due time', async () => {
  const { run, calls } = harness({ candidates: [candidate('already-checked'), candidate('other'), candidate('already-checked', 'store-b')] });
  const summary = await run({ storeSubdomain: 'store-a', orderId: 'already-checked', limit: 1 });
  assert.equal(summary.checked, 1);
  assert.deepEqual(calls.api, ['already-checked']);
  assert.deepEqual(Array.from(calls.selections[0].params[0]), ['store-a']);
  assert.equal(calls.selections[0].params[1], 'already-checked');
  assert.match(calls.selections[0].sql, /WHERE \$2::text IS NOT NULL OR state.next_check_at/);
});

test('forced reconciliation reports missing or ambiguous snapshots instead of claiming success', async () => {
  const missing = harness();
  await assert.rejects(missing.run({ orderId: 'missing' }), /No paid snapshot/);
  assert.equal(missing.calls.api.length, 0);
  assert.equal(missing.calls.unlocks, 1);
  const ambiguous = harness({ candidates: [candidate('same'), candidate('same', 'store-b')] });
  await assert.rejects(ambiguous.run({ orderId: 'same' }), /multiple stores/);
  assert.equal(ambiguous.calls.api.length, 0);
});

test('database advisory lock contention skips the batch without API or state writes', async () => {
  const { run, calls } = harness({ locked: false, candidates: [candidate('order-1')] });
  const summary = await run();
  assert.equal(summary.skipped, true);
  assert.equal(summary.reason, 'locked_by_another_process');
  assert.equal(calls.api.length, 0);
  assert.equal(calls.state.length, 0);
  assert.equal(calls.unlocks, 0);
  assert.equal(calls.released.length, 1);
});

test('overlapping in-process batches skip without taking another database connection', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { run, calls } = harness({ candidates: [candidate('order-1')], list: async () => { await gate; return []; } });
  const first = run();
  await new Promise(resolve => setImmediate(resolve));
  const second = await run();
  assert.equal(second.reason, 'already_running');
  assert.equal(calls.connections, 1);
  release();
  assert.equal((await first).checked, 1);
  await run();
  assert.equal(calls.connections, 2);
});

test('selection failures release both locks, and unlock failures destroy the connection', async () => {
  const broken = harness({ selectionError: true });
  await assert.rejects(broken.run(), /selection error/);
  await assert.rejects(broken.run(), /selection error/);
  assert.equal(broken.calls.connections, 2);
  assert.equal(broken.calls.unlocks, 2);
  assert.equal(broken.calls.released.length, 2);
  const unlock = harness({ unlockError: true });
  await unlock.run();
  assert.equal(unlock.calls.released.length, 1);
  assert.ok(unlock.calls.released[0]);
});
