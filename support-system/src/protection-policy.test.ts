import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProtectionTimeline, evaluateProtectionCoverage } from './protection-policy';

test('timeline uses source timestamps and excludes service-only, cancelled and pending shipments', () => {
  const raw = { created_at: '2026-08-01T00:00:00Z', status: 'finished', updated_at: '2026-11-03T00:00:00Z',
    _support_completed_at: '2026-10-30T00:00:00Z', _support_completed_source: 'orders/finished.updated_at',
    fulfillments: [
      { id: 'service', status: 'shipped', created_at: '2026-08-01T00:00:00Z', line_items: [{ id: 'p' }] },
      { id: 'void', status: 'cancelled', created_at: '2026-08-02T00:00:00Z', line_items: [{ id: 'a' }] },
      { id: 'waiting', status: 'pending', created_at: '2026-08-03T00:00:00Z', line_items: [{ id: 'a' }] },
      { id: 'parcel', status: 'finished', created_at: '2026-08-05T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', line_items: [{ id: 'a', ship_quantity: 1 }] },
    ] };
  const actual = extractProtectionTimeline(raw, ['a']);
  assert.equal(actual.ordered_at, '2026-08-01T00:00:00.000Z');
  assert.equal(actual.shipped_at, '2026-08-05T00:00:00.000Z');
  assert.equal(actual.shipped_source, 'merchant_fulfillment.created_at');
  assert.equal(actual.completed_at, '2026-10-30T00:00:00.000Z');
  assert.equal(actual.completed_source, 'orders/finished.updated_at');
  assert.equal(actual.delivered_at, null, 'finished fulfillment is not proof of carrier delivery');
  assert.equal(extractProtectionTimeline({ ...raw, _support_completed_at: undefined }, ['a']).completed_at, null);
  assert.equal(extractProtectionTimeline({ status: 'finished', updated_at: raw.updated_at }, ['a']).completed_at, null);
});

