import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmailJobNo,
  buildPaidSupportInviteEventKey,
  maskClientLink,
  renderAgentReplyNoticeEmail,
  renderPaidSupportInviteEmail,
} from './email-service';

test('buildPaidSupportInviteEventKey normalizes customer email', () => {
  assert.equal(
    buildPaidSupportInviteEventKey({
      storeSubdomain: 'store-a',
      orderId: 'ORD-1001',
      customerEmail: ' Customer@Example.COM ',
    }),
    'paid_support_invite:store-a:ORD-1001:customer@example.com',
  );
});

test('maskClientLink keeps the link usable for display without exposing the full token', () => {
  const masked = maskClientLink('https://support.example.com/ticket?t=bt_abcdefghijklmnopqrstuvwxyz123456');
  assert.equal(masked, 'https://support.example.com/ticket?t=bt_abcd...3456');
});

test('renderPaidSupportInviteEmail stores masked snapshots and sends full link body', () => {
  const rendered = renderPaidSupportInviteEmail({
    storeName: 'ThinkPro',
    orderNumber: '#1001',
    clientLink: 'https://support.example.com/ticket?t=bt_abcdefghijklmnopqrstuvwxyz123456',
  });

  assert.match(rendered.subject, /ThinkPro/);
  assert.match(rendered.html, /bt_abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(rendered.text, /bt_abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(rendered.snapshotBody, /bt_abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(rendered.snapshotBody, /bt_abcd\.\.\.3456/);
});

test('renderAgentReplyNoticeEmail stores masked snapshots and sends full ticket link body', () => {
  const rendered = renderAgentReplyNoticeEmail({
    storeName: 'ThinkPro',
    orderNumber: '#1001',
    publicTicketNo: 'T202605150001',
    clientLink: 'https://support.example.com/ticket?t=ta_abcdefghijklmnopqrstuvwxyz123456',
  });

  assert.match(rendered.subject, /T202605150001/);
  assert.match(rendered.html, /ta_abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(rendered.text, /ta_abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(rendered.snapshotBody, /ta_abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(rendered.snapshotBody, /ta_abcd\.\.\.3456/);
});

test('buildEmailJobNo is prefixed and unique enough for operator-facing records', () => {
  const first = buildEmailJobNo();
  const second = buildEmailJobNo();

  assert.match(first, /^EJ\d{14}[a-f0-9]{6}$/);
  assert.notEqual(first, second);
});
