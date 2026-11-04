import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { normalizeOrder, normalizeRefundAmount } from './normalize-order';
import { applyOrderStatusUpdate, guardSnapshotOrderStatus, mergeOrderStatus, resolveOrderCompletion, type OrderStatus } from './order-status-service';

const OLD = '2026-10-27T01:00:00Z';
const NOW = '2026-10-27T02:00:00Z';
const LATER = '2026-10-27T03:00:00Z';
const before: OrderStatus = { orderStatus: 'placed', paymentStatus: 'paid', fulfillmentStatus: 'shipped', refundStatus: '', refundAmount: '0.00' };
const order = (extra: Record<string, unknown> = {}) => ({ id: 'ORDER', number: '#ORDER', status: 'placed',
  financial_status: 'paid', fulfillment_status: 'waiting', updated_at: NOW, total_refund_price: '0.00', ...extra }) as any;
const snapshot = (extra: Record<string, unknown> = {}) => ({ id: '1', order_number: '#ORDER', store_name: 'Fixture',
  order_status: 'placed', payment_status: 'paid', fulfillment_status: 'shipped', refund_status: '', refund_amount: '0.00',
  raw_order_json: order({ updated_at: OLD, fulfillment_status: 'shipped' }), ...extra });

test('completion time comes from a finished event or explicit completion field, never the latest unrelated update', () => {
  const finished = order({ status: 'finished', updated_at: LATER });
  assert.deepEqual(resolveOrderCompletion({}, finished), {});
  assert.deepEqual(resolveOrderCompletion({}, finished, { status: 'placed', updated_at: NOW }), {});
  assert.deepEqual(resolveOrderCompletion({}, order(), { status: 'finished', updated_at: NOW }), {});
  const recorded = resolveOrderCompletion({}, finished, { status: 'finished', updated_at: NOW });
  assert.deepEqual(recorded, { _support_completed_at: new Date(NOW).toISOString(), _support_completed_source: 'orders/finished.updated_at' });
  assert.deepEqual(resolveOrderCompletion(recorded, finished), recorded);
  assert.deepEqual(resolveOrderCompletion(recorded, finished, { status: 'finished', updated_at: LATER }), recorded);
  assert.deepEqual(resolveOrderCompletion({}, { ...finished, finished_at: OLD }), {
    _support_completed_at: new Date(OLD).toISOString(), _support_completed_source: 'order.finished_at',
  });
  assert.deepEqual(resolveOrderCompletion({}, order({ status: 'finished', updated_at: NOW }), { status: 'finished', updated_at: LATER }), {});
});

test('refund state and amount use financial_status and total_refund_price independently of cancellation', () => {
  for (const status of ['partially_refunded', 'refunded', 'refunding', 'refund_failed']) {
    const normalized = normalizeOrder('fixture', 'Fixture', order({ financial_status: status, total_refund_price: '12.50',
      refund_status: 'deprecated-unrelated-value' }), []);
    assert.equal(normalized.refundStatus, status);
    assert.equal(normalized.refundAmount, '12.50');
    assert.equal(normalized.orderStatus, 'placed');
  }
  assert.equal(normalizeOrder('fixture', 'Fixture', order({ total_refund_price: undefined }), []).refundAmount, '');
  assert.equal(normalizeOrder('fixture', 'Fixture', order({ total_refund_price: 0 }), []).refundAmount, '0');
  for (const invalid of [-1, Infinity, NaN, true, {}, '1e5', '-1', 'NaN']) assert.equal(normalizeRefundAmount(invalid), '');
});

test('refund updates preserve shipping, absent fields, and unknown amounts without inferring cancellation', () => {
  assert.deepEqual(mergeOrderStatus(before, { financial_status: 'partially_refunded', total_refund_price: '12.50', fulfillment_status: 'waiting' }),
    { ...before, paymentStatus: 'partially_refunded', refundStatus: 'partially_refunded', refundAmount: '12.50' });
  assert.deepEqual(mergeOrderStatus(before, {}), before);
  assert.equal(mergeOrderStatus({ ...before, refundAmount: '' }, { financial_status: 'refunding' }).refundAmount, '');
});

test('same-version and legacy merges allow partial to full but reject paid/waiting regression', () => {
  const partial = { ...before, paymentStatus: 'partially_refunded', refundStatus: 'partially_refunded', refundAmount: '10.50' };
  const full = mergeOrderStatus(partial, { financial_status: 'refunded', total_refund_price: '20.00' }, true);
  assert.equal(full.paymentStatus, 'refunded');
  for (const financial_status of ['waiting', 'paid', 'partially_refunded']) {
    assert.deepEqual(mergeOrderStatus(full, { financial_status, total_refund_price: '0' }, true), full);
  }
  assert.equal(mergeOrderStatus(before, { financial_status: 'waiting' }, true).paymentStatus, 'paid');
});

