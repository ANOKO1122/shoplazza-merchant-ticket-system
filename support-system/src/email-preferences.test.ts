import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { EMAIL_PREFERENCES_SCHEMA_SQL } from './email-preferences-schema';
import { decorateEmailWithUnsubscribe, getEmailUnsubscribePreference, isEmailUnsubscribed, normalizePreferenceEmail, unsubscribeEmailByToken, withEmailPreferenceGuard } from './email-preferences';
import { closeDatabasePools, getClient } from './pg';

test('preference identities preserve aliases and reject recipient lists', () => {
  assert.equal(normalizePreferenceEmail(' Customer+Claim@Example.com '), 'customer+claim@example.com');
  assert.notEqual(normalizePreferenceEmail('a.b@example.com'), normalizePreferenceEmail('ab@example.com'));
  for (const value of ['', 'a@example.com,b@example.com', 'A <a@example.com>', 'a@example.com\r\nBcc:x@example.com']) assert.throws(() => normalizePreferenceEmail(value));
});

test('queued legacy footers adopt the current label without rotating a valid token', async () => {
  const token = `eu_${'x'.repeat(43)}`;
  const link = `https://tickets.example.invalid/email-preferences?token=${token}`;
  const html = `<html><body><p>Your update</p><!-- email-unsubscribe:start --><a href="${link}">Unsubscribe from ticket emails</a><br>This stops all ticket emails across stores. Your shipping protection email preference stays unchanged.<!-- email-unsubscribe:end --></body></html>`;
  const db = { query: async (sql: string, values: unknown[]) => {
    assert.match(sql, /^SELECT 1 FROM support_email_unsubscribe_tokens/);
    assert.deepEqual(values, [crypto.createHash('sha256').update(token).digest('hex'), 'ticket', 'buyer@example.invalid']);
    return { rows: [{ '?column?': 1 }] };
  } } as any;
  const result = await decorateEmailWithUnsubscribe({ to: 'Buyer@Example.invalid', subject: 'Update', html, text: '' }, 'ticket', 'https://tickets.example.invalid', db);
  assert.match(result.html, />Unsubscribe<\/a>/);
  assert.ok(result.html.includes(`href="${link}"`));
  assert.doesNotMatch(result.html, /Unsubscribe from|This stops all|preference stays unchanged/);
  assert.equal(result.html.match(/email-unsubscribe:start/g)?.length, 1);
  assert.ok(result.html.indexOf('email-unsubscribe:end') < result.html.indexOf('</body>'));
  assert.match(result.text, /Unsubscribe/);
  assert.doesNotMatch(result.text, /This stops all/);
  const retry = await decorateEmailWithUnsubscribe(result, 'ticket', 'https://tickets.example.invalid', db);
  assert.deepEqual(retry, result);
});

