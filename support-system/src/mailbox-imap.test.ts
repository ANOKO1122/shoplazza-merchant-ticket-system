import assert from 'node:assert/strict';
import test from 'node:test';
import { completedBackfillCursor, cursorForValidity, importSearchPlan, parseIncomingRaw, selectImportUids, sourceComplete } from './mailbox-imap';

const raw = Buffer.from(`From: Buyer <Buyer@Example.invalid>\r
To: Customer Support <customersupport@reply.us-seel.com>\r
Subject: Re: Claim update\r
Message-ID: <incoming@example.invalid>\r
In-Reply-To: <notice@example.invalid>\r
References: <older@example.invalid> <notice@example.invalid>\r
Date: Fri, 13 Nov 2026 10:00:00 +0000\r
MIME-Version: 1.0\r
Content-Type: multipart/mixed; boundary="x"\r
\r
--x\r
Content-Type: text/plain; charset=utf-8\r
\r
My photos are attached.\r
--x\r
Content-Type: image/jpeg; name="photo.jpg"\r
Content-Disposition: attachment; filename="photo.jpg"\r
Content-Transfer-Encoding: base64\r
\r
/9j/AA==\r
--x--\r
`);

test('parses plain text, sender, thread references and verified attachment bytes', async () => {
  const parsed = await parseIncomingRaw(raw, '7', 9);
  assert.equal(parsed.sender, 'buyer@example.invalid');
  assert.equal(parsed.body.trim(), 'My photos are attached.');
  assert.deepEqual(parsed.references, ['<older@example.invalid>', '<notice@example.invalid>']);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].mimeType, 'image/jpeg');
  assert.equal(parsed.attachments[0].bytes?.toString('hex'), 'ffd8ff00');
});

test('rejects attachment spoofing and keeps a visible metadata stub', async () => {
  const unsafe = Buffer.from(`From: buyer@example.invalid\r
To: customersupport@reply.us-seel.com\r
Content-Type: application/pdf; name="report.pdf"\r
Content-Disposition: attachment; filename="report.pdf"\r
\r
<script>bad</script>`);
  const parsed = await parseIncomingRaw(unsafe, '7', 10);
  assert.equal(parsed.attachments[0].bytes, undefined);
  assert.equal(parsed.attachments[0].omittedReason, 'unsupported_type');
});

test('UID selection resumes after cursor and restarts safely on UIDVALIDITY change', () => {
  assert.deepEqual(selectImportUids({ uidValidity: '7', lastUid: 20 }, '7', [19, 20, 21, 22]), [21, 22]);
  assert.deepEqual(selectImportUids({ uidValidity: '7', lastUid: 20 }, '8', [4, 5]), [4, 5]);
});

test('a capped or shorter-than-advertised raw fetch is not parsed as a complete email', () => {
  assert.equal(sourceComplete(undefined, 36 * 1024 * 1024), false);
  assert.equal(sourceComplete(100, 99), false);
  assert.equal(sourceComplete(100, 100), true);
});

test('an empty initial window retains its date boundary until its UID cursor is established', () => {
  const now = new Date('2026-11-13T10:00:00Z');
  const first = importSearchPlan({ uidValidity: null, lastUid: 0, initialSince: null }, '7', now);
  assert.deepEqual(first.query, { since: new Date('2026-10-14T10:00:00Z') });
  const retry = importSearchPlan({ uidValidity: '7', lastUid: 0, initialSince: first.initialSince }, '7', new Date('2026-11-14T10:00:00Z'));
  assert.deepEqual(retry.query, first.query);
  assert.equal(completedBackfillCursor([], 209, 0), 209);
  assert.equal(completedBackfillCursor([], 9, cursorForValidity({ uidValidity: '7', lastUid: 209 }, '8')), 9);
  assert.equal(completedBackfillCursor(Array.from({ length: 50 }, (_, index) => index + 1), 209, 0), null);
  const incremental = importSearchPlan({ uidValidity: '7', lastUid: 209, initialSince: null }, '7', now);
  assert.deepEqual(incremental.query, { uid: '210:*' });
});
