import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerPreviewResponse, buildTrackingDetails, extractTrackingNo } from './admin-preview';

test('buildCustomerPreviewResponse returns read-only customer view data without tokens', () => {
  const response = buildCustomerPreviewResponse({
    snapshot: {
      store_subdomain: 'store-a',
      store_name: 'ThinkPro',
      order_id: 'ORD-1001',
      order_number: '#1001',
      customer_email: 'customer@example.com',
      customer_name: 'Jane Doe',
      order_amount: '85.88',
      order_currency: 'USD',
      paid_at: '2026-05-11T10:30:00Z',
      payment_method: 'Card',
      card_last4: '4690',
      logistics_json: { tracking_number: 'TRACK123' },
      items_json: [{ title: 'Keyboard', quantity: 1 }],
    },
    ticket: {
      public_ticket_no: 'T202605150001',
      status: 'waiting',
      issue_type: 'Damaged item',
      created_at: '2026-05-15T01:00:00Z',
      updated_at: '2026-05-15T02:00:00Z',
      customer_access_token_hash: 'secret',
    },
    messages: [
      {
        id: 1,
        sender_type: 'agent',
        sender_name: 'Admin',
        content: 'Please upload photos.',
        created_at: '2026-05-15T02:00:00Z',
      },
    ],
  });

  assert.equal(response.ok, true);
  assert.equal(response.preview_mode, true);
  assert.equal(response.mode, 'existing_ticket');
  assert.equal(response.order.order_number, '#1001');
  assert.equal(response.order.tracking_no, 'TRACK123');
  assert.deepEqual(response.order.tracking_numbers, ['TRACK123']);
  assert.deepEqual(response.order.shipments, []);
  assert.equal(response.ticket?.public_ticket_no, 'T202605150001');
  assert.equal(response.messages[0].content, 'Please upload photos.');
  assert.equal(JSON.stringify(response).includes('secret'), false);
  assert.equal(JSON.stringify(response).includes('token'), false);
});

test('buildCustomerPreviewResponse marks orders without a ticket as new_ticket', () => {
  const response = buildCustomerPreviewResponse({
    snapshot: {
      store_subdomain: 'store-a',
      order_id: 'ORD-1002',
      customer_email: 'customer@example.com',
      items_json: [],
    },
    ticket: null,
    messages: [],
  });

  assert.equal(response.preview_mode, true);
  assert.equal(response.mode, 'new_ticket');
  assert.equal(response.ticket, null);
});

test('tracking details keep packages separate and distinguish cumulative from current numbers', () => {
  const snapshot = {
    logistics_json: { tracking_number: 'STALE-LOGISTICS' },
    raw_order_json: { fulfillments: [
      {
        id: 'package-a', tracking_number: 'OLD-NUMBER', tracking_company: 'Old carrier', updated_at: '2026-10-21T12:00:00Z',
        tracking_number_history: ['HISTORY-FIRST', 'NEW-A', 'HISTORY-FIRST'],
        tracking_items: [
          { tracking_number: ' NEW-A ', tracking_company: 'Carrier A' },
          { tracking_number: 'NEW-A', tracking_company: 'Carrier A' },
          { tracking_number: 'NEW-B', tracking_company: 'Carrier B' },
        ],
      },
      { id: 'package-b', tracking_number: 'SECOND', tracking_company: 'Carrier C', updated_at: '2026-10-22T12:00:00Z' },
    ] },
  };
  const result = buildTrackingDetails(snapshot);
  assert.equal(result.tracking_no, 'NEW-A');
  assert.deepEqual(result.tracking_numbers, ['HISTORY-FIRST', 'NEW-A', 'NEW-B', 'SECOND']);
  assert.deepEqual(result.shipments, [
    { id: 'package-a', tracking_numbers: ['HISTORY-FIRST', 'NEW-A', 'NEW-B'], current_tracking_numbers: ['NEW-A', 'NEW-B'], tracking_company: 'Carrier A, Carrier B', updated_at: '2026-10-21T12:00:00Z' },
    { id: 'package-b', tracking_numbers: ['SECOND'], current_tracking_numbers: ['SECOND'], tracking_company: 'Carrier C', updated_at: '2026-10-22T12:00:00Z' },
  ]);
  assert.equal(extractTrackingNo(snapshot), result.tracking_no);
  const preview = buildCustomerPreviewResponse({ snapshot });
  assert.deepEqual(preview.order.shipments, result.shipments);
  assert.deepEqual(preview.order.tracking_numbers, result.tracking_numbers);
  assert.ok(!JSON.stringify(result).includes('OLD-NUMBER'));
  assert.ok(!JSON.stringify(result).includes('STALE-LOGISTICS'));
});

