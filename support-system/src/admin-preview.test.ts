import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerPreviewResponse } from './admin-preview';

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
