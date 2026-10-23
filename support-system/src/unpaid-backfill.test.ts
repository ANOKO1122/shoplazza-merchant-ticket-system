import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import type { ShoplazzaOrderDetail } from './shoplazza-client';

const NOW = '2026-10-23T09:00:00.000Z';
const STORE = { subdomain: 'test-store', storeName: 'Test', accessToken: 'mock-token' };

// Load only the module under test. Every dependency is explicitly supplied;
// an unexpected import fails instead of reaching a real database, API or mail server.
function loadModule<T>(filename: string, dependencies: Record<string, unknown>): T {
  let clock = Date.parse(NOW);
  class FixedDate extends Date {
    constructor(value?: string | number) { super(value ?? NOW); }
    static now() { clock += 1000; return clock; }
  }
  const code = ts.transpileModule(
    fs.readFileSync(path.resolve(__dirname, '../src', filename), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } },
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require(name: string) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    console: { log() {}, warn() {}, error() {} },
    Date: FixedDate,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
  }, { filename });
  return module.exports as T;
}

function order(id: string, status = 'waiting', email = 'buyer@example.invalid'): ShoplazzaOrderDetail {
  return { id, number: id, financial_status: status, customer: { email } } as ShoplazzaOrderDetail;
}

function clientWithFetch(fetch: (url: string) => Promise<unknown>) {
  return loadModule<typeof import('./shoplazza-client')>('shoplazza-client.ts', {
    './config': { buildApiHost: () => 'test.invalid' },
    'node-fetch': fetch,
  });
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('waiting list requests 250 per page and follows the cursor within its update window', async () => {
  const urls: URL[] = [];
  const client = clientWithFetch(async raw => {
    const url = new URL(raw);
    urls.push(url);
    return urls.length === 1
      ? response({ data: { orders: Array.from({ length: 250 }, (_, i) => order(String(i))), has_more: true, cursor: 'next-page' } })
      : response({ data: { orders: [order('last')], has_more: false } });
  });
  const result = await client.listWaitingOrdersUpdatedSince(STORE, '2026-10-23T08:00:00Z', NOW);
  assert.equal(result.length, 251);
  assert.equal(urls.length, 2);
  for (const url of urls) {
    assert.equal(url.searchParams.get('page_size'), '250');
    assert.equal(url.searchParams.get('financial_status'), 'waiting');
    assert.equal(url.searchParams.get('updated_at_min'), '2026-10-23T08:00:00Z');
    assert.equal(url.searchParams.get('updated_at_max'), NOW);
    assert.equal(url.searchParams.has('created_at_min'), false);
  }
  assert.equal(urls[1].searchParams.get('cursor'), 'next-page');
});

test('waiting list rejects a repeated cursor without looping to the page limit', async () => {
  let requests = 0;
  const client = clientWithFetch(async () => {
    requests++;
    return response({ data: { orders: [order(String(requests))], has_more: true, cursor: 'same-cursor' } });
  });
  await assert.rejects(client.listWaitingOrdersUpdatedSince(STORE, NOW, NOW), /repeated cursor/);
  assert.equal(requests, 2);
});

test('waiting list accepts an explicitly successful empty data object on the first page', async () => {
  let requests = 0;
  const client = clientWithFetch(async () => {
    requests++;
    return response({ code: 'Success', data: {} });
  });
  const orders = await client.listWaitingOrdersUpdatedSince(STORE, NOW, NOW);
  assert.equal(orders.length, 0);
  assert.equal(requests, 1);
});

test('waiting list preserves previous pages when the final response is an explicitly successful empty data object', async () => {
  let requests = 0;
  const client = clientWithFetch(async () => ++requests === 1
    ? response({ data: { orders: [order('first')], has_more: true, cursor: 'last-page' } })
    : response({ code: 'Success', data: {} }));
  const orders = await client.listWaitingOrdersUpdatedSince(STORE, NOW, NOW);
  assert.deepEqual(Array.from(orders, item => item.id), ['first']);
  assert.equal(requests, 2);
});

test('waiting list rejects incomplete pages and HTTP errors instead of returning partial success', async t => {
  const cases = [
    { name: 'HTTP error', body: {}, status: 429, error: /HTTP 429/ },
    { name: 'missing orders', body: { code: 'error', message: 'failed' }, status: 200, error: /no orders array/ },
    { name: 'empty data without explicit success', body: { data: {} }, status: 200, error: /no orders array/ },
    { name: 'empty data with error code', body: { code: 'Error', data: {} }, status: 200, error: /no orders array/ },
    { name: 'success without data', body: { code: 'Success' }, status: 200, error: /no orders array/ },
    { name: 'success with null data', body: { code: 'Success', data: null }, status: 200, error: /no orders array/ },
    { name: 'success with array data', body: { code: 'Success', data: [] }, status: 200, error: /no orders array/ },
    { name: 'success with string data', body: { code: 'Success', data: '' }, status: 200, error: /no orders array/ },
    { name: 'success with nonempty data but missing orders', body: { code: 'Success', data: { cursor: 'next' } }, status: 200, error: /no orders array/ },
    { name: 'success with malformed orders', body: { code: 'Success', data: { orders: null } }, status: 200, error: /no orders array/ },
    { name: 'empty data but malformed top-level orders', body: { code: 'Success', data: {}, orders: null }, status: 200, error: /no orders array/ },
    { name: 'empty success claiming more pages', body: { code: 'Success', data: {}, has_more: true, cursor: 'next' }, status: 200, error: /empty page/ },
    { name: 'empty nonterminal page', body: { orders: [], has_more: true, cursor: 'next' }, status: 200, error: /empty page/ },
    { name: 'missing cursor', body: { orders: [order('next')], has_more: true }, status: 200, error: /no cursor/ },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let calls = 0;
      const client = clientWithFetch(async () => ++calls === 1
        ? response({ orders: [order('first')], has_more: true, cursor: 'page-2' })
        : response(scenario.body, scenario.status));
      await assert.rejects(client.listWaitingOrdersUpdatedSince(STORE, NOW, NOW), scenario.error);
    });
  }
});

