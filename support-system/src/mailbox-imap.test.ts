import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIncomingRaw, selectImportUids } from './mailbox-imap';

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