const databaseUrl = process.env.SUPPORT_EMAIL_PREFERENCES_TEST_DATABASE_URL;
test('independent preferences, opaque links and delivery serialization', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /_test$/);
  process.env.SUPPORT_DATABASE_URL = databaseUrl;
  process.env.SUPPORT_PG_POOL_MAX = '1';
  const db = new Pool({ connectionString: databaseUrl });
  const mail = { to: ' Customer+Claim@Example.com ', subject: 'Fixture', html: '<html><body><p>Your update</p></body></html>', text: 'Your update' };
  const token = (html: string) => html.match(/token=(eu_[A-Za-z0-9_-]{43})/)![1];
  try {
    await db.query(EMAIL_PREFERENCES_SCHEMA_SQL);
    await db.query('TRUNCATE support_email_preferences, support_email_unsubscribe_tokens');
    const ticket = await decorateEmailWithUnsubscribe(mail, 'ticket', 'https://tickets.example.invalid');
    const protection = await decorateEmailWithUnsubscribe(mail, 'protection', 'https://us-seel.com');
    await t.test('footer is scoped, opaque, before body end and stable across retry', async () => {
      assert.match(ticket.html, />Unsubscribe<\/a>/);
      assert.match(protection.html, />Unsubscribe<\/a>/);
      assert.match(protection.html, /https:\/\/us-seel\.com\/email-preferences\?token=eu_/);
      assert.doesNotMatch(ticket.html, /Customer\+Claim|customer\+claim/i);
      assert.ok(ticket.html.indexOf('email-unsubscribe:end') < ticket.html.indexOf('</body>'));
      assert.match(ticket.text, /Unsubscribe/);
      const retry = await decorateEmailWithUnsubscribe(ticket, 'ticket', 'https://tickets.example.invalid');
      assert.equal(retry.html, ticket.html); assert.equal(retry.text, ticket.text);
      const other = await decorateEmailWithUnsubscribe({ ...ticket, to: 'other@example.com' }, 'ticket', 'https://tickets.example.invalid');
      assert.notEqual(token(other.html), token(ticket.html));
      assert.equal(other.html.match(/email-unsubscribe:start/g)?.length, 1);
    });
    await t.test('lookup is read-only; token binds category and normalized recipient across stores', async () => {
      const view = await getEmailUnsubscribePreference(token(ticket.html));
      assert.equal(view?.category, 'ticket'); assert.equal(view?.unsubscribed, false);
      assert.doesNotMatch(view!.email_masked, /customer\+claim/);
      await unsubscribeEmailByToken(token(ticket.html));
      await unsubscribeEmailByToken(token(ticket.html));
      assert.equal(await isEmailUnsubscribed('CUSTOMER+CLAIM@example.com', 'ticket'), true);
      assert.equal(await isEmailUnsubscribed(mail.to, 'protection'), false);
      assert.equal(await isEmailUnsubscribed('customer@example.com', 'ticket'), false);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM support_email_preferences')).rows[0].n, 1);
      for (const invalid of ['', token(ticket.html).slice(0, -1), 'eu_' + 'z'.repeat(43), [token(ticket.html)], { token: token(ticket.html) }]) {
        assert.equal(await getEmailUnsubscribePreference(invalid), null);
        assert.equal(await unsubscribeEmailByToken(invalid), null);
      }
    });
    await t.test('final guard blocks suppressed category but allows the other category and propagates failures', async () => {
      let sends = 0;
      assert.deepEqual(await withEmailPreferenceGuard(mail.to, 'ticket', async () => ++sends), { suppressed: true });
      assert.deepEqual(await withEmailPreferenceGuard(mail.to, 'protection', async () => ++sends), { suppressed: false, value: 1 });
      assert.equal(sends, 1);
      await assert.rejects(withEmailPreferenceGuard(mail.to, 'protection', async () => { throw new Error('fixture delivery failure'); }), /fixture delivery failure/);
      await unsubscribeEmailByToken(token(protection.html));
      assert.equal(await isEmailUnsubscribed(mail.to, 'protection'), true);
    });
    await t.test('confirmation waits for an in-progress send and all later sends are suppressed', async () => {
      const address = 'concurrent@example.invalid';
      const decorated = await decorateEmailWithUnsubscribe({ ...mail, to: address }, 'ticket', 'https://tickets.example.invalid');
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { release = r; });
      const sending = withEmailPreferenceGuard(address, 'ticket', async () => { enter(); await held; return 'accepted'; });
      await entered;
      let confirmed = false;
      const unsubscribing = unsubscribeEmailByToken(token(decorated.html)).then(value => { confirmed = true; return value; });
      try {
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          waiting = Number((await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n) > 0;
          if (waiting) break;
          await new Promise(r => setTimeout(r, 10));
        }
        assert.ok(waiting, 'Unsubscribe waits on delivery preference lock'); assert.equal(confirmed, false);
      } finally { release(); }
      assert.deepEqual(await sending, { suppressed: false, value: 'accepted' });
      assert.equal((await unsubscribing)?.unsubscribed, true);
      assert.deepEqual(await withEmailPreferenceGuard(address, 'ticket', async () => assert.fail('must not send')), { suppressed: true });
    });
    await t.test('decorator token insert follows caller transaction rollback', async () => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const decorated = await decorateEmailWithUnsubscribe({ ...mail, to: 'rollback@example.invalid' }, 'protection', 'https://us-seel.com', client);
        await client.query('ROLLBACK');
        assert.equal(await getEmailUnsubscribePreference(token(decorated.html)), null);
      } finally { client.release(); }
    });
    await t.test('SMTP preference locks leave the ordinary database pool available', async () => {
      const occupied = await getClient();
      const delivery = withEmailPreferenceGuard('pool-fixture@example.invalid', 'ticket', async () => 'ready');
      let completed: unknown;
      try { completed = await Promise.race([delivery, new Promise(resolve => setTimeout(() => resolve('blocked'), 1000))]); }
      finally { occupied.release(); }
      await delivery;
      assert.deepEqual(completed, { suppressed: false, value: 'ready' });
    });
    await t.test('missing preference storage fails closed without calling transport', async () => {
      await db.query('ALTER TABLE support_email_preferences RENAME TO support_email_preferences_hidden');
      try { await assert.rejects(withEmailPreferenceGuard('never@example.invalid', 'ticket', async () => assert.fail('must not send'))); }
      finally { await db.query('ALTER TABLE support_email_preferences_hidden RENAME TO support_email_preferences'); }
    });
  } finally { await db.end(); await closeDatabasePools(); }
});
