import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CustomerClaim, CustomerOrderResponse } from '../../src/protection-customer-types';
import { ClaimDetail } from './ClaimDetail';
import { issueOptions, validSelections, selectionAmount, safeImage, evidenceUrl, money, takeAccessToken } from './domain';
test('received and missing package questions cannot retain an incompatible issue', () => {
  assert.deepEqual(issueOptions(true).map(option => option.value), ['damaged', 'missing_items']);
  assert.deepEqual(issueOptions(false).map(option => option.value), ['delivered_not_received', 'not_arrived', 'delayed']);
});
test('quantity selection cannot exceed current available items and unknown money stays unknown', () => {
  const items = [{ id: 'item', quantity: 3, amount_cents: 1000, available_quantity: 2, available_amount_cents: 667, has_active_claim: false }];
  assert.equal(validSelections([{ item_id: 'item', quantity: 2 }], items), true);
  for (const selection of [[{ item_id: 'item', quantity: 3 }], [{ item_id: 'item', quantity: .5 }], [{ item_id: 'missing', quantity: 1 }], [{ item_id: 'item', quantity: 1 }, { item_id: 'item', quantity: 1 }]]) assert.equal(validSelections(selection, items), false);
  assert.equal(selectionAmount([{ item_id: 'item', quantity: 1 }], items), 333);
  assert.equal(selectionAmount([{ item_id: 'item', quantity: 2 }], items, 250), 250);
  assert.equal(selectionAmount([{ item_id: 'item', quantity: 1 }], items, null), null);
  assert.equal(selectionAmount([{ item_id: 'item', quantity: 1 }], [{ ...items[0], amount_cents: null }]), null);
  assert.equal(money(null, 'USD'), 'Amount under review');
});
test('only safe image addresses and private evidence routes become media URLs', () => {
  assert.equal(safeImage('https://example.invalid/item.jpg'), 'https://example.invalid/item.jpg');
  for (const value of ['javascript:alert(1)', 'data:image/svg+xml,bad', '//evil.invalid/image', '/admin']) assert.equal(safeImage(value), undefined);
  assert.equal(evidenceUrl('/api/protection/evidence/uuid'), '/api/protection/evidence/uuid');
  for (const value of ['https://evil.invalid/api/protection/evidence/a', '/api/admin/protection/evidence/a', '/api/protection/evidence/../order']) assert.equal(evidenceUrl(value), undefined);
});
test('access credentials are removed immediately without retaining query or fragment credentials', () => {
  const calls: string[] = [];
  const access = takeAccessToken({ href: 'https://us-seel.com/protection?utm_source=email#access=pa_test' }, { replaceState(_state: unknown, _unused: string, next: string) { calls.push(next); } });
  assert.equal(access, 'pa_test');
  assert.deepEqual(calls, ['/protection?utm_source=email']);
});
test('open claim states accept supplements while closed states show only their recorded result', () => {
  const claim: CustomerClaim = { public_no: 'CL-fixture', protection_no: 'SP-fixture', reason: 'damaged', issue_code: 'damaged', received_package: true, description: '<script>doNotRun()</script>', status: 'submitted', requested_amount_cents: 2500, approved_amount_cents: null, currency: 'USD', selections: [], created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z', customer_message: null, evidence: [], location: null, messages: [] };
  const data = { order: { items: [] }, limits: { max_files: 6, max_file_bytes: 25 * 1024 * 1024, max_total_bytes: 100 * 1024 * 1024 } } as unknown as CustomerOrderResponse;
  for (const status of ['submitted', 'reviewing', 'needs_info', 'approved', 'rejected', 'closed'] as const) {
    const html = renderToStaticMarkup(<ClaimDetail claim={{ ...claim, status }} data={data} onClose={() => {}} onUpdated={() => {}} />);
    assert.equal(html.includes('Additional details'), ['submitted', 'reviewing', 'needs_info'].includes(status), status);
    assert.ok(html.includes('&lt;script&gt;doNotRun()&lt;/script&gt;'));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('Start a return'));
  }
});
