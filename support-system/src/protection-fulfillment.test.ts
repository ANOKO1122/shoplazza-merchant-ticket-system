import test from 'node:test';
import assert from 'node:assert/strict';
import { planProtectionFulfillment } from './protection-fulfillment';
const order = (extra: Record<string, unknown> = {}) => ({ id: 'o', status: 'finished', financial_status: 'paid', line_items: [
  { id: 'goods', product_id: 'g', quantity: 1, fulfillment_status: 'finished' },
  { id: 'service', product_id: 'p', quantity: 2, refund_quantity_total: 0, fulfillment_status: 'waiting' },
], ...extra });
test('completion planner writes only remaining configured service quantities after order finished', () => {
  assert.deepEqual(planProtectionFulfillment(order(), [], ['p']), { action: 'create', lines: [{ id: 'service', ship_quantity: 2 }], complete_ids: [] });
  for (const status of ['placed', 'cancelled', 'closed']) assert.equal(planProtectionFulfillment(order({ status }), [], ['p']).action, 'skip');
  for (const financial_status of ['refunded', 'refunding', 'partially_refunded']) assert.equal(planProtectionFulfillment(order({ financial_status }), [], ['p']).action, 'skip');
  assert.equal(planProtectionFulfillment(order({ cancelled_at: '2026-11-01T00:00:00Z' }), [], ['p']).action,'skip');
});
test('existing service-only fulfillment is completed but physical or mixed packages are never completed', () => {
  const parcel = { id: 'service-parcel', status: 'shipped', line_items: [{ id: 'service', ship_quantity: 2 }] };
  assert.deepEqual(planProtectionFulfillment(order(), [parcel], ['p']), { action: 'complete', lines: [], complete_ids: ['service-parcel'] });
  const mixed = { ...parcel, line_items: [...parcel.line_items, { id: 'goods', ship_quantity: 1 }] };
  assert.equal(planProtectionFulfillment(order(), [mixed], ['p']).action, 'blocked');
  assert.equal(planProtectionFulfillment(order(), [{ ...mixed, status: 'finished' }], ['p']).action, 'done');
  assert.equal(planProtectionFulfillment(order(), [{ ...parcel, status: 'finished' }], ['p']).action, 'done');
  assert.equal(planProtectionFulfillment(order(), [{ ...parcel, line_items: [{ id: 'service' }] }], ['p']).action, 'blocked');
});
