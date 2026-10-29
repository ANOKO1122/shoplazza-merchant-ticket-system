import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import nodemailer from 'nodemailer';
import * as pg from './pg';
import { createBootstrapToken, hashToken } from './token';
import { createTicket } from './ticket-service';
import { createSupportRouter } from './support-routes';
import { createAgentReplyNoticeEmailJob, createCustomerComplaintInviteJob } from './email-service';

// Explicit opt-in only: no .env, live database, provider requests or email delivery.
const testUrl = process.env.SUPPORT_INVITE_TEST_DATABASE_URL;
const identity = {
  storeSubdomain: 'invite-fixture.invalid', storeName: 'Fixture Store',
  orderId: 'fixture-order', orderNumber: '#FIXTURE', customerEmail: 'customer@example.invalid',
};

test('invitation activation and original email entry work in PostgreSQL', { skip: !testUrl, timeout: 60_000 }, async t => {
  const url = new URL(testUrl!);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/support_[a-z0-9_]*_test$/i);
  assert.equal(url.search, '');
  const env = {
    SUPPORT_DATABASE_URL: testUrl!, SUPPORT_BOOTSTRAP_TOKEN_DAYS: '60', SUPPORT_TICKET_ACCESS_TOKEN_DAYS: '120',
    SUPPORT_PUBLIC_BASE_URL: 'https://support.example.invalid', SUPPORT_TOKEN_SECRET: 'fixture-only',
    SUPPORT_MAIL_FROM: 'support@example.invalid', SUPPORT_SMTP_HOST: 'smtp.invalid', SUPPORT_SMTP_PORT: '1025',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.mock.method(nodemailer, 'createTransport', () => { throw new Error('SMTP forbidden in activation tests'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('External HTTP forbidden in activation tests'); });
  const pool = pg.getPool();
  t.after(async () => {
    await pg.closeDatabasePools();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, url.pathname.slice(1));
  assert.equal(Number((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count), 0,
    'only a fresh empty disposable database may be used');
  await pg.ensureTables();

  const app = express();
  app.use(express.json());
  app.use('/api/support', createSupportRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const port = (server.address() as { port: number }).port;
  const send = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method, path: '/api/support' + path,
      headers: { 'Content-Type': 'application/json' } }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(data) }));
    });
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
  const tokenRow = async (token: string) => (await pool.query(
    'SELECT *, expires_at::text AS expiry FROM support_access_tokens WHERE token_hash=$1', [hashToken(token)],
  )).rows[0];
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM support_tickets) AS tickets,
    (SELECT count(*)::int FROM support_ticket_messages) AS messages,
    (SELECT count(*)::int FROM support_access_tokens WHERE purpose='ticket_access') AS access_tokens`)).rows[0];
  const submit = (token: string, extra = {}) => send('POST', '/tickets', { token, description: 'Where is my order?', ...extra });
  const create = (token: string, extra = {}) => createTicket({ ...identity, description: 'Where is my order?',
    bootstrapTokenHash: hashToken(token), ...extra });
  const invite = async (forceNewTicket = false) => {
    const token = await createBootstrapToken({ ...identity, forceNewTicket });
    // Simulate a payment invitation opened twenty days after it was sent.
    await pool.query(`UPDATE support_access_tokens SET created_at=now()-interval '20 days',
      expires_at=now()+interval '40 days' WHERE token_hash=$1`, [hashToken(token)]);
    return token;
  };
  const reset = () => pool.query('TRUNCATE support_tickets, support_ticket_messages, support_access_tokens, support_email_jobs');

  for (const forceNew of [false, true]) {
    await t.test(`${forceNew ? 'manual' : 'payment'} invitation copies the first ticket expiry only on successful submission`, async () => {
      await reset();
      const token = await invite(forceNew);
      const unrelated = await invite(true);
      const otherExpiry = (await tokenRow(unrelated)).expiry;
      const before = (await tokenRow(token)).expires_at.getTime();
      const result = await submit(token);
      assert.equal(result.status, 200);
      const bootstrap = await tokenRow(token);
      const access = await tokenRow(result.body.accessToken);
      assert.equal(bootstrap.expiry, access.expiry, 'expiry must match exactly, including database microseconds');
      assert.ok(bootstrap.expires_at.getTime() > before + 79 * 86400_000);
      assert.ok(Math.abs(access.expires_at.getTime() - Date.now() - 120 * 86400_000) < 10_000);
      assert.equal((await tokenRow(unrelated)).expiry, otherExpiry);
      assert.deepEqual(await counts(), { tickets: 1, messages: 2, access_tokens: 1 });
    });
  }

  await t.test('opening an unused invitation and rejected submissions do not activate or extend it', async () => {
    await reset();
    const token = await invite();
    const expiry = (await tokenRow(token)).expiry;
    const opened = await send('GET', '/bootstrap?t=' + token);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.mode, 'new_ticket');
    assert.equal((await submit(token, { issue_type: 'invalid type' })).status, 400);
    assert.equal((await tokenRow(token)).expiry, expiry);
    assert.deepEqual(await counts(), { tickets: 0, messages: 0, access_tokens: 0 });
  });

  await t.test('an activated payment invitation opens its own closed ticket instead of another open ticket for the order', async () => {
    await reset();
    const token = await invite();
    const original = await create(token);
    await pool.query("UPDATE support_tickets SET status='closed' WHERE public_ticket_no=$1", [original.publicTicketNo]);
    await create(await invite(true));
    const expiry = (await tokenRow(token)).expiry;
    const opened = await send('GET', '/bootstrap?t=' + token);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.mode, 'existing_ticket');
    assert.equal(opened.body.ticket.public_ticket_no, original.publicTicketNo);
    assert.equal(opened.body.ticket.status, 'closed');
    assert.equal((await tokenRow(token)).expiry, expiry);
    const repeated = await submit(token);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.publicTicketNo, original.publicTicketNo);
    assert.equal((await tokenRow(token)).expiry, expiry);
    assert.equal((await counts()).tickets, 2);
    assert.equal((await counts()).messages, 4);
  });

  for (const forceNew of [false, true]) {
    await t.test(`${forceNew ? 'manual' : 'payment'} invitation concurrent activation and retries create one ticket without renewal`, async () => {
      await reset();
      const token = await invite(forceNew);
      const results = await Promise.all([create(token), create(token)]);
      assert.equal(results[0].publicTicketNo, results[1].publicTicketNo);
      assert.equal((await counts()).tickets, 1);
      assert.equal((await counts()).messages, 2);
      const firstExpiry = (await tokenRow(token)).expiry;
      const replay = await create(token);
      assert.equal(replay.publicTicketNo, results[0].publicTicketNo);
      assert.equal((await tokenRow(token)).expiry, firstExpiry);
      const opened = await send('GET', '/bootstrap?t=' + token);
      assert.equal(opened.status, 200);
      assert.equal(opened.body.ticket.public_ticket_no, results[0].publicTicketNo);
      assert.equal((await tokenRow(token)).expiry, firstExpiry);
    });
  }

  await t.test('a submission overtaken by activation enters that ticket instead of reporting an order conflict', async () => {
    await reset();
    const token = await invite();
    let activated: Awaited<ReturnType<typeof createTicket>> | undefined;
    let activationExpiry: string | undefined;
    const originalQuery = pool.query.bind(pool);
    // Pause the first empty hash lookup while another request commits real activation.
    const intercepted = t.mock.method(pool, 'query', (async (sql: string, values?: any[]) => {
      const result = await originalQuery(sql, values);
      if (!activated && sql.includes('WHERE bootstrap_token_hash = $1') && values?.[0] === hashToken(token)) {
        activated = await create(token);
        activationExpiry = (await tokenRow(token)).expiry;
      }
      return result;
    }) as typeof pool.query);
    try {
      const response = await submit(token);
      assert.ok(activated, 'the other request must commit during the initial lookup');
      assert.equal(response.status, 200);
      assert.equal(response.body.publicTicketNo, activated.publicTicketNo);
      assert.equal((await tokenRow(token)).expiry, activationExpiry);
      assert.equal((await counts()).tickets, 1);
      assert.equal((await counts()).messages, 2);
    } finally {
      intercepted.mock.restore();
    }
  });

  await t.test('failed first customer message rolls back the ticket, access token and invitation expiry together', async () => {
    await reset();
    const token = await invite();
    const expiry = (await tokenRow(token)).expiry;
    await pool.query("ALTER TABLE support_ticket_messages ADD CONSTRAINT fixture_reject_message CHECK (content != 'fixture failure')");
    try {
      await assert.rejects(create(token, { description: 'fixture failure' }), /fixture_reject_message/);
      assert.deepEqual(await counts(), { tickets: 0, messages: 0, access_tokens: 0 });
      assert.equal((await tokenRow(token)).expiry, expiry);
    } finally {
      await pool.query('ALTER TABLE support_ticket_messages DROP CONSTRAINT fixture_reject_message');
    }
  });

  await t.test('an unused payment invitation retains the existing order fallback without activation or renewal', async () => {
    await reset();
    const original = await create(await invite(true));
    const token = await invite();
    const expiry = (await tokenRow(token)).expiry;
    const opened = await send('GET', '/bootstrap?t=' + token);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.ticket.public_ticket_no, original.publicTicketNo);
    const submitted = await submit(token);
    assert.equal(submitted.status, 409);
    assert.equal(submitted.body.public_ticket_no, original.publicTicketNo);
    assert.equal((await tokenRow(token)).expiry, expiry);
    assert.equal((await counts()).tickets, 1);
    assert.equal((await counts()).messages, 2);
  });

  await t.test('expired, revoked and mismatched invitations cannot create or renew a ticket', async () => {
    for (const invalid of ['expired', 'revoked', 'store', 'order', 'email']) {
      await reset();
      const token = await invite();
      if (invalid === 'expired') await pool.query("UPDATE support_access_tokens SET expires_at=now()-interval '1 day' WHERE token_hash=$1", [hashToken(token)]);
      if (invalid === 'revoked') await pool.query('UPDATE support_access_tokens SET revoked_at=now() WHERE token_hash=$1', [hashToken(token)]);
      const expiry = (await tokenRow(token)).expiry;
      const extra = invalid === 'store' ? { storeSubdomain: 'other.invalid' } : invalid === 'order' ? { orderId: 'other' } :
        invalid === 'email' ? { customerEmail: 'other@example.invalid' } : {};
      await assert.rejects(create(token, extra), /Invalid or expired token/);
      assert.deepEqual(await counts(), { tickets: 0, messages: 0, access_tokens: 0 });
      assert.equal((await tokenRow(token)).expiry, expiry);
    }
  });

  await t.test('reply notification and an independent new invitation leave the original invitation expiry unchanged', async () => {
    await reset();
    const token = await invite();
    const original = await create(token);
    const expiry = (await tokenRow(token)).expiry;
    const params = { ...identity, publicTicketNo: original.publicTicketNo };
    await createAgentReplyNoticeEmailJob(params);
    const { job } = await createCustomerComplaintInviteJob(params);
    const newToken = new URL(job.raw_client_link).searchParams.get('t')!;
    assert.notEqual(newToken, token);
    const newTicket = await create(newToken);
    assert.notEqual(newTicket.publicTicketNo, original.publicTicketNo);
    assert.equal((await tokenRow(token)).expiry, expiry);
    assert.equal((await tokenRow(newToken)).expiry, (await tokenRow(newTicket.accessToken)).expiry);
    assert.equal(Number((await pool.query("SELECT count(*) FROM support_email_jobs WHERE status='sent'")).rows[0].count), 0);
  });
});
