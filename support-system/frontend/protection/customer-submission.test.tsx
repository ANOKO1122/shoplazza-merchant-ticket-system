import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CustomerClaim } from '../../src/protection-customer-types';
import type { ProtectionOrder } from '../../src/protection-types';
import { CustomerSubmission } from './CustomerSubmission';

const submission: CustomerClaim = {
  public_no: 'CL-fixture', protection_no: 'SP-fixture', reason: 'stolen', issue_code: 'delivered_not_received',
  received_package: false, description: 'Package not received', status: 'submitted', requested_amount_cents: 1000,
  approved_amount_cents: null, currency: 'USD', selections: [], created_at: '2026-11-08T00:00:00Z',
  updated_at: '2026-11-08T00:00:00Z', customer_message: null, evidence: [], messages: [],
  location: { latitude: 23.174861, longitude: 113.335333, accuracy_meters: 30, captured_at: '2026-11-08T00:00:00Z' },
};
const order: ProtectionOrder = {
  id: '1', public_no: 'SP-fixture', store_subdomain: 'fixture.invalid', store_name: 'Fixture', order_id: 'fixture', order_number: '#1',
  customer_email: 'fixture@example.invalid', customer_name: 'Fixture', currency: 'USD', order_amount_cents: 1000,
  protection_fee_cents: 100, protected_value_cents: 1000, refund_amount_cents: 0, payment_status: 'paid', order_status: 'finished',
  fulfillment_status: 'fulfilled', refund_status: 'none', paid_at: null, synced_at: '2026-11-08T00:00:00Z', items: [],
  logistics: [], shipping_address: {}, claim_count: 1, service_fulfillment_status: 'completed',
};

test('staff location review shows original coordinates and qualifies the device estimate', () => {
  const html = renderToStaticMarkup(<CustomerSubmission submission={submission} order={order} />);
  assert.ok(html.includes('顾客提交的位置'));
  assert.ok(html.includes('23.174861, 113.335333'));
  assert.ok(html.includes('设备报告的估计范围'));
  assert.ok(html.includes('30 米'));
  assert.ok(html.includes('不代表实际误差保证'));
  assert.ok(html.includes('WGS84'));
  assert.ok(!html.includes('顾客自愿提供'));
  assert.ok(!html.includes('<iframe') && !html.includes('maps.google'));
});

test('claims without a saved location show a neutral absence message', () => {
  const html = renderToStaticMarkup(<CustomerSubmission submission={{ ...submission, location: null }} order={order} />);
  assert.ok(html.includes('此申请未记录位置'));
  assert.ok(!html.includes('不影响正常审核'));
});
