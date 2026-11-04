import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const STORE = { subdomain: 'status-fixture.invalid', store_name: 'Fixture', access_token: 'offline-only', enabled: true };
const ORDER = { id: 'A', number: 'ORDER-A', status: 'placed', financial_status: 'refunded',
  fulfillment_status: 'shipped', total_refund_price: '12.50', updated_at: '2026-10-27T01:00:00Z' };
const plain = (value: any) => JSON.parse(JSON.stringify(value));

function harness(options: { found?: boolean; enabled?: boolean; fetchFailures?: number; fetchedAt?: string; writeFailures?: number; staleApplies?: number;
  completeFailures?: number; lostClaim?: boolean } = {}) {
  const event: any = { id: 1, store_subdomain: STORE.subdomain, topic: 'orders/partially_refunded', order_id: 'A', order_number: 'ORDER-A',
    payload_json: { order: { ...ORDER, financial_status: 'paid', total_refund_price: '0' } }, status: 'received', attempts: 0 };
  const calls = { receipts: [] as any[], applied: [] as any[], logs: [] as any[], fetches: 0 };
  const deps: Record<string, any> = {
    crypto,
    './store-service': { getStoreBySubdomain: async () => ({ ...STORE, enabled: options.enabled !== false }) },
    './shoplazza-client': { getOrderForStatusUpdate: async (_store: unknown, id: string) => {
      assert.equal(id, 'A'); calls.fetches++;
      if (options.fetchFailures && options.fetchFailures-- > 0) throw new Error('private provider error');
      return plain({ ...ORDER, updated_at: options.fetchedAt || ORDER.updated_at });
    } },
    './order-status-service': { applyOrderStatusUpdate: async (params: any) => {
      if (options.writeFailures && options.writeFailures-- > 0) throw new Error('private database error');
      calls.applied.push(params);
      if(options.staleApplies&&options.staleApplies-->0)return {matched:true,changed:false,skipReason:'stale',orderNumber:ORDER.number};
      return { matched: true, changed: true, orderNumber: ORDER.number };
    } },
    './log-service': { logSync: async (params: any) => { calls.logs.push(params); } },
    './pg': {
      queryWebhook: async (sql: string, values: unknown[]) => { calls.receipts.push({ sql, values }); return { rows: [], rowCount: 1 }; },
      query: async (sql: string, values: any[] = []) => {
        if (sql.includes("SET status = 'processing'")) {
          assert.match(sql, /event_key LIKE 'order-status:%'/);
          assert.match(sql, /FOR UPDATE SKIP LOCKED/);
          assert.match(sql, /status IN \('received', 'failed'\)/);
          assert.match(sql, /processing_started_at < now\(\) - interval '10 minutes'/);
          if (['processed', 'ignored'].includes(event.status) || event.deferred) return { rows: [], rowCount: 0 };
          event.status = 'processing'; event.attempts++;
          return { rows: [{ ...event }], rowCount: 1 };
        }
        if (sql.startsWith('SELECT EXISTS')) return { rows: [{ found: options.found !== false }], rowCount: 1 };
        if (sql.includes("SET status = 'processed'")) {
          assert.match(sql, /status = 'processing' AND attempts = \$3/);
          if (options.completeFailures && options.completeFailures-- > 0) throw new Error('private completion error');
          if (options.lostClaim) { event.deferred = true; return { rows: [], rowCount: 0 }; }
          event.status = 'processed'; return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SET status = 'ignored'")) {
          assert.match(sql, /status = 'processing' AND attempts = \$2/);
          assert.deepEqual(plain(values), [event.id, event.attempts]);
          if (options.lostClaim) { event.deferred = true; return { rows: [], rowCount: 0 }; }
          event.status = 'ignored'; return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SET status = 'failed'")) {
          assert.match(sql, /status = 'processing' AND attempts = \$4/);
          event.status = 'failed'; event.deferred = true; event.error = values[1]; event.delay = values[2];
          return { rows: [], rowCount: 1 };
        }
        throw new Error('Unapproved SQL');
      },
    },
  };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'order-status-webhook.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console: { error() {} },
    require(name: string) {
      assert.ok(name in deps, `External API, mail, or database dependency forbidden: ${name}`);
      return deps[name];
    },
  });
  return { subject: module.exports as typeof import('./order-status-webhook'), calls, event };
}

test('status event identity keeps repeated updates and isolates store/topic without trusting reused headers', () => {
  const { subject } = harness();
  const first = subject.orderStatusEventKey('store', 'orders/partially_refunded', { order: { id: 'A', financial_status: 'paid' } });
  assert.equal(first, subject.orderStatusEventKey('store', 'orders/partially_refunded', { order: { financial_status: 'paid', id: 'A' } }));
  assert.notEqual(first, subject.orderStatusEventKey('store', 'orders/partially_refunded', { order: { id: 'A', financial_status: 'refunded' } }));
  assert.notEqual(first, subject.orderStatusEventKey('other', 'orders/partially_refunded', { order: { id: 'A', financial_status: 'paid' } }));
  assert.notEqual(first, subject.orderStatusEventKey('store', 'orders/refunded', { order: { id: 'A', financial_status: 'paid' } }));
  for (const payload of [null, {}, { order: [] }, { order: { id: {} } }, { order: { id: 0 } }, { order: { number: 'A' } }]) {
    assert.throws(() => subject.parseOrderStatusWebhook('orders/partially_refunded', payload));
  }
  assert.throws(() => subject.parseOrderStatusWebhook('orders/updated', { order: { id: 'A' } }));
});

