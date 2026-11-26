import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { normalizeOrder } from './normalize-order';
import { mergeFulfillments, validateFulfillments } from './fulfillment-service';

const store = { subdomain: 'fixture.invalid', storeName: 'Fixture', accessToken: 'fixture-only' };
const original = { id: 'old-order', number: 'OLD-1', financial_status: 'paid', created_at: '2020-01-01T00:00:00Z',
  customer: { email: 'fixture@example.invalid' }, line_items: [], fulfillment_status: 'shipped',
  fulfillments: [{ id: 'parcel', tracking_number: 'CURRENT', tracking_number_history: ['UNTRUSTED'] }] };

function harness(options: { exists?: boolean; detail?: any; inserted?: boolean } = {}) {
  const calls = { api: 0, guard: 0, writes: [] as any[], logs: [] as any[] };
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'fulfillment-order-recovery.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const dependencies: Record<string, unknown> = {
    './pg': { query: async () => ({ rows: options.exists ? [{ order_number: 'EXISTING' }] : [] }) },
    './shoplazza-client': { getOrderDetail: async () => { calls.api++; return options.detail === undefined ? original : options.detail; } },
    './normalize-order': { normalizeOrder }, './fulfillment-service': { mergeFulfillments, validateFulfillments },
    './shipping-address-guard': { withSnapshotShippingAddressGuard: async (order: any, _fetch: unknown, write: any) => {
      calls.guard++;
      return write({ query: async (sql: string, values: any[]) => {
        calls.writes.push({ sql, values });
        return { rowCount: options.inserted === false ? 0 : 1, rows: options.inserted === false ? [] : [{ id: '1' }] };
      } }, order);
    } },
    './log-service': { logSync: async (entry: any) => { calls.logs.push(entry); } },
  };
  vm.runInNewContext(code, { module, exports: module.exports, Date, Error, require(name: string) {
    if (!(name in dependencies)) throw new Error(`Forbidden dependency (including mail/token workflows): ${name}`);
    return dependencies[name];
  } });
  return { subject: module.exports as typeof import('./fulfillment-order-recovery'), calls };
}

test('existing business order bypasses provider and notification suppression', async () => {
  const { subject, calls } = harness({ exists: true });
  assert.equal((await subject.recoverMissingFulfillmentOrder({ store, orderId: 'old-order' })).recovered, false);
  assert.equal(calls.api + calls.guard + calls.writes.length + calls.logs.length, 0);
});

test('historical recovery preserves order time and commits a no-invitation marker without mail dependencies', async () => {
  const { subject, calls } = harness();
  assert.equal((await subject.recoverMissingFulfillmentOrder({ store, orderId: 'old-order', topic: 'fulfillments/update' })).recovered, true);
  assert.equal(calls.api, 1);
  assert.equal(calls.writes.length, 2);
  assert.equal(calls.writes[0].values[12], original.created_at);
  const raw = JSON.parse(calls.writes[0].values[22]);
  assert.deepEqual(raw.fulfillments[0].tracking_number_history, ['CURRENT']);
  assert.match(calls.writes[1].sql, /support_order_notification_suppressions/);
  assert.equal(calls.logs[0].detailJson.emailJobsCreated, 0);
  assert.equal(calls.logs[0].detailJson.notificationsSuppressed, true);
});

for (const status of ['partially_refunded', 'refunded']) {
  test(`historical recovery preserves ${status} and suppresses notifications`, async () => {
    const { subject, calls } = harness({ detail: { ...original, financial_status: status, total_refund_price: '13.50' } });
    assert.equal((await subject.recoverMissingFulfillmentOrder({ store, orderId: 'old-order' })).recovered, true);
    const [snapshot, suppression] = calls.writes;
    assert.equal(snapshot.values[10], status);
    assert.equal(snapshot.values[13], status);
    assert.equal(snapshot.values[14], '13.50');
    assert.match(suppression.sql, /support_order_notification_suppressions/);
  });
}

test('a concurrent existing snapshot is not overwritten or given a suppression marker', async () => {
  const { subject, calls } = harness({ inserted: false });
  assert.equal((await subject.recoverMissingFulfillmentOrder({ store, orderId: 'old-order' })).recovered, false);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.logs.length, 0);
});

for (const [name, detail] of [
  ['missing', null], ['wrong identity', { ...original, id: 'other-order' }],
  ['unpaid', { ...original, financial_status: 'pending' }], ['no email', { ...original, customer: null }],
  ['missing items', { ...original, line_items: undefined }],
] as const) {
  test(`${name} provider detail stays retryable without inserting anything`, async () => {
    const { subject, calls } = harness({ detail });
    await assert.rejects(subject.recoverMissingFulfillmentOrder({ store, orderId: 'old-order' }), /queued for retry/);
    assert.equal(calls.guard + calls.writes.length, 0);
    assert.equal(calls.logs[0].status, 'failed');
  });
}
