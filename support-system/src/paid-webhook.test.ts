import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const STORE = { subdomain: 'offline-store', storeName: 'Offline', accessToken: 'not-real' };
const ORDER = { id: 'ORDER-ID', number: 'ORDER-1', financial_status: 'paid',
  customer: { email: 'offline@example.invalid' }, payment_line: { payment_channel: 'paypal' },
  line_items: [{ title: 'Fixture', quantity: 1 }], fulfillment_status: 'waiting' };
const plain = (value: any) => JSON.parse(JSON.stringify(value));
function load<T>(filename: string, dependencies: Record<string, unknown>): T {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, filename), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Buffer,
    console: { log() {}, warn() {}, error() {} },
    require(name: string) {
      if (!(name in dependencies)) throw new Error(`Forbidden external dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename });
  return module.exports as T;
}

function harness(options: { payload?: any; emailFailures?: number; snapshotFailures?: number; finishFailures?: number;
  enabled?: boolean; getDetail?: () => Promise<any>; lostClaim?: boolean } = {}) {
  const event: any = { id: 1, store_subdomain: STORE.subdomain, topic: 'orders/paid', order_id: ORDER.id,
    order_number: ORDER.number, payload_json: options.payload || { order: plain(ORDER) }, status: 'received', attempts: 0 };
  const calls = { receipt: [] as any[], sql: [] as any[], snapshots: [] as any[], logs: [] as any[], invites: [] as any[], api: 0 };
  const jobs = new Set<string>();
  const forbidden = async () => { throw new Error('Unexpected real API dependency'); };
  const dependencies: Record<string, any> = {
    crypto,
    './config': { loadStoresConfig: async () => options.enabled === false ? [] : [STORE], buildStoreDomain: () => 'offline.invalid' },
    './normalize-order': load('normalize-order.ts', {}),
    './shoplazza-client': { getOrderDetail: async () => { calls.api++; return options.getDetail ? options.getDetail() : null; },
      getOrderByNumber: async () => null, getOrderTransactions: forbidden },
    './email-service': { extractStoreCustomDomain: () => '', createPaidSupportInviteEmailJob: async (params: any) => {
      calls.invites.push(params);
      if (options.emailFailures && options.emailFailures-- > 0) throw new Error('mail insert temporarily failed');
      const key = [params.storeSubdomain, params.orderId, params.customerEmail.toLowerCase()].join(':');
      const inserted = !jobs.has(key);
      jobs.add(key);
      return { inserted, job: { email_job_no: 'OFFLINE' } };
    } },
    './log-service': { logSync: async (entry: any) => { calls.logs.push(entry); } },
    './pg': {
      queryWebhook: async (sql: string, values: any[]) => { calls.receipt.push({ sql, values }); return { rowCount: 1, rows: [] }; },
      query: async (sql: string, values: any[] = []) => {
        calls.sql.push({ sql, values });
        if (sql.includes("SET status = 'processing'")) {
          assert.match(sql, /event_key LIKE 'paid:%'/);
          assert.match(sql, /status IN \('received', 'failed'\)/);
          assert.match(sql, /processing_started_at < now\(\) - interval '10 minutes'/);
          assert.match(sql, /FOR UPDATE SKIP LOCKED/);
          if (event.status === 'processed' || event.deferred) return { rows: [], rowCount: 0 };
          event.status = 'processing'; event.attempts++;
          return { rows: [{ ...event }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO support_order_snapshots')) {
          if (options.snapshotFailures && options.snapshotFailures-- > 0) throw new Error('snapshot unavailable');
          calls.snapshots.push(values);
          assert.match(sql, /jsonb_set\(EXCLUDED.raw_order_json, '\{fulfillments\}', support_order_snapshots.raw_order_json->'fulfillments'/);
          return { rows: [{ is_new: calls.snapshots.length === 1 }], rowCount: 1 };
        }
        if (sql.includes("SET status = 'processed'")) {
          assert.match(sql, /status = 'processing' AND attempts = \$3/);
          if (options.finishFailures && options.finishFailures-- > 0) throw new Error('finish update unavailable');
          if (options.lostClaim) return { rows: [], rowCount: 0 };
          event.status = 'processed'; return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SET status = 'failed'")) {
          assert.match(sql, /status = 'processing' AND attempts = \$4/);
          event.status = 'failed'; event.error = values[1]; event.delay = values[2]; event.deferred = true;
          return { rows: [], rowCount: 1 };
        }
        throw new Error('Unmocked SQL');
      },
    },
  };
  dependencies['./shipping-address-guard'] = { withSnapshotShippingAddressGuard: async (order: any, _fetch: unknown, write: any) => write(dependencies['./pg'], order) };
  const subject = load<typeof import('./paid-webhook')>('paid-webhook.ts', dependencies);
  return { subject, calls, event, jobs };
}

test('paid event identity ignores reused provider headers, retains changes, and canonicalizes key order', () => {
  const { subject } = harness();
  const original = subject.paidEventKey(STORE.subdomain, { order: { id: 'A', number: 'A1' } });
  assert.equal(original, subject.paidEventKey(STORE.subdomain, { order: { number: 'A1', id: 'A' } }));
  assert.notEqual(original, subject.paidEventKey(STORE.subdomain, { order: { id: 'B', number: 'A1' } }));
  assert.notEqual(original, subject.paidEventKey(STORE.subdomain, { order: { id: 'A', number: 'CHANGED' } }));
  assert.notEqual(original, subject.paidEventKey('other-store', { order: { id: 'A', number: 'A1' } }));
  assert.match(original, /^paid:/);
});

test('paid receipt requires an order identity but supports lookup by order number', () => {
  const { subject } = harness();
  for (const payload of [null, {}, { order: [] }, { order: {} }, { order: { id: 0 } }, { order: { id: {} } }]) {
    assert.throws(() => subject.parsePaidWebhook(payload));
  }
  assert.equal(subject.parsePaidWebhook({ order: { number: 'A1' } }).orderNumber, 'A1');
});

test('paid durable receipt counts duplicates without resetting processing state and strips secrets', async () => {
  const { subject, calls } = harness();
  await subject.enqueuePaidWebhook({ storeSubdomain: STORE.subdomain, payload: { order: ORDER },
    headers: { authorization: 'secret', cookie: 'secret', 'x-shoplazza-deduplication-id': 'reused', 'user-agent': 'fixture' } });
  const { sql, values } = calls.receipt[0];
  assert.match(sql, /ON CONFLICT \(event_key\) DO UPDATE/);
  assert.match(sql, /delivery_count = shoplazza_webhook_events.delivery_count \+ 1/);
  assert.doesNotMatch(sql.split('DO UPDATE')[1], /status\s*=|next_attempt_at\s*=/);
  assert.deepEqual(JSON.parse(values[6]), { 'x-shoplazza-deduplication-id': 'reused', 'user-agent': 'fixture' });
});

test('complete paid payload processes without API, saving snapshot before one invitation', async () => {
  const { subject, calls, jobs, event } = harness();
  assert.deepEqual(plain(await subject.processPendingPaidWebhooks()), { processed: 1, failed: 0 });
  assert.equal(event.status, 'processed');
  assert.equal(calls.api, 0); assert.equal(calls.snapshots.length, 1); assert.equal(jobs.size, 1);
  assert.equal(calls.snapshots[0][2], ORDER.id);
  assert.equal(calls.invites[0].jobSource, 'webhook');
});

for (const failure of ['emailFailures', 'snapshotFailures', 'finishFailures'] as const) {
  test(`paid ${failure} remains retryable; retry completes with one invitation`, async () => {
    const { subject, calls, event, jobs } = harness({ [failure]: 1 });
    assert.deepEqual(plain(await subject.processPendingPaidWebhooks()), { processed: 0, failed: 1 });
    assert.equal(event.status, 'failed'); assert.equal(event.delay, 30);
    if (failure === 'snapshotFailures') assert.equal(calls.invites.length, 0);
    event.deferred = false;
    assert.deepEqual(plain(await subject.processPendingPaidWebhooks()), { processed: 1, failed: 0 });
    assert.equal(event.attempts, 2); assert.equal(event.status, 'processed'); assert.equal(jobs.size, 1);
  });
}

test('unavailable detail / missing recipient is retried without empty invitation', async () => {
  for (const order of [{ number: 'ORDER-1' }, { id: 'ORDER-ID', financial_status: 'paid' }]) {
    const { subject, event, calls } = harness({ payload: { order } });
    assert.deepEqual(plain(await subject.processPendingPaidWebhooks()), { processed: 0, failed: 1 });
    assert.equal(event.status, 'failed'); assert.equal(calls.invites.length, 0); assert.equal(calls.snapshots.length, 0);
  }
});

test('disabled store is retried without touching snapshots or invitations', async () => {
  const { subject, calls } = harness({ enabled: false });
  assert.equal((await subject.processPendingPaidWebhooks()).failed, 1);
  assert.equal(calls.snapshots.length + calls.invites.length + calls.api, 0);
});

test('incomplete body retains the old API-failure fallback and does not mutate persisted input', async () => {
  const payload = { order: { id: 'ORDER-ID', customer: ORDER.customer } };
  const { subject, calls } = harness({ payload });
  assert.equal((await subject.processPendingPaidWebhooks()).processed, 1);
  assert.equal(calls.snapshots[0][10], 'paid'); assert.equal(calls.invites.length, 1);
  assert.equal('financial_status' in payload.order, false);
});

test('legacy orders/updated keeps snapshot processing without creating a paid invitation', async () => {
  const { subject, calls } = harness();
  await subject.processOrderWebhook({ store: STORE, topic: 'orders/updated', payload: { order: ORDER } });
  assert.equal(calls.snapshots.length, 1); assert.equal(calls.invites.length, 0);
});

test('non-paid state is not turned into a paid snapshot or invitation', async () => {
  const { subject, calls } = harness({ payload: { order: { ...ORDER, financial_status: 'pending' } } });
  assert.equal((await subject.processPendingPaidWebhooks()).processed, 1);
  assert.equal(calls.snapshots.length + calls.invites.length, 0);
});

test('local worker calls share one run and a stale claimant cannot mark a later attempt processed', async () => {
  const { subject, calls } = harness({ lostClaim: true });
  const first = subject.processPendingPaidWebhooks({ limit: 1 });
  assert.equal(subject.processPendingPaidWebhooks({ limit: 1 }), first);
  assert.deepEqual(plain(await first), { processed: 0, failed: 0 });
  assert.equal(calls.invites.length, 1);
});
