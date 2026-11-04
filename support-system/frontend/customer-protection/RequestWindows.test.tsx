import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CustomerOrderResponse, ProtectionRequestWindow } from '../../src/protection-customer-types';
import { canOpenRequest, reasonWindowNotice, requestReason, requestDate, selectedWindowProblem, SelectedRequestWindows, RequestWindowNotice } from './RequestWindows';
import { ServiceDetails } from './ServiceDetails';
const open: ProtectionRequestWindow = { reason: 'lost', status: 'open', opens_at: '2026-11-01T18:00:00Z', closes_at: '2026-11-20T18:00:00Z', basis: 'Based on the shipment information supplied by the store.', message: 'You can submit this request now.' };
const items = [
  { id: 'first', title: 'First parcel', available_quantity: 1, has_active_claim: false, request_windows: [open] },
  { id: 'second', title: 'Later parcel', available_quantity: 1, has_active_claim: false, request_windows: [{ ...open, status: 'not_open', message: 'This item is not yet eligible. Check its opening date.' }] },
] as CustomerOrderResponse['order']['items'];
test('selected parcel timing cannot be bypassed using the open window of another parcel', () => {
  assert.equal(selectedWindowProblem('not_arrived', [{ item_id: 'first', quantity: 1 }], items), null);
  assert.match(selectedWindowProblem('missing_items', [{ item_id: 'first', quantity: 1 }, { item_id: 'second', quantity: 1 }], items)!, /not opened/);
  assert.match(selectedWindowProblem('not_arrived', [{ item_id: 'unknown', quantity: 1 }], items)!, /not available/);
  assert.equal(requestReason('delivered_not_received'), 'stolen');
  assert.equal(requestReason('wrong_item'), null);
  assert.equal(requestReason('other'), null);
});
test('closed request dates keep the explanation accessible without bypassing other order restrictions', () => {
  assert.equal(canOpenRequest({ can_submit: false, reason_code: 'request_window', message: null }), true);
  assert.equal(canOpenRequest({ can_submit: true, reason_code: null, message: null }), true);
  for (const reason_code of ['manual_review', 'no_available_items', 'refunded', null]) {
    assert.equal(canOpenRequest({ can_submit: false, reason_code, message: null }), false);
  }
});
test('mixed parcels allow choosing open items while preselected closed items show their own deadline', () => {
  assert.equal(reasonWindowNotice('not_arrived', [], items), null);
  assert.equal(reasonWindowNotice('not_arrived', [{ item_id: 'first', quantity: 1 }], items), null);
  const mixed = reasonWindowNotice('not_arrived', [{ item_id: 'second', quantity: 1 }], items)!;
  assert.equal(mixed.returnToItems, true);
  assert.deepEqual(mixed.items.map(item => item.id), ['second']);
  const expired = items.map(item => ({ ...item, request_windows: [{ ...open, status: 'expired' as const }] }));
  const closed = reasonWindowNotice('not_arrived', [], expired)!;
  assert.equal(closed.returnToItems, false);
  assert.equal(closed.items.length, 2);
  assert.match(selectedWindowProblem('not_arrived', [{ item_id: 'first', quantity: 1 }], expired)!, /deadline.*passed/);
});
test('expired, future and unknown notices explain dates without a support referral or invented deadline', () => {
  for (const status of ['expired', 'not_open', 'unknown'] as const) {
    const window = { ...open, status, ...(status === 'unknown' ? { opens_at: null, closes_at: null } : {}) };
    const html = renderToStaticMarkup(<RequestWindowNotice issue="not_arrived" items={[{ id: 'first', title: 'First parcel', window }]} basis="shipment" />);
    assert.match(html, status === 'expired' ? /request window has closed/ : status === 'not_open' ? /Requests are not open yet/ : /Request dates are not available/);
    assert.doesNotMatch(html, /contact|support|<a\b/i);
    assert.match(html, /60 days after your item ships/);
    assert.match(html, /90 days after the order date/);
    if (status === 'unknown') { assert.match(html, /Not yet available/); assert.doesNotMatch(html, /Nov 20/); }
    else assert.match(html, /Nov 20, 2026, 6:00 PM UTC/);
  }
});
test('a waiting period beyond the order deadline does not claim a future deadline has already passed', () => {
  const window = { ...open, status: 'expired' as const, opens_at: '2026-12-01T18:00:00Z' };
  const html = renderToStaticMarkup(<RequestWindowNotice issue="not_arrived" items={[{ id: 'late', title: 'Late shipment', window }]} />);
  assert.match(html, /waiting period extends beyond/);
  assert.match(html, /Dec 1, 2026, 6:00 PM UTC/);
  assert.match(html, /Nov 20, 2026, 6:00 PM UTC/);
  assert.doesNotMatch(html, /deadline has passed|already passed/);
});
test('current dates do not imply an existing request is rejected and missing dates are not invented', () => {
  const html = renderToStaticMarkup(<SelectedRequestWindows data={{ order: { items } } as CustomerOrderResponse} selections={[{ item_id: 'second', quantity: 1 }]} issue="not_arrived" existing />);
  assert.match(html, /Current request window/);
  assert.match(html, /Your existing review and requests for additional information can continue/);
  assert.match(html, /UTC/);
  assert.equal(requestDate(null), 'Not yet available');
  assert.equal(requestDate('bad date'), 'Not yet available');
  assert.match(requestDate('2026-11-01T18:00:00Z'), /6:00 PM/);
});
test('the reusable service information has an explicit button and remains outside checkbox labels', () => {
  const html = renderToStaticMarkup(<ServiceDetails />);
  assert.match(html, /aria-label="About Shipping Protection"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /type="button"/);
  assert.doesNotMatch(html, /<label|\b(?:insurance|insured|underwriting|policyholder|seel)\b|承保|保险/i);
});
