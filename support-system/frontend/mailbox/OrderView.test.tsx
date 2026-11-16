import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProtectionOrder } from '../../src/protection-types';
import { OrderSummary, trackingNumbers } from './OrderView';

const order: ProtectionOrder = {
  id: '9', public_no: 'SP-EXAMPLE', store_subdomain: 'private-shop.example', store_name: 'Private Shop',
  order_id: 'external-81', order_number: 'ORDER-81', customer_email: 'customer@example.test', customer_name: 'Customer',
  currency: 'USD', order_amount_cents: 6797, protection_fee_cents: 198, protected_value_cents: 6599,
  refund_amount_cents: 0, payment_status: 'paid', order_status: 'open', fulfillment_status: 'fulfilled', refund_status: 'none',
  paid_at: '2026-08-25T08:43:22Z', synced_at: '2026-08-27T15:29:13Z',
  items: [], shipping_address: {}, claim_count: 0, service_fulfillment_status: 'ready',
  logistics: [
    { status: 'shipped', tracking_number: '4PX-123', tracking_items: [{ tracking_number: '4PX-123' }, { tracking_number: 'USPS-456' }] },
    { status: 'cancelled', tracking_number: 'OLD-999' },
  ],
  timeline: { ordered_at: '2026-08-25T08:43:22Z', shipped_at: '2026-08-27T15:29:13Z', shipped_source: 'merchant_fulfillment.shipped_at',
    delivered_at: null, delivered_source: null, completed_at: null, completed_source: null, items: {} },
};

test('order card shows financial summary and tracking without exposing store identity', () => {
  const html = renderToStaticMarkup(<OrderSummary order={order} onOpen={() => {}} onTrack={() => {}} />);
  assert.match(html, /ORDER-81/);
  assert.match(html, /external-81/);
  assert.match(html, /67\.97/);
  assert.match(html, /1\.98/);
  assert.match(html, /物流查询/);
  assert.doesNotMatch(html, /Private Shop|private-shop\.example/);
});

test('tracking list excludes cancelled shipments and deduplicates numbers', () => {
  assert.deepEqual(trackingNumbers(order.logistics), ['4PX-123', 'USPS-456']);
});