test('waiting list identifies an overfull window for splitting, without returning partial orders', async () => {
  let requests = 0;
  const client = clientWithFetch(async () => {
    requests++;
    return response({ orders: [order(String(requests))], has_more: true, cursor: `page-${requests}` });
  });
  await assert.rejects(client.listWaitingOrdersUpdatedSince(STORE, NOW, NOW),
    (error: any) => error.code === 'WAITING_WINDOW_TOO_LARGE');
  assert.equal(requests, 200);
});

function backfillHarness(
  list: (min: string, max: string) => Promise<ShoplazzaOrderDetail[]>,
  initialCursor: string | null = '2026-10-23T06:05:00.000Z',
) {
  let cursor = initialCursor;
  const cursorWrites: string[] = [];
  const snapshotWrites: string[] = [];
  const snapshots = new Map<string, string>([['already-paid', 'paid']]);
  const logs: any[] = [];
  const failWrites = new Set<string>();
  const forbidden = () => { throw new Error('Unpaid sync attempted a paid/API/email operation'); };
  const jobs = loadModule<typeof import('./backfill-jobs')>('backfill-jobs.ts', {
    './store-service': { getEnabledStores: async () => [{ subdomain: STORE.subdomain, store_name: STORE.storeName, access_token: STORE.accessToken }] },
    './shoplazza-client': {
      listWaitingOrdersUpdatedSince: async (_store: unknown, min: string, max: string) => list(min, max),
      listPaidOrdersCreatedSince: forbidden,
      getOrderTransactions: forbidden,
    },
    './normalize-order': loadModule('normalize-order.ts', {}),
    './email-service': { createPaidSupportInviteEmailJob: forbidden },
    './config': {},
    './log-service': { logSync: async (entry: unknown) => { logs.push(entry); } },
    './pg': {
      query: async (sql: string, params: any[]) => {
        if (sql.includes('SELECT store_subdomain')) {
          return { rows: [{ store_subdomain: STORE.subdomain, last_unpaid_synced_at: cursor, last_synced_at: NOW }] };
        }
        if (sql.includes('INSERT INTO support_order_snapshots')) {
          const id = params[2];
          assert.equal(params[10], 'waiting');
          assert.match(sql, /WHERE support_order_snapshots.payment_status IS DISTINCT FROM 'paid'/);
          if (failWrites.has(id)) throw new Error('simulated snapshot write failure');
          if (snapshots.get(id) === 'paid') return { rows: [], rowCount: 0 };
          const isNew = !snapshots.has(id);
          snapshots.set(id, params[10]);
          snapshotWrites.push(id);
          return { rows: [{ is_new: isNew }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO support_backfill_state')) {
          assert.doesNotMatch(sql, /\blast_synced_at\b/);
          assert.match(sql, /GREATEST\(support_backfill_state.last_unpaid_synced_at/);
          cursor = cursor && cursor > params[1] ? cursor : params[1];
          cursorWrites.push(cursor!);
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected database operation: ${sql}`);
      },
    },
  });
  return { run: () => jobs.runUnpaidBackfillOnly(STORE.subdomain), cursorWrites, snapshotWrites, snapshots, logs, failWrites };
}

test('unpaid backlog advances one completed hour at a time and protects paid snapshots', async () => {
  const windows: string[][] = [];
  const harness = backfillHarness(async (min, max) => {
    windows.push([min, max]);
    return [order(max), order('already-paid'), order('skip-paid', 'paid'), order('no-email', 'waiting', '')];
  });
  await harness.run();
  assert.deepEqual(windows, [
    ['2026-10-23T06:00:00.000Z', '2026-10-23T07:00:00.000Z'],
    ['2026-10-23T07:00:00.000Z', '2026-10-23T08:00:00.000Z'],
    ['2026-10-23T08:00:00.000Z', NOW],
  ]);
  assert.deepEqual(harness.cursorWrites, windows.map(window => window[1]));
  assert.equal(harness.snapshotWrites.length, 3);
  assert.equal(harness.snapshots.get('already-paid'), 'paid');
  assert.equal(harness.snapshots.has('skip-paid'), false);
  assert.equal(harness.snapshots.has('no-email'), false);
  assert.equal(harness.logs.length, 3);
});

test('a failed later window retains previous progress and retry resumes with a five-minute overlap', async () => {
  const windows: string[][] = [];
  let fail = true;
  const harness = backfillHarness(async (min, max) => {
    windows.push([min, max]);
    if (fail && min === '2026-10-23T07:00:00.000Z') throw new Error('waiting list HTTP 429');
    return [order(max)];
  });
  await assert.rejects(harness.run(), /HTTP 429/);
  assert.deepEqual(harness.cursorWrites, ['2026-10-23T07:00:00.000Z']);
  fail = false;
  await harness.run();
  assert.equal(windows[2][0], '2026-10-23T06:55:00.000Z');
  assert.equal(harness.cursorWrites.at(-1), NOW);
});

test('a failed snapshot write does not mark its window complete', async () => {
  const harness = backfillHarness(async (_min, max) => [order(max)]);
  harness.failWrites.add('2026-10-23T08:00:00.000Z');
  await assert.rejects(harness.run(), /snapshot write failure/);
  assert.deepEqual(harness.cursorWrites, ['2026-10-23T07:00:00.000Z']);
});

test('overfull windows are split and only completed child windows advance the cursor', async () => {
  const attempted: string[][] = [];
  const completed: string[][] = [];
  const harness = backfillHarness(async (min, max) => {
    attempted.push([min, max]);
    if (Date.parse(max) - Date.parse(min) > 30 * 60 * 1000) {
      throw Object.assign(new Error('waiting list exceeded 200 pages'), { code: 'WAITING_WINDOW_TOO_LARGE' });
    }
    completed.push([min, max]);
    return [order(max)];
  }, '2026-10-23T08:05:00.000Z');
  await harness.run();
  assert.equal(attempted.length, 3);
  assert.deepEqual(harness.cursorWrites, ['2026-10-23T08:30:00.000Z', NOW]);
  assert.equal(completed[0][0], '2026-10-23T08:00:00.000Z');
  assert.equal(completed[1][0], completed[0][1]);
});

test('an unsplittable overfull window fails visibly without advancing its cursor', async () => {
  let attempts = 0;
  const harness = backfillHarness(async () => {
    attempts++;
    throw Object.assign(new Error('waiting list exceeded 200 pages'), { code: 'WAITING_WINDOW_TOO_LARGE' });
  }, '2026-10-23T08:05:00.000Z');
  await assert.rejects(harness.run(), /exceeded 200 pages/);
  assert.ok(attempts < 20);
  assert.deepEqual(harness.cursorWrites, []);
});

test('simultaneous unpaid runs for one store share the active run', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const harness = backfillHarness(async () => {
    requests++;
    await gate;
    return [];
  }, null);
  const first = harness.run();
  const second = harness.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(harness.cursorWrites, [NOW]);
});