test('four request windows use shipment or completion opening dates and one payment-based deadline', () => {
  const timeline = extractProtectionTimeline({ created_at: '2026-08-01T00:00:00Z',
    _support_completed_at: '2026-08-15T00:00:00Z', _support_completed_source: 'orders/finished.updated_at',
    fulfillments: [{ status: 'shipped', created_at: '2026-08-05T00:00:00Z', delivered_at: '2026-08-10T00:00:00Z', line_items: [{ id: 'a', ship_quantity: 1 }] }] }, ['a']);
  const order = { paid_at: '2026-08-03T00:00:00Z', timeline, items: [{ id: 'a', is_protection: false }] };
  const at = Date.parse('2026-09-04T00:00:00Z');
  const normal = evaluateProtectionCoverage(order, { mode: 'shipment', now: at });
  assert.deepEqual(normal.windows.map(w => [w.reason, w.opens_at, w.closes_at, w.status]), [
    ['delayed', '2026-09-04T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 'open'],
    ['lost', '2026-10-04T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 'not_open'],
    ['damaged', '2026-08-25T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 'open'],
    ['stolen', '2026-08-25T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 'open'],
  ]);
  assert.equal(evaluateProtectionCoverage(order, { mode: 'shipment', now: at - 1 }).windows[0].status, 'not_open');
  assert.ok(evaluateProtectionCoverage(order, { mode: 'shipment', now: Date.parse('2026-12-01T00:00:00Z') }).windows.every(w => w.status === 'open'));
  assert.ok(evaluateProtectionCoverage(order, { mode: 'shipment', now: Date.parse('2026-12-01T00:00:00Z') + 1 }).windows.every(w => w.status === 'expired'));
  const completed = evaluateProtectionCoverage(order, { mode: 'completion', now: at });
  assert.equal(completed.windows[0].opens_at, '2026-09-14T00:00:00.000Z');
  assert.equal(completed.windows[1].opens_at, '2026-10-14T00:00:00.000Z');
  assert.equal(completed.windows[2].opens_at, '2026-08-25T00:00:00.000Z', 'damage uses the selected item shipment even in completion mode');
  assert.equal(completed.windows[3].opens_at, '2026-08-25T00:00:00.000Z', 'theft uses the selected item shipment even in completion mode');
  assert.ok(completed.windows.every(w => w.closes_at === '2026-12-01T00:00:00.000Z'));
  assert.ok(evaluateProtectionCoverage(order, { mode: null, now: at }).windows.every(w => w.status === 'unknown'));
  assert.equal(normal.policy_version, '2026-11-11:shipment');
});

test('damage and theft open on the twentieth day after shipment even when the order has no completion date', () => {
  const timeline = extractProtectionTimeline({ created_at: '2026-08-01T00:00:00Z', status: 'placed',
    fulfillments: [{ status: 'shipped', created_at: '2026-08-05T00:00:00Z', line_items: [{ id: 'a', ship_quantity: 1 }] }] }, ['a']);
  const order = { paid_at: '2026-08-03T00:00:00Z', timeline, items: [{ id: 'a', is_protection: false }] };
  assert.equal(timeline.completed_at, null);
  for (const reason of ['damaged', 'stolen']) {
    const before = evaluateProtectionCoverage(order, { mode: 'shipment', now: Date.parse('2026-08-25T00:00:00Z') - 1 }).windows.find(w => w.reason === reason)!;
    const opened = evaluateProtectionCoverage(order, { mode: 'shipment', now: Date.parse('2026-08-25T00:00:00Z') }).windows.find(w => w.reason === reason)!;
    assert.equal(before.status, 'not_open', `${reason} must not open early`);
    assert.equal(opened.status, 'open', `${reason} opens exactly 20 days after shipment`);
    assert.equal(opened.opens_at, '2026-08-25T00:00:00.000Z');
    assert.equal(opened.closes_at, '2026-12-01T00:00:00.000Z');
  }
});

test('payment date must be verified before any request window can open or show a deadline', () => {
  const timeline = extractProtectionTimeline({ created_at: '2026-08-01T00:00:00Z',
    _support_completed_at: '2026-08-15T00:00:00Z', _support_completed_source: 'orders/finished.updated_at',
    fulfillments: [{ status: 'shipped', created_at: '2026-08-05T00:00:00Z', line_items: [{ id: 'a', ship_quantity: 1 }] }] }, ['a']);
  for (const paid_at of [null, 'not a date']) {
    const coverage = evaluateProtectionCoverage({ paid_at, timeline, items: [{ id: 'a', is_protection: false }] }, { mode: 'shipment', now: Date.parse('2026-09-04T00:00:00Z') });
    assert.ok(coverage.windows.every(w => w.status === 'unknown' && w.closes_at === null), 'order creation and completion dates cannot replace the payment date');
  }
});

test('selected-item window waits for its own final shipment, while unknown mapping cannot borrow another parcel date', () => {
  const timeline = extractProtectionTimeline({ created_at: '2026-08-01T00:00:00Z',
    _support_completed_at: '2026-10-01T00:00:00Z', _support_completed_source: 'orders/finished.updated_at', fulfillments: [
    { status: 'shipped', created_at: '2026-08-02T00:00:00Z', line_items: [{ id: 'a', ship_quantity: 1 }] },
    { status: 'shipped', created_at: '2026-08-20T00:00:00Z', line_items: [{ id: 'b', ship_quantity: 1 }] },
  ] }, ['a', 'b', 'c']);
  const order = { paid_at: '2026-08-01T00:00:00Z', timeline, items: ['a', 'b', 'c'].map(id => ({ id, is_protection: false })) };
  const options = { mode: 'shipment' as const, now: Date.parse('2026-09-05T00:00:00Z') };
  assert.equal(evaluateProtectionCoverage(order, { ...options, itemIds: ['a'] }).windows[0].status, 'open');
  assert.equal(evaluateProtectionCoverage(order, { ...options, itemIds: ['a', 'b'] }).windows[0].status, 'not_open');
  assert.equal(evaluateProtectionCoverage(order, { ...options, itemIds: ['c'] }).windows[0].status, 'unknown');
  assert.equal(evaluateProtectionCoverage(order, { ...options, itemIds: ['a'] }).windows.find(w => w.reason === 'damaged')!.opens_at, '2026-08-22T00:00:00.000Z');
  assert.equal(evaluateProtectionCoverage(order, { ...options, itemIds: ['a', 'b'] }).windows.find(w => w.reason === 'damaged')!.status, 'not_open');
  assert.equal(evaluateProtectionCoverage(order, { ...options, itemIds: ['c'] }).windows.find(w => w.reason === 'stolen')!.status, 'unknown');
});

test('split shipments retain per-item dates and ambiguous quantities never inherit another item shipment', () => {
  const raw = { created_at: '2026-08-01T00:00:00Z', fulfillments: [
    { status: 'shipped', created_at: '2026-08-02T00:00:00Z', line_items: [{ id: 'a', ship_quantity: 1 }, { id: 'b', ship_quantity: 1 }] },
    { status: 'shipped', created_at: '2026-09-02T00:00:00Z', line_items: [{ id: 'b', ship_quantity: 1 }] },
  ] };
  const result = extractProtectionTimeline(raw, [{ id: 'a', quantity: 1 }, { id: 'b', quantity: 2 }, { id: 'c', quantity: 1 }]);
  assert.equal(result.items.a.shipped_at, '2026-08-02T00:00:00.000Z');
  assert.equal(result.items.b.shipped_at, '2026-09-02T00:00:00.000Z');
  assert.equal(result.items.c.shipped_at, null);
  assert.equal(result.shipped_at, null, 'an unshipped item prevents claiming an order-wide shipment time');
  const ambiguous = extractProtectionTimeline(raw, [{ id: 'b', quantity: 1 }]);
  assert.equal(ambiguous.items.b.shipped_at, null, 'overlapping quantities require verification');
});
