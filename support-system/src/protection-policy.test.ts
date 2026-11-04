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

test('four request windows enforce exact boundaries, original order cap and explicit anchor modes', () => {
  const timeline = extractProtectionTimeline({ created_at: '2026-08-01T00:00:00Z',
    _support_completed_at: '2026-08-15T00:00:00Z', _support_completed_source: 'orders/finished.updated_at',
    fulfillments: [{ status: 'shipped', created_at: '2026-08-05T00:00:00Z', delivered_at: '2026-08-10T00:00:00Z', line_items: [{ id: 'a', ship_quantity: 1 }] }] }, ['a']);
  const order = { timeline, items: [{ id: 'a', is_protection: false }] };
  const at = Date.parse('2026-09-04T00:00:00Z');
  const normal = evaluateProtectionCoverage(order, { mode: 'shipment', now: at });
  const delay = normal.windows.find(w => w.reason === 'delayed')!;
  assert.equal(delay.status, 'open'); assert.equal(delay.opens_at, '2026-09-04T00:00:00.000Z');
  assert.equal(delay.closes_at, '2026-10-30T00:00:00.000Z');
  assert.equal(evaluateProtectionCoverage(order, { mode: 'shipment', now: at - 1 }).windows[0].status, 'not_open');
  assert.equal(evaluateProtectionCoverage(order, { mode: 'shipment', now: Date.parse(delay.closes_at!) }).windows[0].status, 'open');
  assert.equal(evaluateProtectionCoverage(order, { mode: 'shipment', now: Date.parse(delay.closes_at!) + 1 }).windows[0].status, 'expired');
  const completed = evaluateProtectionCoverage(order, { mode: 'completion', now: at });
  assert.equal(completed.windows[0].opens_at, '2026-09-14T00:00:00.000Z');
  assert.equal(completed.windows[0].closes_at, delay.closes_at, 'completion mode never extends the order-date90-day cap');
  assert.equal(normal.windows.find(w => w.reason === 'damaged')!.opens_at, '2026-08-15T00:00:00.000Z', 'explicit merchant completion governs damage, not carrier delivery');
  assert.equal(normal.windows.find(w => w.reason === 'stolen')!.closes_at, '2026-08-22T00:00:00.000Z');
  assert.ok(evaluateProtectionCoverage(order, { mode: null, now: at }).windows.every(w => w.status === 'unknown'));
});

test('selected-item window waits for its own final shipment, while unknown mapping cannot borrow another parcel date', () => {
  const timeline = extractProtectionTimeline({ created_at: '2026-08-01T00:00:00Z', fulfillments: [
    { status: 'shipped', created_at: '2026-08-02T00:00:00Z', line_items: [{ id: 'a', ship_quantity: 1 }] },
    { status: 'shipped', created_at: '2026-08-20T00:00:00Z', line_items: [{ id: 'b', ship_quantity: 1 }] },
  ] }, ['a', 'b', 'c']);
  const order = { timeline, items: ['a', 'b', 'c'].map(id => ({ id, is_protection: false })) };
  const options = { mode: 'shipment' as const, now: Date.parse('2026-09-05T00:00:00Z') };
  assert.equal(evaluateProtectionCoverage(order, { ...options, itemIds: ['a'] }).windows[0].status, 'open');
  assert.equal(evaluateProtectionCoverage(order, { ...options, itemIds: ['a', 'b'] }).windows[0].status, 'not_open');
  assert.equal(evaluateProtectionCoverage(order, { ...options, itemIds: ['c'] }).windows[0].status, 'unknown');
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