test('durable status receipts strip secret headers and duplicates do not reopen completed or deferred work', async () => {
  const { subject, calls } = harness();
  await subject.enqueueOrderStatusWebhook({ storeSubdomain: STORE.subdomain, topic: 'orders/partially_refunded', payload: { order: ORDER },
    headers: { authorization: 'private', cookie: 'private', 'x-shoplazza-deduplication-id': 'same-id', 'user-agent': 'fixture' } });
  const receipt = calls.receipts[0];
  assert.deepEqual(JSON.parse(receipt.values[6]), { 'x-shoplazza-deduplication-id': 'same-id', 'user-agent': 'fixture' });
  assert.match(receipt.sql, /delivery_count = shoplazza_webhook_events.delivery_count \+ 1/);
  assert.doesNotMatch(receipt.sql.split('DO UPDATE')[1], /status\s*=|next_attempt_at\s*=/);
});

test('existing orders use the current API status instead of the stale callback and never load email code', async () => {
  const { subject, calls, event } = harness();
  assert.deepEqual(plain(await subject.processPendingOrderStatusWebhooks()), { processed: 1, failed: 0 });
  assert.equal(event.status, 'processed');
  assert.equal(calls.fetches, 1);
  assert.equal(calls.applied[0].order.financial_status, 'refunded');
  assert.equal(calls.applied[0].topic, 'orders/partially_refunded');
});

test('unknown orders are acknowledged as skipped without fetching or inserting an order', async () => {
  const { subject, calls, event } = harness({ found: false });
  assert.deepEqual(plain(await subject.processPendingOrderStatusWebhooks()), { processed: 1, failed: 0 });
  assert.equal(event.status, 'processed');
  assert.equal(calls.fetches + calls.applied.length, 0);
  assert.equal(calls.logs[0].detailJson.reason, 'not_found');
});

test('an API version older than the callback remains queued until the provider catches up', async () => {
  const options = { fetchedAt: '2026-10-26T01:00:00Z' };
  const { subject, calls, event } = harness(options);
  assert.deepEqual(plain(await subject.processPendingOrderStatusWebhooks()), { processed: 0, failed: 1 });
  assert.equal(calls.applied.length, 0);
  options.fetchedAt = ORDER.updated_at;
  event.deferred = false;
  assert.deepEqual(plain(await subject.processPendingOrderStatusWebhooks()), { processed: 1, failed: 0 });
  assert.equal(calls.applied.length, 1);
});

test('a finished event older than already saved state stays retryable until its completion evidence can be persisted',async()=>{
  const {subject,calls,event}=harness({staleApplies:1});event.topic='orders/finished';event.payload_json.order.status='finished';
  assert.deepEqual(plain(await subject.processPendingOrderStatusWebhooks()),{processed:0,failed:1});
  assert.equal(event.status,'failed');assert.equal(calls.applied[0].completionEvent.status,'finished');
  event.deferred=false;
  assert.deepEqual(plain(await subject.processPendingOrderStatusWebhooks()),{processed:1,failed:0});
});

for (const failure of ['fetchFailures', 'writeFailures', 'completeFailures'] as const) {
  test(`status ${failure} retries successfully without leaking raw error text`, async () => {
    const { subject, calls, event } = harness({ [failure]: 1 });
    assert.deepEqual(plain(await subject.processPendingOrderStatusWebhooks()), { processed: 0, failed: 1 });
    assert.equal(event.status, 'failed');
    assert.equal(event.delay, 30);
    assert.doesNotMatch(JSON.stringify({ error: event.error, logs: calls.logs }), /private/);
    event.deferred = false;
    assert.deepEqual(plain(await subject.processPendingOrderStatusWebhooks()), { processed: 1, failed: 0 });
    assert.equal(event.status, 'processed');
  });
}

test('disabled stores do not fetch and a worker losing its claim cannot complete newer work', async () => {
  const disabled = harness({ enabled: false });
  assert.deepEqual(plain(await disabled.subject.processPendingOrderStatusWebhooks()), { processed: 0, failed: 1 });
  assert.equal(disabled.calls.fetches + disabled.calls.applied.length, 0);
  const stale = harness({ lostClaim: true });
  assert.deepEqual(plain(await stale.subject.processPendingOrderStatusWebhooks()), { processed: 0, failed: 0 });
  assert.equal(stale.event.status, 'processing');
});

test('concurrent dispatch shares a single drain of the durable status queue', async () => {
  const { subject, calls } = harness();
  const first = subject.processPendingOrderStatusWebhooks();
  assert.equal(first, subject.processPendingOrderStatusWebhooks());
  await first;
  assert.equal(calls.fetches, 1);
});

for (const initialStatus of ['received', 'failed', 'processing']) {
  test(`retired order update in ${initialStatus} state is ignored without reading the provider or modifying orders`, async () => {
    const { subject, calls, event } = harness({ enabled: false });
    event.topic = 'orders/update'; event.status = initialStatus; event.payload_json = {};
    assert.deepEqual(plain(await subject.processPendingOrderStatusWebhooks()), { processed: 1, failed: 0 });
    assert.equal(event.status, 'ignored');
    assert.equal(calls.fetches + calls.applied.length + calls.logs.length, 0);
    assert.deepEqual(plain(await subject.processPendingOrderStatusWebhooks()), { processed: 0, failed: 0 });
  });
}

test('retired order updates cannot enter the durable status queue', async () => {
  const { subject, calls } = harness();
  await assert.rejects(subject.enqueueOrderStatusWebhook({ storeSubdomain: STORE.subdomain,
    topic: 'orders/update', payload: { order: ORDER }, headers: {} }), /Unsupported order status event/);
  assert.equal(calls.receipts.length, 0);
});
