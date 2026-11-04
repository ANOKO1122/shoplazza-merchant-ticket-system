import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { protectionMailReadiness, sendProtectionNotificationEmail } from './protection-notification-mailer';

test('protection email defaults disabled and incomplete dedicated settings never fall back to ticket SMTP', async t => {
  t.mock.method(nodemailer, 'createTransport', () => { throw new Error('No SMTP transport may be created'); });
  const env = { SUPPORT_MAIL_FROM: 'ticket@old.example', SUPPORT_SMTP_HOST: 'ordinary.invalid' };
  assert.deepEqual(protectionMailReadiness(env), { mode: 'disabled', ready: false, reason: 'disabled' });
  assert.equal(protectionMailReadiness({ ...env, SUPPORT_PROTECTION_MAIL_MODE: 'dedicated' }).ready, false);
  await assert.rejects(sendProtectionNotificationEmail({ to: 'customer@example.invalid', subject: 'Update', html: '<p>Update</p>', text: 'Update', messageId: '<fixture@us-seel.com>' }, env), /disabled/);
});

test('dedicated protection delivery uses its own sender, credentials and deterministic Message-ID', async t => {
  let delivered: any; let transport: any;
  t.mock.method(nodemailer, 'createTransport', (options: any) => {
    transport = options;
    return { sendMail: async (mail: any) => { delivered = mail; return { messageId: mail.messageId, accepted: [mail.to], rejected: [] }; }, close() {} } as any;
  });
  const env = { SUPPORT_PROTECTION_MAIL_MODE: 'dedicated', SUPPORT_PROTECTION_SMTP_HOST: 'smtp.example.invalid', SUPPORT_PROTECTION_SMTP_PORT: '465', SUPPORT_PROTECTION_SMTP_SECURE: 'true', SUPPORT_PROTECTION_SMTP_USER: 'fixture-user', SUPPORT_PROTECTION_SMTP_PASS: 'fixture-password', SUPPORT_PROTECTION_MAIL_FROM: 'Shipping Protection <updates@us-seel.com>', SUPPORT_MAIL_FROM: 'old@ordinary.invalid' };
  const result = await sendProtectionNotificationEmail({ to: 'customer@example.invalid', subject: 'Update', html: '<p>Update</p>', text: 'Update', messageId: '<same-event@us-seel.com>' }, env);
  assert.equal(result.messageId, '<same-event@us-seel.com>');
  assert.equal(delivered.from, 'Shipping Protection <updates@us-seel.com>');
  assert.equal(delivered.messageId, '<same-event@us-seel.com>');
  assert.equal(transport.host, 'smtp.example.invalid');
  assert.deepEqual(transport.auth, { user: 'fixture-user', pass: 'fixture-password' });
  for (const from of ['other@elsewhere.invalid, updates@us-seel.com', 'updates@us-seel.com>', '<updates@us-seel.com', 'Shipping\r\nBcc: hidden@elsewhere.invalid <updates@us-seel.com>']) {
    assert.equal(protectionMailReadiness({ ...env, SUPPORT_PROTECTION_MAIL_FROM: from }).ready, false, from);
  }
});
