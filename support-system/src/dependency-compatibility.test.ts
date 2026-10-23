import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import nodemailer from 'nodemailer';
import sharp from 'sharp';

test('Nodemailer composes the support mail fields without SMTP or network delivery', async t => {
  const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
  t.after(() => transporter.close());
  const result = await transporter.sendMail({
    from: 'Fixture Support <support@example.invalid>',
    replyTo: 'reply@example.invalid',
    to: 'customer@example.invalid',
    subject: 'Support for fixture order',
    text: 'Your fixture support link is ready.',
    html: '<p>Your fixture support link is ready.</p>',
  });

  assert.deepEqual(result.envelope, {
    from: 'support@example.invalid', to: ['customer@example.invalid'],
  });
  assert.ok(result.messageId);
  assert.ok(Buffer.isBuffer(result.message));
  const message = result.message.toString();
  assert.match(message, /Reply-To: reply@example\.invalid/);
  assert.match(message, /Subject: Support for fixture order/);
  assert.match(message, /Content-Type: multipart\/alternative/);
  assert.match(message, /Content-Type: text\/plain/);
  assert.match(message, /Content-Type: text\/html/);
  assert.match(message, /Your fixture support link is ready/);
});

test('Sharp supports the attachment WebP and thumbnail JPEG processing pipelines', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'support-sharp-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'fixture.png');
  await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#336699' } })
    .png().toFile(input);

  let attachment = sharp(input).rotate();
  const inputMetadata = await attachment.metadata();
  assert.equal(inputMetadata.width, 1600);
  if (inputMetadata.width && inputMetadata.width > 1200) attachment = attachment.resize(1200);
  const attachmentFile = path.join(directory, 'attachment.webp');
  await attachment.webp({ quality: 80 }).toFile(attachmentFile);
  const attachmentMetadata = await sharp(attachmentFile).metadata();
  assert.equal(attachmentMetadata.format, 'webp');
  assert.equal(attachmentMetadata.width, 1200);
  assert.equal(attachmentMetadata.height, 600);

  const thumbnail = await sharp(await fs.readFile(input)).rotate()
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, progressive: true, mozjpeg: true }).toBuffer();
  const thumbnailMetadata = await sharp(thumbnail).metadata();
  assert.equal(thumbnailMetadata.format, 'jpeg');
  assert.equal(thumbnailMetadata.width, 400);
  assert.equal(thumbnailMetadata.height, 200);
  assert.ok(thumbnail.length < 100 * 1024);
});

test('Sharp rejects a non-image upload as a handled promise rejection', async () => {
  await assert.rejects(() => sharp(Buffer.from('fixture non-image bytes')).webp().toBuffer());
});
