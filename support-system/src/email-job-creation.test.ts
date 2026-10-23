import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import nodemailer from 'nodemailer';
import {
  createAgentReplyNoticeEmailJob,
  createCustomerComplaintInviteJob,
  createPaidSupportInviteEmailJob,
} from './email-service';

const fixture = {
  storeSubdomain: 'fixture-store',
  storeName: 'Fixture Store',
  orderId: 'fixture-order',
  orderNumber: '#1001',
  customerEmail: 'customer@example.invalid',
  publicTicketNo: 'fixture-ticket',
};

const creators = [
  {
    type: 'paid_support_invite',
    tokens: 1,
    create: async () => (await createPaidSupportInviteEmailJob(fixture)).job,
  },
  {
    type: 'agent_reply_notice',
    tokens: 1,
    create: () => createAgentReplyNoticeEmailJob(fixture),
  },
  {
    type: 'customer_complaint_invite',
    tokens: 2,
    create: async () => (await createCustomerComplaintInviteJob(fixture)).job,
  },
];

function numberConflict(message = 'duplicate email job number') {
  return Object.assign(new Error(message), {
    code: '23505',
    constraint: 'support_email_jobs_email_job_no_key',
  });
}

interface FakeResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

function fakeDatabase(t: TestContext, options: {
  insert: (attempt: number, values: unknown[]) => FakeResult;
  previousReply?: Record<string, unknown>;
}) {
  // Never load .env. Every database/SMTP/network operation is mocked or blocked.
  const env = {
    SUPPORT_PUBLIC_BASE_URL: 'https://support.example.invalid',
    SUPPORT_DATABASE_URL: 'postgresql://fixture:fixture@database.invalid/fixture',
    SUPPORT_TOKEN_SECRET: 'fixture-only',
    SUPPORT_MAIL_FROM: 'support@example.invalid',
    SUPPORT_SMTP_HOST: 'smtp.invalid',
    SUPPORT_SMTP_PORT: '1025',
  };
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(Pool.prototype, 'connect', () => { throw new Error('Real database access forbidden'); });
  t.mock.method(nodemailer, 'createTransport', () => { throw new Error('SMTP access forbidden'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network access forbidden'); });

  const inserts: unknown[][] = [];
  const tokenHashes = new Map<unknown, number>();
  let templateReads = 0;
  let existingJobReads = 0;
  const existingJob = { id: 99, email_job_no: 'existing-job', status: 'sent' };

  t.mock.method(Pool.prototype, 'query', async (text: string, values: unknown[] = []): Promise<FakeResult> => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('SELECT value FROM support_system_settings')) {
      return { rows: [{ value: env.SUPPORT_PUBLIC_BASE_URL }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO support_access_tokens')) {
      tokenHashes.set(values[0], 700 + tokenHashes.size);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id FROM support_access_tokens')) {
      assert.ok(tokenHashes.has(values[0]), 'lookup must refer to a token created in this test');
      return { rows: [{ id: tokenHashes.get(values[0]) }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT ej.raw_client_link')) {
      const rows = options.previousReply ? [options.previousReply] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM support_email_templates WHERE email_type = $1')) {
      templateReads += 1;
      return {
        rows: [{
          subject_template: 'Support for {{order_number}}',
          body_template: '<p>{{order_number}}</p><a href="{{client_link}}">Support</a><a href="{{complaint_link}}">Complaint</a>',
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith('INSERT INTO support_email_jobs')) {
      if (sql.includes("'paid_support_invite'")) {
        assert.match(sql, /ON CONFLICT \(event_key\) DO NOTHING/);
      }
      inserts.push([...values]);
      return options.insert(inserts.length, values);
    }
    if (sql === 'SELECT * FROM support_email_jobs WHERE event_key = $1') {
      existingJobReads += 1;
      assert.equal(values[0], 'paid_support_invite:fixture-store:fixture-order:customer@example.invalid');
      return { rows: [existingJob], rowCount: 1 };
    }
    throw new Error(`Unexpected database query: ${sql}`);
  });

  return {
    inserts,
    existingJob,
    get tokenCount() { return tokenHashes.size; },
    get templateReads() { return templateReads; },
    get existingJobReads() { return existingJobReads; },
  };
}

for (const creator of creators) {
  test(`${creator.type} retries a job number collision without recreating tokens or content`, async t => {
    const db = fakeDatabase(t, {
      insert(attempt, values) {
        if (attempt === 1) throw numberConflict();
        return { rows: [{ id: 100, email_job_no: values[0] }], rowCount: 1 };
      },
    });

    const job = await creator.create();
    assert.equal(db.inserts.length, 2);
    assert.equal(job.id, 100);
    assert.equal(job.email_job_no, db.inserts[1][0]);
    assert.match(String(db.inserts[0][0]), /^EJ\d{6}[a-f0-9]{16}$/);
    assert.match(String(db.inserts[1][0]), /^EJ\d{6}[a-f0-9]{16}$/);
    assert.notEqual(db.inserts[0][0], db.inserts[1][0]);
    assert.deepEqual(db.inserts[0].slice(1), db.inserts[1].slice(1));
    assert.equal(db.tokenCount, creator.tokens);
    assert.equal(db.templateReads, 1);
    assert.equal(db.existingJobReads, 0);
  });

  test(`${creator.type} stops after three number collisions and throws the last error`, async t => {
    const errors = Array.from({ length: 3 }, (_, i) => numberConflict(`collision ${i + 1}`));
    const db = fakeDatabase(t, { insert(attempt) { throw errors[attempt - 1] || new Error('too many retries'); } });

    await assert.rejects(creator.create, error => error === errors[2]);
    assert.equal(db.inserts.length, 3);
    assert.equal(new Set(db.inserts.map(values => values[0])).size, 3);
    assert.equal(db.tokenCount, creator.tokens);
    assert.equal(db.templateReads, 1);
  });
}

test('paid invite event deduplication returns the existing job without retrying', async t => {
  const db = fakeDatabase(t, { insert: () => ({ rows: [], rowCount: 0 }) });
  const result = await createPaidSupportInviteEmailJob(fixture);

  assert.equal(result.inserted, false);
  assert.strictEqual(result.job, db.existingJob);
  assert.equal(db.inserts.length, 1);
  assert.equal(db.existingJobReads, 1);
});

test('event deduplication also terminates a retry after a number collision', async t => {
  const db = fakeDatabase(t, {
    insert(attempt) {
      if (attempt === 1) throw numberConflict();
      return { rows: [], rowCount: 0 };
    },
  });
  const result = await createPaidSupportInviteEmailJob(fixture);

  assert.equal(result.inserted, false);
  assert.strictEqual(result.job, db.existingJob);
  assert.equal(db.inserts.length, 2);
  assert.equal(db.existingJobReads, 1);
  assert.equal(db.tokenCount, 1);
});

const unrelatedErrors = [
  Object.assign(new Error('another unique constraint'), { code: '23505', constraint: 'support_email_jobs_event_key_key' }),
  Object.assign(new Error('wrong SQLSTATE'), { code: '08006', constraint: 'support_email_jobs_email_job_no_key' }),
  Object.assign(new Error('unidentified unique violation'), { code: '23505' }),
  new Error('database unavailable'),
];

for (const originalError of unrelatedErrors) {
  test(`job creation propagates ${originalError.message} without retrying`, async t => {
    const db = fakeDatabase(t, { insert() { throw originalError; } });

    await assert.rejects(() => createPaidSupportInviteEmailJob(fixture), error => error === originalError);
    assert.equal(db.inserts.length, 1);
    assert.equal(db.tokenCount, 1);
  });
}

test('reply job retries preserve a previously sent valid customer link', async t => {
  const link = 'https://support.example.invalid/ticket?t=ta_existing_fixture';
  const db = fakeDatabase(t, {
    previousReply: { raw_client_link: link, token_id: 777, revoked_at: null, expires_at: '2100-01-01T00:00:00Z' },
    insert(attempt, values) {
      if (attempt === 1) throw numberConflict();
      return { rows: [{ id: 100, email_job_no: values[0] }], rowCount: 1 };
    },
  });

  await createAgentReplyNoticeEmailJob(fixture);
  assert.equal(db.inserts.length, 2);
  assert.equal(db.tokenCount, 0);
  assert.equal(db.templateReads, 1);
  assert.equal(db.inserts[1][10], 777);
  assert.equal(db.inserts[1][14], link);
  assert.ok(String(db.inserts[1][12]).includes(link));
  assert.deepEqual(db.inserts[0].slice(1), db.inserts[1].slice(1));
});