test('same-version cumulative money comparison is exact for huge values and fractional cents', () => {
  for (const [saved, incoming] of [['9007199254740993.01', '9007199254740993.00'], ['10.01', '9.9999'], ['0.000001', '0.0000009'], ['00010.50', '10.499']]) {
    assert.equal(mergeOrderStatus({ ...before, refundAmount: saved }, { total_refund_price: incoming }, true).refundAmount, saved);
  }
  assert.equal(mergeOrderStatus(before, { total_refund_price: '0.01' }, true).refundAmount, '0.01');
  assert.equal(mergeOrderStatus({ ...before, refundAmount: '5.00' }, { total_refund_price: '4.00' }, false).refundAmount, '4.00',
    'a strictly newer authoritative GET can correct provider data');
});

test('legacy and same-version views preserve terminal shipping/order states; newer GET can correct them', () => {
  for (const fulfillmentStatus of ['partially_finished', 'finished', 'returning', 'returned', 'partially_returned', 'cancelled', 'future_status']) {
    const saved = { ...before, orderStatus: 'finished', fulfillmentStatus };
    const incoming = { status: 'placed', fulfillment_status: 'shipped' };
    assert.deepEqual(mergeOrderStatus(saved, incoming, true), saved);
    assert.equal(mergeOrderStatus(saved, incoming, false).fulfillmentStatus, 'shipped');
  }
});

function database(t: TestContext, rows: any[], state?: any, failure?: 'log' | 'rollback') {
  const calls: Array<{ sql: string; values: any[] }> = [];
  let released: Error | undefined;
  const client = {
    async query(sql: string, values: any[] = []) {
      calls.push({ sql, values });
      if (sql.includes('SELECT id, order_number')) return { rows, rowCount: rows.length };
      if (sql.includes('SELECT state_json')) return { rows: state ? [state] : [], rowCount: state ? 1 : 0 };
      if (sql.includes('INSERT INTO support_sync_logs') && failure) throw new Error('fixture log failure');
      if (sql === 'ROLLBACK' && failure === 'rollback') throw new Error('fixture rollback failure');
      return { rows: [], rowCount: 1 };
    },
    release(error?: Error) { released = error; },
  };
  t.mock.method(Pool.prototype, 'connect', async () => client as any);
  t.mock.method(Pool.prototype, 'query', () => { throw new Error('Unscoped query forbidden'); });
  return { client, calls, get released() { return released; } };
}
const apply = (value: any) => applyOrderStatusUpdate({ storeSubdomain: 'fixture', storeName: 'Fixture', order: value, topic: 'orders/partially_refunded' });

test('unknown orders and invalid/missing provider versions never insert/update an order or status state', async t => {
  for (const missing of [true, false]) {
    await t.test(String(missing), async sub => {
      const db = database(sub, missing ? [] : [snapshot()]);
      const result = await apply(order({ updated_at: 'not-a-time', financial_status: 'refunded' }));
      assert.equal(result.matched, !missing);
      assert.equal(result.changed, false);
      assert.equal(result.skipReason, missing ? 'not_found' : 'missing_updated_at');
      assert.equal(db.calls.filter(call => /^(INSERT INTO support_order_status_state|UPDATE support_order_snapshots)/.test(call.sql.trim())).length, 0);
      assert.equal(db.calls.filter(call => call.sql.includes('INSERT INTO support_sync_logs')).length, 1);
    });
  }
});

test('snapshot raw updated_at can reject an event before a dedicated state row exists', async t => {
  const db = database(t, [snapshot({ raw_order_json: order({ updated_at: LATER }) })]);
  const result = await apply(order({ financial_status: 'refunded', total_refund_price: '20' }));
  assert.equal(result.skipReason, 'stale');
  assert.equal(db.calls.some(call => call.sql.includes('INSERT INTO support_order_status_state')), false);
});