test('duplicate package IDs retain both numbers while the newest remains current', () => {
  const older = { id: 'same-package', tracking_number: 'OLD123', updated_at: '2026-10-20T12:00:00Z' };
  const current = { id: 'same-package', tracking_number: 'NEW123', tracking_no: 'OLD-ALIAS', updated_at: '2026-10-21T12:00:00Z' };
  for (const fulfillments of [[older, current], [current, older]]) {
    const result = buildTrackingDetails({ raw_order_json: { fulfillments } });
    assert.equal(result.shipments.length, 1);
    assert.deepEqual([...result.tracking_numbers].sort(), ['NEW123', 'OLD123']);
    assert.deepEqual(result.shipments[0].current_tracking_numbers, ['NEW123']);
    assert.equal(result.tracking_no, 'NEW123');
  }
});

test('structured tracking data does not attach unrelated legacy numbers to packages', () => {
  for (const fulfillments of [[], [{ id: 'package-a', tracking_number: 'OLD123', tracking_items: [] }]]) {
    const result = buildTrackingDetails({
      logistics_json: { tracking_number: 'STALE123' },
      raw_order_json: { tracking_number: 'STALE456', fulfillments },
    });
    assert.equal(result.tracking_no, '');
    assert.deepEqual(result.tracking_numbers, []);
  }
});

test('a package without current numbers still exposes its retained numbers without marking them current', () => {
  const result = buildTrackingDetails({ raw_order_json: { fulfillments: [
    { id: 'package-a', tracking_items: [], tracking_number_history: [' OLD123 ', 'OLD123', '', null, 42] },
  ] } });
  assert.equal(result.tracking_no, '');
  assert.deepEqual(result.tracking_numbers, ['OLD123']);
  assert.deepEqual(result.shipments[0].current_tracking_numbers, []);
  assert.deepEqual(result.shipments[0].tracking_numbers, ['OLD123']);
});

test('two retained stages of one fulfillment stay in one package while another ID stays separate', () => {
  const result = buildTrackingDetails({ raw_order_json: { fulfillments: [
    { id: 'single-erp-record', tracking_number_history: ['FIRST-STAGE', 'SECOND-STAGE'], tracking_number: 'SECOND-STAGE' },
    { id: 'another-package', tracking_number_history: ['THIRD'], tracking_number: 'THIRD' },
  ] } });
  assert.equal(result.shipments.length, 2);
  assert.deepEqual(result.shipments[0].tracking_numbers, ['FIRST-STAGE', 'SECOND-STAGE']);
  assert.deepEqual(result.shipments[0].current_tracking_numbers, ['SECOND-STAGE']);
  assert.deepEqual(result.tracking_numbers, ['FIRST-STAGE', 'SECOND-STAGE', 'THIRD']);
  assert.equal(result.tracking_no, 'SECOND-STAGE');
});

test('legacy nested tracking fields and arrays stay compatible without inventing package identities', () => {
  const result = buildTrackingDetails({ logistics_json: { shipment: { tracking_numbers: ['FIRST123', '', 'SECOND123', 'FIRST123'] } } });
  assert.equal(result.tracking_no, 'FIRST123');
  assert.deepEqual(result.tracking_numbers, ['FIRST123', 'SECOND123']);
  assert.deepEqual(result.shipments, []);
  assert.deepEqual(buildTrackingDetails(null), { tracking_no: '', tracking_numbers: [], shipments: [] });
  assert.deepEqual(buildTrackingDetails({ raw_order_json: { fulfillments: [null, 1, []] } }).shipments, []);
});
