import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentPolicy, matchNotificationThread, normalizeMailboxAddress, parseMailHeaders } from './mailbox-domain';

test('normalizes a parsed sender and rejects malformed addresses', () => {
  assert.equal(normalizeMailboxAddress(' Customer@Example.COM '), 'customer@example.com');
  assert.equal(normalizeMailboxAddress('a@example.com\r\nBcc: other@example.com'), null);
  assert.equal(normalizeMailboxAddress('not-an-address'), null);
});

test('extracts message IDs from References without admitting arbitrary text', () => {
  assert.deepEqual(parseMailHeaders('<one@example.com> garbage <two@example.com>'), ['<one@example.com>', '<two@example.com>']);
  assert.deepEqual(parseMailHeaders(undefined), []);
});

test('only a sent notification reply from its recipient auto-links a claim', () => {
  const notification = { messageId: '<notice@example.com>', recipient: 'buyer@example.com', status: 'sent' };
  assert.equal(matchNotificationThread({ sender: 'BUYER@example.com', references: ['<notice@example.com>'], notification }), 'verified');
  assert.equal(matchNotificationThread({ sender: 'forwarded@example.com', references: ['<notice@example.com>'], notification }), 'candidate');
  assert.equal(matchNotificationThread({ sender: 'buyer@example.com', references: ['<notice@example.com>'], notification: { ...notification, status: 'pending' } }), 'none');
});

test('accepts real image and PDF signatures but rejects spoofed files and size limits', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  assert.equal(attachmentPolicy({ filename: 'photo.jpg', contentType: 'image/jpeg', bytes: jpeg, count: 1, totalBytes: jpeg.length }).accepted, true);
  assert.equal(attachmentPolicy({ filename: 'photo.jpg', contentType: 'image/jpeg', bytes: Buffer.from('script'), count: 1, totalBytes: 6 }).accepted, false);
  const pdf = Buffer.from('%PDF-1.7\n');
  assert.equal(attachmentPolicy({ filename: 'report.pdf', contentType: 'application/pdf', bytes: pdf, count: 1, totalBytes: pdf.length }).accepted, true);
  assert.equal(attachmentPolicy({ filename: 'report.pdf', contentType: 'application/pdf', bytes: pdf, count: 7, totalBytes: pdf.length }).accepted, false);
  assert.equal(attachmentPolicy({ filename: 'report.pdf', contentType: 'application/pdf', bytes: pdf, count: 1, totalBytes: 25 * 1024 * 1024 + 1 }).accepted, false);
});