test('status writes patch only state leaves and log the number of matching email snapshots', async t => {
  const db = database(t, [snapshot(), snapshot({ id: '2' })]);
  const result = await apply(order({ financial_status: 'refunded', total_refund_price: '20' }));
  assert.equal(result.changed, true);
  const update = db.calls.find(call => call.sql.includes('UPDATE support_order_snapshots'))!;
  assert.deepEqual(update.values[0], ['1', '2']);
  assert.deepEqual(JSON.parse(update.values[6]), { status: 'placed', financial_status: 'refunded', fulfillment_status: 'shipped', total_refund_price: '20' });
  assert.doesNotMatch(update.sql, /shipping_address_json\s*=|customer_email\s*=|paid_at\s*=|fulfillments/);
  const log = db.calls.find(call => call.sql.includes('INSERT INTO support_sync_logs'))!;
  assert.equal(JSON.parse(log.values[6]).matchedRows, 2);
  assert.equal(JSON.parse(log.values[6]).changedRows, 2);
  assert.deepEqual(log.values.slice(3, 5), [1, 0]);
  assert.ok(db.calls.findIndex(call => call.sql.includes('pg_advisory_xact_lock')) < db.calls.findIndex(call => call.sql.includes('SELECT id, order_number')));
});

test('legacy guard uses saved state for a changed email and keeps the refund in normalized/raw data', async t => {
  const db = database(t, [snapshot()], { provider_updated_at: NOW, state_json: {
    status: 'finished', financial_status: 'refunded', fulfillment_status: 'shipped', total_refund_price: '20.00',
  } });
  const incoming = normalizeOrder('fixture', 'Fixture', order({ updated_at: OLD, customer: { email: 'other@example.invalid' } }), []);
  const result = await guardSnapshotOrderStatus(db.client as any, incoming);
  assert.equal(result.order.paymentStatus, 'refunded');
  assert.equal(result.order.refundAmount, '20.00');
  assert.equal(result.order.orderStatus, 'finished');
  assert.equal(result.order.customerEmail, 'other@example.invalid');
  assert.equal(result.order.rawOrderJson.financial_status, 'refunded');
  assert.equal(result.order.rawOrderJson.updated_at, new Date(NOW).toISOString());
});

test('finished event time survives later status changes and legacy snapshot replacement', async t => {
  const db = database(t, [snapshot()]);
  await applyOrderStatusUpdate({ storeSubdomain: 'fixture', order: order({ status: 'finished', updated_at: LATER }),
    topic: 'orders/finished', completionEvent: { status: 'finished', updated_at: NOW } });
  const patch = JSON.parse(db.calls.find(call => call.sql.includes('UPDATE support_order_snapshots'))!.values[6]);
  assert.equal(patch._support_completed_at, new Date(NOW).toISOString());
  assert.equal(patch._support_completed_source, 'orders/finished.updated_at');
  db.calls.length = 0;
  const db2 = database(t, [snapshot({ raw_order_json: { ...order({ status: 'finished', updated_at: LATER }), ...patch } })]);
  const incoming = normalizeOrder('fixture', 'Fixture', order({ status: 'finished', updated_at: LATER,
    _support_completed_at: '2099-01-01T00:00:00Z', _support_completed_source: 'orders/finished.updated_at' }), []);
  const guarded = await guardSnapshotOrderStatus(db2.client as any, incoming);
  assert.equal(guarded.order.rawOrderJson._support_completed_at, new Date(NOW).toISOString());
});

test('authoritative cancellation survives status state and later snapshot replacement that omit the date', async t => {
  const db = database(t, [snapshot()]);
  await applyOrderStatusUpdate({ storeSubdomain: 'fixture', order: order({ status: 'finished', canceled_at: NOW }), topic: 'orders/finished' });
  const patch = JSON.parse(db.calls.find(call => call.sql.includes('UPDATE support_order_snapshots'))!.values[6]);
  assert.equal(patch.cancelled_at, new Date(NOW).toISOString());
  const state = JSON.parse(db.calls.find(call => call.sql.includes('INSERT INTO support_order_status_state'))!.values[2]);
  assert.equal(state.cancelled_at, patch.cancelled_at);
  const db2 = database(t, [snapshot()], { provider_updated_at: NOW, state_json: state });
  const incoming = normalizeOrder('fixture', 'Fixture', order({ status: 'finished', updated_at: LATER, cancelled_at: null }), []);
  const guarded = await guardSnapshotOrderStatus(db2.client as any, incoming);
  assert.equal(guarded.order.rawOrderJson.cancelled_at, new Date(NOW).toISOString());
});

test('log failure rolls back state and snapshot writes; rollback failure destroys the pooled connection', async t => {
  for (const failure of ['log', 'rollback'] as const) await t.test(failure, async sub => {
    const db = database(sub, [snapshot()], undefined, failure);
    await assert.rejects(apply(order({ financial_status: 'refunded' })), /fixture log failure/);
    assert.ok(db.calls.some(call => call.sql === 'ROLLBACK'));
    assert.ok(!db.calls.some(call => call.sql === 'COMMIT'));
    assert.equal(Boolean(db.released), failure === 'rollback');
  });
});
